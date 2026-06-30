import type { Token, Trade } from "@prisma/client";
import { Decimal } from "decimal.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import type { MarketPoint } from "../domain/types.js";
import { JupiterClient } from "./jupiter.js";
import { PositionService } from "./position-service.js";
import { rawToUi } from "./trade-executor.js";

export type ReconcileInput = {
  note: string;
  txHash?: string;
  status?: "WATCHING" | "HOLDING" | "REMOVED";
};

type WalletDeltas = {
  tokenDeltaRaw: Decimal;
  solDelta: Decimal;
  feeSol: Decimal;
};

export class ReconciliationService {
  private readonly jupiter = new JupiterClient();
  private readonly positions = new PositionService();

  async reconcile(address: string, input: ReconcileInput) {
    const token = await prisma.token.findUnique({
      where: { address },
      include: {
        positions: { where: { status: "OPEN" }, take: 1, orderBy: { createdAt: "desc" } },
        trades: { where: { status: { in: ["PENDING", "FAILED"] } }, take: 1, orderBy: { createdAt: "desc" } }
      }
    });
    if (!token || token.status !== "ERROR") throw new Error("Only ERROR tokens can be reconciled");

    const decimals = token.decimals ?? await this.jupiter.getMintDecimals(address);
    const balanceRaw = await this.jupiter.getWalletTokenBalanceRaw(address);
    const balanceUi = rawToUi(balanceRaw, decimals);
    const position = token.positions[0];
    let trade = token.trades[0] ?? null;
    const signature = input.txHash ?? trade?.txHash ?? trade?.preparedTxHash ?? undefined;
    const deltas = signature ? await this.readDeltas(signature, address) : null;

    if (!position) {
      if (new Decimal(balanceRaw).gt(0)) {
        if (!deltas || deltas.tokenDeltaRaw.lte(0)) {
          throw new Error("Wallet holds this token; a confirmed buy transaction signature is required");
        }
        trade = await this.ensureTrade(token, trade, "BUY_INITIAL", signature!);
        return this.recoverInitialBuy(token, trade, signature!, deltas, balanceUi, decimals, input.note);
      }
      if (input.status === "HOLDING") throw new Error("Cannot reconcile to HOLDING when wallet balance is zero");
      const status = input.status ?? "WATCHING";
      return prisma.token.update({
        where: { id: token.id },
        data: {
          status,
          decimals,
          removedAt: status === "REMOVED" ? new Date() : null,
          removeReason: `RECONCILED: ${input.note}`
        }
      });
    }

    const recordedRaw = new Decimal(position.amountToken.toString()).mul(new Decimal(10).pow(decimals)).round();
    if (recordedRaw.isZero() && new Decimal(balanceRaw).isZero() && !trade) {
      const lastSell = await prisma.trade.findFirst({
        where: { positionId: position.id, side: "SELL", status: "CONFIRMED" },
        orderBy: { confirmedAt: "desc" }
      });
      const closed = await this.positions.closePosition(position.id, marketFromToken(token, position), lastSell?.reason ?? "RECONCILED_SELL");
      return { tokenStatus: "CLOSED", position: closed, walletBalance: 0, recoveredTrade: lastSell?.id ?? null };
    }
    if (!deltas && !recordedRaw.eq(balanceRaw)) {
      throw new Error("Database and wallet balances differ; provide the confirmed transaction signature");
    }
    if (!deltas) {
      return prisma.token.update({ where: { id: token.id }, data: { status: "HOLDING", removeReason: `RECONCILED: ${input.note}` } });
    }

    if (deltas.tokenDeltaRaw.gt(0)) {
      trade = await this.ensureTrade(token, trade, "BUY_ADD", signature!);
      return this.recoverAddBuy(token, position, trade, signature!, deltas, balanceUi, decimals, input.note);
    }
    if (deltas.tokenDeltaRaw.lt(0)) {
      trade = await this.ensureTrade(token, trade, "SELL", signature!);
      return this.recoverSell(token, position, trade, signature!, deltas, balanceUi, decimals, input.note);
    }
    throw new Error("The supplied transaction did not change this wallet's token balance");
  }

