import type { OhlcvCandle } from "@prisma/client";
import Decimal from "decimal.js";
import { prisma } from "../db.js";
import { MARKET_CANDLE_TIMEFRAME } from "../domain/market.js";
import { evaluateBuy, evaluateSell, shouldAddPosition } from "../domain/strategy.js";
import type { Candle, MarketPoint, PositionPoint, StrategyParameters } from "../domain/types.js";

export type BacktestParams = StrategyParameters & {
  initialCapitalSol: number;
  buyAmountSol: number;
  addAmountSol: number;
  slippagePercent: number;
  buyFeeSol: number;
  sellFeeSol: number;
};

export const defaultBacktestParams: BacktestParams = {
  initialCapitalSol: 10,
  buyAmountSol: 0.2,
  addAmountSol: 0.2,
  minFdvUsd: 30_000,
  minLiquidityUsd: 10_000,
  rsiBuyBelow: 30,
  rsiSellCrossDown: 70,
  rsiSellAbove: 80,
  maxSingleCandleDropPercent: 3,
  lpDropThresholdPercent: 10,
  addPositionDropPercent: 30,
  maxAddPositionCount: 1,
  trailingActivateProfitPercent: 20,
  trailingDrawdownPercent: 10,
  emergencyStopLossPercent: 0,
  slippagePercent: 6,
  buyFeeSol: 0.0005,
  sellFeeSol: 0.0002
};

type SimTrade = {
  buyTime: Date;
  addBuyTime?: Date;
  sellTime: Date;
  buyPrice: number;
  addBuyPrice?: number;
  averageEntryPrice: number;
  sellPrice: number;
  buyRsi?: number | null;
  addBuyRsi?: number | null;
  sellRsi?: number | null;
  buyFdvUsd?: number | null;
  addBuyFdvUsd?: number | null;
  sellFdvUsd?: number | null;
  buyLiquidityUsd?: number | null;
  addBuyLiquidityUsd?: number | null;
  sellLiquidityUsd?: number | null;
  sellReason: string;
  pnlSol: number;
  pnlPercent: number;
  holdingMinutes: number;
  trailingActivated: boolean;
  maxProfitPercent: number;
  addPositionCount: number;
};

export class BacktestService {
  async run(address: string, startTime: Date, endTime: Date, params: BacktestParams, name = "RSI-7 backtest") {
    const token = await prisma.token.findUniqueOrThrow({ where: { address } });
    const rows = await prisma.ohlcvCandle.findMany({
      where: { tokenId: token.id, timeframe: MARKET_CANDLE_TIMEFRAME, timestamp: { gte: startTime, lte: endTime } },
      orderBy: { timestamp: "asc" }
    });
    if (rows.length < 10) throw new Error("Not enough stored candles in the selected range");
    const result = simulate(rows, params);
    return prisma.backtestRun.create({
      data: {
        name,
        address,
        startTime,
        endTime,
        paramsJson: params,
        summaryJson: result.summary,
        trades: {
          create: result.trades.map((trade) => ({ ...trade, address }))
        }
      },
      include: { trades: true }
    });
  }
}

