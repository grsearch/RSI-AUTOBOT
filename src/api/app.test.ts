import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const mint = "So11111111111111111111111111111111111111112";
const authorization = `Basic ${Buffer.from("test:test-password").toString("base64")}`;

describe("force-sell API", () => {
  it("does not report success when execution fails", async () => {
    const app = createApp({
      strategy: { forceSell: async () => { throw new Error("quote failed"); } },
      reconciliation: { reconcile: async () => ({}) }
    });
    const response = await withServer(app, (baseUrl) => fetch(`${baseUrl}/api/tokens/${mint}/force-sell`, {
      method: "POST",
      headers: { authorization, "x-confirm-live": `SELL ${mint}` }
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("reports success only after forceSell resolves", async () => {
    const app = createApp({
      strategy: { forceSell: async () => undefined },
      reconciliation: { reconcile: async () => ({}) }
    });
    const response = await withServer(app, (baseUrl) => fetch(`${baseUrl}/api/tokens/${mint}/force-sell`, {
      method: "POST",
      headers: { authorization, "x-confirm-live": `SELL ${mint}` }
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sold: true, address: mint });
  });
});

async function withServer<T>(app: ReturnType<typeof createApp>, action: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await action(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
