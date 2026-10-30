"use client";

import { useReadContracts } from "wagmi";
import { STOCKS, NVDA_V3_POOL, feedAbi, v3PoolAbi, v3NvdaPrice, fmtUsd, EXPLORER } from "@/lib/contracts";

function ageLabel(updatedAt: bigint): string {
  const age = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
  if (age < 90) return `${age}s ago`;
  if (age < 5400) return `${Math.round(age / 60)}m ago`;
  return `${(age / 3600).toFixed(1)}h ago`;
}

export default function Board() {
  const { data, isLoading } = useReadContracts({
    contracts: [
      ...STOCKS.map((s) => ({ address: s.feed, abi: feedAbi, functionName: "latestRoundData" as const })),
      { address: NVDA_V3_POOL, abi: v3PoolAbi, functionName: "slot0" as const },
    ],
    query: { refetchInterval: 20_000 },
  });

  const nvdaFair = data?.[0]?.status === "success" ? Number(data[0].result[1]) / 1e8 : null;
  const nvdaMarket =
    data?.[3]?.status === "success" ? v3NvdaPrice(data[3].result[0] as bigint) : null;
  const premiumBps =
    nvdaFair && nvdaMarket ? Math.round(((nvdaMarket - nvdaFair) / nvdaFair) * 10000) : null;

  return (
    <section aria-label="Fair price board">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <h2 className="text-[11px] font-bold tracking-[0.3em] text-[var(--color-faded)] uppercase">
          The board — market vs fair
        </h2>
        <span className="num text-[11px] text-[var(--color-faded)]">
          <span className="inline-block w-2 h-2 rounded-full bg-[var(--color-good)] mr-2 blink" />
          Chainlink fair · Uniswap market · live on Robinhood Chain
        </span>
      </div>

      <div className="mt-3 border border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="grid grid-cols-[1fr_1fr] md:grid-cols-[1.2fr_1fr_1fr_1fr_0.9fr] text-[10px] tracking-[0.22em] uppercase text-[var(--color-faded)] border-b border-[var(--color-line)]">
          <div className="px-4 py-2.5">Stock token</div>
          <div className="px-4 py-2.5 hidden md:block">Market (DEX)</div>
          <div className="px-4 py-2.5">Fair (Chainlink)</div>
          <div className="px-4 py-2.5 hidden md:block">Premium</div>
          <div className="px-4 py-2.5 text-right">Feed age</div>
        </div>

        {STOCKS.map((s, i) => {
          const r = data?.[i];
          const fair = r?.status === "success" ? Number(r.result[1]) / 1e8 : null;
          const updatedAt = r?.status === "success" ? (r.result[3] as bigint) : null;
          const isNvda = i === 0;
          const prem = isNvda ? premiumBps : null;
          return (
            <div
              key={s.symbol}
              className="grid grid-cols-[1fr_1fr] md:grid-cols-[1.2fr_1fr_1fr_1fr_0.9fr] items-baseline border-b border-[var(--color-line)] last:border-b-0 hover:bg-[var(--color-panel2)] transition-colors"
            >
              <div className="px-4 py-4">
                <span className="num text-xl font-bold text-[var(--color-cream)]">{s.symbol}</span>
                <span className="ml-2 text-xs text-[var(--color-faded)] hidden sm:inline">{s.name}</span>
                {isNvda && (
                  <span className="ml-2 text-[9px] font-bold tracking-[0.18em] bg-[var(--color-amber)] text-black px-1.5 py-0.5 align-middle">
                    GUARDED POOL
                  </span>
                )}
              </div>
              <div className="px-4 py-4 num text-lg hidden md:block text-[var(--color-cream)]">
                {isNvda ? (nvdaMarket ? `$${fmtUsd(nvdaMarket)}` : "…") : <span className="text-[var(--color-faded)] text-sm">RFQ / AMM</span>}
              </div>
              <div className="px-4 py-4 num text-lg text-[var(--color-amber)]">
                {fair ? `$${fmtUsd(fair)}` : isLoading ? "…" : "—"}
              </div>
              <div className="px-4 py-4 num text-lg hidden md:block">
                {prem === null ? (
                  <span className="text-[var(--color-faded)] text-sm">—</span>
                ) : (
                  <span className={prem > 300 ? "text-[var(--color-bad)] font-bold" : prem > 150 ? "text-[var(--color-amber)]" : "text-[var(--color-good)]"}>
                    {prem >= 0 ? "+" : ""}
                    {(prem / 100).toFixed(2)}%
                  </span>
                )}
              </div>
              <div className="px-4 py-4 num text-xs text-right text-[var(--color-faded)]">
                {updatedAt ? ageLabel(updatedAt) : "…"}
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-faded)] max-w-3xl">
        Fair = Chainlink total-return feed (share price × ERC-8056 multiplier, read onchain). Market = live Uniswap v3
        NVDA/USDG. When the two disagree, somebody is about to overpay.{" "}
        <a className="underline decoration-[var(--color-amber-dim)] underline-offset-2 hover:text-[var(--color-amber)]" href={`${EXPLORER}/address/${NVDA_V3_POOL}`} target="_blank" rel="noreferrer">
          Verify the market pool ↗
        </a>
      </p>
    </section>
  );
}
