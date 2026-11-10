# Submission pack. Base Stocks Maxxing

Track: **Programmable Stock Markets** (a net-new market primitive: fair-price
execution guard + dislocation index + open verdict API).

Video: `demo/slipnope-demo.mp4` (118s, 1080p, burned subtitles; `demo/slipnope-demo.srt`
for uploads). Poster: `demo/poster.jpg`.

## Required entry steps (Base Season rules)

1. Publish a **public X post with the video demo**, tagging **@buildonbase**.
2. Submit the form linked on base.org/stocksmaxxing with that post's link, the
   track, and the project details.
3. Keep the app live and the pools working until the season closes (Dec 5).

## X post. draft

> Tokenized stocks trade 24/7. The market that prices them doesn't.
>
> SlipNope is a Uniswap v4 hook that refuses the trade when you'd overpay
> Chainlink fair value. Not a warning. the swap reverts.
>
> 3 guarded markets live on Base. 14 swaps already adjudicated. $0 custodied.
>
> slipnope.vercel.app @buildonbase

Attach `demo/slipnope-demo.mp4`. Optional thread:

- 2/ The board prices every Coinbase stock token two ways: Chainlink reference
  (onchain) vs the market quote (Cambrian). Right now MSTRc trades +11.8% over
  fair and TSLAc +6.9%. The guard blocks a buy at that price.
- 3/ A refused swap is a real failed transaction, not a UI state. Receipt:
  0x8c29ed1f…cd2f2. status 0, `PostSwapOutOfBand(628, 300)`.
- 4/ The band isn't a magic number: a keeper derives it from realized
  volatility inside hard bounds. The keeper can only move the band. never a
  price, never a pause.
- 5/ A block isn't a dead end: park the order at your own maximum and it fills
  when the book comes back. Withdraw any time.

## Form answers (copy-paste)

**Project name**
SlipNope

**Describe your project in 1-2 sentences**
A Uniswap v4 hook on Base that checks every tokenized-stock swap against the Chainlink reference price and reverts the trade when the buyer would overpay. Three guarded markets are live: NVDAc, AAPLc and TSLAc.

**Current stage**
Live product

**Does your project have a token?**
No

**Entry type**
Build New

**Intended Base track**
Programmable Stock Markets

**Launch partners you want to consider working with**
None

**What support is most valuable for you?**
Liquidity in the guarded pools, and an introduction to a market maker willing to quote inside the band. The contracts and the app are done. The pools hold about twenty-five dollars each, which is enough to prove the guard but too thin for a normal-sized trade.

**Product or demo URL**
https://slipnope.vercel.app

**Why should we select you to be a part of Stocks Maxxing?**
Tokenized stocks on Base trade around the clock against a reference price that stops updating when the market closes. Every wallet still lets you buy. SlipNope moves the fair-price check into the pool itself: a v4 hook reads the Chainlink feed during the swap and reverts the trade if the price has moved past the band. The refusal is a real failed transaction on Base, and any frontend or bot that routes through the pool inherits it.

Three markets are live. The AAPLc and TSLAc pools were initialised at the reference price to the wei, and fifteen swaps from four different wallets have settled through the guard. We also publish a board that prices ten Coinbase stock tokens two ways, Chainlink against the market, so the overpayment is visible before anyone trades. A public endpoint reports the hook's own verdict for any of those tokens.

The limitation is liquidity, not code. A trade above roughly thirty cents can be refused by the post-swap check because the pool is thin. That is the guard doing its job, and it is why support with depth matters more to us than another feature. A volatility-adaptive band and a resting-order queue already exist; the queue is live on mainnet, the adaptive band is proven on Sepolia.

Base is the only chain where this can be built today, because it is the only place with Coinbase stock tokens, per-asset Chainlink equity feeds and Uniswap v4 in one network. With the season we would deepen the NVDAc pool, move the adaptive band to mainnet, and put the guard in front of wallets that route stock-token orders.

## Verification links

| What | Where |
|---|---|
| App | https://slipnope.vercel.app |
| Source (Sourcify, exact match) | https://sourcify.dev/#/lookup/0xee7344d34b3ec4f2ad24a668bc0d84e55de640c0 |
| Hook (v2, mainnet) | https://basescan.org/address/0xee7344d34b3ec4f2ad24a668bc0d84e55de640c0 |
| Router | https://basescan.org/address/0x1FBd69cf077E3eCcB9C3D4d85A87304611501ad7 |
| FairLimit | https://basescan.org/address/0xB44b89a1aeFfbBD3967F86bE1864734255836F79 |
| Blocked swap (status 0) | https://basescan.org/tx/0x8c29ed1f57f08e10ee2fb87506a2617c731a187bf905eef8558294442e2cd2f2 |
| Guarded swap | https://basescan.org/tx/0x53955f5fce1a2d4faac25fb994169316351ed31de7530d9a1313bdb5a2226a49 |
| Dislocation tape | https://slipnope-api.fly.dev/tape |
| Verdict API | https://slipnope-api.fly.dev/guard/nvdac |
| Proof counters | https://slipnope-api.fly.dev/proof |

## 60-second judge path

1. Open the app. Read the dislocation tape: market vs Chainlink, with a `BLOCK` badge where a buy would overpay.
2. Open `https://slipnope-api.fly.dev/guard/tslac`. The verdict is read from the hook.
3. Click the blocked transaction. BaseScan shows status 0 and the reason.
4. Scroll to **Fair-Limit**, park 1 USDC at your own cap, withdraw it.
5. Check `/proof`. The counters come from chain logs.
