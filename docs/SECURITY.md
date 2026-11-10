# Security notes — SlipNope

Scope: the SlipNope hook, the guarded router, the band registry, the FairLimit
queue, and the offchain services. Written as an adversarial review of what can
go wrong, not a checklist.

## Trust boundaries

| Component | Trusts | Can it move funds? | Can it change the verdict? |
|---|---|---|---|
| `SlipNope` / `SlipNopeV3` hook | Chainlink feed at its configured address | No | No — immutable per pool after `configurePool` |
| `GuardedSwapRouter` | PoolManager | No — sweeps residuals to the caller | No |
| `BandRegistry` | owner for keeper rotation | No | **Band only**, bounded 100–800 bps |
| `FairLimit` | hook's `previewGuard`, router | Yes — escrowed order funds only | No |
| Rust API | Base RPC, Cambrian, TypeSafe | No keys, no signing | No |
| Keeper script | its own key | No | Band only, inside bounds |

The guard never reads an offchain service. Cambrian and TypeSafe are evidence and
annotation; if both went offline the hook would behave identically.

## Hook

- **Fail-closed oracle handling.** Non-positive answer, incomplete round
  (`answeredInRound < roundId`), or `updatedAt` older than the configured
  `maxStale` reverts. Equity feeds hold their last value overnight by design, so
  `maxStale` is 4 days — long enough for a weekend, short enough to catch a dead
  feed.
- **Direction-aware pre-swap check.** Only adverse deviation blocks: buying
  above fair, selling below fair. A favourable dislocation is never refused —
  that would punish the person fixing the price.
- **Symmetric post-swap bound.** A single swap may not leave the book more than
  `band` from fair in *either* direction. Without it, one oversized buy could
  crash a thin book far below fair; that is the same failure as overpaying, just
  aimed at LPs instead of buyers. Reverting in `afterSwap` unwinds the swap.
- **Immutable pool configuration.** `configurePool` is one-time per pool id and
  owner-only. There is no setter for feed, stock, decimals, or staleness. An
  attacker who compromises the owner key cannot weaken an existing pool; they
  could only configure a *new* pool id, which nobody is forced to use.
- **No delta-taking.** The hook never returns a non-zero `BeforeSwapDelta` and
  holds no tokens, so there is no hook balance to drain.
- **Reentrancy.** The hook only reads state (`getSlot0`, the feed) and returns a
  fee override; PoolManager's lock prevents reentrant swaps during the call.

## BandRegistry / V3

- Keeper can only call `setBand` inside `[100, 800]` bps. It cannot pause the
  hook, change a feed, or withdraw anything — there is nothing to withdraw.
- `SlipNopeV3._bandFor` wraps the registry read in `try/catch`: a reverting or
  misconfigured registry falls back to the immutable 300 bps default. A broken
  keeper can make the guard looser only up to the hard bounds, never absent.
- Owner can rotate the keeper. That is the only privileged action, and it cannot
  affect a swap's outcome directly.

## FairLimit

- **Custody is narrow and explicit.** Only escrowed order amounts sit in the
  contract; no admin withdrawal path exists.
- `cancel` is owner-only and always available. `refundExpired` is callable by
  anyone but pays only the order owner, so a griefer can at worst return someone
  their money.
- **Fill asks the hook, not a local calculation.** If the reference is stale,
  `previewGuard` reverts and the order stays parked. If the order's own premium
  cap is tighter than the band, the stricter one wins.
- An order can never be looser than 800 bps — otherwise "fair" would be
  meaningless.
- `forceApprove` is reset to zero after each fill.
- **Known limitation:** fills are pull-based, so an order only executes when
  someone calls `fill`. There is no gas subsidy and no guarantee of execution.

## Offchain services

- No private key in the API. The keeper script is the only signer and reads its
  key from the environment; it should run with a dedicated low-value key.
- Ledger entries are user-supplied. They are displayed as user records, never
  as protocol truth; the authoritative counters come from `eth_getLogs`.
- Cambrian quota is bounded by a 10-minute snapshot plus TTLs; a price outage
  degrades the tape (fallback to the last hourly close) rather than blocking
  anything.
- TypeSafe advisory output is displayed with its model name and confidence and
  is marked advisory. A failure sets `advisoryDegraded: true` and renders the
  deterministic verdict alone.

## Economic / market risks

- **Thin pools.** A small pool can be walked. The router caps a single trade at
  the hook's band with a sqrt-price limit derived from the Chainlink fair price,
  so an oversized trade fills up to the boundary and the unspent input is swept
  back to the caller. The hook's post-swap bound remains the hard stop for any
  call that bypasses that limit. LPs carry normal impermanent-loss risk.
- **Feed disagreement.** If Chainlink and the market genuinely disagree, the
  guard blocks the side that would lose money. That is the product, but it does
  mean a pool can sit one-sided until fair moves or new liquidity arrives.
- **B20 issuer controls.** Tokenized stocks have issuer-level pause and policy
  lists. A blocked address will fail transfers regardless of the guard; this is
  outside the hook's control and is disclosed in the UI.

## Operational

- Deployer key is a throwaway hot wallet, held only locally, never committed.
  Mainnet ETH on it is kept to gas money.
- Pools and contracts are verified on BaseScan; the frontend links to them.
- The Fly API scales to zero and restores its tape snapshot from disk so a cold
  start never renders an empty board.

## Not covered / next

- No third-party audit. The contracts are small and tested, but a review by an
  external auditor is required before real user funds beyond escrowed orders
  are at stake.
- No formal verification of the price math beyond unit and fork tests.
- Keeper liveness is best-effort; the band simply stays where it was if it stops.
