import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Decimal } from "decimal.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { delay, fetchJson } from "./http.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export type SwapOrder = {
  requestId: string;
  transaction?: string | null;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  priceImpact?: number | string;
  priceImpactPct?: number | string;
  errorCode?: number;
  errorMessage?: string;
};

export type SwapExecution = {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
};

export type ExecutionReceipt = {
  txHash: string;
  inputRaw: string;
  outputRaw: string;
  feeSol: number;
  router: string;
};

export type PreparedSwap = {
  requestId: string;
  signedTransaction: string;
  preparedTxHash: string | null;
  router: string;
};

export class JupiterClient {
  readonly connection = new Connection(config.HELIUS_RPC_URL, "confirmed");
  readonly wallet: Keypair | null;

  constructor() {
    this.wallet = config.WALLET_PRIVATE_KEY ? decodeWallet(config.WALLET_PRIVATE_KEY) : null;
  }

  get walletAddress(): string | null {
    return this.wallet?.publicKey.toBase58() ?? null;
  }

  async getOrder(inputMint: string, outputMint: string, amountRaw: string, withTransaction = false): Promise<SwapOrder> {
    if (!config.JUPITER_API_KEY) throw new Error("JUPITER_API_KEY is required for tradability checks");
    const url = new URL(`${config.JUPITER_BASE_URL}/order`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amountRaw);
    url.searchParams.set("slippageBps", String(Math.round(config.SLIPPAGE_PERCENT * 100)));
    if (withTransaction) {
      if (!this.wallet) throw new Error("Wallet is unavailable");
      url.searchParams.set("taker", this.wallet.publicKey.toBase58());
    }
    const order = await fetchJson<SwapOrder>(url, { headers: { "x-api-key": config.JUPITER_API_KEY } });
    if (!order.outAmount || order.errorCode != null || (withTransaction && !order.transaction)) {
      throw new Error(`Jupiter order unavailable${order.errorCode != null ? ` (${order.errorCode})` : ""}: ${order.errorMessage ?? "no route"}`);
    }
    return order;
  }

  async checkRoundTrip(tokenMint: string, inputLamports: string): Promise<{ buy: SwapOrder; sell: SwapOrder; roundTripLossPercent: number }> {
    const buy = await this.getOrder(SOL_MINT, tokenMint, inputLamports);
    const sell = await this.getOrder(tokenMint, SOL_MINT, buy.outAmount);
    const loss = new Decimal(inputLamports).minus(sell.outAmount).div(inputLamports).mul(100).toNumber();
    if (loss > config.MAX_PRICE_IMPACT_PERCENT) {
      throw new Error(`Round-trip quote loss ${loss.toFixed(2)}% exceeds ${config.MAX_PRICE_IMPACT_PERCENT}%`);
    }
    return { buy, sell, roundTripLossPercent: loss };
  }

  async execute(
    inputMint: string,
    outputMint: string,
    amountRaw: string,
    onPrepared?: (prepared: PreparedSwap) => Promise<void>
  ): Promise<ExecutionReceipt> {
    if (!this.wallet) throw new Error("Live wallet is unavailable");
    const order = await this.getOrder(inputMint, outputMint, amountRaw, true);
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction!, "base64"));
    transaction.sign([this.wallet]);

    const simulation = await this.connection.simulateTransaction(transaction, { commitment: "processed", sigVerify: false });
    if (simulation.value.err) throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    logger.info({ event: "transaction_simulation_success", router: order.router, unitsConsumed: simulation.value.unitsConsumed });

    const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
    const firstSignature = transaction.signatures[0];
    const preparedTxHash = firstSignature?.some((byte) => byte !== 0) ? bs58.encode(firstSignature) : null;
    await onPrepared?.({
      requestId: order.requestId,
      signedTransaction,
      preparedTxHash,
      router: order.router ?? "unknown"
    });

    const result = await fetchJson<SwapExecution>(`${config.JUPITER_BASE_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.JUPITER_API_KEY },
      body: JSON.stringify({
        signedTransaction,
        requestId: order.requestId
      })
    }, { timeoutMs: 30_000, retries: 0 });

    if (result.status !== "Success" || !result.signature || !result.totalInputAmount || !result.totalOutputAmount) {
      throw new Error(`Jupiter execution failed (${result.code}): ${result.error ?? "unknown error"}`);
    }
    logger.info({
      event: "transaction_execution_confirmed",
      signature: result.signature,
      requestId: order.requestId,
      inputAmount: result.totalInputAmount,
      outputAmount: result.totalOutputAmount
    });
    const feeSol = await this.readFeeSol(result.signature);
    return {
      txHash: result.signature,
      inputRaw: result.totalInputAmount,
      outputRaw: result.totalOutputAmount,
      feeSol,
      router: order.router ?? "unknown"
    };
  }

  async getWalletSolBalance(): Promise<number> {
    if (!this.wallet) return 0;
    return (await this.connection.getBalance(this.wallet.publicKey, "confirmed")) / 1_000_000_000;
  }

  async getWalletTokenBalanceRaw(mint: string): Promise<string> {
    if (!this.wallet) throw new Error("Wallet is unavailable");
    const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { mint: new PublicKey(mint) }, "confirmed");
    return accounts.value
      .reduce((sum, account) => sum.plus(account.account.data.parsed.info.tokenAmount.amount as string), new Decimal(0))
      .toFixed(0);
  }

  async getMintDecimals(mint: string): Promise<number> {
    return (await this.getMintInfo(mint)).decimals;
  }

  async assertMintSafeToBuy(mint: string): Promise<void> {
    const info = await this.getMintInfo(mint);
    if (config.BLOCK_FREEZE_AUTHORITY && info.freezeAuthority) throw new Error("Mint has an active freeze authority");
    if (config.BLOCK_MINT_AUTHORITY && info.mintAuthority) throw new Error("Mint has an active mint authority");
  }

  private async getMintInfo(mint: string): Promise<{ decimals: number; mintAuthority: string | null; freezeAuthority: string | null }> {
    const info = await this.connection.getParsedAccountInfo(new PublicKey(mint), "confirmed");
    const parsed = info.value?.data;
    if (typeof parsed !== "object" || !("parsed" in parsed)) throw new Error(`Cannot read decimals for ${mint}`);
    const mintInfo = (parsed as { parsed?: { info?: { decimals?: unknown; mintAuthority?: unknown; freezeAuthority?: unknown } } }).parsed?.info;
    const decimals = mintInfo?.decimals;
    if (typeof decimals !== "number") throw new Error(`Invalid mint decimals for ${mint}`);
    return {
      decimals,
      mintAuthority: typeof mintInfo?.mintAuthority === "string" ? mintInfo.mintAuthority : null,
      freezeAuthority: typeof mintInfo?.freezeAuthority === "string" ? mintInfo.freezeAuthority : null
    };
  }

  private async readFeeSol(signature: string): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const transaction = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (transaction?.meta) {
        const message = transaction.transaction.message as unknown as { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[] };
        const feePayer = message.staticAccountKeys?.[0] ?? message.accountKeys?.[0];
        return feePayer?.equals(this.wallet!.publicKey) ? transaction.meta.fee / 1_000_000_000 : 0;
      }
      await delay(300 * (attempt + 1));
    }
    logger.warn({ event: "transaction_fee_unavailable", signature });
    return 0;
  }
}

function decodeWallet(value: string): Keypair {
  try {
    const bytes = value.trim().startsWith("[") ? Uint8Array.from(JSON.parse(value) as number[]) : bs58.decode(value.trim());
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("WALLET_PRIVATE_KEY must be a base58 secret key or JSON byte array");
  }
}
