import test from "node:test";
import assert from "node:assert/strict";
import { formatMinutes, calculateCoins } from "../js/format.js";

test("formatMinutes converts minute values to friendly text", () => {
  assert.equal(formatMinutes(0), "< 1 min");
  assert.equal(formatMinutes(0.4), "< 1 min");
  assert.equal(formatMinutes(14), "14 min");
  assert.equal(formatMinutes(60), "1 hr");
  assert.equal(formatMinutes(75), "1 hr 15 min");
});

test("calculateCoins applies minimum coins based on class cutoff", () => {
  // Default 30 min cutoff -> 3 coins minimum
  const r1 = calculateCoins(5, 30);
  assert.equal(r1.coins, 3);
  assert.equal(r1.label, "3 coins");
  assert.equal(r1.allowed, true);

  const r2 = calculateCoins(28, 30);
  assert.equal(r2.coins, 3);
  assert.equal(r2.allowed, true);

  // Over limit at 30 min cutoff
  const r3 = calculateCoins(35, 30);
  assert.equal(r3.coins, 4);
  assert.equal(r3.allowed, false);

  // 60 min cutoff -> 6 coins minimum
  const r4 = calculateCoins(20, 60);
  assert.equal(r4.coins, 6);
  assert.equal(r4.allowed, true);

  const r5 = calculateCoins(58, 60);
  assert.equal(r5.coins, 6);
  assert.equal(r5.allowed, true);

  const r6 = calculateCoins(65, 60);
  assert.equal(r6.coins, 7);
  assert.equal(r6.allowed, false);
});
