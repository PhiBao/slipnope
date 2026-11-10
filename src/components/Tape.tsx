"use client";

import { useQuery } from "@tanstack/react-query";
import { API_URL, EXPLORER, fmtUsd } from "@/lib/contracts";

type Row = {
  symbol: string;
  name: string;
  token: string;
  feed: string;
  fair_usd: number | null;
  market_usd: number | null;
  premium_bps: number | null;
  would_block: boolean;
  feed_age_secs: number | null;
  history: [number, number][];
  history_min: number | null;
  history_max: number | null;
  change_24h_pct: number | null;
  quote_confidence: "firm" | "fair" | "thin" | "unknown";
};

type Tape = {
  generatedAt: number;
  cachedAt?: number;
  staleSecs?: number;
  bandBps: number;
  dislocated: number;
  tracked: number;
  rows: Row[];
  warming?: boolean;
};

function Spark({ points }: { points: [number, number][] }) {
  if (!points || points.length < 2) return <span className="text-[var(--color-faded)]">—</span>;
  const w = 84;
  const h = 20;
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p[1] - lo) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = points[points.length - 1][1] >= points[0][1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={d} fill="none" stroke={rising ? "var(--color-good)" : "var(--color-bad)"} strokeWidth="1.4" />
    </svg>
  );
}

function age(secs: number | null) {
  if (secs === null) return "—";
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

const CONF_LABEL: Record<Row["quote_confidence"], string> = {
  firm: "firm quote",
  fair: "moving",
  thin: "thin quote",
  unknown: "no history",
};

export default function Tape() {
  const { data, isLoading } = useQuery<Tape>({
    queryKey: ["tape"],
    queryFn: async () => {
      const res = await fetch(`${API_URL || ""}/tape`);
      if (!res.ok) throw new Error(`tape ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const rows = (data?.rows ?? []).slice().sort((a, b) => Math.abs(b.premium_bps ?? 0) - Math.abs(a.premium_bps ?? 0));
  const maxAbs = Math.max(300, ...rows.map((r) => Math.abs(r.premium_bps ?? 0)));

  return (
    <section aria-label="The Dislocation Tape">
      <div className="flex items-end justify-between gap-4 flex-wrap border-b border-[var(--color-line)] pb-3">
        <div>
          <h2 className="text-[11px] font-bold tracking-[0.3em] text-[var(--color-faded)] uppercase">
            The dislocation tape
          </h2>
          <p className="mt-1.5 text-sm text-[var(--color-faded)] max-w-2xl leading-relaxed">
            Every Coinbase stock token on Base, priced two ways: <span className="text-[var(--color-amber)]">Chainlink fair</span>{" "}
            (the number the hook enforces) against the <span className="text-[var(--color-cream)]">market quote</span>. Where
            they diverge, a buyer is about to overpay — and the guard would refuse the trade.
          </p>
        </div>
        <div className="num text-right">
          <div className="text-[10px] tracking-[0.2em] text-[var(--color-faded)] uppercase">Dislocated now</div>
          <div className="text-3xl font-bold text-[var(--color-amber)]">
            {data ? data.dislocated : "—"}
            <span className="text-sm text-[var(--color-faded)]"> / {data ? data.tracked : 10}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 border border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="grid grid-cols-[2.2rem_1fr_auto] md:grid-cols-[2.2rem_9rem_1fr_7rem_6rem_5rem] items-center gap-3 px-4 py-2 text-[9.5px] tracking-[0.2em] uppercase text-[var(--color-faded)] border-b border-[var(--color-line)]">
          <div>#</div>
          <div>Stock</div>
          <div className="hidden md:block">Premium vs fair</div>
          <div className="hidden md:block text-right">Market</div>
          <div className="hidden md:block text-right">Fair</div>
          <div className="text-right">24h</div>
        </div>

        {isLoading && !data && <div className="p-6 num text-xs text-[var(--color-faded)]">Loading tape…</div>}
        {data?.warming && <div className="p-6 num text-xs text-[var(--color-faded)]">Tape warming up — first sweep takes ~15s.</div>}

        {rows.map((r, i) => {
          const prem = r.premium_bps ?? 0;
          const blocked = r.would_block;
          const width = Math.min(100, (Math.abs(prem) / maxAbs) * 100);
          return (
            <div
              key={r.symbol}
              className="grid grid-cols-[2.2rem_1fr_auto] md:grid-cols-[2.2rem_9rem_1fr_7rem_6rem_5rem] items-center gap-3 px-4 py-2.5 border-b border-[var(--color-line)] last:border-b-0 hover:bg-[var(--color-panel2)]"
            >
              <div className="num text-xs text-[var(--color-faded)]">{String(i + 1).padStart(2, "0")}</div>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="num font-bold text-[15px]">{r.symbol}</span>
                  {blocked && (
                    <span className="text-[8px] font-bold tracking-[0.14em] bg-[var(--color-bad)] text-black px-1 py-0.5">
                      BLOCK
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[var(--color-faded)] truncate">{r.name}</div>
              </div>

              {/* premium bar: center-zero, right = overpay */}
              <div className="hidden md:flex items-center gap-2">
                <div className="relative h-4 flex-1 bg-[var(--color-ink)]">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--color-line)]" />
                  <div
                    className={`absolute top-0 bottom-0 ${prem >= 0 ? "left-1/2 bg-[var(--color-bad)]" : "right-1/2 bg-[var(--color-good)]"}`}
                    style={{ width: `${width / 2}%`, opacity: 0.85 }}
                  />
                </div>
                <span
                  className={`num text-sm w-[4.5rem] text-right ${
                    blocked ? "text-[var(--color-bad)] font-bold" : prem >= 0 ? "text-[var(--color-cream)]" : "text-[var(--color-good)]"
                  }`}
                >
                  {r.premium_bps === null ? "—" : `${prem >= 0 ? "+" : ""}${(prem / 100).toFixed(2)}%`}
                </span>
              </div>

              <div className="hidden md:block num text-right text-sm">
                {r.market_usd ? `$${fmtUsd(r.market_usd)}` : "—"}
                <div className="text-[9px] text-[var(--color-faded)]">{CONF_LABEL[r.quote_confidence]}</div>
              </div>

              <div className="hidden md:block num text-right text-sm text-[var(--color-amber)]">
                {r.fair_usd ? `$${fmtUsd(r.fair_usd)}` : "—"}
                <div className="text-[9px] text-[var(--color-faded)]">{age(r.feed_age_secs)}</div>
              </div>

              <div className="flex justify-end">
                <Spark points={r.history} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-start justify-between gap-6 flex-wrap">
        <p className="text-[11px] leading-relaxed text-[var(--color-faded)] max-w-2xl">
          Fair = Chainlink tokenized-equity feed, read onchain every sweep (total return, multiplier included). Market =
          Cambrian&apos;s Uniswap v3 quote on Base. Premium beyond ±{(data?.bandBps ?? 300) / 100}% is exactly what SlipNope
          refuses to let you pay. A frozen fair feed fails closed, not open.
        </p>
        <p className="num text-[10px] text-[var(--color-faded)]">
          {data ? `updated ${data.staleSecs ?? 0}s ago` : ""} ·{" "}
          <a className="underline decoration-[var(--color-amber-dim)] underline-offset-2 hover:text-[var(--color-amber)]" href={`${EXPLORER}/address/${rows[0]?.feed ?? ""}`} target="_blank" rel="noreferrer">
            verify a feed ↗
          </a>
        </p>
      </div>
    </section>
  );
}
