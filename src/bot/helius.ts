import { env } from "./config.js";
import { logger } from "../utils/logger.js";

function getHeliusApiKey(): string | null {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (rpcUrl.includes("helius-rpc.com")) {
    const match = rpcUrl.match(/api-key=([^&]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

const HELIUS_API_KEY = getHeliusApiKey();
const HELIUS_DAS_URL = HELIUS_API_KEY 
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : null;
const HELIUS_ENHANCED_URL = HELIUS_API_KEY
  ? `https://api.helius.xyz/v0`
  : null;

export interface HeliusTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: number;
  rawBalance: string;
  priceUsd: number | null;
}

export interface HeliusHoldings {
  nativeSol: number;
  nativeSolLamports: number;
  tokens: HeliusTokenInfo[];
  unknownMintCount: number;
}

export interface HeliusAsset {
  id: string;
  interface: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  };
  token_info?: {
    symbol?: string;
    decimals?: number;
    balance?: number;
    price_info?: {
      price_per_token?: number;
      currency?: string;
    };
  };
}

export interface HeliusNativeBalance {
  lamports: number;
  price_per_sol?: number;
}

export async function getAssetsByOwner(ownerAddress: string): Promise<HeliusHoldings | null> {
  if (!HELIUS_DAS_URL) {
    logger.warn("Helius API key not configured - cannot use DAS");
    return null;
  }

  try {
    const response = await fetch(HELIUS_DAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "helius-holdings",
        method: "getAssetsByOwner",
        params: {
          ownerAddress,
          displayOptions: {
            showFungible: true,
            showNativeBalance: true,
          },
        },
      }),
    });

    if (!response.ok) {
      logger.error({ status: response.status }, "Helius DAS request failed");
      return null;
    }

    const data = await response.json() as {
      result?: {
        items?: HeliusAsset[];
        nativeBalance?: HeliusNativeBalance;
      };
      error?: { message: string };
    };

    if (data.error) {
      logger.error({ error: data.error.message }, "Helius DAS error");
      return null;
    }

    const items = data.result?.items ?? [];
    const nativeBalance = data.result?.nativeBalance;

    const nativeSolLamports = nativeBalance?.lamports ?? 0;
    const nativeSol = nativeSolLamports / 1e9;

    const tokens: HeliusTokenInfo[] = [];
    let unknownMintCount = 0;

    for (const asset of items) {
      if (!asset.token_info) continue;

      const tokenInfo = asset.token_info;
      const metadata = asset.content?.metadata;

      const decimals = tokenInfo.decimals ?? 0;
      const rawBalance = String(tokenInfo.balance ?? 0);
      const balance = Number(tokenInfo.balance ?? 0) / Math.pow(10, decimals);

      if (balance <= 0) continue;

      const symbol = tokenInfo.symbol || metadata?.symbol || "";
      const name = metadata?.name || "";

      if (!symbol && !name) {
        unknownMintCount++;
      }

      const priceInfo = tokenInfo.price_info;
      const priceUsd = priceInfo?.price_per_token ?? null;

      tokens.push({
        mint: asset.id,
        symbol: symbol || asset.id.slice(0, 6),
        name: name || asset.id.slice(0, 8) + "...",
        decimals,
        balance,
        rawBalance,
        priceUsd,
      });
    }

    logger.info({
      owner: ownerAddress.slice(0, 8),
      tokenCount: tokens.length,
      nativeSol: nativeSol.toFixed(4),
      unknownMintCount,
    }, "Holdings fetched via Helius DAS");

    return { nativeSol, nativeSolLamports, tokens, unknownMintCount };
  } catch (err) {
    logger.error({ err: String(err) }, "Failed to fetch holdings from Helius DAS");
    return null;
  }
}

export interface HeliusEnhancedTransaction {
  signature: string;
  timestamp: number;
  slot: number;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
      mint: string;
    }>;
  }>;
}

export async function getEnhancedTransactions(
  walletAddress: string,
  options: { limit?: number; before?: string } = {}
): Promise<HeliusEnhancedTransaction[] | null> {
  if (!HELIUS_ENHANCED_URL || !HELIUS_API_KEY) {
    logger.warn("Helius API key not configured - cannot use Enhanced Transactions");
    return null;
  }

  const limit = options.limit ?? 100;
  const url = new URL(`${HELIUS_ENHANCED_URL}/addresses/${walletAddress}/transactions`);
  url.searchParams.set("api-key", HELIUS_API_KEY);
  url.searchParams.set("limit", String(limit));
  if (options.before) {
    url.searchParams.set("before", options.before);
  }

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      logger.error({ status: response.status }, "Helius Enhanced TX request failed");
      return null;
    }

    const data = await response.json() as HeliusEnhancedTransaction[];
    logger.info({ count: data.length, wallet: walletAddress.slice(0, 8) }, "Fetched enhanced transactions");
    return data;
  } catch (err) {
    logger.error({ err: String(err) }, "Failed to fetch enhanced transactions");
    return null;
  }
}

export function isHeliusConfigured(): boolean {
  return HELIUS_API_KEY !== null;
}
