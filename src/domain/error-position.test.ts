import { describe, expect, it } from "vitest";
import { PREPARED_TRANSACTION_EXPIRY_MS, assessPositionBalance, assessUncertainTrade } from "./error-position.js";

describe("ERROR position recovery safety", () => {
  it("allows recovery only when the exact raw wallet balance matches", () => {
    expect(assessPositionBalance("101.098", 6, "101098000")).toEqual({ recoverable: true, reason: "BALANCE_MATCH", recordedRaw: "101098000" });
    expect(assessPositionBalance("101.098", 6, "101097999").reason).toBe("WALLET_BALANCE_MISMATCH");
  });

  it("does not recover zero or invalid recorded balances", () => {
    expect(assessPositionBalance("0", 6, "0").reason).toBe("ZERO_RECORDED_BALANCE");
    expect(assessPositionBalance("invalid", 6, "0").reason).toBe("INVALID_BALANCE");
  });

  it("blocks confirmed transactions until reconciliation", () => {
    expect(assessUncertainTrade({ hasExecutionReceipt: true, hasPreparedPayload: true, createdAt: 0, now: PREPARED_TRANSACTION_EXPIRY_MS * 2, chainState: "success" }))
      .toEqual({ resolved: false, reason: "CHAIN_CONFIRMED" });
  });

  it("accepts chain failures and expired prepared-only transactions", () => {
    expect(assessUncertainTrade({ hasExecutionReceipt: false, hasPreparedPayload: true, createdAt: 0, now: 1, chainState: "failed" }).resolved).toBe(true);
    expect(assessUncertainTrade({ hasExecutionReceipt: false, hasPreparedPayload: true, createdAt: 0, now: PREPARED_TRANSACTION_EXPIRY_MS, chainState: "not_found" }))
      .toEqual({ resolved: true, reason: "PREPARED_TRANSACTION_EXPIRED" });
  });

  it("does not assume a missing execution receipt transaction expired", () => {
    expect(assessUncertainTrade({ hasExecutionReceipt: true, hasPreparedPayload: true, createdAt: 0, now: PREPARED_TRANSACTION_EXPIRY_MS * 2, chainState: "not_found" }).resolved).toBe(false);
  });
});
