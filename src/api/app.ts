import { PublicKey } from "@solana/web3.js";
import auth from "basic-auth";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import crypto from "node:crypto";
import path from "node:path";
import { pinoHttp } from "pino-http";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { SHADOW_CANDLE_INTERVAL_MS } from "../domain/shadow-market.js";
import { BacktestService, defaultBacktestParams } from "../services/backtest.js";
import { ReconciliationService } from "../services/reconciliation.js";
import { StrategyEngine } from "../services/strategy-engine.js";

const tokenInput = z.object({
  network: z.literal("solana"),
  address: z.string().trim().refine(isSolanaAddress, "Invalid Solana mint address"),
  symbol: z.string().trim().max(32).optional().transform((value) => value || "UNKNOWN")
});

const backtestInput = z.object({
  address: z.string().trim().refine(isSolanaAddress, "Invalid Solana mint address"),
  name: z.string().trim().max(100).optional(),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  params: z.object({
    initialCapitalSol: z.number().positive().optional(),
    buyAmountSol: z.number().positive().optional(),
    addAmountSol: z.number().positive().optional(),
    minFdvUsd: z.number().positive().optional(),
    minLiquidityUsd: z.number().positive().optional(),
    rsiBuyBelow: z.number().min(0).max(100).optional(),
    rsiSellCrossDown: z.number().min(0).max(100).optional(),
    rsiSellAbove: z.number().min(0).max(100).optional(),
    maxSingleCandleDropPercent: z.number().min(0).max(100).optional(),
    lpDropThresholdPercent: z.number().min(0).max(100).optional(),
    addPositionDropPercent: z.number().min(0).max(100).optional(),
    maxAddPositionCount: z.number().int().min(0).max(10).optional(),
    trailingActivateProfitPercent: z.number().min(0).max(1000).optional(),
    trailingDrawdownPercent: z.number().min(0.1).max(100).optional(),
    emergencyStopLossPercent: z.number().min(0).max(100).optional(),
    slippagePercent: z.number().min(0).max(20).optional(),
    buyFeeSol: z.number().min(0).max(0.1).optional(),
    sellFeeSol: z.number().min(0).max(0.1).optional()
  }).default({})
}).refine((value) => value.endTime > value.startTime, { message: "endTime must be after startTime" });

type AppDependencies = {
  strategy?: Pick<StrategyEngine, "forceSell">;
  reconciliation?: Pick<ReconciliationService, "reconcile">;
};

