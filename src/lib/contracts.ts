import type { Address } from "viem";

// Robinhood Chain mainnet (4663) — verified onchain 2026-10-29/30.
export const CHAIN_ID = 4663;
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
export const WIF = "0x5173b8eA6923c2d40267890D45C46a3480954773" as Address;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

// Deployed by contracts/script/DeployCore.s.sol — set via env after deployment.
export const ROBINHOOK = (process.env.NEXT_PUBLIC_ROBINHOOK ?? "") as Address | "";
export const REGISTRY = (process.env.NEXT_PUBLIC_REGISTRY ?? "") as Address | "";
export const ROUTER = (process.env.NEXT_PUBLIC_ROUTER ?? "") as Address | "";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface StockInfo {
  symbol: string;
  name: string;
  token: Address;
  feed: Address;
}

export const STOCKS: StockInfo[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  },
  {
    symbol: "AAPL",
    name: "Apple",
    token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    feed: "0x4A1166a659A55625345e9515b32adECea5547C38",
  },
];

// Live Uniswap v3 NVDA/USDG pool (token0=USDG 6dp, token1=NVDA 18dp) — market reference.
export const NVDA_V3_POOL = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3" as Address;

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

export const v3PoolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint32" },
      { name: "unlocked", type: "bool" },
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

export const registryAbi = [
  { type: "function", name: "stake", stateMutability: "nonpayable", inputs: [{ name: "a", type: "uint256" }], outputs: [] },
  { type: "function", name: "unstake", stateMutability: "nonpayable", inputs: [{ name: "a", type: "uint256" }], outputs: [] },
  { type: "function", name: "setBand", stateMutability: "nonpayable", inputs: [{ name: "bps", type: "uint24" }], outputs: [] },
  { type: "function", name: "staked", stateMutability: "view", inputs: [{ name: "u", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bandBps", stateMutability: "view", inputs: [{ name: "u", type: "address" }], outputs: [{ type: "uint24" }] },
  { type: "function", name: "getBandBps", stateMutability: "view", inputs: [{ name: "u", type: "address" }], outputs: [{ type: "uint24" }] },
  { type: "function", name: "MIN_STAKE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export type PoolKeyTuple = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** NVDA/USDG guarded pool key (USDG 0x5fc5.. sorts before NVDA 0xd060..). */
export function nvdaPoolKey(): PoolKeyTuple | null {
  if (!ROBINHOOK) return null;
  return {
    currency0: USDG,
    currency1: STOCKS[0].token,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 60,
    hooks: ROBINHOOK as Address,
  };
}

/** Human USD price of NVDA from v3 slot0 sqrtPrice (token0=USDG 6dp, token1=NVDA 18dp). */
export function v3NvdaPrice(sqrtPriceX96: bigint): number {
  // rawRatio = token1/token0 raw = (sqrt/2^96)^2 ; USD per NVDA = 10^(18-6) / rawRatio
  const q96 = 2n ** 96n;
  const ratioNum = sqrtPriceX96 * sqrtPriceX96; // rawRatio * 2^192
  // price = 10^12 * 2^192 / ratioNum  -> compute with float via scaled bigint
  const scaled = (10n ** 12n * (q96 * q96) * 10n ** 8n) / ratioNum; // price * 1e8
  return Number(scaled) / 1e8;
}

export function fmtUsd(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
