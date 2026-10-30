"use client";

import { useMemo } from "react";
import { loadLedger, type LedgerEntry } from "@/lib/ledger";
import { fmtUsd, EXPLORER, shortAddr } from "@/lib/contracts";

export default function LedgerPanel({ entries }: { entries: LedgerEntry[] }) {
  const stats = useMemo(() => {
    const blocks = entries.filter((e) => e.decision === "BLOCK");
    const saved = blocks.reduce((a, e) => a + e.savedUsd, 0);
    const fills = entries.filter((e) => e.decision !== "BLOCK");
    const offHours = blocks.filter((e) => {
      const h = new Date(e.ts).getUTCHours();
      return h < 13 || h >= 21; // outside US market hours in UTC (approx, ET 9:30-16:00)
    }).length;
    return { blocks: blocks.length, saved, fills: fills.length, offHours };
  }, [entries]);

  return (
    <section aria-label="Overpay Ledger" className="border border-[var(--color-line)] bg-[var(--color-panel)] p-5 sm:p-6 h-full">
      <div className="text-[10px] font-bold tracking-[0.3em] text-[var(--color-faded)] uppercase">Overpay Ledger</div>
      <div className="mt-3 flex items-baseline gap-6 flex-wrap">
        <div>
          <span className="num text-4xl font-bold text-[var(--color-amber)]">${fmtUsd(stats.saved)}</span>
          <span className="ml-2 text-sm text-[var(--color-faded)]">saved by {stats.blocks} block{stats.blocks === 1 ? "" : "s"}</span>
        </div>
        <span className="num text-xs text-[var(--color-faded)]">{stats.fills} guarded fills recorded</span>
      </div>

      {stats.blocks > 0 && (
        <p className="mt-3 text-sm leading-relaxed border-l-2 border-[var(--color-amber)] pl-3">
          Autopsy: {stats.offHours} of your {stats.blocks} blocked attempts happened while the US market was closed —
          exactly when thin books dislocation bites. That pattern is why the band exists.
        </p>
      )}

      <div className="mt-4 max-h-72 overflow-auto">
        {entries.length === 0 ? (
          <p className="text-sm text-[var(--color-faded)] leading-relaxed">
            No attempts yet. Your fills <em className="not-italic text-[var(--color-cream)]">and your blocks</em> will
            be recorded here — the blocks are the point. Stored locally in your browser
            {typeof window !== "undefined" && process.env.NEXT_PUBLIC_API_URL ? " and mirrored to the RobinHook API" : ""}.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {entries.slice(0, 30).map((e) => (
              <li key={e.id} className="py-2.5 num text-xs flex items-center gap-3 flex-wrap">
                <span
                  className={`px-1.5 py-0.5 font-bold tracking-wider ${
                    e.decision === "BLOCK"
                      ? "bg-[var(--color-bad)] text-black"
                      : e.decision === "WARN"
                        ? "bg-[var(--color-amber)] text-black"
                        : "bg-[var(--color-good)] text-black"
                  }`}
                >
                  {e.decision}
                </span>
                <span className="font-semibold text-sm">
                  {e.side.toUpperCase()} {e.symbol}
                </span>
                <span className="text-[var(--color-faded)]">
                  pool ${fmtUsd(e.poolPrice)} vs fair ${fmtUsd(e.fairPrice)} ({(e.adverseBps / 100).toFixed(2)}%)
                </span>
                {e.decision === "BLOCK" && <span className="text-[var(--color-amber)]">saved ~${fmtUsd(e.savedUsd)}</span>}
                <span className="ml-auto text-[var(--color-faded)]">{new Date(e.ts).toLocaleTimeString()}</span>
                {e.txHash && (
                  <a href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noreferrer" className="text-[var(--color-amber)] underline underline-offset-2">
                    {shortAddr(e.txHash)} ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="hidden">{loadLedger().length}</span>
    </section>
  );
}
