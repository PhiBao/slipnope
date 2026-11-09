import type { Address } from "viem";

// Base mainnet (8453) — verified onchain 2026-11-09.
export const CHAIN_ID = 8453;
export const RPC_URL = "https://mainnet.base.org";
export const EXPLORER = "https://basescan.org";

export const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Address;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
export const WETH = "0x4200000000000000000000000000000000000006" as Address;

// Deployed by contracts/script/DeployCore.s.sol — set via env after deployment.
export const SLIPNOPE = (process.env.NEXT_PUBLIC_SLIPNOPE ?? "") as Address | "";
export const ROUTER = (process.env.NEXT_PUBLIC_ROUTER ?? "") as Address | "";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface StockInfo {
  symbol: string;
  name: string;
  token: Address;
  feed: Address;
}

// Coinbase tokenized stocks (B20) + Chainlink feeds — verified onchain 2026-11-09.
export const STOCKS: StockInfo[] = [
  {
    symbol: "NVDAc",
    name: "NVIDIA",
    token: "0xb20000000000000000000078ee7ce2fE4908108C",
    feed: "0x04689a41629776563E6822F76f2e57D148d28513",
  },
  {
    symbol: "AAPLc",
    name: "Apple",
    token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    feed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  },
  {
    symbol: "TSLAc",
    name: "Tesla",
    token: "0xb2000000000000000000001e800a7f5189430cD0",
    feed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
  },
];

export const DYNAMIC_FEE_FLAG = 8388608; // 0x800000
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

export const feedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export const hookAbi = [
  {
    type: "function",
    name: "previewGuard",
    stateMutability: "view",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "trader", type: "address" },
    ],
    outputs: [
      { name: "adverseBps", type: "uint256" },
      { name: "bandBps", type: "uint24" },
      { name: "fee", type: "uint24" },
      { name: "blocked", type: "bool" },
      { name: "poolPrice", type: "uint256" },
      { name: "fairPrice", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "poolPriceE18",
    stateMutability: "view",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "guards",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "feed", type: "address" },
      { name: "stock", type: "address" },
      { name: "feedDecimals", type: "uint8" },
      { name: "stockDecimals", type: "uint8" },
      { name: "quoteDecimals", type: "uint8" },
      { name: "maxStale", type: "uint256" },
      { name: "configured", type: "bool" },
    ],
  },
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "swapExactInput",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export type PoolKeyTuple = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** NVDAc/USDC guarded pool key (USDC 0x8335.. sorts before NVDAc 0xb200..). */
export function nvdaPoolKey(): PoolKeyTuple | null {
  if (!SLIPNOPE) return null;
  return {
    currency0: USDC,
    currency1: STOCKS[0].token,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 10,
    hooks: SLIPNOPE as Address,
  };
}

/** Integer sqrt for bigint. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * sqrtPriceX96 bounds derived from the Chainlink fair price (not from the pool
 * price), so a swap can move at most ~3% before hitting the limit. This keeps
 * the pool from being pushed to an extreme by one oversized trade — the hook's
 * afterSwap check is the hard guard, this is the router-side bound.
 */
export function fairSqrtLimits(fairPriceE18: bigint): { buy: bigint; sell: bigint } {
  // pool price raw ratio = 10^20 * 2^96 / fairE18  (USDC 6dp, stock 8dp)
  const Q96 = 1n << 96n;
  const ratioX96 = (10n ** 20n * Q96) / fairPriceE18;
  const sqrtP = isqrt(ratioX96 * Q96);
  return { buy: (sqrtP * 97n) / 100n, sell: (sqrtP * 103n) / 100n };
}

export function fmtUsd(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
