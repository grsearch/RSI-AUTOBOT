import { Prisma, type ShadowPool } from "@prisma/client";
import pLimit from "p-limit";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { calculateRsi } from "../domain/indicators.js";
import { SHADOW_CANDLE_INTERVAL_MS, SHADOW_PRICE_MISMATCH_ERROR, isShadowPoolSampleable, normalizePairPrices, selectMainPool, shadowCandleBucket } from "../domain/shadow-market.js";
import { logger } from "../logger.js";
import { fetchJson } from "./http.js";

type BirdeyeEnvelope<T> = { success?: boolean; data: T };
const PAIR_BATCH_SIZE = 20;
const RSI_HISTORY_SIZE = 105;
const MIN_SAMPLES_PER_CLOSED_CANDLE = 3;
const POOL_DISCOVERY_RETRY_MS = 6 * 60 * 60 * 1000;
const POOL_DISCOVERY_BATCH_SIZE = 10;
const PAIR_PERMISSION_RETRY_MS = 6 * 60 * 60 * 1000;
const PAIR_RATE_LIMIT_RETRY_MS = 5 * 60 * 1000;
type ActiveShadowPool = ShadowPool & { token: { priceUsd: Prisma.Decimal | null } };

export class ShadowMarketService {
  private readonly poolDiscoveryRetryAfter = new Map<string, number>();
  private pairRequestRetryAfter = 0;

