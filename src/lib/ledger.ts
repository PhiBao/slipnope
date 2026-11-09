import { API_URL } from "./contracts";

export interface LedgerEntry {
  id: string;
  ts: number;
  wallet: string;
  symbol: string;
  side: "buy" | "sell";
  amountUsd: number;
  poolPrice: number;
  fairPrice: number;
  adverseBps: number;
  bandBps: number;
  decision: "OK" | "WARN" | "BLOCK";
  savedUsd: number;
  txHash?: string;
}

const KEY = "slipnope-ledger-v1";

export function loadLedger(): LedgerEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordEntry(e: Omit<LedgerEntry, "id" | "ts">): LedgerEntry {
  const entry: LedgerEntry = { ...e, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now() };
  try {
    const all = loadLedger();
    all.unshift(entry);
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 200)));
  } catch {
    /* storage unavailable */
  }
  if (API_URL) {
    fetch(`${API_URL}/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }).catch(() => undefined);
  }
  return entry;
}

/** Estimated dollars saved by a block: adverse share of the attempted notional. */
export function savedEstimate(amountUsd: number, adverseBps: number): number {
  if (adverseBps <= 0 || amountUsd <= 0) return 0;
  return (amountUsd * adverseBps) / (10000 + adverseBps);
}
