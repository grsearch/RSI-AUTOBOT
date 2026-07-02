import { describe, expect, it } from "vitest";
import { buildBirdeyeOhlcvUrl, classifyOhlcvProgress, mergeOhlcvHistory, normalizeMarketDataBatch, shouldRefreshOhlcv } from "./market-data.js";

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

  it("uses the working v2 OHLCV endpoint with only v2-compatible parameters", () => {
    const url = buildBirdeyeOhlcvUrl("https://public-api.birdeye.so", first, 105, 12 * 60_000);

    expect(url.pathname).toBe("/defi/ohlcv");
    expect(url.searchParams.get("address")).toBe(first);
    expect(url.searchParams.get("type")).toBe("5m");
    expect(url.searchParams.get("currency")).toBe("usd");
    expect(url.searchParams.get("time_from")).toBe("0");
    expect(url.searchParams.get("time_to")).toBe("599");
    for (const v3OnlyParameter of ["mode", "count_limit", "ui_amount_mode", "padding", "outlier"]) {
      expect(url.searchParams.has(v3OnlyParameter)).toBe(false);
    }
  });

  it("caps v2 OHLCV ranges at the endpoint's 1000-candle limit", () => {
    const now = 2_000 * 5 * 60_000;
    const url = buildBirdeyeOhlcvUrl("https://public-api.birdeye.so", first, 5000, now);

    expect(Number(url.searchParams.get("time_to")) - Number(url.searchParams.get("time_from"))).toBe(1000 * 5 * 60 - 1);
  });

  it("does not disguise an empty OHLCV response as a successful refresh from stored candles", () => {
    const stored = [{ timestamp: new Date(0), open: 1, high: 1, low: 1, close: 1, volume: 0 }];

    expect(mergeOhlcvHistory(stored, [], 100)).toEqual([]);
  });

  it("lets fresh Birdeye candles replace stored values at the same timestamp", () => {
    const stored = [{ timestamp: new Date(0), open: 1, high: 1, low: 1, close: 1, volume: 0 }];
    const fresh = [{ timestamp: new Date(0), open: 2, high: 2, low: 2, close: 2, volume: 5 }];

    expect(mergeOhlcvHistory(stored, fresh, 100)).toEqual(fresh);
  });

  it("distinguishes current, recovering, and stuck OHLCV responses", () => {
    const previous = new Date(5 * 60_000);
    const expected = 15 * 60_000;

    expect(classifyOhlcvProgress(previous, new Date(expected), expected)).toBe("current");
    expect(classifyOhlcvProgress(previous, new Date(10 * 60_000), expected)).toBe("catching-up");
    expect(classifyOhlcvProgress(previous, new Date(5 * 60_000), expected)).toBe("no-progress");
  });
});
