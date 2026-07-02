import type { Token } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { attachRsi } from "../domain/indicators.js";
import { MARKET_CANDLE_INTERVAL_MS, MARKET_CANDLE_TIMEFRAME } from "../domain/market.js";
import type { Candle, MarketPoint } from "../domain/types.js";
import { logger } from "../logger.js";
import { fetchJson } from "./http.js";

type BirdeyeEnvelope<T> = { success?: boolean; data: T };
type OverviewPayload = Record<string, unknown>;
type OhlcvPayload = { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
const MIN_RSI_HISTORY_CANDLES = 100;
const RSI_HISTORY_MULTIPLIER = 15;
const MARKET_DATA_BATCH_SIZE = 20;
const CREATION_TIME_RETRY_MS = 6 * 60 * 60 * 1000;
const SOL_PRICE_CACHE_MS = 5 * 60 * 1000;
const SOL_PRICE_FAILURE_RETRY_MS = 60 * 1000;

export class MarketDataService {
  private solPriceCache: { value: number; expiresAt: number } | null = null;
  private solPricePending: Promise<number> | null = null;
  private solPriceRetryAfter = 0;
  private readonly creationTimeRetryAfter = new Map<string, number>();
  private readonly ohlcvRequestAfter = new Map<string, number>();

  async getMarketDataMultiple(addresses: string[]): Promise<Map<string, OverviewPayload>> {
    const result = new Map<string, OverviewPayload>();
    for (let index = 0; index < addresses.length; index += MARKET_DATA_BATCH_SIZE) {
      const batch = addresses.slice(index, index + MARKET_DATA_BATCH_SIZE);
      try {
        const url = new URL("/defi/v3/token/market-data/multiple", config.BIRDEYE_BASE_URL);
        url.searchParams.set("list_address", batch.join(","));
        url.searchParams.set("ui_amount_mode", "scaled");
        const response = await this.request<BirdeyeEnvelope<unknown>>(url);
        for (const [address, market] of normalizeMarketDataBatch(response.data, batch)) result.set(address, market);
      } catch (error) {
        logger.warn({ event: "birdeye_market_batch_failed", batchSize: batch.length, error: errorMessage(error) });
      }
    }
    return result;
  }

  async refreshToken(token: Token, prefetchedOverview?: OverviewPayload): Promise<MarketPoint> {
    if (!config.BIRDEYE_API_KEY) throw new Error("BIRDEYE_API_KEY is required for market refresh");
    const refreshStartedAt = Date.now();
    const ohlcvNeeded = shouldRefreshOhlcv(token.lastOhlcvAt, refreshStartedAt)
      && (this.ohlcvRequestAfter.get(token.address) ?? 0) <= refreshStartedAt;
    if (ohlcvNeeded) this.ohlcvRequestAfter.set(token.address, floor5Minutes(refreshStartedAt) + MARKET_CANDLE_INTERVAL_MS);
    const overviewPromise = prefetchedOverview && hasRequiredMarketData(prefetchedOverview)
      ? Promise.resolve(prefetchedOverview)
      : this.getOverview(token.address);
    const [overview, candles, chainCreatedAt, solPriceUsd] = await Promise.all([
      overviewPromise,
      ohlcvNeeded ? this.getOhlcvWithHistory(token, refreshStartedAt) : Promise.resolve(null),
      this.resolveCreationTime(token),
      this.getSolPriceUsd()
    ]);

    const priceUsd = pickNumber(overview, ["price", "priceUsd", "value"]);
    const fdvUsd = pickNumber(overview, ["fdv", "fullyDilutedValuation"]);
    const liquidityUsd = pickNumber(overview, ["liquidity", "liquidityUsd"]);
    const volume24hUsd = marketVolume24hUsd(overview);
    if (!(priceUsd > 0) || !(fdvUsd >= 0) || !(liquidityUsd >= 0)) {
      throw new Error(`Birdeye returned incomplete market data for ${token.address}`);
    }

    const decimals = optionalNumber(overview, ["decimals"]);
    const closedCandles = candles?.filter((candle) => candle.timestamp.getTime() < floor5Minutes(refreshStartedAt)) ?? null;
    const withRsi = closedCandles ? attachRsi(closedCandles, config.RSI_PERIOD) : null;
    const latestClosedAt = withRsi?.at(-1)?.timestamp.getTime();
    const hasRefreshedRsi = Boolean(withRsi?.length);
    const latestRsi = hasRefreshedRsi ? withRsi!.at(-1)?.rsi ?? null : token.rsi == null ? null : Number(token.rsi);
    const now = new Date();
    const ageMinutes = chainCreatedAt ? Math.max(0, (now.getTime() - chainCreatedAt.getTime()) / 60_000) : null;
    const priceSol = solPriceUsd > 0 ? priceUsd / solPriceUsd : null;

    await prisma.$transaction(async (tx) => {
      if (withRsi && withRsi.length > 0) {
        await tx.ohlcvCandle.createMany({
          skipDuplicates: true,
          data: withRsi.map((candle) => candleRecord(
            token.id,
            token.address,
            candle,
            candle.timestamp.getTime() === latestClosedAt ? fdvUsd : null,
            candle.timestamp.getTime() === latestClosedAt ? liquidityUsd : null,
            candle.timestamp.getTime() === latestClosedAt ? ageMinutes : null
          ))
        });
      }

      const openPosition = await tx.position.findFirst({ where: { tokenId: token.id, status: "OPEN" } });
      const pnlPercent = openPosition
        ? ((priceUsd - Number(openPosition.averageEntryPriceUsd)) / Number(openPosition.averageEntryPriceUsd)) * 100
        : null;

      await tx.token.update({
        where: { id: token.id },
        data: {
          previousRsi: hasRefreshedRsi ? token.rsi : undefined,
          rsi: hasRefreshedRsi ? latestRsi : undefined,
          fdvUsd,
          liquidityUsd,
          volume24hUsd: volume24hUsd ?? undefined,
          ageMinutes,
          priceUsd,
          priceSol,
          decimals: decimals == null ? undefined : Math.trunc(decimals),
          chainCreatedAt: chainCreatedAt ?? undefined,
          lastOhlcvAt: hasRefreshedRsi ? withRsi!.at(-1)?.timestamp : undefined,
          lastMarketCheckAt: now
        }
      });

      await tx.marketSnapshot.create({
        data: {
          tokenId: token.id,
          address: token.address,
          priceUsd,
          priceSol,
          fdvUsd,
          liquidityUsd,
          ageMinutes,
          rsi: latestRsi,
          tokenStatus: token.status,
          positionStatus: openPosition?.status,
          pnlPercent,
          trailingActivated: openPosition?.trailingActivated ?? false,
          highestPriceUsd: openPosition?.highestPriceUsd
        }
      });
    });

    logger.info({
      event: "market_data_updated",
      address: token.address,
      priceUsd,
      fdvUsd,
      liquidityUsd,
      volume24hUsd,
      rsi: latestRsi,
      rsiCandleCount: withRsi?.length ?? 0,
      candleTimeframe: MARKET_CANDLE_TIMEFRAME,
      ohlcvRequested: ohlcvNeeded
    });
    return { timestamp: now, priceUsd, priceSol, fdvUsd, liquidityUsd, ageMinutes, rsi: latestRsi };
  }

  async getSolPriceUsd(): Promise<number> {
    if (this.solPriceCache && this.solPriceCache.expiresAt > Date.now()) return this.solPriceCache.value;
    if (this.solPriceRetryAfter > Date.now()) {
      if (this.solPriceCache) return this.solPriceCache.value;
      throw new Error("Birdeye SOL price retry is temporarily delayed");
    }
    if (this.solPricePending) return this.solPricePending;
    this.solPricePending = this.fetchSolPriceUsd();
    try {
      const value = await this.solPricePending;
      this.solPriceRetryAfter = 0;
      return value;
    } catch (error) {
      this.solPriceRetryAfter = Date.now() + SOL_PRICE_FAILURE_RETRY_MS;
      throw error;
    } finally {
      this.solPricePending = null;
    }
  }

  private async fetchSolPriceUsd(): Promise<number> {
    const url = new URL("/defi/price", config.BIRDEYE_BASE_URL);
    url.searchParams.set("address", "So11111111111111111111111111111111111111112");
    const response = await this.request<BirdeyeEnvelope<Record<string, unknown>>>(url);
    const value = pickNumber(response.data, ["value", "price"]);
    if (!(value > 0)) throw new Error("Birdeye SOL price is unavailable");
    this.solPriceCache = { value, expiresAt: Date.now() + SOL_PRICE_CACHE_MS };
    return value;
  }

  private async getOverview(address: string): Promise<OverviewPayload> {
    const url = new URL("/defi/token_overview", config.BIRDEYE_BASE_URL);
    url.searchParams.set("address", address);
    url.searchParams.set("frames", MARKET_CANDLE_TIMEFRAME);
    url.searchParams.set("ui_amount_mode", "scaled");
    const response = await this.request<BirdeyeEnvelope<OverviewPayload>>(url);
    return response.data;
  }

  private async getOhlcvWithHistory(token: Token, now: number): Promise<Candle[]> {
    const historyCandleCount = rsiHistoryCandleCount();
    const storedRows = await prisma.ohlcvCandle.findMany({
      where: { tokenId: token.id, timeframe: MARKET_CANDLE_TIMEFRAME },
      orderBy: { timestamp: "desc" },
      take: historyCandleCount
    });
    const latestExpected = latestClosedCandleTimestamp(now);
    const missingCandleCount = token.lastOhlcvAt
      ? Math.max(1, Math.ceil((latestExpected - token.lastOhlcvAt.getTime()) / MARKET_CANDLE_INTERVAL_MS))
      : historyCandleCount;
    const fetchCount = storedRows.length >= historyCandleCount
      ? Math.min(historyCandleCount, Math.max(config.RSI_PERIOD + 3, missingCandleCount + 2))
      : historyCandleCount;
    const freshCandles = await this.getOhlcv(token.address, fetchCount, now);
    const candlesByTimestamp = new Map<number, Candle>();
    for (const row of storedRows.reverse()) {
      candlesByTimestamp.set(row.timestamp.getTime(), {
        timestamp: row.timestamp,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume)
      });
    }
    for (const candle of freshCandles) candlesByTimestamp.set(candle.timestamp.getTime(), candle);
    return [...candlesByTimestamp.values()]
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .slice(-historyCandleCount);
  }

  private async getOhlcv(address: string, count: number, now: number): Promise<Candle[]> {
    const nowSeconds = Math.floor(now / 1000);
    const url = new URL("/defi/v3/ohlcv", config.BIRDEYE_BASE_URL);
    url.searchParams.set("address", address);
    url.searchParams.set("type", MARKET_CANDLE_TIMEFRAME);
    url.searchParams.set("currency", "usd");
    url.searchParams.set("time_to", String(nowSeconds));
    url.searchParams.set("mode", "count");
    url.searchParams.set("count_limit", String(count));
    url.searchParams.set("ui_amount_mode", "scaled");
    url.searchParams.set("padding", "false");
    url.searchParams.set("outlier", "false");
    const response = await this.request<BirdeyeEnvelope<OhlcvPayload>>(url);
    const items = Array.isArray(response.data) ? response.data : response.data.items ?? [];
    const candlesByTimestamp = new Map<number, Candle>();
    for (const item of items) {
      const candle = parseCandle(item);
      if (candle) candlesByTimestamp.set(candle.timestamp.getTime(), candle);
    }
    return [...candlesByTimestamp.values()].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  }

  private async resolveCreationTime(token: Token): Promise<Date | null> {
    if (token.chainCreatedAt) return token.chainCreatedAt;
    const retryAfter = this.creationTimeRetryAfter.get(token.address) ?? 0;
    if (retryAfter > Date.now()) return null;
    const createdAt = await this.getCreationTime(token.address);
    if (createdAt) this.creationTimeRetryAfter.delete(token.address);
    else this.creationTimeRetryAfter.set(token.address, Date.now() + CREATION_TIME_RETRY_MS);
    return createdAt;
  }

  private async getCreationTime(address: string): Promise<Date | null> {
    try {
      const url = new URL("/defi/token_creation_info", config.BIRDEYE_BASE_URL);
      url.searchParams.set("address", address);
      const response = await this.request<BirdeyeEnvelope<Record<string, unknown>>>(url);
      const seconds = optionalNumber(response.data, ["blockUnixTime", "block_unix_time", "unixTime", "createdAt"]);
      return seconds ? new Date(seconds > 10_000_000_000 ? seconds : seconds * 1000) : null;
    } catch (error) {
      logger.warn({ event: "token_creation_time_unavailable", address, error: errorMessage(error) });
      return null;
    }
  }

  private request<T>(url: URL): Promise<T> {
    return fetchJson<T>(url, { headers: { "X-API-KEY": config.BIRDEYE_API_KEY, "x-chain": "solana" } });
  }
}

