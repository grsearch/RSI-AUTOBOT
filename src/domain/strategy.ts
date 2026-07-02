import type {
  BuyDecision,
  Candle,
  MarketPoint,
  PositionPoint,
  SellDecision,
  StrategyParameters
} from "./types.js";
import { MARKET_CANDLE_INTERVAL_MS, MAX_CLOSED_CANDLE_AGE_MS } from "./market.js";

export function evaluateBuy(
  market: MarketPoint,
  recentCandles: Candle[],
  priorLiquidityUsd: number | null,
  params: StrategyParameters
): BuyDecision {
  const blockers: string[] = [];
  if (market.fdvUsd <= params.minFdvUsd) blockers.push("FDV_TOO_LOW");
  if (market.liquidityUsd <= params.minLiquidityUsd) blockers.push("LIQUIDITY_TOO_LOW");
  if (market.rsi == null) blockers.push("RSI_UNAVAILABLE");
  else if (market.rsi >= params.rsiBuyBelow) blockers.push("RSI_NOT_OVERSOLD");

  const lastThree = recentCandles.slice(-3);
  if (lastThree.length < 3) blockers.push("INSUFFICIENT_CANDLES");
  else {
    const hasGap = lastThree.some((candle, index) => index > 0 && candle.timestamp.getTime() - lastThree[index - 1]!.timestamp.getTime() !== MARKET_CANDLE_INTERVAL_MS);
    const latestAgeMs = market.timestamp.getTime() - lastThree[2]!.timestamp.getTime();
    if (hasGap || latestAgeMs < 0 || latestAgeMs > MAX_CLOSED_CANDLE_AGE_MS) blockers.push("NON_CONSECUTIVE_CANDLES");
    if (lastThree.some((candle) => candle.open > 0 && ((candle.open - candle.close) / candle.open) * 100 > params.maxSingleCandleDropPercent)) {
      blockers.push("SHARP_CANDLE_DROP");
    }
  }

  if (priorLiquidityUsd == null || priorLiquidityUsd <= 0) blockers.push("LIQUIDITY_HISTORY_UNAVAILABLE");
  else if (((priorLiquidityUsd - market.liquidityUsd) / priorLiquidityUsd) * 100 > params.lpDropThresholdPercent) {
    blockers.push("LIQUIDITY_FALLING");
  }
  return { allowed: blockers.length === 0, blockers };
}

export function shouldAddPosition(
  market: MarketPoint,
  position: PositionPoint,
  buyDecision: BuyDecision,
  params: StrategyParameters
): boolean {
  const drop = ((position.initialEntryPriceUsd - market.priceUsd) / position.initialEntryPriceUsd) * 100;
  return buyDecision.allowed && drop > params.addPositionDropPercent && position.addPositionCount < params.maxAddPositionCount;
}

/** Sell precedence is deliberate: liquidity safety, emergency loss, trailing, then RSI. */
export function evaluateSell(
  market: MarketPoint,
  previousRsi: number | null,
  position: PositionPoint,
  params: StrategyParameters
): SellDecision {
  const highestPriceUsd = Math.max(position.highestPriceUsd, market.priceUsd);
  const profitPercent = ((market.priceUsd - position.averageEntryPriceUsd) / position.averageEntryPriceUsd) * 100;

  if (market.fdvUsd < params.minFdvUsd) return decision("SELL_FDV_BREAK", highestPriceUsd);
  if (market.liquidityUsd < params.minLiquidityUsd) return decision("SELL_LP_BREAK", highestPriceUsd);
  if (params.emergencyStopLossPercent > 0 && profitPercent <= -params.emergencyStopLossPercent) {
    return decision("SELL_EMERGENCY_STOP", highestPriceUsd);
  }

  const activateTrailing = position.trailingActivated || profitPercent >= params.trailingActivateProfitPercent;
  const trailingStopPriceUsd = activateTrailing
    ? highestPriceUsd * (1 - params.trailingDrawdownPercent / 100)
    : undefined;

  if (activateTrailing && trailingStopPriceUsd != null && market.priceUsd <= trailingStopPriceUsd) {
    return {
      ...decision("SELL_TRAILING_STOP", highestPriceUsd),
      activateTrailing,
      trailingStopPriceUsd
    };
  }

  if (!activateTrailing && market.rsi != null) {
    const crossDownEnabled = params.rsiSellCrossDown < 99;
    if (crossDownEnabled && previousRsi != null && previousRsi >= params.rsiSellCrossDown && market.rsi < params.rsiSellCrossDown) {
      return decision("SELL_RSI_CROSS_DOWN_70", highestPriceUsd);
    }
    if (market.rsi > params.rsiSellAbove) return decision("SELL_RSI_ABOVE_80", highestPriceUsd);
  }

  return { shouldSell: false, activateTrailing, highestPriceUsd, trailingStopPriceUsd };
}

function decision(reason: NonNullable<SellDecision["reason"]>, highestPriceUsd: number): SellDecision {
  return { shouldSell: true, reason, activateTrailing: false, highestPriceUsd };
}
