import type { Position, Token } from "@prisma/client";
import { Decimal } from "decimal.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { evaluateBuy, evaluateSell, shouldAddPosition } from "../domain/strategy.js";
import type { MarketPoint, StrategyParameters } from "../domain/types.js";
import { logger } from "../logger.js";
import { delay } from "./http.js";
import { JupiterClient } from "./jupiter.js";
import { PositionService } from "./position-service.js";
import { TradeExecutor } from "./trade-executor.js";
import type { PreparedSwap } from "./jupiter.js";

const params: StrategyParameters = {
  minFdvUsd: config.MIN_FDV_USD,
  minLiquidityUsd: config.MIN_LIQUIDITY_USD,
  rsiBuyBelow: config.RSI_BUY_BELOW,
  rsiSellCrossDown: config.RSI_SELL_CROSS_DOWN,
  rsiSellAbove: config.RSI_SELL_ABOVE,
  maxSingleCandleDropPercent: config.MAX_SINGLE_CANDLE_DROP_PERCENT,
  lpDropThresholdPercent: config.LP_DROP_THRESHOLD_PERCENT,
  addPositionDropPercent: config.ADD_POSITION_DROP_PERCENT,
  maxAddPositionCount: config.MAX_ADD_POSITION_COUNT,
  trailingActivateProfitPercent: config.TRAILING_ACTIVATE_PROFIT_PERCENT,
  trailingDrawdownPercent: config.TRAILING_DRAWDOWN_PERCENT,
  emergencyStopLossPercent: config.EMERGENCY_STOP_LOSS_PERCENT
};

export class StrategyEngine {
  private readonly jupiter = new JupiterClient();
  private readonly executor = new TradeExecutor(this.jupiter);
  private readonly positions = new PositionService();

  async processToken(tokenId: string): Promise<void> {
    const token = await prisma.token.findUnique({
      where: { id: tokenId },
      include: { positions: { where: { status: "OPEN" }, take: 1, orderBy: { createdAt: "desc" } } }
    });
    if (!token || token.status === "REMOVED" || token.status === "CLOSED" || token.status === "ERROR") return;
    if (!hasFreshMarket(token)) return;
    const market = marketFromToken(token);
    const position = token.positions[0];

    if (!position && (market.fdvUsd < config.MIN_FDV_USD || market.liquidityUsd < config.MIN_LIQUIDITY_USD)) {
      await prisma.token.update({
        where: { id: token.id },
        data: {
          status: "REMOVED",
          removedAt: new Date(),
          removeReason: market.fdvUsd < config.MIN_FDV_USD ? "FDV_BELOW_MINIMUM" : "LIQUIDITY_BELOW_MINIMUM"
        }
      });
      logger.info({ event: "token_removed", address: token.address, reason: "market_filter" });
      return;
    }

    if (position) await this.processHolding(token, position, market);
    else if (token.status === "WATCHING") await this.processWatching(token, market);
    await prisma.token.update({ where: { id: token.id }, data: { lastStrategyAt: new Date() } });
  }

  async forceSell(address: string): Promise<void> {
    const token = await prisma.token.findUnique({
      where: { address },
      include: { positions: { where: { status: "OPEN" }, take: 1, orderBy: { createdAt: "desc" } } }
    });
    if (!token?.positions[0]) throw new Error("No open position exists");
    await this.executeSell(token, token.positions[0], marketFromTokenOrPosition(token, token.positions[0]), "SELL_MANUAL", true);
  }

  private async processWatching(token: Token, market: MarketPoint): Promise<void> {
    const [candles, priorSnapshot] = await Promise.all([
      prisma.ohlcvCandle.findMany({ where: { tokenId: token.id }, orderBy: { timestamp: "desc" }, take: 3 }),
      findLiquidityLookback(token.id)
    ]);
    const decision = evaluateBuy(
      market,
      candles.reverse().map((candle) => ({
        timestamp: candle.timestamp,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume),
        rsi: candle.rsi7 == null ? null : Number(candle.rsi7)
      })),
      priorSnapshot?.liquidityUsd == null ? null : Number(priorSnapshot.liquidityUsd),
      params
    );
    if (!decision.allowed) return;
    if (await this.buyingPaused()) {
      logger.warn({ event: "buy_blocked", address: token.address, reason: "TRADING_PAUSED" });
      return;
    }

