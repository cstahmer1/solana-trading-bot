import { env, MINT_SOL, MINT_USDC } from "./config.js";
import { logger } from "../utils/logger.js";
import { fetch as undiciFetch, Agent } from "undici";
import { getBatchTokens, type TokenPair } from "./dexscreener.js";

// Use undici with keep-alive for better connection handling
const agent = new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connect: {
    timeout: 30000,
  },
});

// Use undici fetch for better network compatibility
const httpFetch = undiciFetch;

type QuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  swapMode?: "ExactIn" | "ExactOut";
  restrictIntermediateTokens?: boolean;
};

export type QuoteResponse = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot?: number;
};

function headers(extra?: Record<string, string>) {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };
  if (env.JUP_API_KEY) {
    h["x-api-key"] = env.JUP_API_KEY;
  }
  return h;
}

export async function jupQuote(p: QuoteParams): Promise<QuoteResponse> {
  // Use the free tier Jupiter API (lite-api.jup.ag)
  const url = new URL(`https://lite-api.jup.ag/swap/v1/quote`);
  url.searchParams.set("inputMint", p.inputMint);
  url.searchParams.set("outputMint", p.outputMint);
  url.searchParams.set("amount", p.amount);
  url.searchParams.set("slippageBps", String(p.slippageBps));
  url.searchParams.set("swapMode", p.swapMode ?? "ExactIn");
  if (p.restrictIntermediateTokens) url.searchParams.set("restrictIntermediateTokens", "true");

  const maxRetries = 3;
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await httpFetch(url.toString(), { 
        headers: {
          ...headers(),
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; SolTradingBot/1.0)",
        },
        dispatcher: agent,
      });
      
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jup quote failed ${res.status}: ${text}`);
      }
      return (await res.json()) as QuoteResponse;
    } catch (e: any) {
      lastError = e;
      logger.warn({ 
        attempt: attempt + 1, 
        maxRetries, 
        error: e.message,
        outputMint: p.outputMint,
      }, "Jupiter quote attempt failed, retrying...");
      
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  
  throw lastError ?? new Error("Jupiter quote failed after retries");
}

export async function jupSwapTx(args: {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
  dynamicComputeUnitLimit?: boolean;
  dynamicSlippage?: boolean;
  prioritizationFeeLamports?: any;
}): Promise<{ swapTransaction: string; lastValidBlockHeight: number; prioritizationFeeLamports?: number }> {
  // Use the free tier Jupiter API (lite-api.jup.ag)
  const res = await httpFetch(`https://lite-api.jup.ag/swap/v1/swap`, {
    method: "POST",
    headers: {
      ...headers(),
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; SolTradingBot/1.0)",
    },
    body: JSON.stringify({
      quoteResponse: args.quoteResponse,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: args.dynamicComputeUnitLimit ?? true,
      dynamicSlippage: args.dynamicSlippage ?? false,
      prioritizationFeeLamports: args.prioritizationFeeLamports ?? {
        priorityLevelWithMaxLamports: { priorityLevel: "medium", maxLamports: 1_000_000, global: false }
      },
    }),
    dispatcher: agent,
  });
  if (!res.ok) throw new Error(`Jup swap failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as any;
}

export type PriceData = { 
  usdPrice: number; 
  decimals: number; 
  blockId: number | null; 
};

async function getSolUsdPrice(): Promise<number> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (!res.ok) {
      logger.warn({ status: res.status }, "CoinGecko price failed, using fallback");
      return 200;
    }
    const json = await res.json() as { solana?: { usd?: number } };
    return json.solana?.usd ?? 200;
  } catch (e) {
    logger.warn({ err: String(e) }, "CoinGecko fetch failed");
    return 200;
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getTokenPriceViaDexScreener(mint: string, solUsd: number): Promise<{ price: number; decimals: number }> {
  try {
    const res = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, 5000);
    if (!res.ok) return { price: 0, decimals: 9 };
    const json = await res.json() as { pairs?: Array<{ priceUsd?: string; baseToken?: { decimals?: number } }> };
    const pair = json.pairs?.[0];
    const price = parseFloat(pair?.priceUsd ?? "0") || 0;
    const decimals = pair?.baseToken?.decimals ?? 9;
    return { price, decimals };
  } catch {
    return { price: 0, decimals: 9 };
  }
}

export async function jupUsdPrices(mints: string[]): Promise<Record<string, PriceData>> {
  const solUsd = await getSolUsdPrice();
  
  const result: Record<string, PriceData> = {
    [MINT_SOL]: { usdPrice: solUsd, decimals: 9, blockId: null },
    [MINT_USDC]: { usdPrice: 1.0, decimals: 6, blockId: null },
  };
  
  const otherMints = mints.filter(m => m !== MINT_SOL && m !== MINT_USDC);
  if (otherMints.length === 0) return result;
  
  const pricePromises = otherMints.map(async (mint) => {
    const dexData = await getTokenPriceViaDexScreener(mint, solUsd);
    return { mint, price: dexData.price, decimals: dexData.decimals };
  });
  
  const prices = await Promise.all(pricePromises);
  let successCount = 0;
  
  for (const { mint, price, decimals } of prices) {
    result[mint] = { usdPrice: price, decimals, blockId: null };
    if (price > 0) successCount++;
  }
  
  if (successCount > 0) {
    logger.info({ count: successCount, total: otherMints.length }, "Got prices from DexScreener");
  }
  
  return result;
}

// Jupiter Token API types
export type NormalizedJupiterToken = {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  volume24h: number;
  liquidity: number;
  holders: number;
  priceChange24h: number;
  marketCap: number;
  tags: string[];
};

async function jupTokenApiFetch<T>(endpoint: string): Promise<T | null> {
  try {
    const hdrs: Record<string, string> = {
      "Accept": "application/json",
    };
    
    if (env.JUP_API_KEY) {
      hdrs["x-api-key"] = env.JUP_API_KEY;
    }

    const response = await fetch(`https://api.jup.ag${endpoint}`, { headers: hdrs });
    
    if (!response.ok) {
      logger.warn({ status: response.status, endpoint }, "Jupiter Token API request failed");
      return null;
    }
    
    return await response.json() as T;
  } catch (err) {
    logger.error({ err, endpoint }, "Jupiter Token API fetch error");
    return null;
  }
}

