import { describe, expect, it } from "vitest";
import { extractWalletDeltas, type ChainTransaction } from "./reconciliation.js";

const key = (value: string) => ({ toBase58: () => value });

describe("extractWalletDeltas", () => {
  it("extracts a wallet-paid sell without double-counting the network fee", () => {
    const transaction: ChainTransaction = {
      meta: {
        fee: 5_000,
        preBalances: [1_000_000_000],
        postBalances: [1_099_995_000],
        preTokenBalances: [{ mint: "mint", owner: "wallet", uiTokenAmount: { amount: "1000000" } }],
        postTokenBalances: [],
        loadedAddresses: null
      },
      transaction: { message: { staticAccountKeys: [key("wallet")] } }
    };

    const result = extractWalletDeltas(transaction, "wallet", "mint");
    expect(result.tokenDeltaRaw.toString()).toBe("-1000000");
    expect(result.solDelta.toNumber()).toBeCloseTo(0.099995);
    expect(result.feeSol.toNumber()).toBe(0.000005);
    expect(result.solDelta.plus(result.feeSol).toNumber()).toBeCloseTo(0.1);
  });

  it("does not charge the wallet for a third-party fee payer", () => {
    const transaction: ChainTransaction = {
      meta: {
        fee: 10_000,
        preBalances: [1_000_000_000, 500_000_000],
        postBalances: [999_990_000, 400_000_000],
        preTokenBalances: [],
        postTokenBalances: [{ mint: "mint", owner: "wallet", uiTokenAmount: { amount: "500000" } }],
        loadedAddresses: null
      },
      transaction: { message: { staticAccountKeys: [key("payer"), key("wallet")] } }
    };

    const result = extractWalletDeltas(transaction, "wallet", "mint");
    expect(result.tokenDeltaRaw.toString()).toBe("500000");
    expect(result.solDelta.toNumber()).toBe(-0.1);
    expect(result.feeSol.toNumber()).toBe(0);
  });
});