export function shouldRefreshOhlcv(lastOhlcvAt: Date | null, now: number): boolean {
  return lastOhlcvAt == null || lastOhlcvAt.getTime() < latestClosedCandleTimestamp(now);
}

export function normalizeMarketDataBatch(payload: unknown, expectedAddresses: string[]): Map<string, OverviewPayload> {
  const expected = new Set(expectedAddresses);
  const result = new Map<string, OverviewPayload>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;

    const ownAddress = typeof value.address === "string" ? value.address : null;
    if (ownAddress && expected.has(ownAddress)) result.set(ownAddress, value);

    for (const [key, nested] of Object.entries(value)) {
      if (expected.has(key) && isRecord(nested)) result.set(key, nested);
      if (key === "data" || key === "items" || key === "tokens") visit(nested, depth + 1);
    }
  };

  visit(payload, 0);
  return result;
}

export function marketVolume24hUsd(value: OverviewPayload): number | null {
  return optionalNumber(value, ["volume_24h_usd", "volume24hUsd", "volume24hUSD", "v24hUSD", "volume24h"]);
}

function hasRequiredMarketData(value: OverviewPayload): boolean {
  return pickNumber(value, ["price", "priceUsd", "value"]) > 0
    && pickNumber(value, ["fdv", "fullyDilutedValuation"]) >= 0
    && pickNumber(value, ["liquidity", "liquidityUsd"]) >= 0;
}

