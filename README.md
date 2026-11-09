# SlipNope — overpay? nope.

**Live app:** https://slipnope.vercel.app · **Chain:** Base (mainnet 8453 · Sepolia verification 84532) · **Season:** Base Stocks Maxxing — Programmable Stock Markets

> Tokenized stocks trade 24/7. The stock market doesn't. In the gap, thin books drift far from fair value — and every wallet lets you click buy anyway. SlipNope is a Uniswap v4 hook that stands *inside* your swap: it reads the Chainlink fair price mid-transaction and **reverts the trade if you would overpay**. Dashboards warn. Pools enforce.

---

## 1. Product

### What it is

SlipNope ports the FairBuy execution-safety thesis ("never overpay for tokenized stocks") to the first place it can live **in the market itself**: a Uniswap v4 `beforeSwap` hook on Base, where every Coinbase tokenized stock ships with a Chainlink fair-price feed a hook can read atomically.

For every swap in a guarded pool the hook computes the direction-aware adverse deviation between pool price and Chainlink fair value:

| Tier | Condition | Result |
|---|---|---|
| **OK** | adverse ≤ band/2 | swap executes, 0.05% LP fee |
| **WARN** | adverse ≤ band | swap executes, fee scales with deviation (cap 1%) |
| **BLOCK** | adverse > band | **swap reverts** (`OverpayBlocked`) — it cannot execute |
| **FAIL-CLOSED** | stale / invalid reference | **swap reverts** — the guard never guesses |

Universal band: ±3.00%.

### Who it is for

Base traders buying tokenized stocks (NVDAc first) in thin 24/7 pools while the underlying market sleeps.

### The problem (evidence)

- Coinbase's Base docs describe the gap structurally: Chainlink equity feeds run 24/5 and freeze off-hours by design; "never settle or liquidate against a frozen feed."
- DEX pools on Base trade into those frozen refs — the last session's price stays in the feed while the pool keeps moving. Somebody is about to overpay, on every thin pool, every night.
- Existing products display prices or execute blindly. Nobody enforces at execution time — because on most chains they can't. On Base + Uniswap v4, a hook can.

### Why now

Coinbase tokenized stocks (B20, 298 listed) + Chainlink 24/5 total-return feeds went live on Base (Aug 2026); Uniswap v4 is deployed on Base mainnet; 0x feed proxies are live on mainnet today. SlipNope was fork-tested against live Base state on Nov 9 2026.

### Innovation

Fair-price protection used to require trusting an app to warn you before you signed elsewhere. SlipNope moves the check **inside execution**:

- `beforeSwap` reads Chainlink, computes adverse deviation from the live pool sqrt price, and the swap either executes in-band at a fair fee, pays a deviation-scaled WARN fee, or **cannot execute at all**.
- Staleness follows equity reality: stock feeds are 24/5 (24-hour heartbeat, freeze off-hours and during corporate actions). A frozen/stale feed fails closed — exactly the behavior Base's own integration guidance demands.
- One-time pool configuration: after `configurePool`, the feed for a pool can never be changed. There is no admin path that can weaken a live guarded pool.

## 2. User experience

1. **Board (no wallet needed):** three numbers per stock — market (guarded pool), fair (Chainlink), premium — live.
2. **Activation moment:** first swap attempted on a dislocated pool → **BLOCKED stamp + "you just saved ~$X"** in the Overpay Ledger.
3. **Primary workflow:** connect wallet (Base) → buy/sell NVDAc in the guarded pool → hook verdict (OK/WARN/BLOCK) renders *before* you sign, from the same `previewGuard` math the hook enforces → sign → BaseScan receipt.
4. **Retention loop:** Overpay Ledger records fills *and* blocks with regime context ("you overpay off-hours") → autopsy → tighter discipline by knowing your history → shareable saved-$ receipts.

## 3. Architecture

