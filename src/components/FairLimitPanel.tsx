"use client";

import { useState } from "react";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import {
  FAIR_LIMIT,
  USDC,
  STOCKS,
  CHAIN_ID,
  erc20Abi,
  fairLimitAbi,
  fairSqrtLimits,
  nvdaPoolKey,
  hookAbi,
  SLIPNOPE,
  fmtUsd,
  shortAddr,
  EXPLORER,
} from "@/lib/contracts";
import ChainNotice from "./ChainNotice";

/**
 * "The block isn't a dead end."
 *
 * When the guard refuses an overpay, the buyer can park the order at their own
 * maximum premium. Anyone may fill it once the hook says the book is fair
 * enough; the owner can withdraw at any moment.
 */
export default function FairLimitPanel() {
  const { address, isConnected, chainId } = useAccount();
  const wrongChain = isConnected && chainId !== undefined && chainId !== CHAIN_ID;
  const [amount, setAmount] = useState("1");
  const [capBps, setCapBps] = useState("100");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | undefined>();

  const deployed = Boolean(FAIR_LIMIT);
  const poolKey = nvdaPoolKey();

  const { data, refetch } = useReadContracts({
    contracts: deployed && address
      ? [
          { address: FAIR_LIMIT as Address, abi: fairLimitAbi, functionName: "nextOrderId" },
          { address: FAIR_LIMIT as Address, abi: fairLimitAbi, functionName: "openOrders" },
          { address: FAIR_LIMIT as Address, abi: fairLimitAbi, functionName: "filledOrders" },
          { address: USDC, abi: erc20Abi, functionName: "allowance", args: [address, FAIR_LIMIT as Address] },
          { address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
        ]
      : [],
    query: { refetchInterval: 20_000 },
  });

  const nextId = data?.[0]?.status === "success" ? Number(data[0].result) : 1;
  const open = data?.[1]?.status === "success" ? Number(data[1].result) : 0;
  const filled = data?.[2]?.status === "success" ? Number(data[2].result) : 0;
  const allowance = data?.[3]?.status === "success" ? (data[3].result as bigint) : 0n;
  const balance = data?.[4]?.status === "success" ? (data[4].result as bigint) : 0n;

  // Scan a wider window than we render, so a wallet's own order does not fall
  // off the list when other people park orders after it.
  const ids = Array.from({ length: Math.min(8, Math.max(0, nextId - 1)) }, (_, i) => nextId - 1 - i);
  const { data: orders } = useReadContracts({
    contracts: deployed
      ? ids.map((id) => ({ address: FAIR_LIMIT as Address, abi: fairLimitAbi, functionName: "orders" as const, args: [BigInt(id)] }))
      : [],
    query: { refetchInterval: 20_000 },
  });
  const { data: statuses } = useReadContracts({
    contracts: deployed
      ? ids.map((id) => ({ address: FAIR_LIMIT as Address, abi: fairLimitAbi, functionName: "status" as const, args: [BigInt(id)] }))
      : [],
    query: { refetchInterval: 15_000 },
  });

  const { data: preview } = useReadContracts({
    contracts: deployed && poolKey
      ? [
          { address: SLIPNOPE as Address, abi: hookAbi, functionName: "previewGuard", args: [poolKey, true, (address ?? "0x0000000000000000000000000000000000000000") as Address] },
        ]
      : [],
    query: { refetchInterval: 20_000 },
  });
  const fairE18 = preview?.[0]?.status === "success" ? (preview[0].result[5] as bigint) : 0n;

  // Your orders first, then the newest of everyone else's. Five rows keeps the
  // table scannable while the wider scan above makes sure your order stays in it.
  const rows = ids.flatMap((id, i) => {
    const o = orders?.[i]?.status === "success" ? orders[i].result : null;
    if (!o) return [];
    const [owner, amountIn, maxPremium, , , isOpen] = o as readonly [Address, bigint, number, bigint, bigint, boolean];
    const st = statuses?.[i]?.status === "success" ? statuses[i].result : null;
    return [
      {
        id,
        owner,
        amountIn,
        maxPremium: Number(maxPremium),
        isOpen,
        isMine: Boolean(address) && owner.toLowerCase() === address?.toLowerCase(),
        status: st as readonly [boolean, bigint, boolean] | null,
      },
    ];
  });
  const visible = [...rows].sort((a, b) => Number(b.isMine) - Number(a.isMine) || b.id - a.id).slice(0, 5);

  const { writeContractAsync } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });

  async function run(fn: () => Promise<`0x${string}`>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const h = await fn();
      setHash(h);
      setMsg(ok);
      setTimeout(() => refetch(), 4000);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.includes("User rejected") || m.includes("User denied") || m.includes("4001")) {
        setMsg("Rejected in your wallet. Nothing moved.");
      } else if (m.includes("NotOwner")) {
        setMsg("Only the wallet that placed this order can withdraw it. Fills are open to anyone.");
      } else if (m.includes("OrderClosed")) {
        setMsg("That order was already filled or withdrawn. Updating the list…");
        setTimeout(() => refetch(), 800);
      } else if (m.includes("PremiumTooHigh")) {
        setMsg("The hook says this book is still too far from fair — the order stays parked.");
      } else if (m.includes("InsufficientBalance") || m.includes("transfer amount exceeds balance")) {
        setMsg("Not enough USDC in this wallet for that order.");
      } else if (m.includes("Expired")) {
        setMsg("That order has expired. Place a new one.");
      } else {
        setMsg(m.slice(0, 180));
      }
    } finally {
      setBusy(false);
    }
  }

  async function place() {
    if (!FAIR_LIMIT) return;
    const amt = parseUnits(amount || "0", 6);
    if (allowance < amt) {
      await run(
        () => writeContractAsync({ address: USDC, abi: erc20Abi, functionName: "approve", args: [FAIR_LIMIT as Address, amt] }),
        "Approved. Place the order again.",
      );
      return;
    }
    const expiry = Math.floor(Date.now() / 1000) + Number(days) * 86400;
    await run(
      () =>
        writeContractAsync({
          address: FAIR_LIMIT as Address,
          abi: fairLimitAbi,
          functionName: "place",
          args: [amt, Number(capBps), BigInt(expiry)],
        }),
      "Order parked. It fills when the book comes back to you.",
    );
  }

  async function fill(id: number) {
    const limits = fairE18 > 0n ? fairSqrtLimits(fairE18) : null;
    if (!limits) {
      setMsg("Fair price unavailable — the guard won't fill blind.");
      return;
    }
    await run(
      () =>
        writeContractAsync({
          address: FAIR_LIMIT as Address,
          abi: fairLimitAbi,
          functionName: "fill",
          args: [BigInt(id), limits.buy],
        }),
      "Filled at your price.",
    );
  }

  return (
    <section aria-label="Fair-Limit orders" className="border border-[var(--color-line)] bg-[var(--color-panel)] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-bold tracking-[0.3em] text-[var(--color-faded)] uppercase">Fair-Limit</div>
          <h3 className="mt-2 text-xl font-black leading-tight">
            A block isn&apos;t a dead end. <span className="text-[var(--color-amber)]">Park the order.</span>
          </h3>
          <p className="mt-2 text-sm text-[var(--color-faded)] leading-relaxed max-w-xl">
            The hook refuses to let you overpay. Say what you{" "}
            <em className="not-italic text-[var(--color-cream)]">will</em> pay — anyone can fill it when the book
            returns, and you can withdraw any time.
          </p>
        </div>
        <div className="num text-right">
          <div className="text-[9px] tracking-[0.18em] text-[var(--color-faded)] uppercase">Open / filled</div>
          <div className="text-2xl font-bold">
            {open}
            <span className="text-[var(--color-faded)] text-base"> / {filled}</span>
          </div>
        </div>
      </div>

      <ChainNotice what="Fair-Limit orders" />

      {deployed ? (
        <>
          <div className="mt-4 grid sm:grid-cols-[1fr_auto_auto_auto] gap-2">
            <label className="flex items-center gap-2 border border-[var(--color-line)] bg-[var(--color-ink)] px-3">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                className="num w-full bg-transparent py-2.5 text-lg outline-none"
                aria-label="USDC to park"
              />
              <span className="num text-xs text-[var(--color-faded)]">USDC</span>
            </label>
            <label className="flex items-center gap-2 border border-[var(--color-line)] bg-[var(--color-ink)] px-3">
              <input
                value={capBps}
                onChange={(e) => setCapBps(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                className="num w-16 bg-transparent py-2.5 text-lg outline-none"
                aria-label="Max premium in basis points"
              />
              <span className="num text-xs text-[var(--color-faded)]">bps max</span>
            </label>
            <label className="flex items-center gap-2 border border-[var(--color-line)] bg-[var(--color-ink)] px-3">
              <input
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                className="num w-10 bg-transparent py-2.5 text-lg outline-none"
                aria-label="Days until expiry"
              />
              <span className="num text-xs text-[var(--color-faded)]">days</span>
            </label>
            <button
              onClick={place}
              disabled={!isConnected || busy || confirming || wrongChain}
              title={!isConnected ? "Connect a wallet first" : wrongChain ? "Switch to Base first" : undefined}
              className="px-5 py-2.5 bg-[var(--color-amber)] text-black text-sm font-black uppercase disabled:opacity-30 hover:bg-[#ffc233]"
            >
              {allowance < parseUnits(amount || "0", 6) ? "Approve" : "Park order"}
            </button>
          </div>
          <div className="num mt-2 text-[11px] text-[var(--color-faded)]">
            Balance {Number(formatUnits(balance, 6)).toFixed(2)} USDC · cap cannot exceed the guard&apos;s widest band
            · fills read the hook, never a local price · withdraw is owner-only
          </div>

          <div className="mt-4 border border-[var(--color-line)]">
            <div className="grid grid-cols-[3rem_1fr_1fr_5rem_auto] gap-2 px-3 py-2 text-[9px] uppercase tracking-[0.18em] text-[var(--color-faded)] border-b border-[var(--color-line)]">
              <div>#</div>
              <div>Parked</div>
              <div>Max premium</div>
              <div>State</div>
              <div />
            </div>
            {ids.length === 0 && <div className="p-3 num text-xs text-[var(--color-faded)]">No orders yet.</div>}
            {ids.length > 0 && visible.length === 0 && (
              <div className="p-3 num text-xs text-[var(--color-faded)]">Reading orders…</div>
            )}
            {visible.map(({ id, owner, amountIn, maxPremium, isOpen, isMine, status: st }) => {
              const fillable = st ? Boolean(st[2]) : false;
              const actionBlocked = !isConnected || wrongChain;
              return (
                <div key={id} className="grid grid-cols-[3rem_1fr_1fr_5rem_auto] gap-2 px-3 py-2.5 num text-xs items-center border-b border-[var(--color-line)] last:border-b-0">
                  <div className="text-[var(--color-faded)]">{id}</div>
                  <div>
                    {fmtUsd(Number(formatUnits(amountIn, 6)))} USDC
                    <div className="text-[9px] tracking-[0.08em] uppercase text-[var(--color-faded)]">
                      {isMine ? <span className="text-[var(--color-amber)]">your order</span> : `by ${shortAddr(owner)}`}
                    </div>
                  </div>
                  <div className={maxPremium <= 100 ? "text-[var(--color-amber)]" : ""}>
                    +{(maxPremium / 100).toFixed(2)}%
                  </div>
                  <div className={isOpen ? (fillable ? "text-[var(--color-good)]" : "text-[var(--color-faded)]") : "text-[var(--color-faded)]"}>
                    {isOpen ? (fillable ? "fillable" : "waiting") : "closed"}
                  </div>
                  <div className="flex gap-2 justify-end">
                    {isOpen && (
                      <>
                        <button
                          onClick={() => fill(id)}
                          disabled={busy || !fillable || actionBlocked}
                          title={
                            !isConnected
                              ? "Connect a wallet to fill"
                              : wrongChain
                                ? "Switch to Base to fill"
                                : !fillable
                                  ? "The hook has not cleared this order yet"
                                  : undefined
                          }
                          className="px-2 py-1 border border-[var(--color-amber)] text-[var(--color-amber)] text-[10px] font-bold uppercase disabled:opacity-30"
                        >
                          Fill
                        </button>
                        {isMine && (
                          <button
                            onClick={() => run(() => writeContractAsync({ address: FAIR_LIMIT as Address, abi: fairLimitAbi, functionName: "cancel", args: [BigInt(id)] }), "Withdrawn.")}
                            disabled={busy || actionBlocked}
                            title={wrongChain ? "Switch to Base to withdraw" : "Withdraw this order back to your wallet"}
                            className="px-2 py-1 border border-[var(--color-line)] text-[10px] font-bold uppercase text-[var(--color-faded)] disabled:opacity-30"
                          >
                            Withdraw
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {msg && <p className="mt-3 text-xs leading-relaxed text-[var(--color-faded)]">{msg}</p>}
          {hash && (
            <a className="num mt-2 inline-block text-[10px] text-[var(--color-amber)] underline underline-offset-2" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
              transaction ↗
            </a>
          )}
        </>
      ) : (
        <p className="mt-4 num text-xs text-[var(--color-faded)]">Queue deployment pending.</p>
      )}
    </section>
  );
}
