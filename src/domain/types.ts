export type Candle = {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rsi?: number | null;
};

export type MarketPoint = {
  timestamp: Date;
  priceUsd: number;
  priceSol?: number | null;
  fdvUsd: number;
  liquidityUsd: number;
  ageMinutes?: number | null;
  rsi?: number | null;
};

export type PositionPoint = {
  averageEntryPriceUsd: number;
  initialEntryPriceUsd: number;
  highestPriceUsd: number;
  trailingActivated: boolean;
  addPositionCount: number;
};

export type StrategyParameters = {
  minFdvUsd: number;
  minLiquidityUsd: number;
  rsiBuyBelow: number;
  rsiSellCrossDown: number;
  rsiSellAbove: number;
  maxSingleCandleDropPercent: number;
  lpDropThresholdPercent: number;
  addPositionDropPercent: number;
  maxAddPositionCount: number;
  trailingActivateProfitPercent: number;
  trailingDrawdownPercent: number;
  emergencyStopLossPercent: number;
};

export type BuyDecision = {
  allowed: boolean;
  blockers: string[];
};

export type SellReason =
  | "SELL_FDV_BREAK"
  | "SELL_LP_BREAK"
  | "SELL_EMERGENCY_STOP"
  | "SELL_TRAILING_STOP"
  | "SELL_RSI_CROSS_DOWN_70"
  | "SELL_RSI_ABOVE_80";

export type SellDecision = {
  shouldSell: boolean;
  reason?: SellReason;
  activateTrailing: boolean;
  highestPriceUsd: number;
  trailingStopPriceUsd?: number;
};
