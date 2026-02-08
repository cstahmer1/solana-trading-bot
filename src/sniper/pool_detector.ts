import { logger } from "../utils/logger.js";
import { SNIPER_CONFIG, MINT_SOL } from "./config.js";

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";

export interface PoolInfo {
  mint: string;
  hasPool: boolean;
  priceUsd: number | null;
  liquidityUsd: number | null;
  dex: string | null;
}

const poolCache = new Map<string, { info: PoolInfo; timestamp: number }>();
const CACHE_TTL_MS = 10_000;

export async function detectPool(mint: string): Promise<PoolInfo> {
  const cached = poolCache.get(mint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.info;
  }

  try {
    const testAmountLamports = "10000000";
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set("inputMint", MINT_SOL);
    url.searchParams.set("outputMint", mint);
    url.searchParams.set("amount", testAmountLamports);
    url.searchParams.set("slippageBps", "500");

    const response = await fetch(url.toString(), {
      headers: { "Accept": "application/json" },
    });

    if (!response.ok) {
      logger.debug({ mint: mint.slice(0, 8), status: response.status }, "No Jupiter route found");
      const info: PoolInfo = {
        mint,
        hasPool: false,
        priceUsd: null,
        liquidityUsd: null,
        dex: null,
      };
      poolCache.set(mint, { info, timestamp: Date.now() });
      return info;
    }

    const quote = await response.json() as {
      outAmount?: string;
      routePlan?: Array<{ swapInfo?: { ammKey?: string; label?: string } }>;
      priceImpactPct?: string;
    };

    if (!quote.outAmount || quote.outAmount === "0") {
      const info: PoolInfo = {
        mint,
        hasPool: false,
        priceUsd: null,
        liquidityUsd: null,
        dex: null,
      };
      poolCache.set(mint, { info, timestamp: Date.now() });
      return info;
    }

    const dex = quote.routePlan?.[0]?.swapInfo?.label || "unknown";
    const priceImpactRaw = parseFloat(quote.priceImpactPct || "0");
    const priceImpactPct = Math.abs(priceImpactRaw) * 100;
    
    const testAmountSol = parseInt(testAmountLamports) / 1e9;
    const solPriceUsd = 125;
    const testAmountUsd = testAmountSol * solPriceUsd;
    const estimatedLiquidity = priceImpactPct > 0 ? (testAmountUsd / priceImpactPct) * 100 : null;

    const info: PoolInfo = {
      mint,
      hasPool: true,
      priceUsd: null,
      liquidityUsd: estimatedLiquidity,
      dex,
    };

    poolCache.set(mint, { info, timestamp: Date.now() });
    
    logger.info({ 
      mint: mint.slice(0, 8), 
      dex, 
      liquidityUsd: estimatedLiquidity?.toFixed(0),
      priceImpactPct: priceImpactPct.toFixed(2),
    }, "SNIPER: Pool detected via Jupiter");

    return info;
  } catch (err) {
    logger.debug({ err, mint: mint.slice(0, 8) }, "Pool detection failed");
    return {
      mint,
      hasPool: false,
      priceUsd: null,
      liquidityUsd: null,
      dex: null,
    };
  }
}

export async function waitForPool(
  mint: string, 
  timeoutMs: number = SNIPER_CONFIG.poolWaitTimeoutMs
): Promise<PoolInfo | null> {
  const startTime = Date.now();
  const checkIntervalMs = 1000;
  
  logger.info({ mint: mint.slice(0, 8), timeoutMs }, "SNIPER: Waiting for pool...");

  while (Date.now() - startTime < timeoutMs) {
    const poolInfo = await detectPool(mint);
    
    if (poolInfo.hasPool) {
      if (poolInfo.liquidityUsd !== null && poolInfo.liquidityUsd >= SNIPER_CONFIG.minLiquidityUsd) {
        logger.info({ 
          mint: mint.slice(0, 8), 
          liquidityUsd: poolInfo.liquidityUsd,
          dex: poolInfo.dex,
          waitedMs: Date.now() - startTime,
        }, "SNIPER: Pool with sufficient liquidity found");
        return poolInfo;
      } else if (poolInfo.liquidityUsd !== null) {
        logger.debug({ 
          mint: mint.slice(0, 8), 
          liquidityUsd: poolInfo.liquidityUsd,
          minRequired: SNIPER_CONFIG.minLiquidityUsd,
        }, "SNIPER: Pool found but insufficient liquidity");
      } else {
        logger.info({ 
          mint: mint.slice(0, 8), 
          dex: poolInfo.dex,
          waitedMs: Date.now() - startTime,
        }, "SNIPER: Pool found (liquidity unknown)");
        return poolInfo;
      }
    }

    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  logger.warn({ mint: mint.slice(0, 8), timeoutMs }, "SNIPER: Pool wait timeout");
  return null;
}

export async function getTokenPrice(mint: string): Promise<number | null> {
  try {
    const solPriceResponse = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const solPriceData = await solPriceResponse.json() as { solana?: { usd?: number } };
    const solPriceUsd = solPriceData.solana?.usd || 150;

    const testAmountLamports = "1000000000";
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set("inputMint", mint);
    url.searchParams.set("outputMint", MINT_SOL);
    url.searchParams.set("amount", testAmountLamports);
    url.searchParams.set("slippageBps", "500");

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      return null;
    }

    const quote = await response.json() as { outAmount?: string; inAmount?: string };
    
    if (!quote.outAmount || !quote.inAmount) {
      return null;
    }

    const outAmountSol = parseInt(quote.outAmount) / 1e9;
    const inAmountTokens = parseInt(quote.inAmount);
    
    const pricePerTokenSol = outAmountSol / (inAmountTokens / 1e9);
    const pricePerTokenUsd = pricePerTokenSol * solPriceUsd;

    return pricePerTokenUsd;
  } catch (err) {
    logger.debug({ err, mint: mint.slice(0, 8) }, "Failed to get token price");
    return null;
  }
}

export function clearPoolCache(mint?: string): void {
  if (mint) {
    poolCache.delete(mint);
  } else {
    poolCache.clear();
  }
}
