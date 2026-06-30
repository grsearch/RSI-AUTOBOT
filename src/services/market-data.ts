import type { Token } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { attachRsi } from "../domain/indicators.js";
import type { Candle, MarketPoint } from "../domain/types.js";
import { logger } from "../logger.js";
import { fetchJson } from "./http.js";

type BirdeyeEnvelope<T> = { success?: boolean; data: T };
type OverviewPayload = Record<string, unknown>;
type OhlcvPayload = { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;

export class MarketDataService {
  private solPriceCache: { value: number; expiresAt: number } | null = null;

  async refreshToken(token: Token): Promise<MarketPoint> {
    if (!config.BIRDEYE_API_KEY) throw new Error("BIRDEYE_API_KEY is required for market refresh");
    const [overview, candles, chainCreatedAt, solPriceUsd] = await Promise.all([
      this.getOverview(token.address),
      this.getOhlcv(token.address),
      token.chainCreatedAt ? Promise.resolve(token.chainCreatedAt) : this.getCreationTime(token.address),
      this.getSolPriceUsd()
    ]);

    const priceUsd = pickNumber(overview, ["price", "priceUsd", "value"]);
    const fdvUsd = pickNumber(overview, ["fdv", "fullyDilutedValuation"]);
    const liquidityUsd = pickNumber(overview, ["liquidity", "liquidityUsd"]);
    if (!(priceUsd > 0) || !(fdvUsd >= 0) || !(liquidityUsd >= 0)) {
      throw new Error(`Birdeye returned incomplete market data for ${token.address}`);
    }

    const decimals = optionalNumber(overview, ["decimals"]);
    const closedCandles = candles.filter((candle) => candle.timestamp.getTime() < floorMinute(Date.now()));
    const withRsi = attachRsi(closedCandles, config.RSI_PERIOD);
    const latestClosedAt = withRsi.at(-1)?.timestamp.getTime();
    const latestRsi = withRsi.at(-1)?.rsi ?? null;
    const now = new Date();
    const ageMinutes = chainCreatedAt ? Math.max(0, (now.getTime() - chainCreatedAt.getTime()) / 60_000) : null;
    const priceSol = solPriceUsd > 0 ? priceUsd / solPriceUsd : null;

    await prisma.$transaction(async (tx) => {
      if (withRsi.length > 0) {
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
          previousRsi: token.rsi,
          rsi: latestRsi,
          fdvUsd,
          liquidityUsd,
          ageMinutes,
          priceUsd,
          priceSol,
          decimals: decimals == null ? undefined : Math.trunc(decimals),
          chainCreatedAt: chainCreatedAt ?? undefined,
          lastOhlcvAt: withRsi.at(-1)?.timestamp,
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

    logger.info({ event: "market_data_updated", address: token.address, priceUsd, fdvUsd, liquidityUsd, rsi: latestRsi });
    return { timestamp: now, priceUsd, priceSol, fdvUsd, liquidityUsd, ageMinutes, rsi: latestRsi };
  }

  async getSolPriceUsd(): Promise<number> {
    if (this.solPriceCache && this.solPriceCache.expiresAt > Date.now()) return this.solPriceCache.value;
    const url = new URL("/defi/price", config.BIRDEYE_BASE_URL);
    url.searchParams.set("address", "So11111111111111111111111111111111111111112");
    const response = await this.request<BirdeyeEnvelope<Record<string, unknown>>>(url);
    const value = pickNumber(response.data, ["value", "price"]);
    if (!(value > 0)) throw new Error("Birdeye SOL price is unavailable");
    this.solPriceCache = { value, expiresAt: Date.now() + 15_000 };
    return value;
  }

  private async getOverview(address: string): Promise<OverviewPayload> {
    const url = new URL("/defi/token_overview", config.BIRDEYE_BASE_URL);
    url.searchParams.set("address", address);
    url.searchParams.set("frames", "1m");
    url.searchParams.set("ui_amount_mode", "scaled");
    const response = await this.request<BirdeyeEnvelope<OverviewPayload>>(url);
    return response.data;
  }

  private async getOhlcv(address: string): Promise<Candle[]> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const url = new URL("/defi/ohlcv", config.BIRDEYE_BASE_URL);
    url.searchParams.set("address", address);
    url.searchParams.set("type", "1m");
    url.searchParams.set("currency", "usd");
    url.searchParams.set("time_from", String(nowSeconds - 60 * Math.max(60, config.RSI_PERIOD * 5)));
    url.searchParams.set("time_to", String(nowSeconds));
    const response = await this.request<BirdeyeEnvelope<OhlcvPayload>>(url);
    const items = Array.isArray(response.data) ? response.data : response.data.items ?? [];
    return items
      .map(parseCandle)
      .filter((candle): candle is Candle => candle != null)
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
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

function candleRecord(tokenId: string, address: string, candle: Candle, fdvUsd: number | null, liquidityUsd: number | null, ageMinutes: number | null): Prisma.OhlcvCandleUncheckedCreateInput {
  return {
    tokenId,
    address,
    timestamp: candle.timestamp,
    timeframe: "1m",
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
  const volume = optionalNumber(raw, ["v", "volume"]) ?? 0;
  if (seconds == null || open == null || high == null || low == null || close == null) return null;
  const timestamp = new Date(seconds > 10_000_000_000 ? seconds : seconds * 1000);
  if (!Number.isFinite(timestamp.getTime()) || open <= 0 || close <= 0) return null;
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

function floorMinute(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