export type JupiterTokenV2 = {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  holderCount?: number;
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  tags?: string[];
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  stats24h?: {
    priceChange?: number;
    buyVolume?: number;
    sellVolume?: number;
    numTraders?: number;
  };
};

export async function getJupiterTrendingTokens(): Promise<NormalizedJupiterToken[]> {
  const tokens = await jupTokenApiFetch<JupiterTokenV2[]>("/tokens/v2/toptrending/24h?limit=50");
  
  if (!tokens || !Array.isArray(tokens)) {
    logger.info("No trending tokens from Jupiter v2");
    return [];
  }
  
  const validTokens = tokens.filter(t => t.id && t.symbol);
  const mints = validTokens.map(t => t.id);
  
  let dexPriceChanges = new Map<string, number>();
  try {
    const dexData = await getBatchTokens(mints);
    for (const [mint, pairs] of dexData) {
      if (pairs && pairs.length > 0) {
        const bestPair = pairs.reduce((best, p) => {
          const bestLiq = best.liquidity?.usd || 0;
          const pLiq = p.liquidity?.usd || 0;
          return pLiq > bestLiq ? p : best;
        }, pairs[0]);
        if (bestPair.priceChange?.h24 !== undefined) {
          dexPriceChanges.set(mint, bestPair.priceChange.h24);
        }
      }
    }
    logger.info({ count: dexPriceChanges.size, total: mints.length }, "Fetched accurate 24h changes from DexScreener for Jupiter tokens");
  } catch (err) {
    logger.warn({ err }, "Failed to fetch DexScreener data for Jupiter tokens, using Jupiter values as fallback");
  }
  
  const normalized: NormalizedJupiterToken[] = validTokens.map(t => {
    const volume24h = (t.stats24h?.buyVolume || 0) + (t.stats24h?.sellVolume || 0);
    const jupiterPriceChangePct = (t.stats24h?.priceChange || 0) * 100;
    const dexPriceChange = dexPriceChanges.get(t.id);
    const priceChange24h = dexPriceChange !== undefined ? dexPriceChange : jupiterPriceChangePct;
    
    return {
      mint: t.id,
      symbol: t.symbol || "Unknown",
      name: t.name || "Unknown",
      price: t.usdPrice || 0,
      volume24h,
      liquidity: t.liquidity || 0,
      holders: t.holderCount || 0,
      priceChange24h,
      marketCap: t.mcap || 0,
      tags: t.tags || [],
    };
  });
  
  logger.info({ count: normalized.length }, "Fetched trending tokens from Jupiter v2");
  return normalized;
}

