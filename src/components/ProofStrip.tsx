"use client";

import { useQuery } from "@tanstack/react-query";
import { API_URL, EXPLORER } from "@/lib/contracts";

type Proof = {
  hook: string;
  guarded_swaps: number;
  warn_swaps: number;
  scanned_ok: boolean;
  head_block: number;
  recent: { tx: string; block: number; trader: string; adverse_bps: number; warn: boolean }[];
};

export default function ProofStrip() {
  const { data } = useQuery<{ proof: Proof | null; staleSecs?: number }>({
    queryKey: ["proof"],
    queryFn: async () => {
      const res = await fetch(`${API_URL || ""}/proof`);
      if (!res.ok) throw new Error(`proof ${res.status}`);
      return res.json();
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const p = data?.proof;
  const traders = new Set((p?.recent ?? []).map((e) => e.trader.toLowerCase())).size;

  const cells = [
    { label: "Guarded swaps settled", value: p ? p.guarded_swaps.toString() : "—" },
    { label: "Distinct wallets", value: p ? traders.toString() : "—" },
    { label: "Funds custodied", value: "$0" },
    { label: "Guard checks", value: p ? "beforeSwap + afterSwap" : "—" },
  ];

  return (
    <section aria-label="Onchain proof" className="border-y border-[var(--color-line)] py-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="num text-2xl font-bold text-[var(--color-amber)] leading-none">{c.value}</div>
            <div className="mt-1 text-[9.5px] tracking-[0.18em] uppercase text-[var(--color-faded)]">{c.label}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-4 flex-wrap">
        <span className="num text-[10px] text-[var(--color-faded)]">
          counted from <span className="text-[var(--color-cream)]">GuardAllowed</span> logs on{" "}
          <a
            className="underline decoration-[var(--color-amber-dim)] underline-offset-2 hover:text-[var(--color-amber)]"
            href={`${EXPLORER}/address/${p?.hook ?? ""}`}
            target="_blank"
            rel="noreferrer"
          >
            the hook contract ↗
          </a>
        </span>
        {p?.recent?.[0] && (
          <a
            className="num text-[10px] text-[var(--color-amber)] underline underline-offset-2"
            href={`${EXPLORER}/tx/${p.recent[0].tx}`}
            target="_blank"
            rel="noreferrer"
          >
            latest guarded swap · {(p.recent[0].adverse_bps / 100).toFixed(2)}% adverse ↗
          </a>
        )}
      </div>
    </section>
  );
}
