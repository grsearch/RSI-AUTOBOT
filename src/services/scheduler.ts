import type { Prisma } from "@prisma/client";
import pLimit from "p-limit";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { evaluateVolumeExit } from "../domain/market-filter.js";
import { logger } from "../logger.js";
import { HealthService } from "./health.js";
import { marketVolume24hUsd, MarketDataService } from "./market-data.js";
import { StrategyEngine } from "./strategy-engine.js";
import { ShadowMarketService } from "./shadow-market.js";

export class Scheduler {
  private marketTimer: NodeJS.Timeout | null = null;
  private strategyTimer: NodeJS.Timeout | null = null;
  private shadowTimer: NodeJS.Timeout | null = null;
  private marketRunning = false;
  private strategyRunning = false;
  private shadowRunning = false;
  private lastCleanupAt = 0;
  private lastVolumeFilterAt = 0;
  private readonly market = new MarketDataService();
  private readonly strategy = new StrategyEngine();
  private readonly shadow = new ShadowMarketService();
  private readonly health = new HealthService();

  async start(): Promise<void> {
    await recoverTransientStates();
    await prisma.systemHealth.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", schedulerRunning: true, tradingPaused: config.TRADING_PAUSED },
      update: { schedulerRunning: true, startedAt: new Date() }
    });
    void this.marketCycle();
    this.marketTimer = setInterval(() => void this.marketCycle(), config.MARKET_FILTER_INTERVAL_MS);
    this.strategyTimer = setInterval(() => void this.strategyCycle(), config.STRATEGY_INTERVAL_MS);
    if (config.SHADOW_RSI_ENABLED) {
      void this.shadowCycle();
      this.shadowTimer = setInterval(() => void this.shadowCycle(), config.SHADOW_SAMPLE_INTERVAL_MS);
    }
  }

  async stop(): Promise<void> {
    if (this.marketTimer) clearInterval(this.marketTimer);
    if (this.strategyTimer) clearInterval(this.strategyTimer);
    if (this.shadowTimer) clearInterval(this.shadowTimer);
    await prisma.systemHealth.update({ where: { id: "singleton" }, data: { schedulerRunning: false } }).catch(() => undefined);
  }

  private async marketCycle(): Promise<void> {
    if (this.marketRunning) return;
    this.marketRunning = true;
    const limit = pLimit(config.MARKET_REQUEST_CONCURRENCY);
    try {
      const tokens = await prisma.token.findMany({
        where: managedTradingTokenWhere,
        include: { positions: { where: { status: "OPEN" }, select: { id: true }, take: 1 } }
      });
      const marketData = await this.market.getMarketDataMultiple(tokens.map((token) => token.address));
      let activeTokens = tokens;
      if (Date.now() - this.lastVolumeFilterAt >= config.VOLUME_FILTER_INTERVAL_MS) {
        const volumes = new Map<string, number>();
        for (const [address, market] of marketData) {
          const volume = marketVolume24hUsd(market);
          if (volume != null) volumes.set(address, volume);
        }
        const decision = evaluateVolumeExit(
          tokens.map((token) => ({ id: token.id, address: token.address, status: token.status, hasOpenPosition: token.positions.length > 0 })),
          volumes,
          config.MIN_VOLUME_24H_USD
        );
        const removedIds = new Set<string>();
        if (decision.remove.length > 0) {
          const updates = await prisma.$transaction(decision.remove.map((candidate) => prisma.token.updateMany({
            where: {
              id: candidate.id,
              status: { in: ["WATCHING", "HOLDING"] },
              positions: { none: { status: "OPEN" } }
            },
            data: {
              status: "REMOVED",
              volume24hUsd: candidate.volume24hUsd,
              removedAt: new Date(),
              removeReason: "VOLUME_24H_BELOW_MINIMUM"
            }
          })));
          updates.forEach((result, index) => { if (result.count === 1) removedIds.add(decision.remove[index]!.id); });
          if (removedIds.size > 0) logger.info({ event: "low_volume_tokens_removed", count: removedIds.size, minimumVolume24hUsd: config.MIN_VOLUME_24H_USD });
        }
        if (decision.deferred.length > 0) {
          logger.info({ event: "low_volume_exit_deferred_for_positions", count: decision.deferred.length, minimumVolume24hUsd: config.MIN_VOLUME_24H_USD });
        }
        activeTokens = tokens.filter((token) => !removedIds.has(token.id));
        this.lastVolumeFilterAt = Date.now();
      }
      const results = await Promise.allSettled(activeTokens.map((token) => limit(() => this.market.refreshToken(token, marketData.get(token.address)))));
      const failures = results.filter((result) => result.status === "rejected");
      const failureSamples = results.flatMap((result, index) => result.status === "rejected"
        ? [{ address: activeTokens[index]?.address, error: errorMessage(result.reason) }]
        : []).slice(0, 5);
      const probes = await this.health.probe();
      const lastError = failures[0]?.status === "rejected" ? errorMessage(failures[0].reason) : probes.errors[0] ?? null;
      await this.updateHealth({ birdeyeOk: Boolean(config.BIRDEYE_API_KEY) && failures.length === 0, heliusOk: probes.heliusOk, jupiterQuoteOk: probes.jupiterQuoteOk, lastMarketCycleAt: new Date(), lastError });
      if (failures.length > 0) logger.error({ event: "market_cycle_partial_failure", failures: failures.length, tokens: tokens.length, failureSamples, lastError });
      if (Date.now() - this.lastCleanupAt > 24 * 60 * 60 * 1000) {
        await prisma.marketSnapshot.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } } });
        this.lastCleanupAt = Date.now();
      }
      if (tokens.length > 0) void this.strategyCycle();
    } catch (error) {
      await this.updateHealth({ birdeyeOk: false, lastError: errorMessage(error) });
      logger.error({ event: "market_cycle_failed", error: errorMessage(error) });
    } finally {
      this.marketRunning = false;
    }
  }

  private async strategyCycle(): Promise<void> {
    if (this.strategyRunning) return;
    this.strategyRunning = true;
    try {
      const tokens = await prisma.token.findMany({
        where: managedTradingTokenWhere,
        orderBy: { createdAt: "asc" }
      });
      for (const token of tokens) await this.strategy.processToken(token.id);
      await this.updateHealth({ lastStrategyCycleAt: new Date() });
    } catch (error) {
      await this.updateHealth({ lastError: errorMessage(error) });
      logger.error({ event: "strategy_cycle_failed", error: errorMessage(error) });
    } finally {
      this.strategyRunning = false;
    }
  }

  private async shadowCycle(): Promise<void> {
    if (this.shadowRunning) return;
    this.shadowRunning = true;
    try {
      await this.shadow.runCycle();
    } catch (error) {
      // The collector is deliberately fail-open: shadow data must never affect trading.
      logger.error({ event: "shadow_rsi_cycle_failed", error: errorMessage(error) });
    } finally {
      this.shadowRunning = false;
    }
  }

  private async updateHealth(data: { birdeyeOk?: boolean; heliusOk?: boolean; jupiterQuoteOk?: boolean; lastMarketCycleAt?: Date; lastStrategyCycleAt?: Date; lastError?: string | null }): Promise<void> {
    const [watchingCount, holdingCount, errorOpenPositionCount] = await Promise.all([
      prisma.token.count({ where: { status: "WATCHING" } }),
      prisma.position.count({ where: { status: "OPEN" } }),
      prisma.position.count({ where: { status: "OPEN", token: { status: "ERROR" } } })
    ]);
    const safetyError = errorOpenPositionCount > 0
      ? `${errorOpenPositionCount} ERROR token(s) still have OPEN positions and require safety recovery or reconciliation`
      : undefined;
    const healthData = { ...data, errorOpenPositionCount, lastError: data.lastError ?? safetyError };
    await prisma.systemHealth.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", watchingCount, holdingCount, schedulerRunning: true, ...healthData },
      update: { watchingCount, holdingCount, ...healthData }
    });
  }
}