  async runCycle(): Promise<void> {
    if (!config.SHADOW_RSI_ENABLED) return;
    if (!config.BIRDEYE_API_KEY) throw new Error("BIRDEYE_API_KEY is required for shadow RSI collection");

    await this.discoverMissingPools();
    const pools = await prisma.shadowPool.findMany({
      where: { token: { status: { in: ["WATCHING", "HOLDING"] } } },
      include: { token: { select: { priceUsd: true } } },
      orderBy: { selectedAt: "asc" }
    });
    if (pools.length === 0) return;
    const sampleablePools = pools.filter((pool) => isShadowPoolSampleable(pool.errorMessage));
    const blockedPools = pools.length - sampleablePools.length;
    if (sampleablePools.length === 0) {
      logger.info({ event: "shadow_rsi_cycle_skipped", reason: "all_pools_price_mismatch", blockedPools });
      return;
    }
    if (this.pairRequestRetryAfter > Date.now()) {
      logger.warn({ event: "shadow_pair_sampling_backoff", retryAt: new Date(this.pairRequestRetryAfter) });
      return;
    }

    const sampledAt = Date.now();
    const prices = await this.getPairPrices(sampleablePools.map((pool) => pool.pairAddress));
    const limit = pLimit(config.MARKET_REQUEST_CONCURRENCY);
    const results = await Promise.allSettled(sampleablePools.map((pool) => limit(async () => {
      const priceUsd = prices.get(pool.pairAddress);
      if (!(priceUsd && priceUsd > 0)) {
        await prisma.shadowPool.update({
          where: { id: pool.id },
          data: { errorMessage: "Birdeye pair overview did not return a positive USD price" }
        });
        return false;
      }
      const tradingPriceUsd = pool.token.priceUsd == null ? null : Number(pool.token.priceUsd);
      if (tradingPriceUsd && (priceUsd / tradingPriceUsd < 0.1 || priceUsd / tradingPriceUsd > 10)) {
        await prisma.shadowPool.update({
          where: { id: pool.id },
          data: { errorMessage: SHADOW_PRICE_MISMATCH_ERROR }
        });
        return false;
      }
      await this.storeSample(pool, priceUsd, sampledAt);
      return true;
    })));

    const updated = results.filter((result) => result.status === "fulfilled" && result.value).length;
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      logger.warn({ event: "shadow_rsi_partial_failure", failed: failed.length, pools: pools.length, error: errorMessage(failed[0]!.reason) });
    }
    logger.info({ event: "shadow_rsi_cycle_completed", pools: pools.length, sampleablePools: sampleablePools.length, blockedPools, prices: prices.size, updated });
  }

  private async discoverMissingPools(): Promise<void> {
    const tokens = await prisma.token.findMany({
      where: {
        status: { in: ["WATCHING", "HOLDING"] },
        shadowPool: null
      },
      select: { id: true, address: true }
    });
    const dueTokens = tokens.filter((token) => (this.poolDiscoveryRetryAfter.get(token.address) ?? 0) <= Date.now());
    if (dueTokens.length === 0) return;

    const limit = pLimit(config.SHADOW_POOL_DISCOVERY_CONCURRENCY);
    await Promise.allSettled(dueTokens.slice(0, POOL_DISCOVERY_BATCH_SIZE).map((token) => limit(async () => {
      try {
        const candidate = await this.getMainPool(token.address);
        if (!candidate) {
          this.poolDiscoveryRetryAfter.set(token.address, Date.now() + POOL_DISCOVERY_RETRY_MS);
          logger.warn({ event: "shadow_pool_not_found", address: token.address, retryAfterMs: POOL_DISCOVERY_RETRY_MS });
          return;
        }
        await prisma.shadowPool.upsert({
          where: { tokenId: token.id },
          create: {
            tokenId: token.id,
            tokenAddress: token.address,
            pairAddress: candidate.pairAddress,
            dex: candidate.dex,
            liquidityUsd: candidate.liquidityUsd
          },
          update: {}
        });
        this.poolDiscoveryRetryAfter.delete(token.address);
        logger.info({ event: "shadow_pool_pinned", address: token.address, ...candidate });
      } catch (error) {
        this.poolDiscoveryRetryAfter.set(token.address, Date.now() + POOL_DISCOVERY_RETRY_MS);
        logger.warn({ event: "shadow_pool_discovery_failed", address: token.address, retryAfterMs: POOL_DISCOVERY_RETRY_MS, error: errorMessage(error) });
      }
    })));
  }

  private async getMainPool(tokenAddress: string) {
    const url = new URL("/defi/v2/markets", config.BIRDEYE_BASE_URL);
    url.searchParams.set("address", tokenAddress);
    url.searchParams.set("sort_by", "liquidity");
    url.searchParams.set("sort_type", "desc");
    url.searchParams.set("limit", String(config.SHADOW_POOL_DISCOVERY_LIMIT));
    const response = await this.request<BirdeyeEnvelope<unknown>>(url);
    return selectMainPool(response.data, tokenAddress);
  }

  private async getPairPrices(pairAddresses: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const uniquePairAddresses = [...new Set(pairAddresses)];
    for (let index = 0; index < uniquePairAddresses.length; index += PAIR_BATCH_SIZE) {
      const batch = uniquePairAddresses.slice(index, index + PAIR_BATCH_SIZE);
      try {
        const url = new URL("/defi/v3/pair/overview/multiple", config.BIRDEYE_BASE_URL);
        url.searchParams.set("list_address", batch.join(","));
        url.searchParams.set("ui_amount_mode", "scaled");
        const response = await this.request<BirdeyeEnvelope<unknown>>(url);
        const normalized = normalizePairPrices(response.data, batch);
        for (const [pairAddress, price] of normalized) result.set(pairAddress, price);
        if (normalized.size === 0) {
          logger.warn({ event: "shadow_pair_batch_empty", batchSize: batch.length, responseShape: responseShape(response.data) });
        }
      } catch (error) {
        logger.warn({ event: "shadow_pair_batch_failed", batchSize: batch.length, error: errorMessage(error) });
        const message = errorMessage(error);
        if (/HTTP (401|403)/.test(message)) this.pairRequestRetryAfter = Date.now() + PAIR_PERMISSION_RETRY_MS;
        else if (/HTTP 429/.test(message)) this.pairRequestRetryAfter = Date.now() + PAIR_RATE_LIMIT_RETRY_MS;
        if (this.pairRequestRetryAfter > Date.now()) break;
      }
    }
    return result;
  }

  private async storeSample(pool: ActiveShadowPool, priceUsd: number, sampledAt: number): Promise<void> {
    const timestamp = new Date(shadowCandleBucket(sampledAt));
    await prisma.$transaction(async (tx) => {
      await tx.shadowCandle.updateMany({
        where: { shadowPoolId: pool.id, timestamp: { lt: timestamp }, isClosed: false },
        data: { isClosed: true }
      });

      const current = await tx.shadowCandle.findUnique({
        where: { shadowPoolId_timestamp: { shadowPoolId: pool.id, timestamp } }
      });
      if (current) {
        await tx.shadowCandle.update({
          where: { id: current.id },
          data: {
            high: Math.max(Number(current.high), priceUsd),
            low: Math.min(Number(current.low), priceUsd),
            close: priceUsd,
            sampleCount: { increment: 1 }
          }
        });
      } else {
        await tx.shadowCandle.create({
          data: {
            shadowPoolId: pool.id,
            pairAddress: pool.pairAddress,
            timestamp,
            open: priceUsd,
            high: priceUsd,
            low: priceUsd,
            close: priceUsd
          }
        });
      }

      const closedDescending = await tx.shadowCandle.findMany({
        where: {
          shadowPoolId: pool.id,
          isClosed: true,
          timestamp: { gte: new Date(shadowCandleBucket(pool.selectedAt.getTime()) + SHADOW_CANDLE_INTERVAL_MS) }
        },
        orderBy: { timestamp: "desc" },
        take: RSI_HISTORY_SIZE
      });
      const closed = contiguousCompleteCandles(closedDescending.reverse(), timestamp.getTime() - SHADOW_CANDLE_INTERVAL_MS);
      const closedValues = calculateRsi(closed.map((candle) => Number(candle.close)), config.RSI_PERIOD);
      const shadowRsiClosed = closedValues.at(-1) ?? null;
      const shadowRsiLive = calculateRsi([...closed.map((candle) => Number(candle.close)), priceUsd], config.RSI_PERIOD).at(-1) ?? null;
      const lastClosed = closed.at(-1);
      if (lastClosed && shadowRsiClosed != null && (lastClosed.rsi7 == null || Number(lastClosed.rsi7) !== shadowRsiClosed)) {
        await tx.shadowCandle.update({ where: { id: lastClosed.id }, data: { rsi7: shadowRsiClosed } });
      }
      await tx.shadowPool.update({
        where: { id: pool.id },
        data: {
          lastSampleAt: new Date(sampledAt),
          lastPriceUsd: priceUsd,
          shadowRsiClosed,
          shadowRsiLive,
          lastClosedCandleAt: lastClosed?.timestamp,
          errorMessage: null
        }
      });
    });
  }

  private request<T>(url: URL): Promise<T> {
    return fetchJson<T>(url, { headers: { "X-API-KEY": config.BIRDEYE_API_KEY, "x-chain": "solana" } });
  }
}

function contiguousCompleteCandles<T extends { timestamp: Date; sampleCount: number }>(candles: T[], expectedLatestAt: number): T[] {
  if (candles.at(-1)?.timestamp.getTime() !== expectedLatestAt) return [];
  let start = candles.length;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index]!;
    const next = candles[index + 1];
    if (candle.sampleCount < MIN_SAMPLES_PER_CLOSED_CANDLE) break;
    if (next && next.timestamp.getTime() - candle.timestamp.getTime() !== SHADOW_CANDLE_INTERVAL_MS) break;
    start = index;
  }
  return candles.slice(start);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function responseShape(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [typeof value];
  return Object.keys(value).slice(0, 20);
}
