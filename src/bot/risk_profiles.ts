import type { RiskProfileName } from "./config.js";
import { loadRiskProfilesFromDB, upsertRiskProfile, type RiskProfileDB } from "./persist.js";
import { logger } from "../utils/logger.js";

export type RiskProfile = {
  name: string;
  maxPositionPctPerAsset: number;
  maxDailyDrawdownPct: number;
  maxTurnoverPctPerDay: number;
  slippageBps: number;
  maxSingleSwapSol: number;
  minTradeUsd: number;
  cooldownSeconds: number;
  entryZ: number;
  takeProfitPct: number;
  stopLossPct: number;
  isDefault?: boolean;
};

const DEFAULT_RISK: Record<RiskProfileName, RiskProfile> = {
  low: {
    name: "low",
    maxPositionPctPerAsset: 0.10,
    maxDailyDrawdownPct: 0.01,
    maxTurnoverPctPerDay: 0.50,
    slippageBps: 30,
    maxSingleSwapSol: 0.50,
    minTradeUsd: 50,
    cooldownSeconds: 30 * 60,
    entryZ: 1.25,
    takeProfitPct: 0.03,
    stopLossPct: 0.02,
    isDefault: true,
  },
  medium: {
    name: "medium",
    maxPositionPctPerAsset: 0.25,
    maxDailyDrawdownPct: 0.03,
    maxTurnoverPctPerDay: 1.00,
    slippageBps: 80,
    maxSingleSwapSol: 1.50,
    minTradeUsd: 25,
    cooldownSeconds: 10 * 60,
    entryZ: 1.0,
    takeProfitPct: 0.05,
    stopLossPct: 0.03,
    isDefault: true,
  },
  high: {
    name: "high",
    maxPositionPctPerAsset: 0.40,
    maxDailyDrawdownPct: 0.07,
    maxTurnoverPctPerDay: 2.00,
    slippageBps: 150,
    maxSingleSwapSol: 3.00,
    minTradeUsd: 15,
    cooldownSeconds: 3 * 60,
    entryZ: 0.75,
    takeProfitPct: 0.08,
    stopLossPct: 0.05,
    isDefault: true,
  },
  degen: {
    name: "degen",
    maxPositionPctPerAsset: 0.60,
    maxDailyDrawdownPct: 0.15,
    maxTurnoverPctPerDay: 6.00,
    slippageBps: 300,
    maxSingleSwapSol: 10.0,
    minTradeUsd: 10,
    cooldownSeconds: 60,
    entryZ: 0.4,
    takeProfitPct: 0.15,
    stopLossPct: 0.10,
    isDefault: true,
  },
};

let RISK: Record<string, RiskProfile> = { ...DEFAULT_RISK };

function dbRowToProfile(row: RiskProfileDB): RiskProfile {
  return {
    name: row.name,
    maxPositionPctPerAsset: Number(row.max_pos_pct),
    maxDailyDrawdownPct: Number(row.max_drawdown),
    maxTurnoverPctPerDay: Number(row.max_turnover),
    slippageBps: Number(row.slippage_bps),
    maxSingleSwapSol: Number(row.max_single_swap_sol),
    minTradeUsd: Number(row.min_trade_usd),
    cooldownSeconds: Number(row.cooldown_seconds),
    entryZ: Number(row.entry_z),
    takeProfitPct: Number(row.take_profit_pct),
    stopLossPct: Number(row.stop_loss_pct),
    isDefault: row.is_default,
  };
}

export async function initRiskProfilesFromDefaults(): Promise<void> {
  try {
    const existingRows = await loadRiskProfilesFromDB();
    const existingNames = new Set(existingRows.map(r => r.name));
    
    for (const [name, profile] of Object.entries(DEFAULT_RISK)) {
      if (!existingNames.has(name)) {
        await upsertRiskProfile({
          name: profile.name,
          maxPositionPctPerAsset: profile.maxPositionPctPerAsset,
          maxDailyDrawdownPct: profile.maxDailyDrawdownPct,
          entryZ: profile.entryZ,
          takeProfitPct: profile.takeProfitPct,
          stopLossPct: profile.stopLossPct,
          maxTurnoverPctPerDay: profile.maxTurnoverPctPerDay,
          slippageBps: profile.slippageBps,
          maxSingleSwapSol: profile.maxSingleSwapSol,
          minTradeUsd: profile.minTradeUsd,
          cooldownSeconds: profile.cooldownSeconds,
          isDefault: profile.isDefault,
        });
        logger.info(`Seeded risk profile '${name}' from defaults`);
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "Failed to seed risk profiles from defaults");
  }
}

export async function loadRiskProfiles(): Promise<void> {
  try {
    const rows = await loadRiskProfilesFromDB();
    if (rows.length > 0) {
      RISK = {};
      for (const row of rows) {
        RISK[row.name] = dbRowToProfile(row);
      }
      logger.info(`Loaded ${rows.length} risk profiles from database`);
    } else {
      RISK = { ...DEFAULT_RISK };
      logger.info("Using default risk profiles (database empty)");
    }
  } catch (e) {
    logger.warn({ err: e }, "Failed to load risk profiles from database, using defaults");
    RISK = { ...DEFAULT_RISK };
  }
}

export async function reloadRiskProfiles(): Promise<void> {
  await loadRiskProfiles();
}

export function getRiskProfile(name: string): RiskProfile | undefined {
  return RISK[name];
}

export function getAllRiskProfiles(): RiskProfile[] {
  return Object.values(RISK);
}

export function getDefaultRiskProfiles(): Record<RiskProfileName, RiskProfile> {
  return DEFAULT_RISK;
}

export function getRiskProfileNames(): string[] {
  return Object.keys(RISK);
}

export { RISK };
