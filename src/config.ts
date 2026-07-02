import "dotenv/config";
import { z } from "zod";

const numberFromEnv = (fallback: number) =>
  z.preprocess((value) => (value === undefined || value === "" ? fallback : Number(value)), z.number().finite());

const intFromEnv = (fallback: number) =>
  z.preprocess((value) => (value === undefined || value === "" ? fallback : Number(value)), z.number().int());

const boolFromEnv = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return String(value).toLowerCase() === "true";
  }, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intFromEnv(3001).pipe(z.number().min(1).max(65535)),
  DATABASE_URL: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(16),
  DASHBOARD_USER: z.string().min(1),
  DASHBOARD_PASSWORD: z.string().min(12),
  BIRDEYE_API_KEY: z.string().default(""),
  BIRDEYE_BASE_URL: z.string().url().default("https://public-api.birdeye.so"),
  HELIUS_RPC_URL: z.string().url(),
  WALLET_PRIVATE_KEY: z.string().min(32),
  JUPITER_API_KEY: z.string().min(1),
  JUPITER_API_PLAN: z.literal("paid"),
  JUPITER_BASE_URL: z.string().url().default("https://api.jup.ag/swap/v2"),
  BUY_AMOUNT_SOL: numberFromEnv(0.2).pipe(z.number().positive()),
  ADD_POSITION_ENABLED: boolFromEnv(true),
  ADD_POSITION_AMOUNT_SOL: numberFromEnv(0.2).pipe(z.number().positive()),
  ADD_POSITION_DROP_PERCENT: numberFromEnv(30).pipe(z.number().min(0).max(100)),
  MAX_ADD_POSITION_COUNT: intFromEnv(1).pipe(z.number().min(0).max(10)),
  SLIPPAGE_PERCENT: numberFromEnv(6).pipe(z.number().min(0.1).max(20)),
  MIN_FDV_USD: numberFromEnv(30_000).pipe(z.number().positive()),
  MIN_LIQUIDITY_USD: numberFromEnv(10_000).pipe(z.number().positive()),
  MIN_VOLUME_24H_USD: numberFromEnv(10_000).pipe(z.number().min(0)),
  RSI_PERIOD: intFromEnv(7).pipe(z.number().min(2).max(100)),
  RSI_BUY_BELOW: numberFromEnv(25).pipe(z.number().min(0).max(100)),
  RSI_SELL_CROSS_DOWN: numberFromEnv(99).pipe(z.number().min(0).max(100)),
  RSI_SELL_ABOVE: numberFromEnv(80).pipe(z.number().min(0).max(100)),
  MAX_SINGLE_CANDLE_DROP_PERCENT: numberFromEnv(3).pipe(z.number().min(0).max(100)),
  LP_DROP_LOOKBACK_MINUTES: intFromEnv(2).pipe(z.number().min(1).max(60)),
  LP_DROP_THRESHOLD_PERCENT: numberFromEnv(10).pipe(z.number().min(0).max(100)),
  TRAILING_ACTIVATE_PROFIT_PERCENT: numberFromEnv(30).pipe(z.number().min(0).max(1000)),
  TRAILING_DRAWDOWN_PERCENT: numberFromEnv(10).pipe(z.number().min(0.1).max(100)),
  BATCH_SELL_DELAY_MS: intFromEnv(3000).pipe(z.number().min(0).max(60_000)),
  BATCH_SELL_FIRST_PERCENT: numberFromEnv(50).pipe(z.number().min(1).max(99)),
  EMERGENCY_STOP_LOSS_PERCENT: numberFromEnv(0).pipe(z.number().min(0).max(100)),
  MAX_PRICE_IMPACT_PERCENT: numberFromEnv(8).pipe(z.number().min(0.1).max(100)),
  MIN_WALLET_RESERVE_SOL: numberFromEnv(0.05).pipe(z.number().min(0)),
  BLOCK_MINT_AUTHORITY: boolFromEnv(true),
  BLOCK_FREEZE_AUTHORITY: boolFromEnv(true),
  MARKET_STALE_AFTER_SECONDS: intFromEnv(360).pipe(z.number().min(30).max(3600)),
  TRADING_PAUSED: boolFromEnv(false),
  MARKET_FILTER_INTERVAL_MS: intFromEnv(180_000).pipe(z.number().min(10_000)),
  VOLUME_FILTER_INTERVAL_MS: intFromEnv(3_600_000).pipe(z.number().min(300_000)),
  STRATEGY_INTERVAL_MS: intFromEnv(30_000).pipe(z.number().min(5_000)),
  MARKET_REQUEST_CONCURRENCY: intFromEnv(3).pipe(z.number().min(1).max(20))
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid configuration: ${details}`);
}

export const config = parsed.data;

export type AppConfig = typeof config;
