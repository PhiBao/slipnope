/**
 * Swap price limits derived from a Chainlink fair price.
 *
 * Kept free of React and viem imports so the band math can be tested on its own.
 */

/** Integer sqrt for bigint. */
export function isqrt(n: bigint): bigint {
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
 * price), so a swap can move at most `bandBps` in price before hitting the
 * limit. This keeps the pool from being pushed past the hook's band by one
 * oversized trade.
 *
 * The band is a price band, but the router takes a sqrt-price limit. A price
 * move of 1 + b is a sqrt-price move of sqrt(1 + b), not 1 + b. Applying the
 * band directly to sqrtPrice (the old code) let a buy move 1/0.97² - 1 = 6.28%
 * in price while the hook only allows 3%, so hitting the router limit was
 * guaranteed to revert in afterSwap. These bounds use sqrt(1 ± band), which
 * places the limit exactly at the hook's boundary.
 */
export function fairSqrtLimits(fairPriceE18: bigint, bandBps = 300): { buy: bigint; sell: bigint } {
  // pool price raw ratio = 10^20 * 2^96 / fairE18  (USDC 6dp, stock 8dp)
  const Q96 = 1n << 96n;
  const ratioX96 = (10n ** 20n * Q96) / fairPriceE18;
  const sqrtP = isqrt(ratioX96 * Q96);

  const band = BigInt(Math.max(1, Math.min(9_900, Math.round(bandBps))));
  const SCALE = 1_000_000_000n;
  // sqrt(1 + band/10_000) and sqrt(1 - band/10_000), scaled by 1e9.
  const sqrtUp = isqrt((10_000n + band) * 10n ** 14n);
  const sqrtDown = isqrt((10_000n - band) * 10n ** 14n);

  return {
    // Buying stock pushes its USD price up: cap it at fair * (1 + band).
    buy: (sqrtP * SCALE) / sqrtUp,
    // Selling stock pushes its USD price down: cap it at fair * (1 - band).
    sell: (sqrtP * SCALE) / sqrtDown,
  };
}
