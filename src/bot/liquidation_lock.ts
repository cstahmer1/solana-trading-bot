import { q } from "./db.js";
import { logger } from "../utils/logger.js";

export const PROTECTIVE_EXIT_REASONS = [
  "scout_stop_loss_exit",
  "break_even_exit",
  "break_even_lock_exit",
  "stale_timeout_exit",
  "core_loss_exit",
] as const;

export type ProtectiveExitReason = (typeof PROTECTIVE_EXIT_REASONS)[number];

export interface ActiveLiquidation {
  mint: string;
  reason: string;
  since: Date;
  banUntil: Date;
}

const DEFAULT_BAN_HOURS = 24;

export function isProtectiveExit(reasonCode: string): boolean {
  return PROTECTIVE_EXIT_REASONS.includes(reasonCode as ProtectiveExitReason);
}

export async function setLiquidatingState(
  mint: string,
  reason: string,
  banHours: number = DEFAULT_BAN_HOURS
): Promise<void> {
  const now = new Date();
  const banUntil = new Date(now.getTime() + banHours * 60 * 60 * 1000);

  const result = await q(
    `UPDATE position_tracking 
     SET liquidating = true, 
         liquidating_reason = $2, 
         liquidating_since = $3, 
         reentry_ban_until = $4 
     WHERE mint = $1
     RETURNING mint`,
    [mint, reason, now.toISOString(), banUntil.toISOString()]
  );

  if (result.length === 0) {
    await q(
      `INSERT INTO position_tracking (
        mint, entry_time, entry_price, peak_price, peak_time, last_price, last_update, 
        total_tokens, slot_type, liquidating, liquidating_reason, liquidating_since, reentry_ban_until
      ) VALUES ($1, $2, 0, 0, $2, 0, $2, 0, 'scout', true, $3, $2, $4)
      ON CONFLICT (mint) DO UPDATE SET
        liquidating = true,
        liquidating_reason = $3,
        liquidating_since = $2,
        reentry_ban_until = $4`,
      [mint, now.toISOString(), reason, banUntil.toISOString()]
    );
    logger.warn(
      {
        mint,
        reason,
        liquidatingSince: now.toISOString(),
        reentryBanUntil: banUntil.toISOString(),
        banHours,
      },
      "LIQUIDATION_LOCK: Created position_tracking row with liquidating state (row was missing)"
    );
  } else {
    logger.info(
      {
        mint,
        reason,
        liquidatingSince: now.toISOString(),
        reentryBanUntil: banUntil.toISOString(),
        banHours,
      },
      "LIQUIDATION_LOCK: Set liquidating state"
    );
  }
}

export async function isLiquidatingMint(mint: string): Promise<boolean> {
  const rows = await q<{ liquidating: boolean; reentry_ban_until: Date | null }>(
    `SELECT liquidating, reentry_ban_until 
     FROM position_tracking 
     WHERE mint = $1`,
    [mint]
  );

  if (rows.length === 0) {
    return false;
  }

  const { liquidating, reentry_ban_until } = rows[0];
  if (!liquidating) {
    return false;
  }

  if (!reentry_ban_until) {
    return true;
  }

  const now = new Date();
  const banExpired = new Date(reentry_ban_until) <= now;

  if (banExpired) {
    logger.info(
      { mint, reentryBanUntil: reentry_ban_until },
      "LIQUIDATION_LOCK: Ban expired, position no longer locked"
    );
    return false;
  }

  return true;
}

export async function clearLiquidatingState(mint: string): Promise<void> {
  const rows = await q<{ liquidating: boolean; liquidating_reason: string | null }>(
    `SELECT liquidating, liquidating_reason FROM position_tracking WHERE mint = $1`,
    [mint]
  );

  const wasLiquidating = rows.length > 0 && rows[0].liquidating;
  const previousReason = rows.length > 0 ? rows[0].liquidating_reason : null;

  await q(
    `UPDATE position_tracking 
     SET liquidating = false, 
         liquidating_reason = NULL, 
         liquidating_since = NULL, 
         reentry_ban_until = NULL 
     WHERE mint = $1`,
    [mint]
  );

  if (wasLiquidating) {
    logger.info(
      { mint, previousReason },
      "LIQUIDATION_LOCK: Cleared liquidating state"
    );
  }
}

export async function getActiveLiquidations(): Promise<ActiveLiquidation[]> {
  const rows = await q<{
    mint: string;
    liquidating_reason: string;
    liquidating_since: Date;
    reentry_ban_until: Date;
  }>(
    `SELECT mint, liquidating_reason, liquidating_since, reentry_ban_until 
     FROM position_tracking 
     WHERE liquidating = true 
       AND reentry_ban_until > NOW()`,
    []
  );

  const activeLiquidations = rows.map((row) => ({
    mint: row.mint,
    reason: row.liquidating_reason,
    since: new Date(row.liquidating_since),
    banUntil: new Date(row.reentry_ban_until),
  }));

  logger.debug(
    { count: activeLiquidations.length },
    "LIQUIDATION_LOCK: Retrieved active liquidations"
  );

  return activeLiquidations;
}
