import { describe, expect, it } from "vitest";
import { normalizeMarketDataBatch, shouldRefreshOhlcv } from "./market-data.js";

const first = "So11111111111111111111111111111111111111112";
const second = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("Birdeye market data helpers", () => {
  it("normalizes address-keyed multiple-token responses", () => {
    const normalized = normalizeMarketDataBatch({
      [first]: { price: 1, fdv: 100, liquidity: 50 },
      [second]: { price: 2, fdv: 200, liquidity: 75 }
    }, [first, second]);

    expect(normalized.get(first)?.price).toBe(1);
    expect(normalized.get(second)?.liquidity).toBe(75);
  });

  it("normalizes nested array responses and ignores unexpected tokens", () => {
    const normalized = normalizeMarketDataBatch({ items: [
      { address: first, price: 1, fdv: 100, liquidity: 50 },
      { address: "unexpected", price: 9, fdv: 9, liquidity: 9 }
    ] }, [first]);

    expect([...normalized.keys()]).toEqual([first]);
  });

  it("requests OHLCV at most once for the latest closed five-minute bucket", () => {
    const twelveMinutes = 12 * 60_000;
    expect(shouldRefreshOhlcv(null, twelveMinutes)).toBe(true);
    expect(shouldRefreshOhlcv(new Date(0), twelveMinutes)).toBe(true);
    expect(shouldRefreshOhlcv(new Date(5 * 60_000), twelveMinutes)).toBe(false);
  });
});
