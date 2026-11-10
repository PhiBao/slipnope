"use client";

import { useAccount } from "wagmi";
import { CHAIN_ID } from "@/lib/contracts";
import { useEnsureBase } from "@/lib/useEnsureBase";

/**
 * Shown in product surfaces that need Base. The hook has already tried an
 * automatic switch; this is the visible state and the manual way out.
 */
export default function ChainNotice({ what }: { what: string }) {
  const { isConnected, chainId } = useAccount();
  const { status, error, ensure } = useEnsureBase();

  if (!isConnected || chainId === CHAIN_ID) return null;

  return (
    <div className="mt-4 flex items-start justify-between gap-4 flex-wrap border border-[var(--color-bad)] bg-[var(--color-ink)] px-4 py-3">
      <div>
        <p className="text-sm font-bold text-[var(--color-cream)]">
          {status === "switching" ? "Asking your wallet to switch to Base…" : "Your wallet is on another network"}
        </p>
        <p className="num mt-1 text-[11px] text-[var(--color-faded)]">
          {what} only settles on Base (8453). {status === "failed" && error ? `Wallet said: ${error}` : "Approve the switch in your wallet, or add Base first."}
        </p>
      </div>
      <button
        onClick={() => ensure()}
        disabled={status === "switching"}
        className="px-4 py-2 bg-[var(--color-bad)] text-black text-xs font-black uppercase tracking-wide disabled:opacity-40"
      >
        {status === "switching" ? "Switching…" : "Switch to Base"}
      </button>
    </div>
  );
}
