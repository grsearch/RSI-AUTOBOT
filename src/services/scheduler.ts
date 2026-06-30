import pLimit from "p-limit";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { HealthService } from "./health.js";
import { MarketDataService } from "./market-data.js";
import { StrategyEngine } from "./strategy-engine.js";

export class Scheduler {
  private marketTimer: NodeJS.Timeout | null = null;
  private strategyTimer: NodeJS.Timeout | null = null;
  private marketRunning = false;
  private strategyRunning = false;
  private lastCleanupAt = 0;
  private readonly market = new MarketDataService();
  private readonly strategy = new StrategyEngine();
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
  }

  async stop(): Promise<void> {
    if (this.marketTimer) clearInterval(this.marketTimer);
    if (this.strategyTimer) clearInterval(this.strategyTimer);
    await prisma.systemHealth.update({ where: { id: "singleton" }, data: { schedulerRunning: false } }).catch(() => undefined);
  }

  private async marketCycle(): Promise<void> {
    if (this.marketRunning) return;
    this.marketRunning = true;
    const limit = pLimit(config.MARKET_REQUEST_CONCURRENCY);
    try {
      const tokens = await prisma.token.findMany({ where: { status: { in: ["WATCHING", "HOLDING"] } } });
      const results = await Promise.allSettled(tokens.map((token) => limit(() => this.market.refreshToken(token))));
      const failures = results.filter((result) => result.status === "rejected");
      const probes = await this.health.probe();
      const lastError = failures[0]?.status === "rejected" ? errorMessage(failures[0].reason) : probes.errors[0] ?? null;
      await this.updateHealth({ birdeyeOk: Boolean(config.BIRDEYE_API_KEY) && failures.length === 0, heliusOk: probes.heliusOk, jupiterQuoteOk: probes.jupiterQuoteOk, lastMarketCycleAt: new Date(), lastError });
      if (failures.length > 0) logger.error({ event: "market_cycle_partial_failure", failures: failures.length, tokens: tokens.length, lastError });
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
        where: { status: { in: ["WATCHING", "HOLDING"] } },
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

  private async updateHealth(data: { birdeyeOk?: boolean; heliusOk?: boolean; jupiterQuoteOk?: boolean; lastMarketCycleAt?: Date; lastStrategyCycleAt?: Date; lastError?: string | null }): Promise<void> {
    const [watchingCount, holdingCount] = await Promise.all([
      prisma.token.count({ where: { status: "WATCHING" } }),
      prisma.position.count({ where: { status: "OPEN" } })
    ]);
    await prisma.systemHealth.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", watchingCount, holdingCount, schedulerRunning: true, ...data },
      update: { watchingCount, holdingCount, ...data }
    });
  }
}

async function recoverTransientStates(): Promise<void> {
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
