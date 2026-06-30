import { config } from "../config.js";
import { JupiterClient, SOL_MINT } from "./jupiter.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export class HealthService {
  private readonly jupiter = new JupiterClient();

  async probe(): Promise<{ heliusOk: boolean; jupiterQuoteOk: boolean; errors: string[] }> {
    const [helius, jupiter] = await Promise.allSettled([
      this.jupiter.connection.getLatestBlockhash("confirmed"),
      config.JUPITER_API_KEY ? this.jupiter.getOrder(SOL_MINT, USDC_MINT, "1000000") : Promise.reject(new Error("JUPITER_API_KEY not configured"))
    ]);
    const errors = [helius, jupiter]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    return { heliusOk: helius.status === "fulfilled", jupiterQuoteOk: jupiter.status === "fulfilled", errors };
  }
}
