import { describe, expect, it } from "vitest";
import { SHADOW_PRICE_MISMATCH_ERROR, isShadowPoolSampleable, normalizePairPrices, selectMainPool, shadowCandleBucket } from "./shadow-market.js";

const token = "So11111111111111111111111111111111111111112";
const pairLow = "4Nd1mYz3XvC9eVb6TjK2PqR8sWfH7uG5aL1oN9iM3xQz";
const pairHigh = "9xQeWvG816bUx9EPfEZ1Y6vX3qk3D3tVZC1L4mN7pRsA";

describe("shadow market normalization", () => {
  it("selects the highest-liquidity market containing the token", () => {
    const result = selectMainPool({ data: { items: [
      { address: pairLow, liquidity: 10_000, base: { address: token }, source: "raydium" },
      { address: pairHigh, liquidityUsd: 90_000, baseAddress: token, dex: "meteora" }
    ] } }, token);
    expect(result).toEqual({ pairAddress: pairHigh, dex: "meteora", liquidityUsd: 90_000 });
  });

  it("rejects a market that explicitly belongs to another token", () => {
    expect(selectMainPool({ data: { items: [{ address: pairHigh, liquidity: 90_000, baseAddress: pairLow }] } }, token)).toBeNull();
  });

  it("normalizes keyed and array pair responses", () => {
    const result = normalizePairPrices({ data: {
      [pairLow]: { priceUsd: "0.0000123" },
      items: [{ pairAddress: pairHigh, price: 0.42 }]
    } }, [pairLow, pairHigh]);
    expect(result.get(pairLow)).toBe(0.0000123);
    expect(result.get(pairHigh)).toBe(0.42);
  });

  it("floors samples into five-minute buckets", () => {
    expect(shadowCandleBucket(Date.UTC(2026, 6, 3, 1, 7, 42))).toBe(Date.UTC(2026, 6, 3, 1, 5));
  });

  it("blocks persistent price-direction mismatches without blocking transient errors", () => {
    expect(isShadowPoolSampleable(SHADOW_PRICE_MISMATCH_ERROR)).toBe(false);
    expect(isShadowPoolSampleable("Birdeye pair overview did not return a positive USD price")).toBe(true);
    expect(isShadowPoolSampleable(null)).toBe(true);
  });
});
