export const MARKET_CANDLE_TIMEFRAME = "5m" as const;
export const MARKET_CANDLE_INTERVAL_MS = 5 * 60_000;
export const MAX_CLOSED_CANDLE_AGE_MS = MARKET_CANDLE_INTERVAL_MS * 2;

export function isRsiFresh(lastOhlcvAt: Date | null, marketAt: Date | null): boolean {
  if (!lastOhlcvAt || !marketAt) return false;
  const ageMs = marketAt.getTime() - lastOhlcvAt.getTime();
  return ageMs >= 0 && ageMs <= MAX_CLOSED_CANDLE_AGE_MS;
}