export function createApp(dependencies: AppDependencies = {}) {
  const app = express();
  const strategy = dependencies.strategy ?? new StrategyEngine();
  const backtest = new BacktestService();
  const reconciliation = dependencies.reconciliation ?? new ReconciliationService();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: "100kb" }));
  app.use(pinoHttp({ logger }));

  app.get("/healthz", (_request, response) => response.json({ ok: true }));

  app.post(
    "/webhook/add-token",
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }),
    requireWebhookSecret,
    asyncRoute(async (request, response) => {
      const input = tokenInput.parse(request.body);
      const result = await addToken(input);
      await prisma.systemHealth.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", lastWebhookAt: new Date() },
        update: { lastWebhookAt: new Date() }
      });
      logger.info({ event: "webhook_received", address: input.address, duplicate: !result.created });
      response.status(result.created ? 201 : 200).json(result);
    })
  );

  app.use("/api", requireBasicAuth);

  app.get("/api/overview", asyncRoute(async (_request, response) => {
    const [watchingCount, openPositions, totalTrades, todayPnl, monthPnl, health] = await Promise.all([
      prisma.token.count({ where: { status: "WATCHING" } }),
      prisma.position.count({ where: { status: "OPEN" } }),
      prisma.trade.count({ where: { status: "CONFIRMED" } }),
      pnlSince(startOfShanghaiDay()),
      pnlSince(startOfShanghaiMonth()),
      prisma.systemHealth.findUnique({ where: { id: "singleton" } })
    ]);
    response.json({ watchingCount, openPositions, totalTrades, todayPnlSol: todayPnl, monthPnlSol: monthPnl, health });
  }));

  app.get("/api/tokens", asyncRoute(async (request, response) => {
    const page = paginationParams(request.query);
    const [tokens, total] = await prisma.$transaction([
      prisma.token.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          positions: { where: { status: "OPEN" }, take: 1, orderBy: { createdAt: "desc" } },
          shadowPool: {
            select: {
              pairAddress: true,
              dex: true,
              liquidityUsd: true,
              selectedAt: true,
              lastSampleAt: true,
              lastPriceUsd: true,
              shadowRsiClosed: true,
              shadowRsiLive: true,
              lastClosedCandleAt: true,
              errorMessage: true
            }
          }
        },
        skip: page.skip,
        take: page.pageSize
      }),
      prisma.token.count()
    ]);
    const items = tokens.map((token) => {
      const position = token.positions[0];
      const pnlPercent = position && token.priceUsd
        ? ((Number(token.priceUsd) - Number(position.averageEntryPriceUsd)) / Number(position.averageEntryPriceUsd)) * 100
        : null;
      return { ...token, currentPnlPercent: pnlPercent };
    });
    response.json({ tokens: items, pagination: paginationMeta(page, total) });
  }));

  app.get("/api/shadow-rsi/:address", asyncRoute(async (request, response) => {
    const address = parseAddress(request.params.address);
    const hours = z.coerce.number().min(1).max(168).default(48).parse(singleQueryValue(request.query.hours));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const pool = await prisma.shadowPool.findUnique({
      where: { tokenAddress: address },
      include: {
        candles: { where: { timestamp: { gte: since } }, orderBy: { timestamp: "asc" } },
        token: {
          select: {
            symbol: true,
            trades: {
              where: { createdAt: { gte: since }, status: "CONFIRMED" },
              orderBy: { createdAt: "asc" },
              select: { id: true, side: true, createdAt: true, rsiAtTrade: true, priceUsd: true, reason: true }
            }
          }
        }
      }
    });
    if (!pool) throw httpError(404, "Shadow pool has not been discovered yet");
    const tradeComparisons = pool.token.trades.map((trade) => {
      const latestAllowed = trade.createdAt.getTime() - SHADOW_CANDLE_INTERVAL_MS;
      const candle = [...pool.candles].reverse().find((candidate) => candidate.isClosed && candidate.timestamp.getTime() <= latestAllowed);
      return { ...trade, shadowRsiClosedAtTrade: candle?.rsi7 ?? null, shadowCandleAt: candle?.timestamp ?? null };
    });
    response.json({
      pool: {
        id: pool.id,
        tokenAddress: pool.tokenAddress,
        symbol: pool.token.symbol,
        pairAddress: pool.pairAddress,
        dex: pool.dex,
        liquidityUsd: pool.liquidityUsd,
        selectedAt: pool.selectedAt,
        lastSampleAt: pool.lastSampleAt,
        shadowRsiClosed: pool.shadowRsiClosed,
        shadowRsiLive: pool.shadowRsiLive,
        errorMessage: pool.errorMessage
      },
      candles: pool.candles,
      trades: tradeComparisons
    });
  }));

  app.post("/api/tokens", asyncRoute(async (request, response) => {
    const result = await addToken(tokenInput.parse({ network: "solana", ...request.body }));
    response.status(result.created ? 201 : 200).json(result);
  }));

  app.delete("/api/tokens/:address", asyncRoute(async (request, response) => {
    const address = parseAddress(request.params.address);
    const token = await prisma.token.findUnique({ where: { address }, include: { positions: { where: { status: "OPEN" }, take: 1 } } });
    if (!token) throw httpError(404, "Token not found");
    if (token.positions.length > 0) throw httpError(409, "Open position exists; force-sell it before removing the token");
    const updated = await prisma.token.update({
      where: { address },
      data: { status: "REMOVED", removedAt: new Date(), removeReason: "MANUAL_REMOVE" }
    });
    response.json(updated);
  }));

  app.post("/api/tokens/:address/force-sell", asyncRoute(async (request, response) => {
    const address = parseAddress(request.params.address);
    if (request.header("x-confirm-live") !== `SELL ${address}`) {
      throw httpError(428, `Live sell requires header x-confirm-live: SELL ${address}`);
    }
    await strategy.forceSell(address);
    response.json({ sold: true, address });
  }));

  app.post("/api/tokens/:address/reconcile", asyncRoute(async (request, response) => {
    const address = parseAddress(request.params.address);
    if (request.header("x-confirm-live") !== `RECONCILE ${address}`) {
      throw httpError(428, `Live reconciliation requires header x-confirm-live: RECONCILE ${address}`);
    }
    const input = z.object({
      status: z.enum(["WATCHING", "HOLDING", "REMOVED"]).optional(),
      note: z.string().trim().min(5).max(500),
      txHash: z.string().trim().min(64).max(100).optional()
    }).parse(request.body);
    const result = await reconciliation.reconcile(address, input);
    logger.warn({ event: "token_manually_reconciled", address, status: input.status, txHash: input.txHash, note: input.note });
    response.json(result);
  }));

  app.get("/api/positions", asyncRoute(async (request, response) => {
    const page = paginationParams(request.query);
    const status = z.enum(["OPEN", "CLOSED", "ERROR"]).optional().parse(singleQueryValue(request.query.status));
    const where = status ? { status } : {};
    const [positions, total] = await prisma.$transaction([
      prisma.position.findMany({
        where,
        include: { token: true },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip: page.skip,
        take: page.pageSize
      }),
      prisma.position.count({ where })
    ]);
    response.json({ positions, pagination: paginationMeta(page, total) });
  }));

  app.get("/api/trades", asyncRoute(async (request, response) => {
    const page = paginationParams(request.query, request.query.limit);
    const [trades, total] = await prisma.$transaction([
      prisma.trade.findMany({ include: { token: true }, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.pageSize }),
      prisma.trade.count()
    ]);
    const items = trades.map(({ signedTransaction: _signedTransaction, ...trade }) => trade);
    response.json({ trades: items, pagination: paginationMeta(page, total) });
  }));

  app.get("/api/pnl/today", asyncRoute(async (_request, response) => response.json({ pnlSol: await pnlSince(startOfShanghaiDay()) })));
  app.get("/api/pnl/month", asyncRoute(async (_request, response) => response.json({ pnlSol: await pnlSince(startOfShanghaiMonth()) })));
  app.get("/api/health", asyncRoute(async (_request, response) => response.json(await prisma.systemHealth.findUnique({ where: { id: "singleton" } }))));

  app.get("/api/settings", (_request, response) => response.json(publicSettings()));
  app.post("/api/settings", asyncRoute(async (request, response) => {
    const input = z.object({ tradingPaused: z.boolean() }).strict().parse(request.body);
    const health = await prisma.systemHealth.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", tradingPaused: input.tradingPaused },
      update: { tradingPaused: input.tradingPaused }
    });
    response.json({ ...publicSettings(), tradingPaused: health.tradingPaused });
  }));

  app.post("/api/backtest/run", asyncRoute(async (request, response) => {
    const input = backtestInput.parse(request.body);
    const run = await backtest.run(input.address, input.startTime, input.endTime, { ...defaultBacktestParams, ...input.params }, input.name);
    response.status(201).json(run);
  }));
  app.get("/api/backtest/runs", asyncRoute(async (_request, response) => response.json(await prisma.backtestRun.findMany({ orderBy: { createdAt: "desc" }, take: 100 }))));
  app.get("/api/backtest/runs/:id", asyncRoute(async (request, response) => {
    const run = await prisma.backtestRun.findUnique({ where: { id: paramValue(request.params.id, "Invalid run id") }, include: { trades: true } });
    if (!run) throw httpError(404, "Backtest run not found");
    response.json(run);
  }));
  app.get("/api/backtest/runs/:id/export.csv", asyncRoute(async (request, response) => {
    const run = await prisma.backtestRun.findUnique({ where: { id: paramValue(request.params.id, "Invalid run id") }, include: { trades: true } });
    if (!run) throw httpError(404, "Backtest run not found");
    response.type("text/csv").attachment(`backtest-${run.id}.csv`).send(backtestCsv(run.trades));
  }));

  const webRoot = path.resolve("public/app");
  app.use(express.static(webRoot, { index: false }));
  app.get("/{*splat}", (request, response, next) => {
    if (request.path.startsWith("/api") || request.path.startsWith("/webhook")) return next();
    response.sendFile(path.join(webRoot, "index.html"));
  });

  app.use((_request, _response, next) => next(httpError(404, "Not found")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return response.status(400).json({ error: "Invalid request", details: error.flatten() });
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    const message = error instanceof Error ? error.message : "Internal server error";
    if (status >= 500) logger.error({ event: "api_error", error: message });
    return response.status(status).json({ error: status >= 500 ? "Internal server error" : message });
  });
  return app;
}

