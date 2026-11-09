"use client";

import { useMemo, useState } from "react";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import {
  SLIPNOPE,
  ROUTER,
  USDC,
  STOCKS,
  hookAbi,
  routerAbi,
  erc20Abi,
  nvdaPoolKey,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  fmtUsd,
  EXPLORER,
} from "@/lib/contracts";
import { recordEntry, savedEstimate } from "@/lib/ledger";

type Side = "buy" | "sell";

export default function GuardCard({ onLedgerChange }: { onLedgerChange: () => void }) {
  const { address, isConnected } = useAccount();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("25");
  const [stampKey, setStampKey] = useState(0);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const poolKey = nvdaPoolKey();
  const deployed = Boolean(SLIPNOPE && ROUTER && poolKey);
  const zeroForOne = side === "buy"; // currency0 = USDC: buy NVDAc pays USDC (0 -> 1)

  const trader = (address ?? "0x0000000000000000000000000000000000000000") as Address;

  const { data: preview, isLoading: previewLoading } = useReadContract({
    address: deployed ? (SLIPNOPE as Address) : undefined,
    abi: hookAbi,
    functionName: "previewGuard",
    args: poolKey ? [poolKey, zeroForOne, trader] : undefined,
    query: { enabled: deployed, refetchInterval: 12_000 },
  });

  const { data: balances } = useReadContracts({
    contracts: address
      ? [
          { address: USDC, abi: erc20Abi, functionName: "balanceOf" as const, args: [address] },
          { address: STOCKS[0].token, abi: erc20Abi, functionName: "balanceOf" as const, args: [address] },
          {
            address: side === "buy" ? USDC : STOCKS[0].token,
            abi: erc20Abi,
            functionName: "allowance" as const,
            args: [address, (ROUTER || "0x0000000000000000000000000000000000000000") as Address],
          },
        ]
      : [],
    query: { refetchInterval: 15_000 },
  });

  const usdcBal = balances?.[0]?.status === "success" ? (balances[0].result as bigint) : 0n;
  const nvdaBal = balances?.[1]?.status === "success" ? (balances[1].result as bigint) : 0n;
  const allowance = balances?.[2]?.status === "success" ? (balances[2].result as bigint) : 0n;

  const amountNum = parseFloat(amount) || 0;
  const inDecimals = side === "buy" ? 6 : 8;
  const amountIn = useMemo(() => {
    try {
      return parseUnits(amount || "0", inDecimals);
    } catch {
      return 0n;
    }
  }, [amount, inDecimals]);

  const adverseBps = preview ? Number(preview[0]) : null;
  const bandBps = preview ? Number(preview[1]) : 300;
  const fee = preview ? Number(preview[2]) : null;
  const blocked = preview ? Boolean(preview[3]) : false;
  const poolPrice = preview ? Number(preview[4]) / 1e18 : null;
  const fairPrice = preview ? Number(preview[5]) / 1e18 : null;

  const verdict: "OK" | "WARN" | "BLOCK" | null = !preview
    ? null
    : blocked
      ? "BLOCK"
      : adverseBps !== null && adverseBps > bandBps / 2
        ? "WARN"
        : "OK";

  const notionalUsd =
    side === "buy" ? amountNum : fairPrice ? amountNum * fairPrice : 0;

  const { writeContractAsync } = useWriteContract();
  const [pendingHash, setPendingHash] = useState<`0x${string}` | undefined>();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash: pendingHash });
  const [busy, setBusy] = useState(false);

  async function handleAction() {
    setErrorMsg(null);
    if (!deployed || !poolKey || !address) return;

    // BLOCK path: the hook would revert. Record the save instead of burning gas.
    if (verdict === "BLOCK" && adverseBps !== null && poolPrice && fairPrice) {
      recordEntry({
        wallet: address,
        symbol: "NVDAc",
        side,
        amountUsd: notionalUsd,
        poolPrice,
        fairPrice,
        adverseBps,
        bandBps,
        decision: "BLOCK",
        savedUsd: savedEstimate(notionalUsd, adverseBps),
      });
      setStampKey((k) => k + 1);
      onLedgerChange();
      return;
    }

    setBusy(true);
    try {
      const inToken = side === "buy" ? USDC : STOCKS[0].token;
      if (allowance < amountIn) {
        const ah = await writeContractAsync({
          address: inToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [ROUTER as Address, amountIn],
        });
        setPendingHash(ah);
      }
      const hash = await writeContractAsync({
        address: ROUTER as Address,
        abi: routerAbi,
        functionName: "swapExactInput",
        args: [
          poolKey,
          zeroForOne,
          amountIn,
          zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
        ],
      });
      setPendingHash(hash);
      setLastTx(hash);
      if (adverseBps !== null && poolPrice && fairPrice) {
        recordEntry({
          wallet: address,
          symbol: "NVDAc",
          side,
          amountUsd: notionalUsd,
          poolPrice,
          fairPrice,
          adverseBps,
          bandBps,
          decision: verdict === "WARN" ? "WARN" : "OK",
          savedUsd: 0,
          txHash: hash,
        });
        onLedgerChange();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("OverpayBlocked") || msg.includes("0x")) {
        setErrorMsg(
          "The hook reverted this swap (OverpayBlocked). Pool price moved outside your band between preview and execution — nothing was spent.",
        );
        if (adverseBps !== null && poolPrice && fairPrice) {
          recordEntry({
            wallet: address,
            symbol: "NVDAc",
            side,
            amountUsd: notionalUsd,
            poolPrice,
            fairPrice,
            adverseBps,
            bandBps,
            decision: "BLOCK",
            savedUsd: savedEstimate(notionalUsd, adverseBps),
          });
          setStampKey((k) => k + 1);
          onLedgerChange();
        }
      } else {
        setErrorMsg(msg.slice(0, 220));
      }
    } finally {
      setBusy(false);
    }
  }

  const verdictStyles = {
    OK: "border-[var(--color-good)] text-[var(--color-good)]",
    WARN: "border-[var(--color-amber)] text-[var(--color-amber)]",
    BLOCK: "border-[var(--color-bad)] text-[var(--color-bad)]",
  } as const;

  return (
    <section aria-label="Guarded swap" className="relative border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden">
      <div className="hazard h-2 w-full" />
      <div className="p-5 sm:p-7">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-black tracking-tight leading-none">
              The guard <span className="text-[var(--color-amber)]">is the pool.</span>
            </h2>
            <p className="mt-2 text-sm text-[var(--color-faded)] max-w-xl leading-relaxed">
              Every swap in the SlipNope NVDAc/USDC pool is checked against Chainlink fair value{" "}
              <em className="not-italic text-[var(--color-cream)]">inside the transaction</em>. Outside your band, the
              swap cannot execute — no warning to ignore, no app to close.
            </p>
          </div>
          {verdict && (
            <div
              key={`${verdict}-${stampKey}`}
              className={`${verdict === "BLOCK" ? "stamp" : ""} border-[3px] px-4 py-2 num font-bold text-xl tracking-widest ${verdictStyles[verdict]}`}
            >
              {verdict === "BLOCK" ? "BLOCKED" : verdict}
            </div>
          )}
        </div>

        {/* side + amount */}
        <div className="mt-6 grid sm:grid-cols-[auto_1fr_auto] gap-3 items-stretch">
          <div className="flex border border-[var(--color-line)]">
            {(["buy", "sell"] as Side[]).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`px-5 py-3 text-sm font-bold tracking-widest uppercase transition-colors ${
                  side === s ? "bg-[var(--color-amber)] text-black" : "text-[var(--color-faded)] hover:text-[var(--color-cream)]"
                }`}
              >
                {s} NVDAc
              </button>
            ))}
          </div>
          <label className="flex items-center gap-3 border border-[var(--color-line)] bg-[var(--color-ink)] px-4 focus-within:border-[var(--color-amber-dim)]">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              className="num w-full bg-transparent py-3 text-2xl font-semibold outline-none"
              aria-label={side === "buy" ? "Amount in USDC" : "Amount in NVDAc"}
            />
            <span className="num text-sm text-[var(--color-faded)]">{side === "buy" ? "USDC" : "NVDAc"}</span>
          </label>
          <button
            onClick={handleAction}
            disabled={!isConnected || !deployed || busy || confirming || amountIn === 0n}
            className="px-6 py-3 bg-[var(--color-amber)] text-black font-black tracking-wide text-sm uppercase disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#ffc233] transition-colors"
          >
            {busy || confirming ? "Working…" : verdict === "BLOCK" ? "Attempt — hook will block" : "Swap under guard"}
          </button>
        </div>

        <div className="num mt-2 text-[11px] text-[var(--color-faded)] flex gap-4 flex-wrap">
          <span>
            Balance: {formatUnits(usdcBal, 6)} USDC · {Number(formatUnits(nvdaBal, 8)).toFixed(4)} NVDAc
          </span>
          {fee !== null && <span>LP fee this swap: {(fee / 10000).toFixed(2)}%</span>}
          <span>Guard band: ±{(bandBps / 100).toFixed(2)}%</span>
        </div>

        {/* verdict detail */}
        {deployed && preview && poolPrice && fairPrice && adverseBps !== null && (
          <div className="mt-5 grid grid-cols-3 gap-px bg-[var(--color-line)] border border-[var(--color-line)] num">
            <div className="bg-[var(--color-ink)] p-3">
              <div className="text-[9px] tracking-[0.22em] text-[var(--color-faded)] uppercase">Pool price</div>
              <div className="text-lg mt-1">${fmtUsd(poolPrice)}</div>
            </div>
            <div className="bg-[var(--color-ink)] p-3">
              <div className="text-[9px] tracking-[0.22em] text-[var(--color-faded)] uppercase">Fair (Chainlink)</div>
              <div className="text-lg mt-1 text-[var(--color-amber)]">${fmtUsd(fairPrice)}</div>
            </div>
            <div className="bg-[var(--color-ink)] p-3">
              <div className="text-[9px] tracking-[0.22em] text-[var(--color-faded)] uppercase">
                {side === "buy" ? "You would overpay" : "You would lose"}
              </div>
              <div className={`text-lg mt-1 ${verdict === "BLOCK" ? "text-[var(--color-bad)] font-bold" : ""}`}>
                {(adverseBps / 100).toFixed(2)}%
                {verdict === "BLOCK" && (
                  <span className="text-sm"> · saves ~${fmtUsd(savedEstimate(notionalUsd, adverseBps))}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {deployed && previewLoading && !preview && (
          <p className="num mt-5 text-xs text-[var(--color-faded)]">Reading pool + Chainlink…</p>
        )}

        {!deployed && (
          <div className="mt-5 border border-dashed border-[var(--color-amber-dim)] p-4 text-sm leading-relaxed">
            <span className="num font-bold text-[var(--color-amber)]">GUARD DEPLOYMENT PENDING — </span>
            <span className="text-[var(--color-faded)]">
              The SlipNope contracts are built and fork-tested against live Base state (7 unit tests + 3
              mainnet-fork tests passing). The guarded swap activates the moment the hook, registry, and router are
              deployed and the NVDAc/USDC pool is seeded. The board above is already live.
            </span>
          </div>
        )}

        {errorMsg && <p className="mt-4 text-sm text-[var(--color-bad)] leading-relaxed">{errorMsg}</p>}
        {lastTx && (
          <p className="num mt-4 text-xs">
            <a className="text-[var(--color-amber)] underline underline-offset-2" href={`${EXPLORER}/tx/${lastTx}`} target="_blank" rel="noreferrer">
              Last guarded swap on Blockscout ↗
            </a>
          </p>
        )}
        {!isConnected && deployed && (
          <p className="mt-4 text-sm text-[var(--color-faded)]">Connect a wallet on Base to trade under the guard.</p>
        )}
      </div>
    </section>
  );
}
