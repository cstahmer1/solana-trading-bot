import { logger } from "../utils/logger.js";
import { getTrendingTokens, getNewListings, NormalizedToken } from "./dexscreener.js";
import { getJupiterTrendingTokens, NormalizedJupiterToken } from "./jupiter.js";
import { env, MINT_SOL, MINT_USDC } from "./config.js";
import { insertOpportunity, insertTrendingToken, getAllPositionTracking, getMintsOnCooldown } from "./persist.js";
import { getScannerConfig } from "./runtime_config.js";
import { getUniverse } from "./universe.js";
import { logScanOpportunity, getOrCreateJourneyId } from "./event_logger.js";

export type ScannerToken = {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  holders: number;
  liquidity: number;
  score: number;
  reasons: string[];
  source: string;
};

export type ScannerConfig = {
  minLiquidity: number;
  minVolume24h: number;
  minHolders: number;
  maxPriceChange24h: number;
  minPriceChange24h: number;
  excludeMints: string[];
};

const DEFAULT_CONFIG: ScannerConfig = {
  minLiquidity: 10000,
  minVolume24h: 5000,
  minHolders: 100,
  maxPriceChange24h: 500,
  minPriceChange24h: -50,
  excludeMints: [MINT_SOL, MINT_USDC],
};

type ScoreableToken = {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  volume24h: number;
  liquidity: number;
  holders: number;
  priceChange24h: number;
  marketCap: number;
};

export async function scanTrendingTokens(config: Partial<ScannerConfig> = {}): Promise<ScannerToken[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  try {
    const trending = await getTrendingTokens();
    if (!trending || trending.length === 0) {
      logger.info("No trending tokens found from DexScreener");
      return [];
    }

    const scored: ScannerToken[] = [];

    for (const token of trending) {
      if (cfg.excludeMints.includes(token.mint)) continue;
      
      const { score, reasons, passes } = scoreToken(token, cfg);
      
      if (!passes) continue;

      scored.push({
        mint: token.mint,
        symbol: token.symbol || "Unknown",
        name: token.name || "Unknown",
        price: token.price || 0,
        priceChange24h: token.priceChange24h || 0,
        volume24h: token.volume24h || 0,
        marketCap: token.marketCap || 0,
        holders: token.holders || 0,
        liquidity: token.liquidity || 0,
        score,
        reasons,
        source: "dexscreener",
      });
    }

    scored.sort((a, b) => b.score - a.score);
    
    logger.info({ count: scored.length }, "Scanned trending tokens");
    return scored.slice(0, 20);
  } catch (err) {
    logger.error({ err }, "Error scanning trending tokens");
    return [];
  }
}

export async function scanJupiterTrending(config: Partial<ScannerConfig> = {}): Promise<ScannerToken[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  try {
    const jupTokens = await getJupiterTrendingTokens();
    if (!jupTokens || jupTokens.length === 0) {
      logger.info("No trending tokens from Jupiter");
      return [];
    }

    const scored: ScannerToken[] = [];

    for (const token of jupTokens) {
      if (cfg.excludeMints.includes(token.mint)) continue;
      
      const scoreableToken = {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        price: token.price,
        volume24h: token.volume24h,
        liquidity: token.liquidity,
        holders: token.holders,
        priceChange24h: token.priceChange24h,
        marketCap: token.marketCap,
      };
      
      const { score: baseScore, reasons: baseReasons, passes } = scoreToken(scoreableToken, cfg);
      
      if (!passes) continue;
      
      let score = baseScore;
      const reasons = [...baseReasons];
      
      if (token.tags.includes("birdeye-trending")) {
        score += 2;
        reasons.push("Birdeye trending");
      }
      if (token.tags.includes("verified")) {
        score += 1;
        reasons.push("Verified token");
      }

      scored.push({
        mint: token.mint,
        symbol: token.symbol || "Unknown",
        name: token.name || "Unknown",
        price: token.price || 0,
        priceChange24h: token.priceChange24h || 0,
        volume24h: token.volume24h || 0,
        marketCap: token.marketCap || 0,
        holders: token.holders || 0,
        liquidity: token.liquidity || 0,
        score,
        reasons,
        source: "jupiter",
      });
    }

    scored.sort((a, b) => b.score - a.score);
    
    logger.info({ count: scored.length }, "Scanned Jupiter trending tokens");
    return scored.slice(0, 20);
  } catch (err) {
    logger.error({ err }, "Error scanning Jupiter trending tokens");
    return [];
  }
}