  private async recoverInitialBuy(token: Token, trade: Trade, signature: string, deltas: WalletDeltas, balanceUi: number, decimals: number, note: string) {
    const received = rawToUi(deltas.tokenDeltaRaw.toFixed(0), decimals);
    const amountSol = trade.side === "BUY_ADD" ? config.ADD_POSITION_AMOUNT_SOL : config.BUY_AMOUNT_SOL;
    const overhead = Decimal.max(deltas.feeSol, deltas.solDelta.neg().minus(amountSol), 0);
    const position = await prisma.$transaction(async (tx) => {
      const created = await tx.position.create({
        data: {
          tokenId: token.id,
          status: "OPEN",
          entryTx: signature,
          entryTime: new Date(),
          entryPriceUsd: trade.priceUsd,
          averageEntryPriceUsd: trade.priceUsd,
          amountSolIn: amountSol,
          amountToken: balanceUi,
          totalSolIn: amountSol,
          totalTokenAmount: received,
          buyFeeSol: overhead.toString(),
          entryFdvUsd: trade.fdvAtTradeUsd,
          entryLiquidityUsd: trade.liquidityAtTradeUsd,
          entryAgeMinutes: trade.ageAtTradeMinutes,
          entryRsi: trade.rsiAtTrade,
          highestPriceUsd: trade.priceUsd
        }
      });
      await tx.trade.update({
        where: { id: trade.id },
        data: { positionId: created.id, status: "CONFIRMED", txHash: signature, amountSol, amountToken: received, feeSol: overhead.toString(), confirmedAt: new Date(), errorMessage: null }
      });
      await tx.token.update({ where: { id: token.id }, data: { status: "HOLDING", decimals, removeReason: `RECONCILED: ${note}` } });
      return created;
    });
    return { tokenStatus: "HOLDING", position, walletBalance: balanceUi, recoveredTrade: trade.id };
  }

  private async recoverAddBuy(token: Token, position: NonNullable<Awaited<ReturnType<typeof this.loadPosition>>>, trade: Trade, signature: string, deltas: WalletDeltas, balanceUi: number, decimals: number, note: string) {
    const received = rawToUi(deltas.tokenDeltaRaw.toFixed(0), decimals);
    const amountSol = trade.side === "BUY_INITIAL" ? config.BUY_AMOUNT_SOL : config.ADD_POSITION_AMOUNT_SOL;
    const overhead = Decimal.max(deltas.feeSol, deltas.solDelta.neg().minus(amountSol), 0);
    const oldTotal = new Decimal(position.totalTokenAmount.toString());
    const newTotal = oldTotal.plus(received);
    const average = oldTotal.mul(position.averageEntryPriceUsd.toString()).plus(new Decimal(received).mul(trade.priceUsd.toString())).div(newTotal);
    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.position.update({
        where: { id: position.id },
        data: {
          amountToken: balanceUi,
          totalTokenAmount: newTotal.toString(),
          totalSolIn: { increment: amountSol },
          addBuyFeeSol: { increment: overhead.toString() },
          averageEntryPriceUsd: average.toString(),
          addPositionCount: { increment: trade.side === "BUY_ADD" ? 1 : 0 },
          lastAddPositionTime: new Date()
        }
      });
      await tx.trade.update({ where: { id: trade.id }, data: { positionId: position.id, status: "CONFIRMED", txHash: signature, amountSol, amountToken: received, feeSol: overhead.toString(), confirmedAt: new Date(), errorMessage: null } });
      await tx.token.update({ where: { id: token.id }, data: { status: "HOLDING", decimals, removeReason: `RECONCILED: ${note}` } });
      return next;
    });
    return { tokenStatus: "HOLDING", position: updated, walletBalance: balanceUi, recoveredTrade: trade.id };
  }

  private async recoverSell(token: Token, position: NonNullable<Awaited<ReturnType<typeof this.loadPosition>>>, trade: Trade, signature: string, deltas: WalletDeltas, balanceUi: number, decimals: number, note: string) {
    const sold = rawToUi(deltas.tokenDeltaRaw.abs().toFixed(0), decimals);
    const received = Decimal.max(0, deltas.solDelta.plus(deltas.feeSol));
    const batchNumber = trade.batchNumber ?? position.sellBatchCompleted + 1;
    await prisma.$transaction(async (tx) => {
      await tx.position.update({
        where: { id: position.id },
        data: {
          amountToken: balanceUi,
          amountSolOut: { increment: received.toString() },
          sellFeeSol: { increment: deltas.feeSol.toString() },
          sellBatchCompleted: Math.max(position.sellBatchCompleted, batchNumber),
          exitTx: signature
        }
      });
      await tx.trade.update({ where: { id: trade.id }, data: { positionId: position.id, status: "CONFIRMED", txHash: signature, amountSol: received.toString(), amountToken: sold, feeSol: deltas.feeSol.toString(), batchNumber, confirmedAt: new Date(), errorMessage: null } });
      await tx.token.update({ where: { id: token.id }, data: { status: balanceUi > 0 ? "HOLDING" : "SELLING", decimals, removeReason: `RECONCILED: ${note}` } });
    });

    if (balanceUi === 0) {
      const closed = await this.positions.closePosition(position.id, marketFromToken(token, position), trade.reason);
      return { tokenStatus: "CLOSED", position: closed, walletBalance: 0, recoveredTrade: trade.id };
    }
    const updated = await this.loadPosition(position.id);
    return { tokenStatus: "HOLDING", position: updated, walletBalance: balanceUi, recoveredTrade: trade.id };
  }

  private async ensureTrade(token: Token, trade: Trade | null, side: "BUY_INITIAL" | "BUY_ADD" | "SELL", signature: string): Promise<Trade> {
    if (trade) {
      if (trade.side !== side && !(side === "BUY_INITIAL" && trade.side === "BUY_ADD")) throw new Error(`Transaction direction conflicts with pending ${trade.side} trade`);
      return trade;
    }
    return prisma.trade.create({
      data: {
        tokenId: token.id,
        side,
        status: "PENDING",
        txHash: signature,
        amountSol: 0,
        amountToken: 0,
        priceUsd: token.priceUsd ?? 0,
        slippagePercent: config.SLIPPAGE_PERCENT,
        fdvAtTradeUsd: token.fdvUsd,
        liquidityAtTradeUsd: token.liquidityUsd,
        ageAtTradeMinutes: token.ageMinutes,
        rsiAtTrade: token.rsi,
        reason: "MANUAL_RECONCILIATION"
      }
    });
  }

  private loadPosition(id: string) {
    return prisma.position.findUniqueOrThrow({ where: { id } });
  }

  private async readDeltas(signature: string, mint: string): Promise<WalletDeltas> {
    const transaction = await this.jupiter.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!transaction?.meta) throw new Error(`Confirmed transaction ${signature} was not found`);
    return extractWalletDeltas(transaction as unknown as ChainTransaction, this.jupiter.walletAddress!, mint);
  }
}

