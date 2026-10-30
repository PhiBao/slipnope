"use client";

import { useState } from "react";
import { useAccount, useReadContracts, useWriteContract } from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import { REGISTRY, WIF, registryAbi, erc20Abi, EXPLORER, shortAddr } from "@/lib/contracts";

export default function StakeCard() {
  const { address, isConnected } = useAccount();
  const [stakeAmt, setStakeAmt] = useState("1000");
  const [bandInput, setBandInput] = useState("100");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { writeContractAsync } = useWriteContract();

  const deployed = Boolean(REGISTRY);
  const { data, refetch } = useReadContracts({
    contracts: address && deployed
      ? [
          { address: WIF, abi: erc20Abi, functionName: "balanceOf" as const, args: [address] },
          { address: REGISTRY as Address, abi: registryAbi, functionName: "staked" as const, args: [address] },
          { address: REGISTRY as Address, abi: registryAbi, functionName: "getBandBps" as const, args: [address] },
          { address: REGISTRY as Address, abi: registryAbi, functionName: "MIN_STAKE" as const },
          { address: WIF, abi: erc20Abi, functionName: "allowance" as const, args: [address, REGISTRY as Address] },
        ]
      : [],
    query: { refetchInterval: 15_000 },
  });

  const wifBal = data?.[0]?.status === "success" ? (data[0].result as bigint) : 0n;
  const staked = data?.[1]?.status === "success" ? (data[1].result as bigint) : 0n;
  const band = data?.[2]?.status === "success" ? Number(data[2].result) : 0;
  const minStake = data?.[3]?.status === "success" ? (data[3].result as bigint) : 1000n * 10n ** 18n;
  const allowance = data?.[4]?.status === "success" ? (data[4].result as bigint) : 0n;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message.slice(0, 180) : "Transaction failed");
    } finally {
      setBusy(false);
    }
  }

  async function doStake() {
    const amt = parseUnits(stakeAmt || "0", 18);
    if (allowance < amt) {
      await run(
        () => writeContractAsync({ address: WIF, abi: erc20Abi, functionName: "approve", args: [REGISTRY as Address, amt] }),
        "Approved. Now stake.",
      );
      return;
    }
    await run(
      () => writeContractAsync({ address: REGISTRY as Address, abi: registryAbi, functionName: "stake", args: [amt] }),
      "Staked. Set your band below.",
    );
  }

  return (
    <section aria-label="Stake WIF for a tighter band" className="border border-[var(--color-line)] bg-[var(--color-panel)] p-5 sm:p-6 h-full">
      <div className="text-[10px] font-bold tracking-[0.3em] text-[var(--color-faded)] uppercase">$WIF flywheel</div>
      <h3 className="mt-2 text-xl font-black leading-tight">
        Stake $WIF. <span className="text-[var(--color-amber)]">Tighten your guard.</span>
      </h3>
      <p className="mt-2 text-sm text-[var(--color-faded)] leading-relaxed">
        Free protection blocks beyond ±3.00%. Stake {Number(formatUnits(minStake, 18)).toLocaleString()} $WIF to set
        your own band down to ±0.25% — the hook reads your stake on every swap. Unstake anytime; your band relaxes
        back to default the moment you drop below the minimum.
      </p>

      {deployed ? (
        <>
          <div className="num mt-4 grid grid-cols-3 gap-px bg-[var(--color-line)] border border-[var(--color-line)] text-center">
            <div className="bg-[var(--color-ink)] p-3">
              <div className="text-[9px] tracking-[0.2em] text-[var(--color-faded)] uppercase">WIF balance</div>
              <div className="mt-1 text-base">{Number(formatUnits(wifBal, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
            <div className="bg-[var(--color-ink)] p-3">
              <div className="text-[9px] tracking-[0.2em] text-[var(--color-faded)] uppercase">Staked</div>
              <div className="mt-1 text-base text-[var(--color-amber)]">{Number(formatUnits(staked, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
            <div className="bg-[var(--color-ink)] p-3">
              <div className="text-[9px] tracking-[0.2em] text-[var(--color-faded)] uppercase">Your band</div>
              <div className="mt-1 text-base">{band > 0 ? `±${(band / 100).toFixed(2)}%` : "±3.00% def."}</div>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <input
              value={stakeAmt}
              onChange={(e) => setStakeAmt(e.target.value.replace(/[^0-9.]/g, ""))}
              className="num w-full bg-[var(--color-ink)] border border-[var(--color-line)] px-3 py-2.5 outline-none focus:border-[var(--color-amber-dim)]"
              aria-label="WIF amount to stake"
            />
            <button
              onClick={doStake}
              disabled={!isConnected || busy}
              className="shrink-0 px-4 bg-[var(--color-amber)] text-black text-sm font-black uppercase disabled:opacity-30 hover:bg-[#ffc233]"
            >
              {allowance < parseUnits(stakeAmt || "0", 18) ? "Approve" : "Stake"}
            </button>
            <button
              onClick={() =>
                run(
                  () => writeContractAsync({ address: REGISTRY as Address, abi: registryAbi, functionName: "unstake", args: [staked] }),
                  "Unstaked. Band restored to default.",
                )
              }
              disabled={!isConnected || busy || staked === 0n}
              className="shrink-0 px-4 border border-[var(--color-line)] text-sm font-bold uppercase disabled:opacity-30 hover:border-[var(--color-amber-dim)]"
            >
              Unstake
            </button>
          </div>

          <div className="mt-3 flex gap-2 items-center">
            <label className="num text-[11px] text-[var(--color-faded)] shrink-0" htmlFor="band-input">
              BAND (BPS, 25–300)
            </label>
            <input
              id="band-input"
              value={bandInput}
              onChange={(e) => setBandInput(e.target.value.replace(/[^0-9]/g, ""))}
              className="num w-24 bg-[var(--color-ink)] border border-[var(--color-line)] px-3 py-2 outline-none focus:border-[var(--color-amber-dim)]"
            />
            <button
              onClick={() =>
                run(
                  () => writeContractAsync({ address: REGISTRY as Address, abi: registryAbi, functionName: "setBand", args: [Number(bandInput)] }),
                  `Band set to ±${(Number(bandInput) / 100).toFixed(2)}%. The hook now enforces it.`,
                )
              }
              disabled={!isConnected || busy || staked < minStake}
              className="px-4 py-2 border border-[var(--color-amber)] text-[var(--color-amber)] text-sm font-bold uppercase disabled:opacity-30 hover:bg-[var(--color-amber)] hover:text-black transition-colors"
            >
              Set band
            </button>
          </div>
          {msg && <p className="mt-3 text-xs leading-relaxed text-[var(--color-faded)]">{msg}</p>}
        </>
      ) : (
        <p className="num mt-4 text-xs text-[var(--color-faded)] leading-relaxed">
          Registry deployment pending — staking activates with the guard deployment.
          $WIF: <a className="text-[var(--color-amber)] underline underline-offset-2" href={`${EXPLORER}/token/${WIF}`} target="_blank" rel="noreferrer">{shortAddr(WIF)} ↗</a>
        </p>
      )}
    </section>
  );
}
