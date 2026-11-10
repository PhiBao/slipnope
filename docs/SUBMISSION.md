# Submission pack — Base Stocks Maxxing

Track: **Programmable Stock Markets** (a net-new market primitive: fair-price
execution guard + dislocation index + open verdict API).

Video: `demo/slipnope-demo.mp4` (118s, 1080p, burned subtitles; `demo/slipnope-demo.srt`
for uploads). Poster: `demo/poster.jpg`.

## Required entry steps (Base Season rules)

1. Publish a **public X post with the video demo**, tagging **@buildonbase**.
2. Submit the form linked on base.org/stocksmaxxing with that post's link, the
   track, and the project details.
3. Keep the app live and the pools working until the season closes (Dec 5).

## X post — draft

> Tokenized stocks trade 24/7. The market that prices them doesn't.
>
> SlipNope is a Uniswap v4 hook that refuses the trade when you'd overpay
> Chainlink fair value. Not a warning — the swap reverts.
>
> 3 guarded markets live on Base. 14 swaps already adjudicated. $0 custodied.
>
> slipnope.vercel.app @buildonbase

Attach `demo/slipnope-demo.mp4`. Optional thread:

- 2/ The board prices every Coinbase stock token two ways: Chainlink reference
  (onchain) vs the market quote (Cambrian). Right now MSTRc trades +11.8% over
  fair and TSLAc +6.9%. The guard blocks a buy at that price.
- 3/ A refused swap is a real failed transaction, not a UI state. Receipt:
  0x8c29ed1f…cd2f2 — status 0, `PostSwapOutOfBand(628, 300)`.
- 4/ The band isn't a magic number: a keeper derives it from realized
  volatility inside hard bounds. The keeper can only move the band — never a
  price, never a pause.
- 5/ A block isn't a dead end: park the order at your own maximum and it fills
  when the book comes back. Withdraw any time.

## Form answers (short form)

**What it does.**
A fair-price execution guard for tokenized stocks on Base. A Uniswap v4 hook
reads the Chainlink reference price inside `beforeSwap` and refuses any trade
that would overpay beyond a band; `afterSwap` refuses a trade that would leave
the book dislocated. Three markets live (NVDAc, AAPLc, TSLAc), a market-wide
dislocation board, a public verdict API, and a resting-order queue so a refusal
isn't a dead end.

**Built on Base.**
Uniswap v4 PoolManager + hooks on Base mainnet, Coinbase tokenized stocks
(B20), Chainlink tokenized-equity feeds, Relay for acquiring test inventory,
Cambrian for market evidence, TypeSafe for an advisory layer. Contracts
verified on BaseScan; the app reads the chain directly.

**What is real.**
- 3 guarded pools, seeded; AAPLc and TSLAc initialised at fair to the wei
- A real failed transaction proving the block (status 0)
- 14 settled guarded swaps from 4 wallets, counted from `GuardAllowed` logs
- 24 tests across 4 suites, including a mainnet-fork suite
- FairLimit queue deployed and used on mainnet

**What is not.**
No third-party audit yet. Mainnet pools are thin (~$25 each), so trades above
roughly $0.30 can be refused by the post-swap bound — documented rather than
hidden. The adaptive-band hook and keeper are proven on Sepolia; mainnet still
runs the fixed-band version.

## Verification links

| What | Where |
|---|---|
| App | https://slipnope.vercel.app |
| Hook (v2, mainnet) | https://basescan.org/address/0xee7344d34b3ec4f2ad24a668bc0d84e55de640c0 |
| Router | https://basescan.org/address/0x1FBd69cf077E3eCcB9C3D4d85A87304611501ad7 |
| FairLimit | https://basescan.org/address/0xB44b89a1aeFfbBD3967F86bE1864734255836F79 |
| Blocked swap (status 0) | https://basescan.org/tx/0x8c29ed1f57f08e10ee2fb87506a2617c731a187bf905eef8558294442e2cd2f2 |
| Guarded swap | https://basescan.org/tx/0x53955f5fce1a2d4faac25fb994169316351ed31de7530d9a1313bdb5a2226a49 |
| Dislocation tape | https://slipnope-api.fly.dev/tape |
| Verdict API | https://slipnope-api.fly.dev/guard/nvdac |
| Proof counters | https://slipnope-api.fly.dev/proof |

## 60-second judge path

1. Open the app. Read the **dislocation tape** — market vs Chainlink, with a
   `BLOCK` badge where a buy would overpay.
2. Open `https://slipnope-api.fly.dev/guard/tslac` — the verdict is read from
   the hook, not computed in the browser.
3. Click the blocked transaction — BaseScan shows status 0 and the reason.
4. Scroll to **Fair-Limit**, park 1 USDC at your own cap, withdraw it.
5. Check `/proof` — the counters come from chain logs, not our database.