export async function scanNewListings(config: Partial<ScannerConfig> = {}): Promise<ScannerToken[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  try {
    const listings = await getNewListings();
    if (!listings || listings.length === 0) {
      logger.info("No new listings found from DexScreener");
      return [];
    }

    const scored: ScannerToken[] = [];

    for (const token of listings) {
      if (cfg.excludeMints.includes(token.mint)) continue;
      
      const { score, reasons, passes } = scoreToken(token, { ...cfg, minHolders: 0 });
      
      if (!passes) continue;

      scored.push({
        mint: token.mint,
        symbol: token.symbol || "Unknown",
        name: token.name || "Unknown",
        price: token.price || 0,
        priceChange24h: token.priceChange24h || 0,
        volume24h: token.volume24h || 0,
        marketCap: token.marketCap || 0,
        holders: token.holders || 0,
        liquidity: token.liquidity || 0,
        score,
        reasons,
        source: "dexscreener",
      });
    }

    scored.sort((a, b) => b.score - a.score);
    
    logger.info({ count: scored.length }, "Scanned new listings");
    return scored.slice(0, 20);
  } catch (err) {
    logger.error({ err }, "Error scanning new listings");
    return [];
  }
}

export type FilterFailReasons = {
  liquidityTooLow: boolean;
  volumeTooLow: boolean;
  holdersTooLow: boolean;
  priceChangeTooHigh: boolean;
  priceChangeTooLow: boolean;
};

function scoreToken(
  token: ScoreableToken,
  cfg: ScannerConfig
): { score: number; reasons: string[]; passes: boolean; failReasons: FilterFailReasons } {
  const reasons: string[] = [];
  let score = 0;
  let passes = true;
  
  const failReasons: FilterFailReasons = {
    liquidityTooLow: false,
    volumeTooLow: false,
    holdersTooLow: false,
    priceChangeTooHigh: false,
    priceChangeTooLow: false,
  };

  if ((token.liquidity || 0) < cfg.minLiquidity) {
    passes = false;
    failReasons.liquidityTooLow = true;
  }

  if ((token.volume24h || 0) < cfg.minVolume24h) {
    passes = false;
    failReasons.volumeTooLow = true;
  }
  
  if ((token.holders || 0) < cfg.minHolders) {
    passes = false;
    failReasons.holdersTooLow = true;
  }
  
  const priceChange = token.priceChange24h || 0;
  if (priceChange > cfg.maxPriceChange24h) {
    passes = false;
    failReasons.priceChangeTooHigh = true;
  }
  if (priceChange < cfg.minPriceChange24h) {
    passes = false;
    failReasons.priceChangeTooLow = true;
  }

  if (!passes) return { score: 0, reasons: [], passes: false, failReasons };

  if (token.volume24h > 100000) {
    score += 3;
    reasons.push("High volume");
  } else if (token.volume24h > 50000) {
    score += 2;
    reasons.push("Good volume");
  } else if (token.volume24h > 10000) {
    score += 1;
    reasons.push("Moderate volume");
  }

  if (token.holders > 1000) {
    score += 3;
    reasons.push("Large holder base");
  } else if (token.holders > 500) {
    score += 2;
    reasons.push("Growing holder base");
  } else if (token.holders > 200) {
    score += 1;
    reasons.push("Early holder growth");
  }

  if (priceChange >= 10 && priceChange <= 100) {
    score += 2;
    reasons.push("Positive momentum");
  } else if (priceChange >= -10 && priceChange < 10) {
    score += 1;
    reasons.push("Stable price");
  } else if (priceChange >= -30 && priceChange < -10) {
    score += 2;
    reasons.push("Potential dip buy");
  }

  if (token.marketCap > 1000000 && token.marketCap < 50000000) {
    score += 2;
    reasons.push("Mid-cap potential");
  } else if (token.marketCap > 100000 && token.marketCap <= 1000000) {
    score += 3;
    reasons.push("Low-cap gem potential");
  }

  if (token.liquidity > 50000) {
    score += 2;
    reasons.push("High liquidity");
  } else if (token.liquidity > 20000) {
    score += 1;
    reasons.push("Good liquidity");
  }

  return { score, reasons, passes, failReasons };
}

export type ScanStats = {
  candidatesFetched: number;
  passedLiquidity: number;
  passedVolume: number;
  passedHolders: number;
  passedPriceChange: number;
  topFailReasons: Record<string, number>;
};

export type ScanResult = {
  timestamp: number;
  trending: ScannerToken[];
  newListings: ScannerToken[];
  topOpportunities: ScannerToken[];
  source: string;
  stats: ScanStats;
};

let lastScan: ScanResult | null = null;
let lastScanTime = 0;
const SCAN_COOLDOWN_MS = 5 * 60 * 1000;

