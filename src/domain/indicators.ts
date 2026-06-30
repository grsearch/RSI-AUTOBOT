import type { Candle } from "./types.js";

/** Wilder RSI. Returned array lines up with the input; warm-up values are null. */
export function calculateRsi(closes: number[], period: number): Array<number | null> {
  const values: Array<number | null> = Array(closes.length).fill(null);
  if (closes.length <= period) return values;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  values[period] = rsiFromAverages(averageGain, averageLoss);

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    values[index] = rsiFromAverages(averageGain, averageLoss);
  }
  return values;
}

function rsiFromAverages(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function attachRsi(candles: Candle[], period: number): Candle[] {
  const values = calculateRsi(candles.map((candle) => candle.close), period);
  return candles.map((candle, index) => ({ ...candle, rsi: values[index] }));
}
