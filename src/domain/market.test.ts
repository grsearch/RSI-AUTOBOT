import { describe, expect, it } from "vitest";
import { isRsiFresh, MARKET_CANDLE_INTERVAL_MS } from "./market.js";

describe("market RSI freshness", () => {
  it("accepts a recent closed five-minute candle", () => {
    const candleAt = new Date("2026-07-02T04:30:00.000Z");
    const marketAt = new Date(candleAt.getTime() + MARKET_CANDLE_INTERVAL_MS + 30_000);

    expect(isRsiFresh(candleAt, marketAt)).toBe(true);
  });

  it("rejects missing, future, and stale RSI candles", () => {
    const candleAt = new Date("2026-07-02T04:30:00.000Z");

    expect(isRsiFresh(null, new Date())).toBe(false);
    expect(isRsiFresh(candleAt, new Date(candleAt.getTime() - 1))).toBe(false);
    expect(isRsiFresh(candleAt, new Date(candleAt.getTime() + MARKET_CANDLE_INTERVAL_MS * 2 + 1))).toBe(false);
  });
});