export async function getJupiterTokenInfo(mint: string): Promise<JupiterTokenV2 | null> {
  const tokens = await jupTokenApiFetch<JupiterTokenV2[]>(`/tokens/v2/search?query=${mint}`);
  return tokens?.[0] ?? null;
}

export async function getJupiterTopTraded(): Promise<NormalizedJupiterToken[]> {
  const tokens = await jupTokenApiFetch<JupiterTokenV2[]>("/tokens/v2/toptraded/24h?limit=50");
  
  if (!tokens || !Array.isArray(tokens)) {
    logger.info("No top traded tokens from Jupiter v2");
    return [];
  }
  
  const validTokens = tokens.filter(t => t.id && t.symbol);
  const mints = validTokens.map(t => t.id);
  
  let dexPriceChanges = new Map<string, number>();
  try {
    const dexData = await getBatchTokens(mints);
    for (const [mint, pairs] of dexData) {
      if (pairs && pairs.length > 0) {
        const bestPair = pairs.reduce((best, p) => {
          const bestLiq = best.liquidity?.usd || 0;
          const pLiq = p.liquidity?.usd || 0;
          return pLiq > bestLiq ? p : best;
        }, pairs[0]);
        if (bestPair.priceChange?.h24 !== undefined) {
          dexPriceChanges.set(mint, bestPair.priceChange.h24);
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch DexScreener data for Jupiter top traded, using Jupiter values as fallback");
  }
  
  const normalized: NormalizedJupiterToken[] = validTokens.map(t => {
    const volume24h = (t.stats24h?.buyVolume || 0) + (t.stats24h?.sellVolume || 0);
    const jupiterPriceChangePct = (t.stats24h?.priceChange || 0) * 100;
    const dexPriceChange = dexPriceChanges.get(t.id);
    const priceChange24h = dexPriceChange !== undefined ? dexPriceChange : jupiterPriceChangePct;
    
    return {
      mint: t.id,
      symbol: t.symbol || "Unknown",
      name: t.name || "Unknown",
      price: t.usdPrice || 0,
      volume24h,
      liquidity: t.liquidity || 0,
      holders: t.holderCount || 0,
      priceChange24h,
      marketCap: t.mcap || 0,
      tags: t.tags || [],
    };
  });
  
  logger.info({ count: normalized.length }, "Fetched top traded tokens from Jupiter v2");
  return normalized;
}

export async function getJupiterRecentTokens(): Promise<NormalizedJupiterToken[]> {
  const tokens = await jupTokenApiFetch<JupiterTokenV2[]>("/tokens/v2/recent?limit=30");
  
  if (!tokens || !Array.isArray(tokens)) {
    logger.info("No recent tokens from Jupiter v2");
    return [];
  }
  
  const validTokens = tokens.filter(t => t.id && t.symbol);
  const mints = validTokens.map(t => t.id);
  
  let dexPriceChanges = new Map<string, number>();
  try {
    const dexData = await getBatchTokens(mints);
    for (const [mint, pairs] of dexData) {
      if (pairs && pairs.length > 0) {
        const bestPair = pairs.reduce((best, p) => {
          const bestLiq = best.liquidity?.usd || 0;
          const pLiq = p.liquidity?.usd || 0;
          return pLiq > bestLiq ? p : best;
        }, pairs[0]);
        if (bestPair.priceChange?.h24 !== undefined) {
          dexPriceChanges.set(mint, bestPair.priceChange.h24);
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch DexScreener data for Jupiter recent tokens, using Jupiter values as fallback");
  }
  
  const normalized: NormalizedJupiterToken[] = validTokens.map(t => {
    const volume24h = (t.stats24h?.buyVolume || 0) + (t.stats24h?.sellVolume || 0);
    const jupiterPriceChangePct = (t.stats24h?.priceChange || 0) * 100;
    const dexPriceChange = dexPriceChanges.get(t.id);
    const priceChange24h = dexPriceChange !== undefined ? dexPriceChange : jupiterPriceChangePct;
    
    return {
      mint: t.id,
      symbol: t.symbol || "Unknown",
      name: t.name || "Unknown",
      price: t.usdPrice || 0,
      volume24h,
      liquidity: t.liquidity || 0,
      holders: t.holderCount || 0,
      priceChange24h,
      marketCap: t.mcap || 0,
      tags: t.tags || [],
    };
  });
  
  logger.info({ count: normalized.length }, "Fetched recent tokens from Jupiter v2");
  return normalized;
}

const priceCache = new Map<string, { price: number; timestamp: number }>();
const PRICE_CACHE_TTL = 10_000;

export async function getJupiterBatchPrices(mints: string[]): Promise<Record<string, number | null>> {
  const result: Record<string, number | null> = {};
  const now = Date.now();
  const mintsToFetch: string[] = [];

  for (const mint of mints) {
    const cached = priceCache.get(mint);
    if (cached && (now - cached.timestamp) < PRICE_CACHE_TTL) {
      result[mint] = cached.price;
    } else {
      mintsToFetch.push(mint);
    }
  }

  if (mintsToFetch.length === 0) {
    return result;
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < mintsToFetch.length; i += BATCH_SIZE) {
    const batch = mintsToFetch.slice(i, i + BATCH_SIZE);
    try {
      const idsParam = batch.join(",");
      const url = `https://api.jup.ag/price/v2?ids=${idsParam}`;
      
      const hdrs: Record<string, string> = { "Accept": "application/json" };
      if (env.JUP_API_KEY) {
        hdrs["x-api-key"] = env.JUP_API_KEY;
      }

      const response = await fetchWithTimeout(url, { headers: hdrs }, 10000);
      
      if (response.ok) {
        const data = await response.json() as { data?: Record<string, { price?: string }> };
        for (const mint of batch) {
          const priceStr = data.data?.[mint]?.price;
          const price = priceStr ? parseFloat(priceStr) : null;
          result[mint] = price;
          if (price !== null) {
            priceCache.set(mint, { price, timestamp: now });
          }
        }
      } else {
        for (const mint of batch) {
          result[mint] = null;
        }
      }
    } catch (err) {
      logger.warn({ err: String(err), batchSize: batch.length }, "Jupiter batch price fetch failed");
      for (const mint of batch) {
        result[mint] = null;
      }
    }
  }

  const priced = Object.values(result).filter(p => p !== null).length;
  if (mintsToFetch.length > 0) {
    logger.debug({ fetched: mintsToFetch.length, priced, cached: mints.length - mintsToFetch.length }, "Jupiter batch prices");
  }

  return result;
}
