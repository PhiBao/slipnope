"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import Board from "@/components/Board";
import GuardCard from "@/components/GuardCard";
import BandCard from "@/components/BandCard";
import LedgerPanel from "@/components/LedgerPanel";
import { loadLedger, type LedgerEntry } from "@/lib/ledger";
import { CHAIN_ID, EXPLORER, POOL_MANAGER, SLIPNOPE, ROUTER, shortAddr } from "@/lib/contracts";

function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    return (
      <button
        onClick={() => connect({ connector: connectors[0] })}
        disabled={isPending}
        className="px-4 py-2 bg-[var(--color-amber)] text-black text-sm font-black uppercase tracking-wide disabled:opacity-40 hover:bg-[#ffc233]"
      >
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }
  if (chainId !== CHAIN_ID) {
    return (
      <button
        onClick={() => switchChain({ chainId: CHAIN_ID })}
        className="px-4 py-2 bg-[var(--color-bad)] text-black text-sm font-black uppercase tracking-wide"
      >
        Switch to Base
      </button>
    );
  }
  return (
    <button
      onClick={() => disconnect()}
      className="num px-4 py-2 border border-[var(--color-line)] text-sm hover:border-[var(--color-amber-dim)]"
      title="Disconnect"
    >
      {shortAddr(address ?? "")} · 8453
    </button>
  );
}

function ProofRow({ label, addr }: { label: string; addr: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[var(--color-faded)]">{label}</span>
      {addr ? (
        <a
          href={`${EXPLORER}/address/${addr}`}
          target="_blank"
          rel="noreferrer"
          className="num text-[var(--color-amber)] underline decoration-[var(--color-amber-dim)] underline-offset-2"
        >
          {shortAddr(addr)} ↗
        </a>
      ) : (
        <span className="num text-[var(--color-faded)]">deployment pending</span>
      )}
    </div>
  );
}

export default function Home() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const refresh = () => setEntries(loadLedger());
  useEffect(refresh, []);

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 pb-20">
      {/* header */}
      <header className="flex items-center justify-between py-5 border-b border-[var(--color-line)]">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/favicon.svg" alt="SlipNope mark" className="w-9 h-9" />
          <div className="leading-none">
            <div className="text-xl font-black tracking-tight">
              SLIP<span className="text-[var(--color-amber)]">NOPE</span>
            </div>
            <div className="num text-[9px] tracking-[0.24em] text-[var(--color-faded)] mt-1">
              UNISWAP V4 FAIR-PRICE GUARD · BASE
            </div>
          </div>
        </div>
        <WalletButton />
      </header>

      {/* hero */}
      <section className="py-10 sm:py-14">
        <h1 className="text-4xl sm:text-6xl font-black leading-[0.95] tracking-tight max-w-3xl">
          Overpay?
          <br />
          <span className="text-[var(--color-amber)]">Nope.</span>
        </h1>
        <p className="mt-5 text-base sm:text-lg text-[var(--color-faded)] leading-relaxed max-w-2xl">
          Tokenized stocks trade 24/7. The stock market doesn&apos;t. In the gap, thin books drift far from fair value —
          and every wallet lets you click buy anyway. SlipNope is a Uniswap v4 hook that reads Chainlink fair value
          inside your swap and <span className="text-[var(--color-cream)]">reverts the trade</span> if you&apos;d
          overpay beyond the band.
        </p>
        <div className="mt-6 flex gap-6 num text-xs text-[var(--color-faded)] flex-wrap">
          <span>
            <span className="text-[var(--color-cream)] font-bold">OK</span> in band · 0.05% fee
          </span>
          <span>
            <span className="text-[var(--color-amber)] font-bold">WARN</span> elevated · fee scales
          </span>
          <span>
            <span className="text-[var(--color-bad)] font-bold">BLOCK</span> beyond band · swap reverts
          </span>
          <span>Frozen feed? Fails closed. Always.</span>
        </div>
      </section>

      <div className="space-y-10">
        <Board />
        <GuardCard onLedgerChange={refresh} />
        <div className="grid lg:grid-cols-2 gap-6 items-stretch">
          <BandCard />
          <LedgerPanel entries={entries} />
        </div>
      </div>

      {/* proof */}
      <section className="mt-14 border border-[var(--color-line)] bg-[var(--color-panel)] p-5 sm:p-6">
        <div className="text-[10px] font-bold tracking-[0.3em] text-[var(--color-faded)] uppercase">
          Verify it yourself
        </div>
        <div className="mt-3 grid sm:grid-cols-2 gap-x-10 text-sm">
          <ProofRow label="SlipNope (v4 hook)" addr={SLIPNOPE} />
          <ProofRow label="GuardedSwapRouter" addr={ROUTER} />
          <ProofRow label="Uniswap v4 PoolManager (Base)" addr={POOL_MANAGER} />
          <ProofRow label="Chainlink NVDAc feed" addr="0x04689a41629776563E6822F76f2e57D148d28513" />
        </div>
        <p className="mt-4 text-xs leading-relaxed text-[var(--color-faded)] max-w-3xl">
          The guard is one-time-configured and immutable: the Chainlink feed for a pool can never be swapped after
          setup, there are no admin keys that can weaken a live pool, and a frozen or stale oracle blocks every swap
          rather than guessing. Coinbase tokenized stocks are available only outside the US per issuer restrictions —
          nothing here is financial advice, and this product is not affiliated with or endorsed by Coinbase, Base,
          Uniswap, or Chainlink.
        </p>
      </section>

      <footer className="mt-10 flex items-center justify-between text-[11px] text-[var(--color-faded)] flex-wrap gap-3">
        <span className="num">SLIPNOPE · BUILT FOR BASE STOCKS MAXXING · PROGRAMMABLE STOCK MARKETS</span>
        <span className="num">DASHBOARDS WARN. POOLS ENFORCE.</span>
      </footer>
    </main>
  );
}