export type ChainTransaction = {
  meta: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable: Array<{ toBase58(): string }>; readonly: Array<{ toBase58(): string }> } | null;
  };
  transaction: { message: { staticAccountKeys?: Array<{ toBase58(): string }>; accountKeys?: Array<{ toBase58(): string }> } };
};

type TokenBalance = { mint: string; owner?: string; uiTokenAmount: { amount: string } };

export function extractWalletDeltas(transaction: ChainTransaction, wallet: string, mint: string): WalletDeltas {
  const message = transaction.transaction.message;
  const keys = [
    ...(message.staticAccountKeys ?? message.accountKeys ?? []),
    ...(transaction.meta.loadedAddresses?.writable ?? []),
    ...(transaction.meta.loadedAddresses?.readonly ?? [])
  ].map((key) => key.toBase58());
  const walletIndex = keys.indexOf(wallet);
  if (walletIndex < 0) throw new Error("Wallet is not present in the supplied transaction");
  const solDelta = new Decimal(transaction.meta.postBalances[walletIndex] ?? 0)
    .minus(transaction.meta.preBalances[walletIndex] ?? 0)
    .div(1_000_000_000);
  const preToken = tokenAmount(transaction.meta.preTokenBalances, wallet, mint);
  const postToken = tokenAmount(transaction.meta.postTokenBalances, wallet, mint);
  const feeSol = walletIndex === 0 ? new Decimal(transaction.meta.fee).div(1_000_000_000) : new Decimal(0);
  return { tokenDeltaRaw: postToken.minus(preToken), solDelta, feeSol };
}

function tokenAmount(items: TokenBalance[] | null | undefined, wallet: string, mint: string): Decimal {
  return (items ?? [])
    .filter((item) => item.owner === wallet && item.mint === mint)
    .reduce((sum, item) => sum.plus(item.uiTokenAmount.amount), new Decimal(0));
}

function marketFromToken(token: Token, position: { averageEntryPriceUsd: unknown }): MarketPoint {
  return {
    timestamp: token.lastMarketCheckAt ?? new Date(),
    priceUsd: token.priceUsd == null ? Number(position.averageEntryPriceUsd) : Number(token.priceUsd),
    priceSol: token.priceSol == null ? null : Number(token.priceSol),
    fdvUsd: token.fdvUsd == null ? 0 : Number(token.fdvUsd),
    liquidityUsd: token.liquidityUsd == null ? 0 : Number(token.liquidityUsd),
    ageMinutes: token.ageMinutes == null ? null : Number(token.ageMinutes),
    rsi: token.rsi == null ? null : Number(token.rsi)
  };
}
