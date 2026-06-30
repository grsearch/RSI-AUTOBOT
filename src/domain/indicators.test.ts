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
});
