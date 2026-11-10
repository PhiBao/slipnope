import assert from "node:assert/strict";
import { fairSqrtLimits } from "../src/lib/bandMath.ts";

// Fair price at the block of the reverted AAPLc swap
// 0xb66498d0c5159449ab04063b4c837cbae9603eec49babd9b3bb9c985a7190690.
const fair = 348_521_000_000_000_000_000n;

const { buy, sell } = fairSqrtLimits(fair);

// Replaying the swap with these limits succeeds; the old limits ended at
// PostSwapOutOfBand(628, 300, 370.4123..., 348.521...).
assert.equal(buy, 41_816_385_986_984_526_600_590_775_120n);
assert.equal(sell, 43_090_272_540_335_543_464_474_754_486n);

// A wider band has to admit a wider move in both directions.
const tight = fairSqrtLimits(fair, 100);
assert.ok(tight.buy > buy, "wider buy band should lower the sqrt limit");
assert.ok(tight.sell < sell, "wider sell band should raise the sqrt limit");

console.log("band math ok", { buy, sell });
