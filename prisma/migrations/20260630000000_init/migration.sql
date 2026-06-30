CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "TokenStatus" AS ENUM ('WATCHING', 'BUYING', 'HOLDING', 'SELLING', 'CLOSED', 'REMOVED', 'ERROR');
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'ERROR');
CREATE TYPE "TradeSide" AS ENUM ('BUY_INITIAL', 'BUY_ADD', 'SELL');
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');

CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'solana',
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "decimals" INTEGER,
    "gmgnUrl" TEXT NOT NULL,
    "status" "TokenStatus" NOT NULL DEFAULT 'WATCHING',
    "fdvUsd" DECIMAL(30,10),
    "liquidityUsd" DECIMAL(30,10),
    "ageMinutes" DECIMAL(30,4),
    "priceUsd" DECIMAL(40,20),
    "priceSol" DECIMAL(40,20),
    "rsi" DECIMAL(20,10),
    "previousRsi" DECIMAL(20,10),
    "chainCreatedAt" TIMESTAMP(3),
    "lastOhlcvAt" TIMESTAMP(3),
    "lastMarketCheckAt" TIMESTAMP(3),
    "lastStrategyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removeReason" TEXT,
    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "mode" "TradingMode" NOT NULL,
    "entryTx" TEXT,
    "exitTx" TEXT,
    "entryTime" TIMESTAMP(3) NOT NULL,
    "exitTime" TIMESTAMP(3),
    "entryPriceUsd" DECIMAL(40,20) NOT NULL,
    "averageEntryPriceUsd" DECIMAL(40,20) NOT NULL,
    "exitPriceUsd" DECIMAL(40,20),
    "amountSolIn" DECIMAL(30,12) NOT NULL,
    "amountToken" DECIMAL(40,12) NOT NULL,
    "amountSolOut" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "totalSolIn" DECIMAL(30,12) NOT NULL,
    "totalTokenAmount" DECIMAL(40,12) NOT NULL,
    "buyFeeSol" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "addBuyFeeSol" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "sellFeeSol" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "entryFdvUsd" DECIMAL(30,10),
    "entryLiquidityUsd" DECIMAL(30,10),
    "entryAgeMinutes" DECIMAL(30,4),
    "entryRsi" DECIMAL(20,10),
    "addEntryFdvUsd" DECIMAL(30,10),
    "addEntryLiquidityUsd" DECIMAL(30,10),
    "addEntryAgeMinutes" DECIMAL(30,4),
    "addEntryRsi" DECIMAL(20,10),
    "exitFdvUsd" DECIMAL(30,10),
    "exitLiquidityUsd" DECIMAL(30,10),
    "exitAgeMinutes" DECIMAL(30,4),
    "exitRsi" DECIMAL(20,10),
    "netPnlSol" DECIMAL(30,12),
    "pnlPercent" DECIMAL(20,8),
    "highestPriceUsd" DECIMAL(40,20) NOT NULL,
    "trailingActivated" BOOLEAN NOT NULL DEFAULT false,
    "trailingActivatedAt" TIMESTAMP(3),
    "trailingStopPriceUsd" DECIMAL(40,20),
    "addPositionCount" INTEGER NOT NULL DEFAULT 0,
    "lastAddPositionTime" TIMESTAMP(3),
    "sellReason" TEXT,
    "sellRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "positionId" TEXT,
    "side" "TradeSide" NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "TradingMode" NOT NULL,
    "batchNumber" INTEGER,
    "txHash" TEXT,
    "amountSol" DECIMAL(30,12) NOT NULL,
    "amountToken" DECIMAL(40,12) NOT NULL,
    "priceUsd" DECIMAL(40,20) NOT NULL,
    "feeSol" DECIMAL(30,12) NOT NULL DEFAULT 0,
    "slippagePercent" DECIMAL(20,8) NOT NULL,
    "priceImpactPercent" DECIMAL(20,8),
    "fdvAtTradeUsd" DECIMAL(30,10),
    "liquidityAtTradeUsd" DECIMAL(30,10),
    "ageAtTradeMinutes" DECIMAL(30,4),
    "rsiAtTrade" DECIMAL(20,10),
    "reason" TEXT NOT NULL,
    "router" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OhlcvCandle" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "timeframe" TEXT NOT NULL DEFAULT '1m',
    "open" DECIMAL(40,20) NOT NULL,
    "high" DECIMAL(40,20) NOT NULL,
    "low" DECIMAL(40,20) NOT NULL,
    "close" DECIMAL(40,20) NOT NULL,
    "volume" DECIMAL(40,10) NOT NULL DEFAULT 0,
    "fdvUsd" DECIMAL(30,10),
    "liquidityUsd" DECIMAL(30,10),
    "ageMinutes" DECIMAL(30,4),
    "rsi7" DECIMAL(20,10),
    "source" TEXT NOT NULL DEFAULT 'birdeye',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OhlcvCandle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "priceUsd" DECIMAL(40,20) NOT NULL,
    "priceSol" DECIMAL(40,20),
    "fdvUsd" DECIMAL(30,10),
    "liquidityUsd" DECIMAL(30,10),
    "ageMinutes" DECIMAL(30,4),
    "rsi" DECIMAL(20,10),
    "tokenStatus" "TokenStatus" NOT NULL,
    "positionStatus" "PositionStatus",
    "pnlPercent" DECIMAL(20,8),
    "trailingActivated" BOOLEAN NOT NULL DEFAULT false,
    "highestPriceUsd" DECIMAL(40,20),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SystemHealth" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "birdeyeOk" BOOLEAN NOT NULL DEFAULT false,
    "heliusOk" BOOLEAN NOT NULL DEFAULT false,
    "jupiterQuoteOk" BOOLEAN NOT NULL DEFAULT false,
    "schedulerRunning" BOOLEAN NOT NULL DEFAULT false,
    "tradingPaused" BOOLEAN NOT NULL DEFAULT false,
    "lastWebhookAt" TIMESTAMP(3),
    "lastMarketCycleAt" TIMESTAMP(3),
    "lastStrategyCycleAt" TIMESTAMP(3),
    "watchingCount" INTEGER NOT NULL DEFAULT 0,
    "holdingCount" INTEGER NOT NULL DEFAULT 0,
    "lastBuyStatus" TEXT,
    "lastSellStatus" TEXT,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SystemHealth_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "paramsJson" JSONB NOT NULL,
    "summaryJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BacktestTrade" (
    "id" TEXT NOT NULL,
    "backtestRunId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "buyTime" TIMESTAMP(3) NOT NULL,
    "addBuyTime" TIMESTAMP(3),
    "sellTime" TIMESTAMP(3) NOT NULL,
    "buyPrice" DECIMAL(40,20) NOT NULL,
    "addBuyPrice" DECIMAL(40,20),
    "averageEntryPrice" DECIMAL(40,20) NOT NULL,
    "sellPrice" DECIMAL(40,20) NOT NULL,
    "buyRsi" DECIMAL(20,10),
    "addBuyRsi" DECIMAL(20,10),
    "sellRsi" DECIMAL(20,10),
    "buyFdvUsd" DECIMAL(30,10),
    "addBuyFdvUsd" DECIMAL(30,10),
    "sellFdvUsd" DECIMAL(30,10),
    "buyLiquidityUsd" DECIMAL(30,10),
    "addBuyLiquidityUsd" DECIMAL(30,10),
    "sellLiquidityUsd" DECIMAL(30,10),
    "sellReason" TEXT NOT NULL,
    "pnlSol" DECIMAL(30,12) NOT NULL,
    "pnlPercent" DECIMAL(20,8) NOT NULL,
    "holdingMinutes" INTEGER NOT NULL,
    "trailingActivated" BOOLEAN NOT NULL,
    "maxProfitPercent" DECIMAL(20,8) NOT NULL,
    "addPositionCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BacktestTrade_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Token_address_key" ON "Token"("address");
CREATE INDEX "Token_status_idx" ON "Token"("status");
CREATE INDEX "Position_status_idx" ON "Position"("status");
CREATE INDEX "Position_tokenId_status_idx" ON "Position"("tokenId", "status");
CREATE INDEX "Trade_positionId_idx" ON "Trade"("positionId");
CREATE INDEX "Trade_createdAt_idx" ON "Trade"("createdAt");
CREATE INDEX "OhlcvCandle_tokenId_timestamp_idx" ON "OhlcvCandle"("tokenId", "timestamp");
CREATE UNIQUE INDEX "OhlcvCandle_address_timeframe_timestamp_key" ON "OhlcvCandle"("address", "timeframe", "timestamp");
CREATE INDEX "MarketSnapshot_tokenId_createdAt_idx" ON "MarketSnapshot"("tokenId", "createdAt");
CREATE INDEX "MarketSnapshot_createdAt_idx" ON "MarketSnapshot"("createdAt");
CREATE INDEX "BacktestTrade_backtestRunId_idx" ON "BacktestTrade"("backtestRunId");

ALTER TABLE "Position" ADD CONSTRAINT "Position_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OhlcvCandle" ADD CONSTRAINT "OhlcvCandle_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_backtestRunId_fkey" FOREIGN KEY ("backtestRunId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
