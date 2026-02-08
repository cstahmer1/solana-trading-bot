import { logger } from "../utils/logger.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const CACHE_TTL_MS = 60_000;

type CacheEntry<T> = { data: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function dexFetch<T>(endpoint: string, ttlMs = CACHE_TTL_MS): Promise<T | null> {
  const cacheKey = endpoint;
  const cached = getCached<T>(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${DEXSCREENER_BASE}${endpoint}`, {
      headers: {
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      logger.warn({ status: res.status, endpoint }, "DexScreener API error");
      return null;
    }

    const json = await res.json() as T;
    setCache(cacheKey, json, ttlMs);
    return json;
  } catch (err) {
    logger.error({ err, endpoint }, "DexScreener fetch failed");
    return null;
  }
}

export type TokenProfile = {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: { type: string; url: string }[];
};

export type BoostedToken = {
  url: string;
  chainId: string;
  tokenAddress: string;
  amount: number;
  totalAmount: number;
  icon?: string;
};

export type TokenPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
    decimals?: number;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
};

export type NormalizedToken = {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  volume24h: number;
  liquidity: number;
  holders: number;
  priceChange24h: number;
  marketCap: number;
  icon?: string;
  source: "dexscreener";
};

export async function getTokenProfiles(): Promise<TokenProfile[]> {
  const data = await dexFetch<TokenProfile[]>("/token-profiles/latest/v1", 60_000);
  if (!data) return [];
  return data.filter((t) => t.chainId === "solana");
}

export async function getBoostedTokens(): Promise<BoostedToken[]> {
  const data = await dexFetch<BoostedToken[]>("/token-boosts/latest/v1", 60_000);
  if (!data) return [];
  return data.filter((t) => t.chainId === "solana");
}

export async function getTokenPairs(mint: string): Promise<TokenPair[]> {
  const data = await dexFetch<{ pairs: TokenPair[] }>(`/latest/dex/tokens/${mint}`, 30_000);
  if (!data?.pairs) return [];
  return data.pairs.filter((p) => p.chainId === "solana");
}

export async function getBatchTokens(mints: string[]): Promise<Map<string, TokenPair[]>> {
  const result = new Map<string, TokenPair[]>();
  if (mints.length === 0) return result;

  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) {
    chunks.push(mints.slice(i, i + 30));
  }

  for (const chunk of chunks) {
    const addresses = chunk.join(",");
    const data = await dexFetch<TokenPair[]>(`/tokens/v1/solana/${addresses}`, 30_000);
    if (data) {
      for (const pair of data) {
        const mint = pair.baseToken.address;
        if (!result.has(mint)) {
          result.set(mint, []);
        }
        result.get(mint)!.push(pair);
      }
    }
  }

  return result;
}

function getBestPair(pairs: TokenPair[]): TokenPair | null {
  if (!pairs || pairs.length === 0) return null;
  return pairs.reduce((best, p) => {
    const bestLiq = best.liquidity?.usd || 0;
    const pLiq = p.liquidity?.usd || 0;
    return pLiq > bestLiq ? p : best;
  }, pairs[0]);
}

function normalizePair(pair: TokenPair, icon?: string): NormalizedToken {
  return {
    mint: pair.baseToken.address,
    symbol: pair.baseToken.symbol || "Unknown",
    name: pair.baseToken.name || "Unknown",
    price: parseFloat(pair.priceUsd) || 0,
    volume24h: pair.volume?.h24 || 0,
    liquidity: pair.liquidity?.usd || 0,
    holders: 0,
    priceChange24h: pair.priceChange?.h24 || 0,
    marketCap: pair.marketCap || pair.fdv || 0,
    icon: icon || pair.info?.imageUrl,
    source: "dexscreener",
  };
}

export async function getTrendingTokens(): Promise<NormalizedToken[]> {
  const [profiles, boosted] = await Promise.all([
    getTokenProfiles(),
    getBoostedTokens(),
  ]);

  const mintSet = new Set<string>();
  const mintIcons = new Map<string, string>();
  
  for (const p of profiles) {
    mintSet.add(p.tokenAddress);
    if (p.icon) mintIcons.set(p.tokenAddress, p.icon);
  }
  for (const b of boosted) {
    mintSet.add(b.tokenAddress);
    if (b.icon) mintIcons.set(b.tokenAddress, b.icon);
  }

  const mints = Array.from(mintSet).slice(0, 100);
  if (mints.length === 0) {
    logger.info("No trending tokens found from DexScreener");
    return [];
  }

  const pairsMap = await getBatchTokens(mints);
  const results: NormalizedToken[] = [];

  for (const mint of mints) {
    const pairs = pairsMap.get(mint);
    const best = getBestPair(pairs || []);
    if (best) {
      results.push(normalizePair(best, mintIcons.get(mint)));
    }
  }

  results.sort((a, b) => b.volume24h - a.volume24h);
  logger.info({ count: results.length }, "Fetched trending tokens from DexScreener");
  return results;
}

export async function getNewListings(): Promise<NormalizedToken[]> {
  const profiles = await getTokenProfiles();
  
  const mints = profiles.map((p) => p.tokenAddress).slice(0, 50);
  if (mints.length === 0) {
    logger.info("No new listings found from DexScreener");
    return [];
  }

  const mintIcons = new Map<string, string>();
  for (const p of profiles) {
    if (p.icon) mintIcons.set(p.tokenAddress, p.icon);
  }

  const pairsMap = await getBatchTokens(mints);
  const results: NormalizedToken[] = [];

  for (const mint of mints) {
    const pairs = pairsMap.get(mint);
    const best = getBestPair(pairs || []);
    if (best) {
      results.push(normalizePair(best, mintIcons.get(mint)));
    }
  }

  logger.info({ count: results.length }, "Fetched new listings from DexScreener");
  return results;
}

export function clearCache() {
  cache.clear();
}

export function getCacheStats() {
  let valid = 0;
  let expired = 0;
  const now = Date.now();
  for (const [, entry] of cache) {
    if (now > entry.expiresAt) expired++;
    else valid++;
  }
  return { valid, expired, total: cache.size };
}