async function addToken(input: z.infer<typeof tokenInput>) {
  const existing = await prisma.token.findUnique({ where: { address: input.address } });
  if (existing) return { created: false, token: existing };
  const token = await prisma.token.create({
    data: {
      network: input.network,
      address: input.address,
      symbol: input.symbol,
      gmgnUrl: `https://gmgn.ai/sol/token/${input.address}`,
      status: "WATCHING"
    }
  });
  logger.info({ event: "token_added", address: input.address, symbol: input.symbol });
  return { created: true, token };
}

function requireWebhookSecret(request: Request, response: Response, next: NextFunction) {
  if (request.header("x-webhook-secret") !== config.WEBHOOK_SECRET) return response.status(401).json({ error: "Invalid webhook secret" });
  return next();
}

function requireBasicAuth(request: Request, response: Response, next: NextFunction) {
  const credentials = auth(request);
  if (!credentials || !safeEqual(credentials.name, config.DASHBOARD_USER) || !safeEqual(credentials.pass, config.DASHBOARD_PASSWORD)) {
    response.set("WWW-Authenticate", 'Basic realm="SOL Trading Bot", charset="UTF-8"');
    return response.status(401).json({ error: "Authentication required" });
  }
  return next();
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response, next).catch(next);
}

function parseAddress(value: string | string[] | undefined): string {
  if (Array.isArray(value)) throw httpError(400, "Invalid Solana address");
  if (!value || !isSolanaAddress(value)) throw httpError(400, "Invalid Solana address");
  return value;
}

