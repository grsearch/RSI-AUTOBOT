ALTER TABLE "Position" ADD COLUMN "sellBatchCompleted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trade" ADD COLUMN "requestId" TEXT;
ALTER TABLE "Trade" ADD COLUMN "preparedTxHash" TEXT;
ALTER TABLE "Trade" ADD COLUMN "signedTransaction" TEXT;

CREATE INDEX "Trade_requestId_idx" ON "Trade"("requestId");
CREATE INDEX "Trade_preparedTxHash_idx" ON "Trade"("preparedTxHash");
