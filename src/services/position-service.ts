import type { Position, Token } from "@prisma/client";
import { Decimal } from "decimal.js";
import { prisma } from "../db.js";
import type { MarketPoint } from "../domain/types.js";
import type { TradeFill } from "./trade-executor.js";

export class PositionService {
  async recordInitialBuy(token: Token, tradeId: string, fill: TradeFill, market: MarketPoint): Promise<Position> {
    const entryPriceUsd = effectivePriceUsd(fill, market);
    return prisma.$transaction(async (tx) => {
      const position = await tx.position.create({
        data: {
          tokenId: token.id,
          status: "OPEN",
          entryTx: fill.txHash,
          entryTime: new Date(),
          entryPriceUsd,
          averageEntryPriceUsd: entryPriceUsd,
          amountSolIn: fill.amountSol,
          amountToken: fill.amountToken,
          totalSolIn: fill.amountSol,
          totalTokenAmount: fill.amountToken,
          buyFeeSol: fill.feeSol,
          entryFdvUsd: market.fdvUsd,
          entryLiquidityUsd: market.liquidityUsd,
          entryAgeMinutes: market.ageMinutes,
          entryRsi: market.rsi,
          highestPriceUsd: entryPriceUsd
        }
      });
      await tx.trade.update({
        where: { id: tradeId },
        data: {
          positionId: position.id,
          status: "CONFIRMED",
          txHash: fill.txHash,
          amountSol: fill.amountSol,
          amountToken: fill.amountToken,
          priceUsd: entryPriceUsd,
          feeSol: fill.feeSol,
          priceImpactPercent: fill.priceImpactPercent,
          router: fill.router,
          confirmedAt: new Date()
        }
      });
      await tx.token.update({ where: { id: token.id }, data: { status: "HOLDING" } });
      return position;
    });
  }

  async recordAddBuy(position: Position, tradeId: string, fill: TradeFill, market: MarketPoint): Promise<Position> {
    const addPriceUsd = effectivePriceUsd(fill, market);
    const oldTokens = new Decimal(position.totalTokenAmount.toString());
    const newTokens = new Decimal(fill.amountToken);
    const totalTokens = oldTokens.plus(newTokens);
    const averagePrice = oldTokens
      .mul(position.averageEntryPriceUsd.toString())
      .plus(newTokens.mul(addPriceUsd))
      .div(totalTokens);

    return prisma.$transaction(async (tx) => {
      const updated = await tx.position.update({
        where: { id: position.id },
        data: {
          amountToken: { increment: fill.amountToken },
          totalTokenAmount: totalTokens.toString(),
          totalSolIn: { increment: fill.amountSol },
          addBuyFeeSol: { increment: fill.feeSol },
          averageEntryPriceUsd: averagePrice.toString(),
          addEntryFdvUsd: market.fdvUsd,
          addEntryLiquidityUsd: market.liquidityUsd,
          addEntryAgeMinutes: market.ageMinutes,
          addEntryRsi: market.rsi,
          addPositionCount: { increment: 1 },
          lastAddPositionTime: new Date()
        }
      });
      await tx.trade.update({
        where: { id: tradeId },
        data: {
          status: "CONFIRMED",
          txHash: fill.txHash,
          amountSol: fill.amountSol,
          amountToken: fill.amountToken,
          priceUsd: addPriceUsd,
          feeSol: fill.feeSol,
          priceImpactPercent: fill.priceImpactPercent,
          router: fill.router,
          confirmedAt: new Date()
        }
      });
      await tx.token.update({ where: { id: position.tokenId }, data: { status: "HOLDING" } });
      return updated;
    });
  }

  async recordSellBatch(positionId: string, tradeId: string, fill: TradeFill, market: MarketPoint, batchNumber: number): Promise<Position> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.position.findUniqueOrThrow({ where: { id: positionId } });
      const remaining = Decimal.max(0, new Decimal(current.amountToken.toString()).minus(fill.amountToken));
      const updated = await tx.position.update({
        where: { id: positionId },
        data: {
          amountToken: remaining.toString(),
          amountSolOut: { increment: fill.amountSol },
          sellFeeSol: { increment: fill.feeSol },
          sellBatchCompleted: Math.max(current.sellBatchCompleted, batchNumber),
          exitTx: fill.txHash ?? current.exitTx
        }
      });
      await tx.trade.update({
        where: { id: tradeId },
        data: {
          status: "CONFIRMED",
          txHash: fill.txHash,
          amountSol: fill.amountSol,
          amountToken: fill.amountToken,
          priceUsd: effectivePriceUsd(fill, market),
          feeSol: fill.feeSol,
          priceImpactPercent: fill.priceImpactPercent,
          router: fill.router,
          confirmedAt: new Date()
        }
      });
      return updated;
    });
  }

  async closePosition(positionId: string, market: MarketPoint, reason: string): Promise<Position> {
    return prisma.$transaction(async (tx) => {
      const position = await tx.position.findUniqueOrThrow({ where: { id: positionId } });
      const fees = new Decimal(position.buyFeeSol.toString())
        .plus(position.addBuyFeeSol.toString())
        .plus(position.sellFeeSol.toString());
      const pnl = new Decimal(position.amountSolOut.toString()).minus(position.totalSolIn.toString()).minus(fees);
      const pnlPercent = pnl.div(position.totalSolIn.toString()).mul(100);
      const exitPriceUsd = position.totalTokenAmount.isZero()
        ? market.priceUsd
        : new Decimal(position.amountSolOut.toString())
            .mul(solUsd(market))
            .div(position.totalTokenAmount.toString())
            .toNumber();
      const updated = await tx.position.update({
        where: { id: positionId },
        data: {
          status: "CLOSED",
          amountToken: 0,
          exitTime: new Date(),
          exitPriceUsd,
          exitFdvUsd: market.fdvUsd,
          exitLiquidityUsd: market.liquidityUsd,
          exitAgeMinutes: market.ageMinutes,
          exitRsi: market.rsi,
          netPnlSol: pnl.toString(),
          pnlPercent: pnlPercent.toString(),
          sellReason: reason
        }
      });
      const shouldRemove = reason === "SELL_FDV_BREAK" || reason === "SELL_LP_BREAK";
      await tx.token.update({
        where: { id: position.tokenId },
        data: shouldRemove
          ? { status: "REMOVED", removedAt: new Date(), removeReason: reason }
          : { status: "WATCHING", removedAt: null, removeReason: null }
      });
      return updated;
    });
  }
}

function effectivePriceUsd(fill: TradeFill, market: MarketPoint): number {
  if (fill.amountToken <= 0) return market.priceUsd;
  return new Decimal(fill.amountSol).mul(solUsd(market)).div(fill.amountToken).toNumber();
}

function solUsd(market: MarketPoint): number {
  return market.priceSol && market.priceSol > 0 ? market.priceUsd / market.priceSol : market.priceUsd;
}
