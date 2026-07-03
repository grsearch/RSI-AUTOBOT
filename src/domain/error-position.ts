import { Decimal } from "decimal.js";

export const PREPARED_TRANSACTION_EXPIRY_MS = 15 * 60 * 1000;

export type PositionBalanceAssessment = {
  recoverable: boolean;
  reason: "BALANCE_MATCH" | "ZERO_RECORDED_BALANCE" | "WALLET_BALANCE_MISMATCH" | "INVALID_BALANCE";
  recordedRaw: string | null;
};

export function assessPositionBalance(positionAmountUi: string, decimals: number, walletBalanceRaw: string): PositionBalanceAssessment {
  try {
    const recordedRaw = new Decimal(positionAmountUi).mul(new Decimal(10).pow(decimals)).round();
    const walletRaw = new Decimal(walletBalanceRaw);
    if (!recordedRaw.isFinite() || !walletRaw.isFinite() || recordedRaw.isNegative() || walletRaw.isNegative()) {
      return { recoverable: false, reason: "INVALID_BALANCE", recordedRaw: null };
    }
    if (recordedRaw.isZero()) return { recoverable: false, reason: "ZERO_RECORDED_BALANCE", recordedRaw: recordedRaw.toFixed(0) };
    if (!recordedRaw.eq(walletRaw)) return { recoverable: false, reason: "WALLET_BALANCE_MISMATCH", recordedRaw: recordedRaw.toFixed(0) };
    return { recoverable: true, reason: "BALANCE_MATCH", recordedRaw: recordedRaw.toFixed(0) };
  } catch {
    return { recoverable: false, reason: "INVALID_BALANCE", recordedRaw: null };
  }
}

export type UncertainTradeAssessment = {
  resolved: boolean;
  reason: "NO_CHAIN_PAYLOAD" | "CHAIN_FAILED" | "PREPARED_TRANSACTION_EXPIRED" | "CHAIN_CONFIRMED" | "EXECUTION_RECEIPT_NOT_FOUND" | "PREPARED_TRANSACTION_PENDING";
};

export function assessUncertainTrade(input: {
  hasExecutionReceipt: boolean;
  hasPreparedPayload: boolean;
  createdAt: number;
  now: number;
  chainState: "success" | "failed" | "not_found";
}): UncertainTradeAssessment {
  if (!input.hasExecutionReceipt && !input.hasPreparedPayload) return { resolved: true, reason: "NO_CHAIN_PAYLOAD" };
  if (input.chainState === "success") return { resolved: false, reason: "CHAIN_CONFIRMED" };
  if (input.chainState === "failed") return { resolved: true, reason: "CHAIN_FAILED" };
  if (input.hasExecutionReceipt) return { resolved: false, reason: "EXECUTION_RECEIPT_NOT_FOUND" };
  if (input.now - input.createdAt >= PREPARED_TRANSACTION_EXPIRY_MS) return { resolved: true, reason: "PREPARED_TRANSACTION_EXPIRED" };
  return { resolved: false, reason: "PREPARED_TRANSACTION_PENDING" };
}