export function simulate(rows: OhlcvCandle[], params: BacktestParams) {
  let capital = params.initialCapitalSol;
  let peakCapital = capital;
  let maxDrawdownPercent = 0;
  let state: null | {
    buyTime: Date;
    buyPrice: number;
    buyRsi: number | null;
    buyFdvUsd: number | null;
    buyLiquidityUsd: number | null;
    tokens: number;
    totalSolIn: number;
    averageEntryPrice: number;
    addBuyTime?: Date;
    addBuyPrice?: number;
    addBuyRsi?: number | null;
    addBuyFdvUsd?: number | null;
    addBuyLiquidityUsd?: number | null;
    position: PositionPoint;
    maxProfitPercent: number;
  } = null;
  const trades: SimTrade[] = [];

  for (let index = 3; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.fdvUsd == null || row.liquidityUsd == null || row.rsi7 == null || Number(row.close) <= 0) continue;
    const market = rowToMarket(row);
    const markToMarketEquity = capital + (state ? state.tokens * market.priceUsd * (1 - params.slippagePercent / 100) : 0);
    peakCapital = Math.max(peakCapital, markToMarketEquity);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peakCapital - markToMarketEquity) / peakCapital) * 100);
    const candles = rows.slice(index - 2, index + 1).map(rowToCandle);
    const priorLiquidity = rows[Math.max(0, index - 2)]?.liquidityUsd;
    const buyDecision = evaluateBuy(market, candles, priorLiquidity == null ? null : Number(priorLiquidity), params);

    if (!state) {
      if (!buyDecision.allowed || capital < params.buyAmountSol) continue;
      const executionPrice = market.priceUsd * (1 + params.slippagePercent / 100);
      const tokens = params.buyAmountSol / executionPrice;
      capital -= params.buyAmountSol + params.buyFeeSol;
      state = {
        buyTime: row.timestamp,
        buyPrice: executionPrice,
        buyRsi: market.rsi ?? null,
        buyFdvUsd: market.fdvUsd,
        buyLiquidityUsd: market.liquidityUsd,
        tokens,
        totalSolIn: params.buyAmountSol,
        averageEntryPrice: executionPrice,
        position: { averageEntryPriceUsd: executionPrice, initialEntryPriceUsd: executionPrice, highestPriceUsd: executionPrice, trailingActivated: false, addPositionCount: 0 },
        maxProfitPercent: 0
      };
      continue;
    }

    const sell = evaluateSell(market, rows[index - 1]?.rsi7 == null ? null : Number(rows[index - 1]!.rsi7), state.position, params);
    state.maxProfitPercent = Math.max(state.maxProfitPercent, ((market.priceUsd - state.averageEntryPrice) / state.averageEntryPrice) * 100);
    if (sell.shouldSell) {
      const proceeds = state.tokens * market.priceUsd * (1 - params.slippagePercent / 100);
      const sellFees = (state.position.addPositionCount > 0 ? 2 : 1) * params.sellFeeSol;
      const buyFees = (state.position.addPositionCount + 1) * params.buyFeeSol;
      capital += proceeds - sellFees;
      const pnlSol = proceeds - state.totalSolIn - buyFees - sellFees;
      trades.push({
        buyTime: state.buyTime,
        addBuyTime: state.addBuyTime,
        sellTime: row.timestamp,
        buyPrice: state.buyPrice,
        addBuyPrice: state.addBuyPrice,
        averageEntryPrice: state.averageEntryPrice,
        sellPrice: market.priceUsd * (1 - params.slippagePercent / 100),
        buyRsi: state.buyRsi,
        addBuyRsi: state.addBuyRsi,
        sellRsi: market.rsi,
        buyFdvUsd: state.buyFdvUsd,
        addBuyFdvUsd: state.addBuyFdvUsd,
        sellFdvUsd: market.fdvUsd,
        buyLiquidityUsd: state.buyLiquidityUsd,
        addBuyLiquidityUsd: state.addBuyLiquidityUsd,
        sellLiquidityUsd: market.liquidityUsd,
        sellReason: sell.reason!,
        pnlSol,
        pnlPercent: (pnlSol / state.totalSolIn) * 100,
        holdingMinutes: Math.round((row.timestamp.getTime() - state.buyTime.getTime()) / 60_000),
        trailingActivated: state.position.trailingActivated || sell.activateTrailing,
        maxProfitPercent: state.maxProfitPercent,
        addPositionCount: state.position.addPositionCount
      });
      state = null;
      peakCapital = Math.max(peakCapital, capital);
      maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peakCapital - capital) / peakCapital) * 100);
      continue;
    }

    state.position = { ...state.position, highestPriceUsd: sell.highestPriceUsd, trailingActivated: sell.activateTrailing };
    if (capital >= params.addAmountSol && shouldAddPosition(market, state.position, buyDecision, params)) {
      const addPrice = market.priceUsd * (1 + params.slippagePercent / 100);
      const addTokens = params.addAmountSol / addPrice;
      state.averageEntryPrice = (state.tokens * state.averageEntryPrice + addTokens * addPrice) / (state.tokens + addTokens);
      state.tokens += addTokens;
      state.totalSolIn += params.addAmountSol;
      state.addBuyTime = row.timestamp;
      state.addBuyPrice = addPrice;
      state.addBuyRsi = market.rsi;
      state.addBuyFdvUsd = market.fdvUsd;
      state.addBuyLiquidityUsd = market.liquidityUsd;
      state.position = { ...state.position, averageEntryPriceUsd: state.averageEntryPrice, addPositionCount: state.position.addPositionCount + 1 };
      capital -= params.addAmountSol + params.buyFeeSol;
    }
  }

  const totalPnlSol = trades.reduce((sum, trade) => sum + trade.pnlSol, 0);
  const winners = trades.filter((trade) => trade.pnlSol > 0);
  const lastPrice = [...rows].reverse().find((row) => Number(row.close) > 0)?.close;
  const finalCapitalSol = capital + (state && lastPrice
    ? state.tokens * Number(lastPrice) * (1 - params.slippagePercent / 100) - params.sellFeeSol
    : 0);
  return {
    trades,
    summary: {
      totalTrades: trades.length,
      addPositionCount: trades.reduce((sum, trade) => sum + trade.addPositionCount, 0),
      wins: winners.length,
      losses: trades.length - winners.length,
      winRate: trades.length ? (winners.length / trades.length) * 100 : 0,
      totalPnlSol,
      returnPercent: ((finalCapitalSol - params.initialCapitalSol) / params.initialCapitalSol) * 100,
      maxDrawdownPercent,
      averagePnlSol: trades.length ? totalPnlSol / trades.length : 0,
      finalCapitalSol,
      openPositionAtEnd: state != null
    }
  };
}

function rowToCandle(row: OhlcvCandle): Candle {
  return { timestamp: row.timestamp, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), rsi: row.rsi7 == null ? null : Number(row.rsi7) };
}

function rowToMarket(row: OhlcvCandle): MarketPoint {
  return { timestamp: row.timestamp, priceUsd: Number(row.close), fdvUsd: Number(row.fdvUsd), liquidityUsd: Number(row.liquidityUsd), ageMinutes: row.ageMinutes == null ? null : Number(row.ageMinutes), rsi: row.rsi7 == null ? null : Number(row.rsi7) };
}