const managedTradingTokenWhere = {
  OR: [
    { status: { in: ["WATCHING", "HOLDING"] } },
    { status: "ERROR", positions: { some: { status: "OPEN" } } }
  ]
} satisfies Prisma.TokenWhereInput;

async function recoverTransientStates(): Promise<void> {
  const reactivated = await prisma.token.updateMany({
    where: { status: "CLOSED", positions: { none: { status: "OPEN" } } },
    data: { status: "WATCHING", removedAt: null, removeReason: null }
  });
  if (reactivated.count > 0) logger.info({ event: "closed_tokens_reactivated", count: reactivated.count });

  const transient = await prisma.token.findMany({
    where: { status: { in: ["BUYING", "SELLING"] } },
    include: { positions: { where: { status: "OPEN" }, take: 1 }, trades: { where: { status: "PENDING" }, take: 1 } }
  });
  for (const token of transient) {
    const hasPosition = token.positions.length > 0;
    if (hasPosition && token.positions[0]!.amountToken.isZero()) {
      await prisma.token.update({
        where: { id: token.id },
        data: { status: "ERROR", removeReason: "Position close must be reconciled after restart" }
      });
      continue;
    }
    if (token.trades.length > 0) {
      await prisma.token.update({
        where: { id: token.id },
        data: { status: "ERROR", removeReason: "Manual reconciliation required after interrupted prepared transaction" }
      });
      continue;
    }
    await prisma.token.update({
      where: { id: token.id },
      data: { status: hasPosition ? "HOLDING" : "WATCHING", removeReason: "Recovered before transaction preparation" }
    });
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
