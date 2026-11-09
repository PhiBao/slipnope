"use client";

import { useAccount } from "wagmi";

export default function BandCard() {
  const { isConnected } = useAccount();
  return (
    <section aria-label="How the guard bands work" className="border border-[var(--color-line)] bg-[var(--color-panel)] p-5 sm:p-6 h-full">
      <div className="text-[10px] font-bold tracking-[0.3em] text-[var(--color-faded)] uppercase">The band</div>
      <h3 className="mt-2 text-xl font-black leading-tight">
        One band. <span className="text-[var(--color-amber)]">Everyone protected.</span>
      </h3>
      <p className="mt-2 text-sm text-[var(--color-faded)] leading-relaxed">
        SlipNope enforces a universal ±3.00% guard band against Chainlink fair value — no staking, no tiers to buy
        your way into. The same three outcomes apply to every wallet:
      </p>

      <div className="mt-4 space-y-0 border border-[var(--color-line)] num text-sm">
        <div className="flex items-center gap-3 p-3 border-b border-[var(--color-line)]">
          <span className="px-1.5 py-0.5 font-bold bg-[var(--color-good)] text-black text-xs tracking-wider">OK</span>
          <span>≤ ±1.50% → fills at 0.05% fee</span>
        </div>
        <div className="flex items-center gap-3 p-3 border-b border-[var(--color-line)]">
          <span className="px-1.5 py-0.5 font-bold bg-[var(--color-amber)] text-black text-xs tracking-wider">WARN</span>
          <span>&lt; ±3.00% → fills, fee scales to 1%</span>
        </div>
        <div className="flex items-center gap-3 p-3">
          <span className="px-1.5 py-0.5 font-bold bg-[var(--color-bad)] text-black text-xs tracking-wider">BLOCK</span>
          <span>&gt; ±3.00% → swap reverts, nothing spent</span>
        </div>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-[var(--color-faded)]">
        Why a single band: Base Chainlink equity feeds run 24/5 and freeze off-hours by design. A frozen feed is treated
        as stale and blocks every swap — the guard never guesses at a price. Connect a wallet and the guard card shows
        your live verdict before you sign, from the same math the hook enforces.
        {!isConnected && " Connect to see your verdict."}
      </p>
    </section>
  );
}
