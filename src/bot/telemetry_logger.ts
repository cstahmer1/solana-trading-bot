import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import { 
  getTokensNeedingTelemetry, 
  insertTokenTelemetry, 
  cleanupOldTelemetry,
  ExitedTokenRecord 
} from "./persist.js";
import { getTokenPairs } from "./dexscreener.js";

let telemetryInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let lastRunTime = 0;
let tokensLogged = 0;
let errorCount = 0;

export function getTelemetryLoggerStatus() {
  return {
    running: isRunning,
    lastRunTime: lastRunTime ? new Date(lastRunTime).toISOString() : null,
    tokensLogged,
    errorCount,
  };
}

async function fetchTokenMetrics(mint: string): Promise<{
  price?: number;
  liquidityUsd?: number;
  volume24h?: number;
  holders?: number;
} | null> {
  try {
    const pairs = await getTokenPairs(mint);
    if (!pairs || pairs.length === 0) {
      return null;
    }

    const bestPair = pairs.reduce((best, p) => {
      const bestLiq = best.liquidity?.usd || 0;
      const pLiq = p.liquidity?.usd || 0;
      return pLiq > bestLiq ? p : best;
    }, pairs[0]);

    return {
      price: bestPair.priceUsd ? parseFloat(bestPair.priceUsd) : undefined,
      liquidityUsd: bestPair.liquidity?.usd,
      volume24h: bestPair.volume?.h24,
    };
  } catch (err) {
    logger.debug({ mint, err: String(err) }, "TELEMETRY: Failed to fetch token metrics");
    return null;
  }
}

async function logTelemetryForToken(token: ExitedTokenRecord): Promise<boolean> {
  const metrics = await fetchTokenMetrics(token.mint);
  
  if (!metrics) {
    return false;
  }

  const features = {
    exitReason: token.last_exit_reason,
    exitPnlUsd: token.last_exit_pnl_usd,
    exitPnlPct: token.last_exit_pnl_pct,
    exitPrice: token.last_known_price,
    priceChangeSinceExit: token.last_known_price && metrics.price 
      ? ((metrics.price - Number(token.last_known_price)) / Number(token.last_known_price) * 100).toFixed(2) + '%'
      : null,
  };

  const success = await insertTokenTelemetry({
    mint: token.mint,
    price: metrics.price,
    liquidityUsd: metrics.liquidityUsd,
    volume24h: metrics.volume24h,
    holders: metrics.holders,
    signal: token.last_known_signal ? Number(token.last_known_signal) : undefined,
    features,
  });

  return success;
}

async function runTelemetryLoggingCycle(): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;
  lastRunTime = Date.now();
  
  try {
    const tokens = await getTokensNeedingTelemetry();
    
    if (tokens.length === 0) {
      isRunning = false;
      return;
    }

    logger.debug({ tokenCount: tokens.length }, "TELEMETRY_CYCLE: Starting");

    let successCount = 0;
    let failCount = 0;

    for (const token of tokens) {
      try {
        const success = await logTelemetryForToken(token);
        if (success) {
          successCount++;
          tokensLogged++;
        } else {
          failCount++;
        }
      } catch (err) {
        failCount++;
        errorCount++;
        logger.debug({ mint: token.mint, err: String(err) }, "TELEMETRY: Error logging token");
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (successCount > 0 || failCount > 0) {
      logger.info({ 
        successCount, 
        failCount, 
        totalTokens: tokens.length 
      }, "TELEMETRY_CYCLE: Complete");
    }

    const config = getConfig();
    const retentionDays = Math.ceil(config.telemetryRetentionHours / 24);
    const cleaned = await cleanupOldTelemetry(retentionDays);
    if (cleaned > 0) {
      logger.info({ cleaned, retentionDays }, "TELEMETRY_CLEANUP: Removed old records");
    }

  } catch (err) {
    errorCount++;
    logger.error({ err: String(err) }, "TELEMETRY_CYCLE: Fatal error");
  } finally {
    isRunning = false;
  }
}

export function startTelemetryLogger(): void {
  if (telemetryInterval) {
    logger.warn({}, "TELEMETRY: Logger already running");
    return;
  }

  const config = getConfig();
  const pollSeconds = config.telemetryCachePollSeconds;

  logger.info({ pollSeconds }, "TELEMETRY: Starting background logger");

  runTelemetryLoggingCycle();

  telemetryInterval = setInterval(() => {
    runTelemetryLoggingCycle();
  }, pollSeconds * 1000);
}

export function stopTelemetryLogger(): void {
  if (telemetryInterval) {
    clearInterval(telemetryInterval);
    telemetryInterval = null;
    logger.info({}, "TELEMETRY: Stopped background logger");
  }
}

export function isTelemetryLoggerRunning(): boolean {
  return telemetryInterval !== null;
}