    const claimed = await prisma.token.updateMany({ where: { id: token.id, status: "WATCHING" }, data: { status: "BUYING" } });
    if (claimed.count !== 1) return;
    let tradeId: string | null = null;
    let executionStarted = false;
    try {
      const decimals = await this.ensureDecimals(token);
      await this.jupiter.assertMintSafeToBuy(token.address);
      const preflight = await this.executor.preflightBuy(token.address, config.BUY_AMOUNT_SOL);
      logger.info({ event: "buy_initial_signal_triggered", address: token.address, roundTripLossPercent: preflight.roundTripLossPercent });
      const trade = await prisma.trade.create({ data: pendingTrade(token, "BUY_INITIAL", market, "RSI_BUY") });
      tradeId = trade.id;
      const fill = await this.executor.buy(token.address, config.BUY_AMOUNT_SOL, decimals, this.executionHooks(trade.id, () => { executionStarted = true; }));
      await this.persistExecutionReceipt(trade.id, fill);
      await this.positions.recordInitialBuy(token, trade.id, fill, market);
      logger.info({ event: "buy_confirmed", address: token.address, txHash: fill.txHash });
    } catch (error) {
      const restore = executionStarted ? "ERROR" : "WATCHING";
      await this.failTradeAndRestore(token.id, tradeId, restore, error);
      logger.error({ event: "buy_failed", address: token.address, error: message(error) });
    }
  }

  private async processHolding(token: Token, position: Position, market: MarketPoint): Promise<void> {
    const sell = evaluateSell(
      market,
      token.previousRsi == null ? null : Number(token.previousRsi),
      {
        averageEntryPriceUsd: Number(position.averageEntryPriceUsd),
        initialEntryPriceUsd: Number(position.entryPriceUsd),
        highestPriceUsd: Number(position.highestPriceUsd),
        trailingActivated: position.trailingActivated,
        addPositionCount: position.addPositionCount
      },
      params
    );

    if (sell.shouldSell) {
      await this.executeSell(token, position, market, sell.reason!);
      return;
    }
    await prisma.position.update({
      where: { id: position.id },
      data: {
        highestPriceUsd: sell.highestPriceUsd,
        trailingActivated: sell.activateTrailing,
        trailingActivatedAt: sell.activateTrailing && !position.trailingActivated ? new Date() : undefined,
        trailingStopPriceUsd: sell.trailingStopPriceUsd
      }
    });

    if (!config.ADD_POSITION_ENABLED) return;
    if (await this.buyingPaused()) return;
    const [candles, priorSnapshot] = await Promise.all([
      prisma.ohlcvCandle.findMany({ where: { tokenId: token.id }, orderBy: { timestamp: "desc" }, take: 3 }),
      findLiquidityLookback(token.id)
    ]);
    const buyDecision = evaluateBuy(
      market,
      candles.reverse().map((candle) => ({
        timestamp: candle.timestamp, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume)
      })),
      priorSnapshot?.liquidityUsd == null ? null : Number(priorSnapshot.liquidityUsd),
      params
    );
    if (!shouldAddPosition(market, {
      averageEntryPriceUsd: Number(position.averageEntryPriceUsd),
      initialEntryPriceUsd: Number(position.entryPriceUsd),
      highestPriceUsd: Number(position.highestPriceUsd),
      trailingActivated: position.trailingActivated,
      addPositionCount: position.addPositionCount
    }, buyDecision, params)) return;
    await this.executeAddBuy(token, position, market);
  }

  private async executeAddBuy(token: Token, position: Position, market: MarketPoint): Promise<void> {
    const claimed = await prisma.token.updateMany({ where: { id: token.id, status: "HOLDING" }, data: { status: "BUYING" } });
    if (claimed.count !== 1) return;
    let tradeId: string | null = null;
    let executionStarted = false;
    try {
      const decimals = await this.ensureDecimals(token);
      await this.jupiter.assertMintSafeToBuy(token.address);
      await this.executor.preflightBuy(token.address, config.ADD_POSITION_AMOUNT_SOL);
      const trade = await prisma.trade.create({ data: { ...pendingTrade(token, "BUY_ADD", market, "ADD_AFTER_DROP"), positionId: position.id } });
      tradeId = trade.id;
      const fill = await this.executor.buy(token.address, config.ADD_POSITION_AMOUNT_SOL, decimals, this.executionHooks(trade.id, () => { executionStarted = true; }));
      await this.persistExecutionReceipt(trade.id, fill);
      await this.positions.recordAddBuy(position, trade.id, fill, market);
      logger.info({ event: "add_buy_confirmed", address: token.address, txHash: fill.txHash });
    } catch (error) {
      const restore = executionStarted ? "ERROR" : "HOLDING";
      await this.failTradeAndRestore(token.id, tradeId, restore, error);
      logger.error({ event: "add_buy_failed", address: token.address, error: message(error) });
    }
  }

  private async executeSell(token: Token, position: Position, market: MarketPoint, reason: string, throwOnFailure = false): Promise<void> {
    const claimed = await prisma.token.updateMany({ where: { id: token.id, status: "HOLDING" }, data: { status: "SELLING" } });
    if (claimed.count !== 1) {
      if (throwOnFailure) throw new Error(`Cannot sell token while status is ${token.status}`);
      return;
    }
    let executionStarted = false;
    try {
      const decimals = await this.ensureDecimals(token);
      const batches = position.addPositionCount > 0 && position.sellBatchCompleted === 0
        ? [config.BATCH_SELL_FIRST_PERCENT / 100, 1]
        : [1];
      let current = position;
      for (let index = 0; index < batches.length; index += 1) {
        if (index > 0) {
          await delay(config.BATCH_SELL_DELAY_MS);
          current = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
        }
        const requestedAmount = index === batches.length - 1
          ? Number(current.amountToken)
          : new Decimal(current.amountToken.toString()).mul(batches[index]!).toNumber();
        const batchNumber = current.sellBatchCompleted + 1;
        const trade = await prisma.trade.create({
          data: { ...pendingTrade(token, "SELL", market, reason), positionId: position.id, batchNumber }
        });
        try {
          const fill = await this.executor.sell(token.address, requestedAmount, decimals, this.executionHooks(trade.id, () => { executionStarted = true; }));
          await this.persistExecutionReceipt(trade.id, fill);
          current = await this.positions.recordSellBatch(position.id, trade.id, fill, market, batchNumber);
          logger.info({ event: `sell_batch_${batchNumber}_confirmed`, address: token.address, txHash: fill.txHash });
        } catch (error) {
          await prisma.trade.update({ where: { id: trade.id }, data: { status: "FAILED", errorMessage: message(error) } });
          throw error;
        }
      }
      await this.positions.closePosition(position.id, market, reason);
      logger.info({ event: "position_closed", address: token.address, reason });
    } catch (error) {
      const status = executionStarted ? "ERROR" : "HOLDING";
      await prisma.token.update({ where: { id: token.id }, data: { status, removeReason: status === "ERROR" ? "Manual reconciliation required after uncertain live sell" : undefined } });
      logger.error({ event: "sell_failed", address: token.address, error: message(error) });
      if (throwOnFailure) throw error;
    }
  }

  private async ensureDecimals(token: Token): Promise<number> {
    if (token.decimals != null) return token.decimals;
    const decimals = await this.jupiter.getMintDecimals(token.address);
    await prisma.token.update({ where: { id: token.id }, data: { decimals } });
    return decimals;
  }

  private async buyingPaused(): Promise<boolean> {
    const health = await prisma.systemHealth.findUnique({ where: { id: "singleton" } });
    return config.TRADING_PAUSED || Boolean(health?.tradingPaused);
  }

  private executionHooks(tradeId: string, markStarted: () => void) {
    return {
      onPrepared: async (prepared: PreparedSwap) => {
        await prisma.trade.update({
          where: { id: tradeId },
          data: {
            requestId: prepared.requestId,
            signedTransaction: prepared.signedTransaction,
            preparedTxHash: prepared.preparedTxHash,
            router: prepared.router
          }
        });
        markStarted();
      }
    };
  }

  private async persistExecutionReceipt(tradeId: string, fill: { txHash?: string; amountSol: number; amountToken: number; feeSol: number; router: string }): Promise<void> {
    await prisma.trade.update({
      where: { id: tradeId },
      data: {
        txHash: fill.txHash,
        amountSol: fill.amountSol,
        amountToken: fill.amountToken,
        feeSol: fill.feeSol,
        router: fill.router
      }
    });
  }

  private async failTradeAndRestore(tokenId: string, tradeId: string | null, status: "WATCHING" | "HOLDING" | "ERROR", error: unknown): Promise<void> {
    await prisma.$transaction(async (tx) => {
      if (tradeId) await tx.trade.update({ where: { id: tradeId }, data: { status: "FAILED", errorMessage: message(error) } });
      await tx.token.update({ where: { id: tokenId }, data: { status } });
    });
  }
}

