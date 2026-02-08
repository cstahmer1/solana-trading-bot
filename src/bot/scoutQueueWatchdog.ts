import { q } from "./db.js";
import { logger } from "../utils/logger.js";

export interface WatchdogConfig {
  staleMinutes: number;
  maxBuyAttempts: number;
  baseBackoffMinutes: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  staleMinutes: 5,
  maxBuyAttempts: 3,
  baseBackoffMinutes: 2,
};

export interface WatchdogResult {
  resetToPending: number;
  markedSkipped: number;
  resetMints: string[];
  skippedMints: string[];
}

export async function resetStaleBuyingScoutQueue(
  config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG
): Promise<WatchdogResult> {
  const { staleMinutes, maxBuyAttempts, baseBackoffMinutes } = config;
  
  const staleRows = await q<{
    mint: string;
    symbol: string | null;
    buy_attempts: number;
    in_progress_at: Date;
  }>(
    `SELECT mint, symbol, buy_attempts, in_progress_at 
     FROM scout_queue 
     WHERE status = 'IN_PROGRESS' 
       AND tx_sig IS NULL
       AND in_progress_at < NOW() - INTERVAL '1 minute' * $1`,
    [staleMinutes]
  );
  
  if (staleRows.length === 0) {
    return { resetToPending: 0, markedSkipped: 0, resetMints: [], skippedMints: [] };
  }
  
  const resetMints: string[] = [];
  const skippedMints: string[] = [];
  
  for (const row of staleRows) {
    const newAttempts = (row.buy_attempts ?? 0) + 1;
    const ageMinutes = row.in_progress_at 
      ? Math.round((Date.now() - new Date(row.in_progress_at).getTime()) / 60000)
      : staleMinutes;
    
    if (newAttempts >= maxBuyAttempts) {
      await q(
        `UPDATE scout_queue SET 
           status = 'SKIPPED',
           buy_attempts = $2,
           last_error = $3,
           in_progress_at = NULL,
           next_attempt_at = NULL,
           updated_at = NOW()
         WHERE mint = $1`,
        [
          row.mint,
          newAttempts,
          `STALE_CLAIM_MAX_RETRIES: exceeded ${maxBuyAttempts} attempts after ${ageMinutes}min stale locks`,
        ]
      );
      
      skippedMints.push(row.mint);
      
      logger.warn({
        mint: row.mint,
        symbol: row.symbol,
        attempts: newAttempts,
        maxAttempts: maxBuyAttempts,
        ageMinutes,
      }, "WATCHDOG: Marked SKIPPED - max retry attempts exceeded");
    } else {
      const backoffMinutes = baseBackoffMinutes * Math.pow(2, newAttempts - 1);
      const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);
      
      await q(
        `UPDATE scout_queue SET 
           status = 'PENDING',
           buy_attempts = $2,
           last_error = $3,
           in_progress_at = NULL,
           next_attempt_at = $4,
           updated_at = NOW()
         WHERE mint = $1`,
        [
          row.mint,
          newAttempts,
          `STALE_CLAIM_RESET: stale lock after ${ageMinutes}min, attempt ${newAttempts}/${maxBuyAttempts}`,
          nextAttemptAt.toISOString(),
        ]
      );
      
      resetMints.push(row.mint);
      
      logger.info({
        mint: row.mint,
        symbol: row.symbol,
        attempts: newAttempts,
        maxAttempts: maxBuyAttempts,
        ageMinutes,
        backoffMinutes,
        nextAttemptAt: nextAttemptAt.toISOString(),
      }, "WATCHDOG: Reset to PENDING with backoff");
    }
  }
  
  if (resetMints.length > 0 || skippedMints.length > 0) {
    logger.info({
      resetToPending: resetMints.length,
      markedSkipped: skippedMints.length,
      totalProcessed: staleRows.length,
      staleMinutes,
      maxBuyAttempts,
    }, "WATCHDOG: Stale claim cleanup complete");
  }
  
  return {
    resetToPending: resetMints.length,
    markedSkipped: skippedMints.length,
    resetMints,
    skippedMints,
  };
}