```
contracts/ (Foundry, Solidity — EVM hooks must be Solidity)
  src/SlipNope.sol              IHooks.beforeSwap guard (OK/WARN/BLOCK + fail-closed)
  src/GuardedSwapRouter.sol     exact-input swaps + liquidity, hookData = trader
  src/mocks/                    test-only mock B20 (8dp) + Chainlink-shaped feed
  test/SlipNope.t.sol           7 unit tests vs local PoolManager
  test/fork/SlipNopeFork.t.sol  3 tests vs LIVE Base mainnet state (chain 8453)
  script/DeployCore.s.sol       CREATE2-mined hook deploy (beforeSwap flag 0x80)
  script/CreateGuardedPool.s.sol  configure + initialise + seed a pool

src/ (Next.js 15 + wagmi/viem, TypeScript)
  app/                          board + guard card + band explainer + ledger
  lib/contracts.ts              verified Base addresses + ABIs
  lib/ledger.ts                 Overpay Ledger (localStorage + API mirror)

services/api/ (Rust, Axum)
  GET /board                    independent Chainlink read via raw eth_call
  POST /ledger, GET /ledger/:wallet, GET /stats, GET /health
  Ledger persists as append-only JSONL audit file.
  Live at https://slipnope-api.fly.dev
```

**Backend language note:** offchain services are Rust. Onchain hook/router are Solidity because Uniswap v4 hooks are EVM contracts — the exception is isolated to `contracts/` and justified by the protocol itself.

