import { describe, expect, it } from "vitest";
import type { JupiterClient, PreparedSwap } from "./jupiter.js";
import { TradeExecutor } from "./trade-executor.js";

describe("TradeExecutor", () => {
  it("persists the prepared transaction before broadcasting", async () => {
    const events: string[] = [];
    const prepared: PreparedSwap = {
      requestId: "request-1",
      signedTransaction: "signed-base64",
      preparedTxHash: "signature",
      router: "metis"
    };
    const jupiter = {
      getWalletSolBalance: async () => 1,
      execute: async (_input: string, _output: string, _amount: string, onPrepared?: (value: PreparedSwap) => Promise<void>) => {
        events.push("prepared");
        await onPrepared?.(prepared);
        events.push("broadcast");
        return { txHash: "signature", inputRaw: "200000000", outputRaw: "1000000", feeSol: 0.000005, router: "metis" };
      }
    } as unknown as JupiterClient;
    const executor = new TradeExecutor(jupiter);

    const fill = await executor.buy("mint", 0.2, 6, {
      onPrepared: async (value) => {
        expect(value).toEqual(prepared);
        events.push("persisted");
      }
    });

    expect(events).toEqual(["prepared", "persisted", "broadcast"]);
    expect(fill.txHash).toBe("signature");
    expect(fill.amountToken).toBe(1);
  });

  it("does not broadcast when prepared-state persistence fails", async () => {
    const events: string[] = [];
    const jupiter = {
      getWalletSolBalance: async () => 1,
      execute: async (_input: string, _output: string, _amount: string, onPrepared?: (value: PreparedSwap) => Promise<void>) => {
        await onPrepared?.({ requestId: "request-2", signedTransaction: "signed", preparedTxHash: null, router: "metis" });
        events.push("broadcast");
        throw new Error("must not reach broadcast");
      }
    } as unknown as JupiterClient;
    const executor = new TradeExecutor(jupiter);

    await expect(executor.buy("mint", 0.2, 6, { onPrepared: async () => { throw new Error("database unavailable"); } }))
      .rejects.toThrow("database unavailable");
    expect(events).toEqual([]);
  });
});
