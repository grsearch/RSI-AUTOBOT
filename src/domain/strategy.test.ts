import { describe, expect, it } from "vitest";
import { evaluateBuy, evaluateSell } from "./strategy.js";
import type { StrategyParameters } from "./types.js";

const params: StrategyParameters = {
  minFdvUsd: 30_000,
  minLiquidityUsd: 10_000,
  rsiBuyBelow: 25,
  rsiSellCrossDown: 99,
  rsiSellAbove: 80,
  maxSingleCandleDropPercent: 3,
  lpDropThresholdPercent: 10,
  addPositionDropPercent: 30,
  maxAddPositionCount: 1,
  trailingActivateProfitPercent: 30,
  trailingDrawdownPercent: 10,
  emergencyStopLossPercent: 45
};

const market = { timestamp: new Date(900_000), priceUsd: 1, fdvUsd: 40_000, liquidityUsd: 20_000, rsi: 20 };
const candles = [0, 1, 2].map((offset) => ({ timestamp: new Date(offset * 300_000), open: 1, high: 1, low: 0.99, close: 0.99, volume: 1 }));

describe("strategy decisions", () => {
  it("allows an oversold buy with stable liquidity", () => {
    expect(evaluateBuy(market, candles, 21_000, params)).toEqual({ allowed: true, blockers: [] });
  });

  it("blocks a buy during a sharp candle drop", () => {
    const risky = [...candles.slice(0, 2), { ...candles[2]!, close: 0.9 }];
    expect(evaluateBuy(market, risky, 21_000, params).blockers).toContain("SHARP_CANDLE_DROP");
  });

  it("blocks a buy when five-minute candles contain a gap", () => {
    const gapped = [candles[0]!, candles[1]!, { ...candles[2]!, timestamp: new Date(900_000) }];
    expect(evaluateBuy(market, gapped, 21_000, params).blockers).toContain("NON_CONSECUTIVE_CANDLES");
  });

  it("activates trailing and sells after a ten percent high-water drawdown", () => {
    const position = { averageEntryPriceUsd: 1, initialEntryPriceUsd: 1, highestPriceUsd: 1.3, trailingActivated: true, addPositionCount: 0 };
    const result = evaluateSell({ ...market, priceUsd: 1.16, rsi: 60 }, 65, position, params);
    expect(result.reason).toBe("SELL_TRAILING_STOP");
  });

  it("uses the emergency loss guard before RSI", () => {
    const position = { averageEntryPriceUsd: 1, initialEntryPriceUsd: 1, highestPriceUsd: 1, trailingActivated: false, addPositionCount: 0 };
    expect(evaluateSell({ ...market, priceUsd: 0.5 }, 20, position, params).reason).toBe("SELL_EMERGENCY_STOP");
  });

  it("disables the fixed emergency stop when configured as zero", () => {
    const position = { averageEntryPriceUsd: 1, initialEntryPriceUsd: 1, highestPriceUsd: 1, trailingActivated: false, addPositionCount: 0 };
    const result = evaluateSell({ ...market, priceUsd: 0.5, rsi: 20 }, 20, position, { ...params, emergencyStopLossPercent: 0 });
    expect(result.shouldSell).toBe(false);
  });

  it("treats a cross-down threshold of 99 as disabled", () => {
    const position = { averageEntryPriceUsd: 1, initialEntryPriceUsd: 1, highestPriceUsd: 1, trailingActivated: false, addPositionCount: 0 };
    const result = evaluateSell(
      { ...market, rsi: 70 },
      100,
      position,
      { ...params, rsiSellAbove: 100 }
    );
    expect(result.shouldSell).toBe(false);
  });
});
