import { describe, expect, it } from "vitest";
import { calculateRsi } from "./indicators.js";

describe("calculateRsi", () => {
  it("returns 100 for uninterrupted gains", () => {
    const rsi = calculateRsi([1, 2, 3, 4, 5, 6, 7, 8], 7);
    expect(rsi[7]).toBe(100);
  });

  it("uses 50 for a flat market", () => {
    const rsi = calculateRsi(Array(8).fill(1), 7);
    expect(rsi[7]).toBe(50);
  });

  it("does not lower Wilder RSI merely because later candles are flat", () => {
    const rsi = calculateRsi([1, 2, 1, 2, 2, 2], 3);
    expect(rsi[4]).toBeCloseTo(rsi[3]!, 10);
    expect(rsi[5]).toBeCloseTo(rsi[3]!, 10);
  });

  it("preserves genuine moves smaller than half a percent", () => {
    const rsi = calculateRsi([1, 1.001, 1.002, 1.003, 1.004, 1.005, 1.006, 1.007], 7);
    expect(rsi[7]).toBe(100);
  });

  it("matches the canonical Wilder RSI example", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    const rsi = calculateRsi(closes, 14);

    expect(rsi[14]).toBeCloseTo(70.464, 3);
  });
});
