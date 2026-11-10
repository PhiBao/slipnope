#!/usr/bin/env node
/**
 * SlipNope band keeper.
 *
 * Reads realized volatility from Cambrian's hourly market history for a
 * tokenized stock, maps it to a guard band inside the registry's hard bounds,
 * and pushes it onchain. The keeper can only move the band — it cannot disable
 * the guard, change a price, or touch funds.
 *
 * Usage:
 *   RPC_URL=... KEEPER_KEY=0x... REGISTRY=0x... CAMBRIAN_API_KEY=... node scripts/keeper.mjs
 *   add --dry-run to print the target band without sending a transaction.
 */
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const CAMBRIAN = "https://api.cambrian.org/evm";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 8453);
const TOKEN = process.env.TOKEN ?? "0xb20000000000000000000078ee7ce2fE4908108C"; // NVDAc
const REGISTRY = process.env.REGISTRY;
const RPC_URL = process.env.RPC_URL ?? (CHAIN_ID === 8453 ? "https://base-rpc.publicnode.com" : "https://sepolia.base.org");
const KEY = process.env.KEEPER_KEY;
const DRY = process.argv.includes("--dry-run");

/** Volatility -> band. 1h stdev in bps, scaled, then clamped to the registry bounds. */
const K = Number(process.env.BAND_K ?? 2.5);
const MIN_BPS = 100;
const MAX_BPS = 800;

const abi = parseAbi([
  "function currentBandBps() view returns (uint24)",
  "function setBand(uint24 bps, string reason)",
]);

async function hourlyPrices(token, limit = 168) {
  const url = `${CAMBRIAN}/price-hour?chain_id=8453&token_address=${token}&limit=${limit}`;
  const res = await fetch(url, { headers: { "X-API-Key": process.env.CAMBRIAN_API_KEY ?? "" } });
  if (!res.ok) throw new Error(`cambrian ${res.status}`);
  const [table] = await res.json();
  const hourCol = table.columns.findIndex((c) => c.name === "blockHour");
  const pxCol = table.columns.findIndex((c) => c.name === "priceUsd");
  const rows = table.data
    .map((r) => ({ t: Date.parse(r[hourCol]), p: Number(r[pxCol]) }))
    .filter((r) => Number.isFinite(r.p) && r.p > 0)
    .sort((a, b) => a.t - b.t);
  return rows.map((r) => r.p);
}

/** Standard deviation of hourly log returns, in basis points. */
function realizedVolBps(prices) {
  if (prices.length < 8) return null;
  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 10_000;
}

function targetBand(volBps) {
  const raw = Math.round(volBps * K);
  return Math.min(MAX_BPS, Math.max(MIN_BPS, raw));
}

async function main() {
  if (!REGISTRY) throw new Error("REGISTRY is required");
  const prices = await hourlyPrices(TOKEN);
  const vol = realizedVolBps(prices);
  if (vol === null) throw new Error(`not enough history (${prices.length} points)`);
  const target = targetBand(vol);

  const chain = CHAIN_ID === 8453 ? base : baseSepolia;
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const current = await pub.readContract({ address: REGISTRY, abi, functionName: "currentBandBps" });

  console.log(
    `vol(1h)=${vol.toFixed(1)}bps over ${prices.length}h -> target ${target}bps (current ${current}bps)`,
  );

  if (Math.abs(target - Number(current)) < 10) {
    console.log("within 10bps of current band — no update");
    return;
  }
  if (DRY) {
    console.log(`dry run: would set ${target}bps`);
    return;
  }
  if (!KEY) throw new Error("KEEPER_KEY is required to send");

  const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const hash = await wallet.writeContract({
    address: REGISTRY,
    abi,
    functionName: "setBand",
    args: [target, `vol1h=${vol.toFixed(1)}bps k=${K}`],
  });
  console.log(`setBand(${target}) -> ${hash}`);
}

main().catch((e) => {
  console.error("keeper failed:", e.message);
  process.exitCode = 1;
});
