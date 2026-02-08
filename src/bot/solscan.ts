import { env } from "./config.js";
import { logger } from "../utils/logger.js";

const SOLSCAN_BASE = "https://pro-api.solscan.io/v2.0";
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

async function solscanFetch<T>(endpoint: string, ttlMs = CACHE_TTL_MS): Promise<T | null> {
  const cacheKey = endpoint;
  const cached = getCached<T>(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${SOLSCAN_BASE}${endpoint}`, {
      headers: {
        "token": process.env.SOLSCAN_API_KEY || "",
        "Accept": "application/json",
      },
    });
    
    if (!res.ok) {
      logger.warn({ status: res.status, endpoint }, "Solscan API error");
      return null;
    }
    
    const json = await res.json() as { success: boolean; data: T };
    if (!json.success) {
      logger.warn({ endpoint, response: json }, "Solscan API returned unsuccessful");
      return null;
    }
    
    setCache(cacheKey, json.data, ttlMs);
    return json.data;
  } catch (err) {
    logger.error({ err, endpoint }, "Solscan fetch failed");
    return null;
  }
}

export type TokenMeta = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  holder?: number;
  supply?: string;
  price?: number;
  volume_24h?: number;
  market_cap?: number;
};

export type TokenTransfer = {
  trans_id: string;
  block_id: number;
  block_time: number;
  from_address: string;
  to_address: string;
  token_address: string;
  token_decimals: number;
  amount: string;
  flow: "in" | "out";
};

export type TokenHolder = {
  address: string;
  amount: number;
  decimals: number;
  owner: string;
  rank: number;
};

export type MarketInfo = {
  pool_id: string;
  program_id: string;
  token_1: string;
  token_2: string;
  token_1_reserve: string;
  token_2_reserve: string;
  volume_24h?: number;
  tvl?: number;
};

export type TrendingToken = {
  address: string;
  symbol: string;
  name: string;
  price: number;
  price_change_24h: number;
  volume_24h: number;
  market_cap: number;
  holder: number;
};

export async function getTokenMeta(mint: string): Promise<TokenMeta | null> {
  return solscanFetch<TokenMeta>(`/token/meta?address=${mint}`, 300_000);
}

export async function getTokenTransfers(
  mint: string,
  limit = 20
): Promise<TokenTransfer[]> {
  const data = await solscanFetch<{ items: TokenTransfer[] }>(
    `/token/transfer?address=${mint}&page=1&page_size=${limit}&sort_by=block_time&sort_order=desc`,
    30_000
  );
  return data?.items ?? [];
}

export async function getTokenHolders(
  mint: string,
  limit = 20
): Promise<TokenHolder[]> {
  const data = await solscanFetch<{ items: TokenHolder[] }>(
    `/token/holders?address=${mint}&page=1&page_size=${limit}`,
    120_000
  );
  return data?.items ?? [];
}

export async function getTokenMarkets(mint: string): Promise<MarketInfo[]> {
  const data = await solscanFetch<MarketInfo[]>(
    `/token/markets?address=${mint}`,
    60_000
  );
  return data ?? [];
}

export async function getAccountTransfers(
  address: string,
  limit = 50
): Promise<TokenTransfer[]> {
  const data = await solscanFetch<{ items: TokenTransfer[] }>(
    `/account/transfer?address=${address}&page=1&page_size=${limit}&sort_by=block_time&sort_order=desc`,
    30_000
  );
  return data?.items ?? [];
}

export async function getTrendingTokens(): Promise<TrendingToken[]> {
  const data = await solscanFetch<TrendingToken[]>(
    `/token/trending?limit=50`,
    120_000
  );
  return data ?? [];
}

export async function getNewListings(limit = 50): Promise<TokenMeta[]> {
  const data = await solscanFetch<TokenMeta[]>(
    `/token/list?sort_by=created_time&sort_order=desc&page=1&page_size=${limit}`,
    60_000
  );
  return data ?? [];
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
