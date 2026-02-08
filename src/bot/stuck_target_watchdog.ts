import { logger } from "../utils/logger.js";
import type { RuntimeConfig } from "./runtime_config.js";

export interface StuckState {
  consecutiveFailures: number;
  lastAttemptAt: number;
  backoffUntil: number;
  lastReason?: string;
}

export interface CheckStuckResult {
  blocked: boolean;
  reason?: string;
  backoffMinutesRemaining?: number;
}

export type ExecutionOutcome = "SKIPPED" | "FAILED" | "SUBMITTED" | "CONFIRMED";

const stuckTargetState: Map<string, StuckState> = new Map();

export function checkStuckTarget(
  mint: string,
  config: RuntimeConfig
): CheckStuckResult {
  if (!config.allocationStuckWatchdogEnabled) {
    return { blocked: false };
  }

  const state = stuckTargetState.get(mint);
  if (!state) {
    return { blocked: false };
  }

  const now = Date.now();
  if (state.backoffUntil > now) {
    const backoffMinutesRemaining = Math.ceil((state.backoffUntil - now) / 60000);
    return {
      blocked: true,
      reason: "STUCK_BACKOFF",
      backoffMinutesRemaining,
    };
  }

  return { blocked: false };
}

export function recordExecutionOutcome(
  mint: string,
  outcome: ExecutionOutcome,
  config: RuntimeConfig
): void {
  if (!config.allocationStuckWatchdogEnabled) {
    return;
  }

  const now = Date.now();
  let state = stuckTargetState.get(mint);

  if (outcome === "SUBMITTED" || outcome === "CONFIRMED") {
    if (state) {
      stuckTargetState.delete(mint);
      logger.debug({ mint, previousFailures: state.consecutiveFailures }, "STUCK_WATCHDOG: Reset after successful execution");
    }
    return;
  }

  if (outcome === "SKIPPED" || outcome === "FAILED") {
    if (!state) {
      state = {
        consecutiveFailures: 0,
        lastAttemptAt: now,
        backoffUntil: 0,
        lastReason: outcome,
      };
    }

    state.consecutiveFailures++;
    state.lastAttemptAt = now;
    state.lastReason = outcome;

    if (state.consecutiveFailures >= config.allocationStuckMaxAttempts) {
      const exponent = state.consecutiveFailures - config.allocationStuckMaxAttempts;
      const backoffMinutes = config.allocationStuckBackoffMinutesBase * Math.pow(2, exponent);
      state.backoffUntil = now + backoffMinutes * 60 * 1000;

      logStuckWarning(mint, state, backoffMinutes);
    }

    stuckTargetState.set(mint, state);
  }
}

export function logStuckWarning(mint: string, state: StuckState, backoffMinutes: number): void {
  logger.warn({
    mint,
    consecutiveFailures: state.consecutiveFailures,
    lastReason: state.lastReason,
    backoffMinutes,
    backoffUntil: new Date(state.backoffUntil).toISOString(),
  }, "ALLOCATION_STUCK_WARNING: Mint blocked from allocation attempts due to repeated failures");
}

export function getStuckTargetState(mint: string): StuckState | undefined {
  return stuckTargetState.get(mint);
}

export function getAllStuckTargets(): Map<string, StuckState> {
  return new Map(stuckTargetState);
}

export function clearStuckTargetState(mint?: string): void {
  if (mint) {
    stuckTargetState.delete(mint);
  } else {
    stuckTargetState.clear();
  }
}

export function getStuckTargetSummary(): {
  totalBlocked: number;
  blockedMints: Array<{ mint: string; failures: number; backoffMinutesRemaining: number }>;
} {
  const now = Date.now();
  const blocked: Array<{ mint: string; failures: number; backoffMinutesRemaining: number }> = [];

  for (const [mint, state] of stuckTargetState) {
    if (state.backoffUntil > now) {
      blocked.push({
        mint,
        failures: state.consecutiveFailures,
        backoffMinutesRemaining: Math.ceil((state.backoffUntil - now) / 60000),
      });
    }
  }

  return {
    totalBlocked: blocked.length,
    blockedMints: blocked,
  };
}
