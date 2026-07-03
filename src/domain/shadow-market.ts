export const SHADOW_CANDLE_INTERVAL_MS = 5 * 60 * 1000;

export type MainPoolCandidate = {
  pairAddress: string;
  dex: string | null;
  liquidityUsd: number | null;
};

type JsonRecord = Record<string, unknown>;

export function shadowCandleBucket(timestamp: number): number {
  return Math.floor(timestamp / SHADOW_CANDLE_INTERVAL_MS) * SHADOW_CANDLE_INTERVAL_MS;
}

export function selectMainPool(payload: unknown, tokenAddress: string): MainPoolCandidate | null {
  const candidates = new Map<string, MainPoolCandidate>();
  visitRecords(payload, (record) => {
    const pairAddress = firstString(record, ["pairAddress", "pair_address", "marketAddress", "market_address", "address"]);
    if (!pairAddress || pairAddress === tokenAddress || !looksLikeSolanaAddress(pairAddress)) return;
    const tokenAddresses = collectTokenAddresses(record);
    if (tokenAddresses.length > 0 && !tokenAddresses.includes(tokenAddress)) return;
    const liquidityUsd = firstNumber(record, ["liquidityUsd", "liquidity_usd", "liquidityUSD", "liquidity"]);
    const dex = firstString(record, ["dex", "dexName", "dex_name", "source"]);
    const previous = candidates.get(pairAddress);
    if (!previous || (liquidityUsd ?? -1) > (previous.liquidityUsd ?? -1)) {
      candidates.set(pairAddress, { pairAddress, dex, liquidityUsd });
    }
  });
  return [...candidates.values()].sort((left, right) => (right.liquidityUsd ?? -1) - (left.liquidityUsd ?? -1))[0] ?? null;
}

export function normalizePairPrices(payload: unknown, expectedPairs: string[]): Map<string, number> {
  const expected = new Set(expectedPairs);
  const prices = new Map<string, number>();
  const accept = (pairAddress: string, value: unknown): void => {
    if (!expected.has(pairAddress) || !isRecord(value)) return;
    const price = firstNumber(value, ["priceUsd", "price_usd", "priceUSD", "price"]);
    if (price != null && price > 0) prices.set(pairAddress, price);
  };
  visitRecords(payload, (record) => {
    const pairAddress = firstString(record, ["pairAddress", "pair_address", "marketAddress", "market_address", "address"]);
    if (pairAddress) accept(pairAddress, record);
    for (const [key, value] of Object.entries(record)) accept(key, value);
  });
  return prices;
}

function collectTokenAddresses(record: JsonRecord): string[] {
  const result = new Set<string>();
  for (const key of ["baseAddress", "base_address", "quoteAddress", "quote_address", "tokenAddress", "token_address"]) {
    const value = record[key];
    if (typeof value === "string") result.add(value);
  }
  for (const key of ["base", "quote", "baseToken", "quoteToken", "token0", "token1"]) {
    const value = record[key];
    if (!isRecord(value)) continue;
    const address = firstString(value, ["address", "mint"]);
    if (address) result.add(address);
  }
  return [...result];
}

function visitRecords(value: unknown, visitor: (record: JsonRecord) => void, depth = 0): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) visitRecords(item, visitor, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  visitor(value);
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isRecord(nested)) visitRecords(nested, visitor, depth + 1);
  }
}

function firstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function looksLikeSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