**Verified mainnet (8453):** PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b` · NVDAc `0xb20000000000000000000078ee7ce2fE4908108C` (8dp) / feed `0x04689a41629776563E6822F76f2e57D148d28513` ($179.49 at fork time) · AAPLc feed `0x787f13dEa48Db0897CbCDD985de77809D837F988` · TSLAc feed `0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4` · USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6dp).

**Production mainnet (8453):** SlipNope `0xe370154e9f41c5c7c9abd62154680fae0449c080` (flags `0x80`) · Router `0x645174D655814839a85Bd80D2F54b35A7160465E` · VanityFactory `0x333bD2996F0098f2Ec5fd56D5E3f70F05C116D85` · guarded NVDAc/USDC pool (tickSpacing 10, Chainlink feed `0x0468…8513`), seeded at fair (pool == fair to the wei), `GuardAllowed` OK-swap verified (tx `0xe6f306e4…7e17`). One mis-initialized tickSpacing-60 pool exists with no liquidity and no funds (superseded by the spacing-10 pool).

**Verified Sepolia (84532, self-deployed stack):** PoolManager `0x7d5C9F16EfE4343b65C8dbbD8733131f240DFDeD` · SlipNope `0xcc1cb596c75aed51ffeb52dca2887b6606128080` (flags `0x80`) · Router `0xC3c3Ae1957e3D679332203f488F21bd3Ea85867f` · MockStock NVDAc-like `0x59A0624569E29c8721AC5365821d0da163d1B38f` (8dp) · Mock USDC `0xBcE84A6C7bEC94BFd5B71Cb6014090b073A94b82` (6dp) · MockFeed `0x94bF2d7Df98f7b6237a45ff9963Ff1783FB6A2d1` ($179.49). Escape verified: full liquidity burn returns 100% of seeded principal to the wei (tx `0xc18b889b…fb6fee`).

## 4. Run it

### Frontend
```bash
pnpm install
pnpm dev            # board is live immediately (Chainlink reads)
pnpm build
```
Copy `.env.example` → `.env.local`, set `NEXT_PUBLIC_SLIPNOPE`/`NEXT_PUBLIC_ROUTER` after mainnet deploy to enable guarded swaps.

### Contracts
```bash
cd contracts
forge build
forge test                                   # 7 unit tests
forge test --match-contract SlipNopeFork --fork-url https://mainnet.base.org -vv   # 3 live-fork tests
```

### Rust API
```bash
cd services/api
cargo run --release  # :8787 — /health /board /ledger /stats
```

## 5. Demo (180 seconds)

| Time | Beat |
|---|---|
| 0:00 | "This NVDAc buy can overpay double digits off-hours — every app will let you click it." |
| 0:20 | Board: market vs Chainlink fair vs premium, live on Base. |
| 0:45 | Guard card: verdict renders from `previewGuard` — OK/WARN/BLOCK with the exact math. |
| 1:15 | **Attempt the bad swap → hook blocks it; "saved ~$X" lands in the Overpay Ledger.** |
| 1:45 | In-band swap executes under guard → BaseScan receipt. |
| 2:15 | Ledger autopsy: blocks cluster off-hours. "Dashboards warn. Pools enforce." |
| 2:40 | Proof panel: hook, router, PoolManager all verifiable on BaseScan. |
| 3:00 | "Trade stocks on Base. Fair is enforced by the pool." |

## 6. Verification — what is real

**Verified live (Nov 9 2026):**

- 7 unit tests pass (OK/WARN/BLOCK tiers, stale fail-closed, frozen-feed fail-closed, router enforcement) — `contracts/test/SlipNope.t.sol`.
- 3 mainnet-fork tests pass against **live Base state**: real Chainlink NVDAc feed reads through the hook ($179.49), pool initialized at fair shows 0 adverse, config is one-time-write — `contracts/test/fork/SlipNopeFork.t.sol`.
- **Sepolia end-to-end deployment verified on BaseScan**: PoolManager, SlipNope hook (flags `0x80`), router, mock 8dp stock + 6dp USDC + $179.49 mock fair, seeded guarded pool. `previewGuard` shows adverse 0 / fee 500 / not blocked at fair. **Guarded swap executed** (GuardAllowed with adverse 0, band 300, fee 500; tx `0xa45d…336e6`). **BLOCK proven on-chain**: mock fair dropped to ~$89.75 → preview shows adverse 9,998 bps blocked → swap reverts with `OverpayBlocked(0x575e24b4)`. Feed restored to $179.49 after.

**Live web:**

- https://slipnope.vercel.app — board reads live Chainlink feeds on Base mainnet every 20s (GuardCard pending until mainnet hook deploy).
- https://slipnope-api.fly.dev — `/health` chainId 8453, `/board` serves NVDAc/AAPLc/TSLAc Chainlink fairs.

**Honest limits:**

- Sepolia uses mock B20 + mock Chainlink (testnet has no B20 precompiles, and foundry's fork EVM can't emulate them — verified via direct RPC reads instead).
- Mainnet guarded pool seeds with the same CREATE2 + scripts; needs a funded mainnet deployer (gas only + a few dollars of USDC/NVDAc to seed).
- Coinbase tokenized stocks are available only outside the US per issuer restrictions.

## 7. Security model

- **No custody:** router settles in the unlock callback and sweeps residuals to the caller in the same tx.
- **No admin weakening:** pool config is one-time-write; there are no per-trader bands to upgrade.
- **Fail-closed oracle handling:** non-positive answer, incomplete round, stale (>4 days for 24/5 equity feeds, freeze-aware) → revert.
- **Direction-aware math:** adverse deviation only (buying above fair / selling below fair); favorable dislocations never blocked.
- **Hook surface:** single permission (`beforeSwap`, address flag `0x80`), no delta-taking, no upgrade keys.
- **Known risks:** thin self-seeded pool can be pushed around — manipulation only ever *causes blocks* (fail-safe direction); B20 policy-blocked addresses will revert swaps (issuer-level compliance, outside the guard's control).

## 8. Hackathon relevance

- **Track:** Programmable Stock Markets — a net-new market primitive (a fair-price execution guard = market infrastructure).
- **Built on / meaningfully integrated with Base:** Uniswap v4 hooks on Base mainnet + Chainlink tokenized-equity feeds + B20 stocks. Existing Solana-era FairBuy logic ported and extended on Base during the season.
- **No token launch:** the product is the guard; a token is optional and we don't need one.
- **Amount of code built during the season:** Base port of the hook (new chain targets, feed set, trillion-step test upgrades), Sepolia v4 core deployment, CREATE2 vanity factory, frontend + API redeploys, fork tests against live Base state.

*FairBuy proved people overpay invisibly. SlipNope makes the market itself stop them.*
