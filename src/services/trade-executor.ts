import { Decimal } from "decimal.js";
import { config } from "../config.js";
import { JupiterClient, SOL_MINT, type PreparedSwap, type SwapOrder } from "./jupiter.js";

export type TradeFill = {
  amountSol: number;
  amountToken: number;
  feeSol: number;
  txHash?: string;
  router: string;
  priceImpactPercent?: number;
};

export type ExecutionHooks = {
  onPrepared?: (prepared: PreparedSwap) => Promise<void>;
};

export class TradeExecutor {
  constructor(private readonly jupiter: JupiterClient) {}

  async preflightBuy(tokenMint: string, amountSol: number): Promise<{ buy: SwapOrder; roundTripLossPercent: number }> {
    const lamports = solToRaw(amountSol);
    const result = await this.jupiter.checkRoundTrip(tokenMint, lamports);
    return { buy: result.buy, roundTripLossPercent: result.roundTripLossPercent };
  }

  async buy(tokenMint: string, amountSol: number, tokenDecimals: number, hooks: ExecutionHooks = {}): Promise<TradeFill> {
    const inputRaw = solToRaw(amountSol);
    const balance = await this.jupiter.getWalletSolBalance();
    if (balance - amountSol < config.MIN_WALLET_RESERVE_SOL) {
      throw new Error(`Wallet reserve guard: ${balance.toFixed(4)} SOL balance is insufficient`);
    }
    const receipt = await this.jupiter.execute(SOL_MINT, tokenMint, inputRaw, hooks.onPrepared);
    return {
      amountSol: rawToUi(receipt.inputRaw, 9),
      amountToken: rawToUi(receipt.outputRaw, tokenDecimals),
      feeSol: receipt.feeSol,
      txHash: receipt.txHash,
      router: receipt.router
    };
  }

  async sell(tokenMint: string, tokenAmount: number, tokenDecimals: number, hooks: ExecutionHooks = {}): Promise<TradeFill> {
    let inputRaw = uiToRaw(tokenAmount, tokenDecimals);
    const walletBalance = await this.jupiter.getWalletTokenBalanceRaw(tokenMint);
    inputRaw = Decimal.min(new Decimal(inputRaw), new Decimal(walletBalance)).floor().toFixed(0);
    if (new Decimal(inputRaw).lte(0)) throw new Error("No token balance available to sell");

    const receipt = await this.jupiter.execute(tokenMint, SOL_MINT, inputRaw, hooks.onPrepared);
    return {
      amountSol: rawToUi(receipt.outputRaw, 9),
      amountToken: rawToUi(receipt.inputRaw, tokenDecimals),
      feeSol: receipt.feeSol,
      txHash: receipt.txHash,
      router: receipt.router
    };
  }
}

export function solToRaw(sol: number): string {
  return new Decimal(sol).mul(1_000_000_000).floor().toFixed(0);
}

export function uiToRaw(amount: number, decimals: number): string {
  return new Decimal(amount).mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
}

export function rawToUi(amount: string, decimals: number): number {
  return new Decimal(amount).div(new Decimal(10).pow(decimals)).toNumber();
}