function pendingTrade(token: Token, side: "BUY_INITIAL" | "BUY_ADD" | "SELL", market: MarketPoint, reason: string) {
  return {
    tokenId: token.id,
    side,
    status: "PENDING" as const,
    amountSol: 0,
    amountToken: 0,
    priceUsd: market.priceUsd,
    slippagePercent: config.SLIPPAGE_PERCENT,
    fdvAtTradeUsd: market.fdvUsd,
    liquidityAtTradeUsd: market.liquidityUsd,
    ageAtTradeMinutes: market.ageMinutes,
    rsiAtTrade: market.rsi,
    reason
  };
}

function hasFreshMarket(token: Token): boolean {
  return token.priceUsd != null && token.fdvUsd != null && token.liquidityUsd != null && token.lastMarketCheckAt != null
    && Date.now() - token.lastMarketCheckAt.getTime() <= config.MARKET_STALE_AFTER_SECONDS * 1000;
}

function marketFromToken(token: Token): MarketPoint {
  return {
    timestamp: token.lastMarketCheckAt!,
    priceUsd: Number(token.priceUsd),
    priceSol: token.priceSol == null ? null : Number(token.priceSol),
    fdvUsd: Number(token.fdvUsd),
    liquidityUsd: Number(token.liquidityUsd),
    ageMinutes: token.ageMinutes == null ? null : Number(token.ageMinutes),
    rsi: token.rsi == null ? null : Number(token.rsi)
  };
}

function marketFromTokenOrPosition(token: Token, position: Position): MarketPoint {
  return {
    timestamp: token.lastMarketCheckAt ?? new Date(),
    priceUsd: token.priceUsd == null ? Number(position.averageEntryPriceUsd) : Number(token.priceUsd),
    priceSol: token.priceSol == null ? null : Number(token.priceSol),
    fdvUsd: token.fdvUsd == null ? 0 : Number(token.fdvUsd),
    liquidityUsd: token.liquidityUsd == null ? 0 : Number(token.liquidityUsd),
    ageMinutes: token.ageMinutes == null ? null : Number(token.ageMinutes),
    rsi: token.rsi == null ? null : Number(token.rsi)
  };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function findLiquidityLookback(tokenId: string) {
  const target = Date.now() - config.LP_DROP_LOOKBACK_MINUTES * 60_000;
  const tolerance = Math.max(120_000, config.MARKET_FILTER_INTERVAL_MS * 2);
  return prisma.marketSnapshot.findFirst({
    where: { tokenId, createdAt: { lte: new Date(target), gte: new Date(target - tolerance) } },
    orderBy: { createdAt: "desc" }
  });
}