export async function runMarketScan(force = false): Promise<ScanResult> {
  logger.info({ force }, "SCANNER: Entering runMarketScan");
  const now = Date.now();
  
  if (!force && lastScan && now - lastScanTime < SCAN_COOLDOWN_MS) {
    logger.info("SCANNER: Returning cached scan result (cooldown)");
    return lastScan;
  }

  logger.info("Running market scan...");

  const scannerConfig = getScannerConfig();
  const cfg = { ...DEFAULT_CONFIG, ...scannerConfig };

  const [rawTrending, rawListings, rawJupiter] = await Promise.all([
    getTrendingTokens().catch(() => [] as NormalizedToken[]),
    getNewListings().catch(() => [] as NormalizedToken[]),
    getJupiterTrendingTokens().catch(() => [] as NormalizedJupiterToken[]),
  ]);

  const stats: ScanStats = {
    candidatesFetched: 0,
    passedLiquidity: 0,
    passedVolume: 0,
    passedHolders: 0,
    passedPriceChange: 0,
    topFailReasons: {
      liquidityTooLow: 0,
      volumeTooLow: 0,
      holdersTooLow: 0,
      priceChangeTooHigh: 0,
      priceChangeTooLow: 0,
    },
  };

  const allRawCandidates: ScoreableToken[] = [];
  
  for (const token of rawTrending) {
    if (!cfg.excludeMints.includes(token.mint)) {
      allRawCandidates.push({
        mint: token.mint,
        symbol: token.symbol || "Unknown",
        name: token.name || "Unknown",
        price: token.price || 0,
        volume24h: token.volume24h || 0,
        liquidity: token.liquidity || 0,
        holders: token.holders || 0,
        priceChange24h: token.priceChange24h || 0,
        marketCap: token.marketCap || 0,
      });
    }
  }
  
  for (const token of rawListings) {
    if (!cfg.excludeMints.includes(token.mint)) {
      allRawCandidates.push({
        mint: token.mint,
        symbol: token.symbol || "Unknown",
        name: token.name || "Unknown",
        price: token.price || 0,
        volume24h: token.volume24h || 0,
        liquidity: token.liquidity || 0,
        holders: token.holders || 0,
        priceChange24h: token.priceChange24h || 0,
        marketCap: token.marketCap || 0,
      });
    }
  }
  
  for (const token of rawJupiter) {
    if (!cfg.excludeMints.includes(token.mint)) {
      allRawCandidates.push({
        mint: token.mint,
        symbol: token.symbol || "Unknown",
        name: token.name || "Unknown",
        price: token.price || 0,
        volume24h: token.volume24h || 0,
        liquidity: token.liquidity || 0,
        holders: token.holders || 0,
        priceChange24h: token.priceChange24h || 0,
        marketCap: token.marketCap || 0,
      });
    }
  }

  const seenMints = new Set<string>();
  const uniqueRawCandidates: ScoreableToken[] = [];
  for (const c of allRawCandidates) {
    if (!seenMints.has(c.mint)) {
      seenMints.add(c.mint);
      uniqueRawCandidates.push(c);
    }
  }
  
  stats.candidatesFetched = uniqueRawCandidates.length;
  
  for (const token of uniqueRawCandidates) {
    const { failReasons } = scoreToken(token, cfg);
    
    if (!failReasons.liquidityTooLow) stats.passedLiquidity++;
    else stats.topFailReasons.liquidityTooLow++;
    
    if (!failReasons.volumeTooLow) stats.passedVolume++;
    else stats.topFailReasons.volumeTooLow++;
    
    if (!failReasons.holdersTooLow) stats.passedHolders++;
    else stats.topFailReasons.holdersTooLow++;
    
    if (!failReasons.priceChangeTooHigh && !failReasons.priceChangeTooLow) {
      stats.passedPriceChange++;
    } else {
      if (failReasons.priceChangeTooHigh) stats.topFailReasons.priceChangeTooHigh++;
      if (failReasons.priceChangeTooLow) stats.topFailReasons.priceChangeTooLow++;
    }
  }

  const [trending, newListings, jupiterTrending] = await Promise.all([
    scanTrendingTokens({ ...scannerConfig, minHolders: 0 }),
    scanNewListings(scannerConfig),
    scanJupiterTrending(scannerConfig),
  ]);

  // PRE-FILTER: Get tokens we already own or can't buy to exclude them BEFORE selecting top candidates
  // Batch load all filter data in parallel (single DB query each)
  const [universe, positions, cooldownMints] = await Promise.all([
    getUniverse(),
    getAllPositionTracking(),
    getMintsOnCooldown(),
  ]);
  const universeMints = new Set(universe.map(u => u.mint));
  const positionMints = new Set(positions.map(p => p.mint));
  
  // Filter function to check if token is eligible for auto-queue (no async - uses preloaded data)
  const isEligibleForQueue = (token: ScannerToken): boolean => {
    if (universeMints.has(token.mint)) return false;
    if (positionMints.has(token.mint)) return false;
    if (cooldownMints.has(token.mint)) return false;
    return true;
  };
  
  // SEPARATE PROCESSING: Reserve slots for new listings (fresh discoveries)
  const NEW_LISTING_RESERVED_SLOTS = 3;
  const TRENDING_SLOTS = 7;
  
  // Filter new listings first (these are fresh discoveries)
  const eligibleNewListings = newListings.filter(isEligibleForQueue);
  eligibleNewListings.sort((a, b) => b.score - a.score);
  const reservedNewListings = eligibleNewListings.slice(0, NEW_LISTING_RESERVED_SLOTS);
  const reservedMints = new Set(reservedNewListings.map(t => t.mint));
  
  // Combine trending sources
  const allTrending = [...trending, ...jupiterTrending];
  const seenTrending = new Set<string>();
  const uniqueTrending: ScannerToken[] = [];
  for (const t of allTrending) {
    if (!seenTrending.has(t.mint) && !reservedMints.has(t.mint)) {
      seenTrending.add(t.mint);
      uniqueTrending.push(t);
    }
  }
  
  // Filter trending tokens for eligibility
  const eligibleTrending = uniqueTrending.filter(isEligibleForQueue);
  eligibleTrending.sort((a, b) => b.score - a.score);
  const topTrending = eligibleTrending.slice(0, TRENDING_SLOTS);
  
  // Combine: reserved new listings + top trending
  const topOpportunities = [...reservedNewListings, ...topTrending];
  topOpportunities.sort((a, b) => b.score - a.score);
  
  logger.info({ 
    reservedNewListings: reservedNewListings.length,
    eligibleTrending: topTrending.length,
    totalOpportunities: topOpportunities.length,
    skippedUniverse: universeMints.size,
    skippedPositions: positionMints.size,
  }, "SCANNER: Pre-filtered eligible tokens for auto-queue");

  // For display purposes, also create full unique list (unfiltered) for UI
  const allTokens = [...trending, ...newListings, ...jupiterTrending];
  const seen = new Set<string>();
  const unique: ScannerToken[] = [];
  for (const t of allTokens) {
    if (!seen.has(t.mint)) {
      seen.add(t.mint);
      unique.push(t);
    }
  }
  unique.sort((a, b) => b.score - a.score);

  const combinedTrending = [...trending, ...jupiterTrending];
  combinedTrending.sort((a, b) => b.score - a.score);

  for (const opp of topOpportunities) {
    try {
      await insertOpportunity({
        mint: opp.mint,
        symbol: opp.symbol,
        name: opp.name,
        score: opp.score,
        volume_24h: opp.volume24h,
        holders: opp.holders,
        price_usd: opp.price,
        market_cap: opp.marketCap,
        liquidity: opp.liquidity,
        price_change_24h: opp.priceChange24h,
        source: opp.source,
        meta: { reasons: opp.reasons },
      });
      
      getOrCreateJourneyId(opp.mint);
      logScanOpportunity({
        mint: opp.mint,
        symbol: opp.symbol,
        score: opp.score,
        reasons: opp.reasons,
        price: opp.price,
        volume24h: opp.volume24h,
        liquidity: opp.liquidity,
        holders: opp.holders,
        priceChange24h: opp.priceChange24h,
        source: opp.source,
        scanner_config_snapshot: {
          minLiquidity: scannerConfig.minLiquidity,
          minVolume24h: scannerConfig.minVolume24h,
          minHolders: scannerConfig.minHolders,
          maxPriceChange24h: scannerConfig.maxPriceChange24h,
          minPriceChange24h: scannerConfig.minPriceChange24h,
        },
      });
    } catch (err) {
      logger.warn({ err, mint: opp.mint }, "Failed to persist opportunity");
    }
  }

  for (let i = 0; i < combinedTrending.slice(0, 20).length; i++) {
    const t = combinedTrending[i];
    try {
      await insertTrendingToken({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        rank: i + 1,
        price_usd: t.price,
        holders: t.holders,
        volume_24h: t.volume24h,
        source: t.source,
      });
    } catch (err) {
      logger.warn({ err, mint: t.mint }, "Failed to persist trending token");
    }
  }

  lastScan = {
    timestamp: now,
    trending: combinedTrending.slice(0, 20),
    newListings,
    topOpportunities,
    source: "dexscreener+jupiter",
    stats,
  };
  lastScanTime = now;

  logger.info({
    trendingCount: trending.length,
    jupiterCount: jupiterTrending.length,
    listingsCount: newListings.length,
    topCount: topOpportunities.length,
    persisted: topOpportunities.length,
    source: "dexscreener+jupiter",
    stats,
  }, "Market scan complete and persisted");

  return lastScan;
}

export function getLastScan(): ScanResult | null {
  return lastScan;
}

export function addToUniverse(mint: string): void {
  logger.info({ mint }, "Token added to trading universe");
}
