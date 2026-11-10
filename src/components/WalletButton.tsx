"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { CHAIN_ID, shortAddr } from "@/lib/contracts";
import { useEnsureBase } from "@/lib/useEnsureBase";

export default function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { status, ensure } = useEnsureBase();

  if (!isConnected) {
    return (
      <button
        onClick={() => connect({ connector: connectors[0] })}
        disabled={isPending}
        className="px-4 py-2 bg-[var(--color-amber)] text-black text-sm font-black uppercase tracking-wide disabled:opacity-40 hover:bg-[#ffc233] transition-colors"
      >
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  if (chainId !== CHAIN_ID) {
    if (status === "switching") {
      return (
        <span className="px-4 py-2 border border-[var(--color-amber-dim)] text-[var(--color-amber)] text-sm font-bold uppercase tracking-wide">
          Switching to Base…
        </span>
      );
    }
    return (
      <button
        onClick={() => ensure()}
        className="px-4 py-2 bg-[var(--color-bad)] text-black text-sm font-black uppercase tracking-wide hover:opacity-90 transition-opacity"
        title="Your wallet is on another network. SlipNope only settles on Base."
      >
        {status === "failed" ? "Retry switch" : "Switch to Base"}
      </button>
    );
  }

  return (
    <button
      onClick={() => disconnect()}
      className="num px-4 py-2 border border-[var(--color-line)] text-sm hover:border-[var(--color-amber-dim)] transition-colors"
      title="Disconnect"
    >
      {shortAddr(address ?? "")} · 8453
    </button>
  );
}