function paramValue(value: string | string[] | undefined, error: string): string {
  if (!value || Array.isArray(value)) throw httpError(400, error);
  return value;
}

function singleQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function paginationParams(query: Request["query"], legacyLimit?: unknown) {
  const parsed = z.object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30)
  }).parse({
    page: singleQueryValue(query.page),
    pageSize: singleQueryValue(query.pageSize) ?? singleQueryValue(legacyLimit)
  });
  return { ...parsed, skip: (parsed.page - 1) * parsed.pageSize };
}

function paginationMeta(page: ReturnType<typeof paginationParams>, total: number) {
  return {
    page: page.page,
    pageSize: page.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.pageSize))
  };
}

function isSolanaAddress(value: string): boolean {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

async function pnlSince(start: Date): Promise<number> {
  const result = await prisma.position.aggregate({ where: { status: "CLOSED", exitTime: { gte: start } }, _sum: { netPnlSol: true } });
  return Number(result._sum.netPnlSol ?? 0);
}

function startOfShanghaiDay(now = new Date()): Date {
  return shanghaiStart(now, false);
}

function startOfShanghaiMonth(now = new Date()): Date {
  return shanghaiStart(now, true);
}

function shanghaiStart(now: Date, month: boolean): Date {
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), month ? 1 : local.getUTCDate()) - offset);
}

function publicSettings() {
  return {
    tradingMode: "live",
    jupiterApiPlan: config.JUPITER_API_PLAN,
    buyAmountSol: config.BUY_AMOUNT_SOL,
    addPositionAmountSol: config.ADD_POSITION_AMOUNT_SOL,
    slippagePercent: config.SLIPPAGE_PERCENT,
    minFdvUsd: config.MIN_FDV_USD,
    minLiquidityUsd: config.MIN_LIQUIDITY_USD,
    minVolume24hUsd: config.MIN_VOLUME_24H_USD,
    rsiPeriod: config.RSI_PERIOD,
    rsiBuyBelow: config.RSI_BUY_BELOW,
    rsiSellCrossDown: config.RSI_SELL_CROSS_DOWN,
    rsiSellAbove: config.RSI_SELL_ABOVE,
    shadowRsiEnabled: config.SHADOW_RSI_ENABLED,
    shadowSampleIntervalMs: config.SHADOW_SAMPLE_INTERVAL_MS,
    trailingActivateProfitPercent: config.TRAILING_ACTIVATE_PROFIT_PERCENT,
    trailingDrawdownPercent: config.TRAILING_DRAWDOWN_PERCENT,
    emergencyStopLossPercent: config.EMERGENCY_STOP_LOSS_PERCENT,
    blockMintAuthority: config.BLOCK_MINT_AUTHORITY,
    blockFreezeAuthority: config.BLOCK_FREEZE_AUTHORITY,
    editableAtRuntime: ["tradingPaused"]
  };
}

function backtestCsv(trades: Array<Record<string, unknown>>): string {
  const columns = ["address", "buyTime", "addBuyTime", "sellTime", "buyPrice", "addBuyPrice", "averageEntryPrice", "sellPrice", "buyRsi", "addBuyRsi", "sellRsi", "sellReason", "pnlSol", "pnlPercent", "holdingMinutes", "trailingActivated", "maxProfitPercent", "addPositionCount"];
  return [columns.join(","), ...trades.map((trade) => columns.map((column) => csvCell(trade[column])).join(","))].join("\n");
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