function latestClosedCandleTimestamp(now: number): number {
  return floor5Minutes(now) - MARKET_CANDLE_INTERVAL_MS;
}

function rsiHistoryCandleCount(): number {
  return Math.min(5000, Math.max(MIN_RSI_HISTORY_CANDLES, config.RSI_PERIOD * RSI_HISTORY_MULTIPLIER));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function candleRecord(tokenId: string, address: string, candle: Candle, fdvUsd: number | null, liquidityUsd: number | null, ageMinutes: number | null): Prisma.OhlcvCandleUncheckedCreateInput {
  return {
    tokenId,
    address,
    timestamp: candle.timestamp,
    timeframe: MARKET_CANDLE_TIMEFRAME,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    rsi7: candle.rsi ?? undefined,
    fdvUsd: fdvUsd ?? undefined,
    liquidityUsd: liquidityUsd ?? undefined,
    ageMinutes: ageMinutes ?? undefined,
    source: "birdeye"
  };
}

function parseCandle(raw: Record<string, unknown>): Candle | null {
  const seconds = optionalNumber(raw, ["unixTime", "unix_time", "timestamp", "time"]);
  const open = optionalNumber(raw, ["o", "open"]);
  const high = optionalNumber(raw, ["h", "high"]);
  const low = optionalNumber(raw, ["l", "low"]);
  const close = optionalNumber(raw, ["c", "close"]);
  const volume = optionalNumber(raw, ["v", "volume", "v_usd"]) ?? 0;
  if (seconds == null || open == null || high == null || low == null || close == null) return null;
  const timestamp = new Date(seconds > 10_000_000_000 ? seconds : seconds * 1000);
  const malformedRange = low <= 0 || high <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || high < low;
  if (!Number.isFinite(timestamp.getTime()) || open <= 0 || close <= 0 || malformedRange || volume < 0) return null;
  return { timestamp, open, high, low, close, volume };
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number {
  return optionalNumber(source, keys) ?? Number.NaN;
}

function optionalNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function floor5Minutes(timestamp: number): number {
  return Math.floor(timestamp / MARKET_CANDLE_INTERVAL_MS) * MARKET_CANDLE_INTERVAL_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
