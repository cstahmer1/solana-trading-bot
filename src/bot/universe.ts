import { env, MINT_SOL, MINT_USDC } from "./config.js";
import { loadTradingUniverse, addTokenToUniverse, removeTokenFromUniverse, getDustPositionsForCleanup, removePositionTracking, getPositionTracking } from "./persist.js";
import { getTokenPairs } from "./dexscreener.js";
import { getConfig } from "./runtime_config.js";
import { logger } from "../utils/logger.js";
import { handleTokenExit } from "./universe_membership.js";

export type UniverseToken = { mint: string; symbol: string; name?: string };

let cachedUniverse: UniverseToken[] | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60_000;

function buildFallbackUniverse(): UniverseToken[] {
  const user = (env.UNIVERSE_MINTS ?? "").trim();
  const extra = user
    ? user.split(",").map((s) => s.trim()).filter(Boolean).map((mint) => ({ mint, symbol: mint.slice(0, 4) + "…" }))
    : [];

  return [
    { mint: MINT_SOL, symbol: "SOL", name: "Solana" },
    { mint: MINT_USDC, symbol: "USDC", name: "USD Coin" },
    ...extra,
  ];
}

export async function getUniverse(): Promise<UniverseToken[]> {
  const now = Date.now();
  if (cachedUniverse && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedUniverse;
  }

  try {
    const rows = await loadTradingUniverse();
    if (rows.length === 0) {
      cachedUniverse = buildFallbackUniverse();
    } else {
      cachedUniverse = rows.map((r) => ({
        mint: r.mint,
        symbol: r.symbol,
        name: r.name ?? undefined,
      }));
    }
    lastCacheTime = now;
    return cachedUniverse;
  } catch (err) {
    logger.warn({ err }, "Failed to load universe from DB, using fallback");
    return buildFallbackUniverse();
  }
}

export function buildUniverse(): UniverseToken[] {
  if (cachedUniverse) return cachedUniverse;
  return buildFallbackUniverse();
}

export async function refreshUniverse(): Promise<UniverseToken[]> {
  cachedUniverse = null;
  lastCacheTime = 0;
  return getUniverse();
}

export async function addToUniverse(
  mint: string,
  symbol: string,
  name?: string,
  source: string = "manual"
): Promise<boolean> {
  const success = await addTokenToUniverse({ mint, symbol, name, source });
  if (success) {
    cachedUniverse = null;
    lastCacheTime = 0;
    logger.info({ mint, symbol, source }, "Token added to trading universe");
  }
  return success;
}

export async function removeFromUniverse(mint: string): Promise<boolean> {
  if (mint === MINT_SOL || mint === MINT_USDC) {
    logger.warn({ mint }, "Cannot remove default tokens from universe");
    return false;
  }
  const success = await removeTokenFromUniverse(mint);
  if (success) {
    cachedUniverse = null;
    lastCacheTime = 0;
    logger.info({ mint }, "Token removed from trading universe");
  }
  return success;
}

export async function checkAndPruneToken(mint: string): Promise<boolean> {
  if (mint === MINT_SOL || mint === MINT_USDC) {
    return false;
  }

  try {
    const config = getConfig();
    const pairs = await getTokenPairs(mint);
    
    if (!pairs || pairs.length === 0) {
      logger.info({ mint }, "Token has no pairs on DexScreener, pruning from universe");
      const tracking = await getPositionTracking(mint);
      await handleTokenExit(mint, undefined, {
        reason: "no_dex_pairs",
        lastPrice: tracking?.last_price ? Number(tracking.last_price) : undefined,
      });
      cachedUniverse = null;
      lastCacheTime = 0;
      return true;
    }

    const bestPair = pairs.reduce((best, p) => {
      const bestLiq = best.liquidity?.usd || 0;
      const pLiq = p.liquidity?.usd || 0;
      return pLiq > bestLiq ? p : best;
    }, pairs[0]);

    const liquidity = bestPair.liquidity?.usd || 0;
    const volume24h = bestPair.volume?.h24 || 0;

    const meetsLiquidity = liquidity >= config.scannerMinLiquidity;
    const meetsVolume = volume24h >= config.scannerMinVolume24h;

    if (!meetsLiquidity || !meetsVolume) {
      const reason = !meetsLiquidity ? "low_liquidity" : "low_volume";
      logger.info({
        mint,
        liquidity,
        volume24h,
        minLiquidity: config.scannerMinLiquidity,
        minVolume24h: config.scannerMinVolume24h,
        reason,
      }, "Token no longer meets quality thresholds, pruning from universe");
      const tracking = await getPositionTracking(mint);
      await handleTokenExit(mint, undefined, {
        reason,
        lastLiquidityUsd: liquidity,
        lastPrice: tracking?.last_price ? Number(tracking.last_price) : undefined,
      });
      cachedUniverse = null;
      lastCacheTime = 0;
      return true;
    }

    return false;
  } catch (err) {
    logger.warn({ mint, err }, "Failed to check token quality for pruning");
    return false;
  }
}

export async function cleanupDustFromUniverse(): Promise<{ removed: string[]; count: number }> {
  const removed: string[] = [];
  
  try {
    const dustPositions = await getDustPositionsForCleanup(24);
    
    for (const { mint } of dustPositions) {
      if (mint === MINT_SOL || mint === MINT_USDC) {
        continue;
      }
      
      const tracking = await getPositionTracking(mint);
      const success = await handleTokenExit(mint, undefined, {
        reason: "dust_cleanup_24h",
        lastPrice: tracking?.last_price ? Number(tracking.last_price) : undefined,
      });
      
      if (success) {
        removed.push(mint);
        cachedUniverse = null;
        lastCacheTime = 0;
      }
    }
    
    if (removed.length > 0) {
      logger.info({ count: removed.length, mints: removed }, "Completed dust cleanup from universe");
    }
    
    return { removed, count: removed.length };
  } catch (err) {
    logger.warn({ err }, "Error during dust cleanup");
    return { removed, count: removed.length };
  }
}
