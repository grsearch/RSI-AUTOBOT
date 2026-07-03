-- Shadow market data is intentionally isolated from the trading OHLCV and RSI tables.
CREATE TABLE "ShadowPool" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "dex" TEXT,
    "liquidityUsd" DECIMAL(30,10),
    "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSampleAt" TIMESTAMP(3),
    "lastPriceUsd" DECIMAL(40,20),
    "shadowRsiClosed" DECIMAL(20,10),
    "shadowRsiLive" DECIMAL(20,10),
    "lastClosedCandleAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShadowPool_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShadowCandle" (
    "id" TEXT NOT NULL,
    "shadowPoolId" TEXT NOT NULL,
    "pairAddress" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(40,20) NOT NULL,
    "high" DECIMAL(40,20) NOT NULL,
    "low" DECIMAL(40,20) NOT NULL,
    "close" DECIMAL(40,20) NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 1,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "rsi7" DECIMAL(20,10),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShadowCandle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShadowPool_tokenId_key" ON "ShadowPool"("tokenId");
CREATE UNIQUE INDEX "ShadowPool_tokenAddress_key" ON "ShadowPool"("tokenAddress");
CREATE INDEX "ShadowPool_pairAddress_idx" ON "ShadowPool"("pairAddress");
CREATE UNIQUE INDEX "ShadowCandle_shadowPoolId_timestamp_key" ON "ShadowCandle"("shadowPoolId", "timestamp");
CREATE INDEX "ShadowCandle_shadowPoolId_timestamp_idx" ON "ShadowCandle"("shadowPoolId", "timestamp");
CREATE INDEX "ShadowCandle_timestamp_idx" ON "ShadowCandle"("timestamp");

ALTER TABLE "ShadowPool" ADD CONSTRAINT "ShadowPool_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShadowCandle" ADD CONSTRAINT "ShadowCandle_shadowPoolId_fkey" FOREIGN KEY ("shadowPoolId") REFERENCES "ShadowPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
