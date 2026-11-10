"use client";

import { useQuery } from "@tanstack/react-query";
import { API_URL } from "@/lib/contracts";

type GuardApi = {
  symbol: string;
  verdict: string;
  buyBlocked: boolean;
  sellBlocked: boolean;
  bandBps: number | null;
  poolPriceUsd: number | null;
  hookFairUsd: number | null;
  premiumBps: number | null;
  advisory: { regime: string; regime_confidence: number; execution_quality: number; confidence: number; model: string } | null;
  advisoryDegraded: boolean;
};

const VERDICT_STYLE: Record<string, string> = {
  OK: "text-[var(--color-good)] border-[var(--color-good)]",
  WARN: "text-[var(--color-amber)] border-[var(--color-amber)]",
  BUY_BLOCKED: "text-[var(--color-bad)] border-[var(--color-bad)]",
  SELL_BLOCKED: "text-[var(--color-bad)] border-[var(--color-bad)]",
};

const REGIME_COPY: Record<string, string> = {
  normal: "book looks normal",
  thin_book: "thin book",
  stale_reference: "reference frozen",
  dislocated: "market dislocated",
};

export default function GuardApiPanel({ symbol = "NVDAc" }: { symbol?: string }) {
  const { data } = useQuery<GuardApi>({
    queryKey: ["guard", symbol.toLowerCase()],
    queryFn: async () => {
      const res = await fetch(`${API_URL || ""}/guard/${encodeURIComponent(symbol)}`);
      if (!res.ok) throw new Error(`guard ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!data) return null;

  const adverse =
    data.poolPriceUsd && data.hookFairUsd
      ? ((data.poolPriceUsd - data.hookFairUsd) / data.hookFairUsd) * 10_000
      : null;

  return (
    <div className="mt-5 border border-[var(--color-line)] bg-[var(--color-ink)]">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--color-line)]">
        <span className="num text-[9px] tracking-[0.2em] uppercase text-[var(--color-faded)]">
          {symbol} verdict · read from the hook onchain
        </span>
        <span className={`num text-[10px] font-bold px-1.5 py-0.5 border ${VERDICT_STYLE[data.verdict] ?? "text-[var(--color-faded)] border-[var(--color-line)]"}`}>
          {data.verdict}
        </span>
      </div>

      <div className="grid grid-cols-3 divide-x divide-[var(--color-line)] num text-xs">
        <div className="p-3">
          <div className="text-[9px] tracking-[0.16em] text-[var(--color-faded)] uppercase">Pool vs fair</div>
          <div className="mt-1">
            {adverse === null ? "—" : `${adverse >= 0 ? "+" : ""}${(adverse / 100).toFixed(2)}%`}
          </div>
        </div>
        <div className="p-3">
          <div className="text-[9px] tracking-[0.16em] text-[var(--color-faded)] uppercase">Band</div>
          <div className="mt-1">{data.bandBps ? `±${(data.bandBps / 100).toFixed(2)}%` : "—"}</div>
        </div>
        <div className="p-3">
          <div className="text-[9px] tracking-[0.16em] text-[var(--color-faded)] uppercase">Market premium</div>
          <div className="mt-1">
            {data.premiumBps === null ? "—" : `${data.premiumBps >= 0 ? "+" : ""}${(data.premiumBps / 100).toFixed(2)}%`}
          </div>
        </div>
      </div>

      <div className="px-3 py-2 border-t border-[var(--color-line)] flex items-center justify-between gap-3 flex-wrap">
        <span className="num text-[10px] text-[var(--color-faded)]">
          Advisory · Jev:{" "}
          {data.advisory ? (
            <span className="text-[var(--color-cream)]">
              {REGIME_COPY[data.advisory.regime] ?? data.advisory.regime} ·{" "}
              {Math.round(data.advisory.regime_confidence * 100)}% conf
            </span>
          ) : (
            <span>offline (deterministic verdict above stands)</span>
          )}
        </span>
        <span className="num text-[9px] text-[var(--color-faded)]">
          {data.advisory ? `${data.advisory.model} · never decides the swap` : "degraded — no advisory"}
        </span>
      </div>
    </div>
  );
}
