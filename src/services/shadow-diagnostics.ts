import type { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { SHADOW_PRICE_MISMATCH_ERROR, normalizePairPrices } from "../domain/shadow-market.js";
import { fetchJson } from "./http.js";

type BirdeyeEnvelope<T> = { success?: boolean; data: T };
type DiagnosticPool = Awaited<ReturnType<typeof diagnosticPools>>[number];

export async function collectShadowPairDiagnostics(sampleSize = 3) {
  if (!config.BIRDEYE_API_KEY) throw new Error("BIRDEYE_API_KEY is required for shadow pair diagnostics");
  const limit = Number.isFinite(sampleSize) ? Math.max(1, Math.min(10, Math.trunc(sampleSize))) : 3;
  const [failed, successful, failedCount, successfulCount] = await Promise.all([
    diagnosticPools({ errorMessage: SHADOW_PRICE_MISMATCH_ERROR }, limit),
    diagnosticPools({ errorMessage: null, shadowRsiClosed: { not: null } }, limit),
    prisma.shadowPool.count({ where: { errorMessage: SHADOW_PRICE_MISMATCH_ERROR } }),
    prisma.shadowPool.count({ where: { errorMessage: null, shadowRsiClosed: { not: null } } })
  ]);

  const samples = [];
  for (const pool of [...failed.map((value) => ({ classification: "price_mismatch" as const, pool: value })), ...successful.map((value) => ({ classification: "successful" as const, pool: value }))]) {
    samples.push(await inspectPool(pool.classification, pool.pool));
  }
  return {
    generatedAt: new Date().toISOString(),
    note: "Responses contain Birdeye market data only. Request headers and API keys are never included.",
    totals: { priceMismatch: failedCount, successfulWithRsi: successfulCount },
    samples
  };
}

function diagnosticPools(where: Prisma.ShadowPoolWhereInput, take = 3) {
  return prisma.shadowPool.findMany({
    where,
    include: { token: { select: { address: true, symbol: true, priceUsd: true, status: true } } },
    orderBy: { updatedAt: "desc" },
    take
  });
}

async function inspectPool(classification: "price_mismatch" | "successful", pool: DiagnosticPool) {
  const marketsUrl = new URL("/defi/v2/markets", config.BIRDEYE_BASE_URL);
  marketsUrl.searchParams.set("address", pool.tokenAddress);
  marketsUrl.searchParams.set("sort_by", "liquidity");
  marketsUrl.searchParams.set("sort_type", "desc");
  marketsUrl.searchParams.set("limit", String(config.SHADOW_POOL_DISCOVERY_LIMIT));

  const pairUrl = new URL("/defi/v3/pair/overview/multiple", config.BIRDEYE_BASE_URL);
  pairUrl.searchParams.set("list_address", pool.pairAddress);
  pairUrl.searchParams.set("ui_amount_mode", "scaled");

  const [markets, pairOverview] = await Promise.all([
    requestDiagnostic(marketsUrl),
    requestDiagnostic(pairUrl)
  ]);
  const pairPrice = pairOverview.ok ? normalizePairPrices(pairOverview.data, [pool.pairAddress]).get(pool.pairAddress) ?? null : null;
  const tokenPriceUsd = pool.token.priceUsd == null ? null : Number(pool.token.priceUsd);
  return {
    classification,
    token: { address: pool.token.address, symbol: pool.token.symbol, status: pool.token.status, priceUsd: tokenPriceUsd },
    pinnedPool: { pairAddress: pool.pairAddress, dex: pool.dex, liquidityUsd: pool.liquidityUsd?.toString() ?? null, selectedAt: pool.selectedAt },
    parsedPairPrice: pairPrice,
    pairToTokenPriceRatio: pairPrice && tokenPriceUsd ? pairPrice / tokenPriceUsd : null,
    markets,
    pairOverview
  };
}

async function requestDiagnostic(url: URL): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetchJson<BirdeyeEnvelope<unknown>>(url, {
      headers: { "X-API-KEY": config.BIRDEYE_API_KEY, "x-chain": "solana" }
    });
    return { ok: true, data: response.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) };
  }
}
