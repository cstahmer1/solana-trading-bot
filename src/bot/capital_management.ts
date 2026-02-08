import { logger } from "../utils/logger.js";
import { jupQuote, type QuoteResponse } from "./jupiter.js";
import { MINT_SOL } from "./config.js";
import { getConfig } from "./runtime_config.js";
import { q } from "./db.js";

export type PositionMode = "scout" | "core";

export interface CapitalConfig {
  maxTotalExposurePct: number;
  maxCoreExposurePct: number;
  maxScoutExposurePct: number;
  maxMintExposurePct: number;
  riskPerTradeScoutPct: number;
  riskPerTradeCorePct: number;
  entryMaxImpactPctScout: number;
  exitMaxImpactPctScout: number;
  entryMaxImpactPctCore: number;
  exitMaxImpactPctCore: number;
  roundtripMinRatioScout: number;
  roundtripMinRatioCore: number;
  sizeSweepMultipliers: number[];
  liquiditySafetyHaircut: number;
  maxParticipation5mVolPct: number;
  maxParticipation1hVolPct: number;
  minPoolTvlUsdScout: number;
  minPoolTvlUsdCore: number;
  min5mVolUsdScout: number;
  min5mVolUsdCore: number;
  scoutSizeMinUsd: number;
  scoutSizeMaxUsd: number;
  scoutSizeBaseUsd: number;
  scoutSizeBaseEquity: number;
  edgeBufferPct: number;
}

export const DEFAULT_CAPITAL_CONFIG: CapitalConfig = {
  maxTotalExposurePct: 0.55,
  maxCoreExposurePct: 0.40,
  maxScoutExposurePct: 0.20,
  maxMintExposurePct: 0.08,
  riskPerTradeScoutPct: 0.0035,
  riskPerTradeCorePct: 0.0060,
  entryMaxImpactPctScout: 0.008,
  exitMaxImpactPctScout: 0.010,
  entryMaxImpactPctCore: 0.005,
  exitMaxImpactPctCore: 0.007,
  roundtripMinRatioScout: 0.94,
  roundtripMinRatioCore: 0.96,
  sizeSweepMultipliers: [0.5, 1, 2, 4, 8],
  liquiditySafetyHaircut: 0.80,
  maxParticipation5mVolPct: 0.005,
  maxParticipation1hVolPct: 0.002,
  minPoolTvlUsdScout: 25000,
  minPoolTvlUsdCore: 150000,
  min5mVolUsdScout: 5000,
  min5mVolUsdCore: 25000,
  scoutSizeMinUsd: 15,
  scoutSizeMaxUsd: 60,
  scoutSizeBaseUsd: 20,
  scoutSizeBaseEquity: 400,
  edgeBufferPct: 0.01,
};

let capitalConfig: CapitalConfig = { ...DEFAULT_CAPITAL_CONFIG };

export function getCapitalConfig(): CapitalConfig {
  return capitalConfig;
}

export function updateCapitalConfig(updates: Partial<CapitalConfig>): void {
  capitalConfig = { ...capitalConfig, ...updates };
  logger.info({ updates }, "Capital config updated");
}

export function syncCapitalConfigFromRuntime(): void {
  const config = getConfig();
  
  capitalConfig = {
    maxTotalExposurePct: config.capMaxTotalExposurePct,
    maxCoreExposurePct: config.capMaxCoreExposurePct,
    maxScoutExposurePct: config.capMaxScoutExposurePct,
    maxMintExposurePct: config.capMaxMintExposurePct,
    riskPerTradeScoutPct: config.capRiskPerTradeScoutPct,
    riskPerTradeCorePct: config.capRiskPerTradeCorePct,
    entryMaxImpactPctScout: config.capEntryMaxImpactPctScout,
    exitMaxImpactPctScout: config.capExitMaxImpactPctScout,
    entryMaxImpactPctCore: config.capEntryMaxImpactPctCore,
    exitMaxImpactPctCore: config.capExitMaxImpactPctCore,
    roundtripMinRatioScout: config.capRoundtripMinRatioScout,
    roundtripMinRatioCore: config.capRoundtripMinRatioCore,
    sizeSweepMultipliers: config.capSizeSweepMultipliers ?? DEFAULT_CAPITAL_CONFIG.sizeSweepMultipliers,
    liquiditySafetyHaircut: config.capLiquiditySafetyHaircut,
    maxParticipation5mVolPct: config.capMaxParticipation5mVolPct,
    maxParticipation1hVolPct: config.capMaxParticipation1hVolPct,
    minPoolTvlUsdScout: config.capMinPoolTvlUsdScout,
    minPoolTvlUsdCore: config.capMinPoolTvlUsdCore,
    min5mVolUsdScout: config.capMin5mVolUsdScout,
    min5mVolUsdCore: config.capMin5mVolUsdCore,
    scoutSizeMinUsd: config.capScoutSizeMinUsd,
    scoutSizeMaxUsd: config.capScoutSizeMaxUsd,
    scoutSizeBaseUsd: config.capScoutSizeBaseUsd,
    scoutSizeBaseEquity: config.capScoutSizeBaseEquity,
    edgeBufferPct: config.capEdgeBufferPct,
  };
  
  logger.debug("Capital config synced from runtime config");
}

export function isCapitalManagementEnabled(): boolean {
  const config = getConfig();
  return config.capitalMgmtEnabled;
}

export interface SizeSweepResult {
  sizeUsd: number;
  sizeSol: number;
  buyQuote: QuoteResponse | null;
  sellQuote: QuoteResponse | null;
  buyImpactPct: number;
  sellImpactPct: number;
  roundtripRatio: number;
  passesConstraints: boolean;
  failureReason?: string;
}

export interface LiquidityCapResult {
  maxFeasibleSizeUsd: number;
  sweepResults: SizeSweepResult[];
  bestPassingSize: number;
  constraintsFailed: string[];
}

export interface SizeDecision {
  finalSizeUsd: number;
  finalSizeSol: number;
  riskCapUsd: number;
  liquidityCapUsd: number;
  edgeCapUsd: number;
  mintCapUsd: number;
  limitingFactor: "risk" | "liquidity" | "edge" | "mint_exposure" | "minimum";
  passedChecks: boolean;
  rejectReason?: string;
  sweepDetails?: LiquidityCapResult;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeRiskCap(
  equityUsd: number,
  stopPct: number,
  mode: PositionMode
): number {
  const cfg = getCapitalConfig();
  const riskPct = mode === "scout" 
    ? cfg.riskPerTradeScoutPct 
    : cfg.riskPerTradeCorePct;
  
  if (stopPct <= 0) return 0;
  
  const riskCapUsd = (equityUsd * riskPct) / stopPct;
  
  logger.debug({
    equityUsd,
    riskPct,
    stopPct,
    riskCapUsd,
    mode,
  }, "CAPITAL_RISK_CAP");
  
  return riskCapUsd;
}

export function computeScoutBaseSize(equityUsd: number): number {
  const cfg = getCapitalConfig();
  
  const sqrtScaling = cfg.scoutSizeBaseUsd * Math.sqrt(equityUsd / cfg.scoutSizeBaseEquity);
  const clampedSize = clamp(sqrtScaling, cfg.scoutSizeMinUsd, cfg.scoutSizeMaxUsd);
  
  logger.debug({
    equityUsd,
    baseUsd: cfg.scoutSizeBaseUsd,
    baseEquity: cfg.scoutSizeBaseEquity,
    sqrtScaling,
    clampedSize,
    minUsd: cfg.scoutSizeMinUsd,
    maxUsd: cfg.scoutSizeMaxUsd,
  }, "CAPITAL_SCOUT_BASE_SIZE");
  
  return clampedSize;
}

export async function performSizeSweep(
  mint: string,
  baseSizeUsd: number,
  solPriceUsd: number,
  mode: PositionMode,
  slippageBps: number = 100
): Promise<LiquidityCapResult> {
  const cfg = getCapitalConfig();
  const sweepResults: SizeSweepResult[] = [];
  const constraintsFailed: string[] = [];
  
  const entryMaxImpact = mode === "scout" 
    ? cfg.entryMaxImpactPctScout 
    : cfg.entryMaxImpactPctCore;
  const exitMaxImpact = mode === "scout" 
    ? cfg.exitMaxImpactPctScout 
    : cfg.exitMaxImpactPctCore;
  const minRoundtrip = mode === "scout" 
    ? cfg.roundtripMinRatioScout 
    : cfg.roundtripMinRatioCore;
  
  for (const multiplier of cfg.sizeSweepMultipliers) {
    const sizeUsd = baseSizeUsd * multiplier;
    const sizeSol = sizeUsd / Math.max(solPriceUsd, 1);
    const sizeLamports = Math.floor(sizeSol * 1e9);
    
    let buyQuote: QuoteResponse | null = null;
    let sellQuote: QuoteResponse | null = null;
    let buyImpactPct = 1;
    let sellImpactPct = 1;
    let roundtripRatio = 0;
    let passesConstraints = false;
    let failureReason: string | undefined;
    
    try {
      buyQuote = await jupQuote({
        inputMint: MINT_SOL,
        outputMint: mint,
        amount: String(sizeLamports),
        slippageBps,
      });
      
      buyImpactPct = parseFloat(buyQuote.priceImpactPct) || 0;
      
      const tokensReceived = BigInt(buyQuote.outAmount);
      const tokensToSell = (tokensReceived * 90n) / 100n;
      
      if (tokensToSell > 0n) {
        sellQuote = await jupQuote({
          inputMint: mint,
          outputMint: MINT_SOL,
          amount: String(tokensToSell),
          slippageBps,
        });
        
        sellImpactPct = parseFloat(sellQuote.priceImpactPct) || 0;
        
        const solOut = parseInt(sellQuote.outAmount) / 1e9;
        const adjustedSolIn = sizeSol * 0.9;
        roundtripRatio = adjustedSolIn > 0 ? solOut / adjustedSolIn : 0;
      }
      
      if (buyImpactPct > entryMaxImpact) {
        failureReason = `buy_impact_${(buyImpactPct * 100).toFixed(2)}%>${(entryMaxImpact * 100).toFixed(2)}%`;
      } else if (sellImpactPct > exitMaxImpact) {
        failureReason = `sell_impact_${(sellImpactPct * 100).toFixed(2)}%>${(exitMaxImpact * 100).toFixed(2)}%`;
      } else if (roundtripRatio < minRoundtrip) {
        failureReason = `roundtrip_${(roundtripRatio * 100).toFixed(1)}%<${(minRoundtrip * 100).toFixed(1)}%`;
      } else {
        passesConstraints = true;
      }
      
    } catch (err) {
      failureReason = `quote_error: ${String(err)}`;
      logger.debug({ mint: mint.slice(0, 8), sizeUsd, err: String(err) }, "Size sweep quote failed");
    }
    
    sweepResults.push({
      sizeUsd,
      sizeSol,
      buyQuote,
      sellQuote,
      buyImpactPct,
      sellImpactPct,
      roundtripRatio,
      passesConstraints,
      failureReason,
    });
  }
  
  const passingSizes = sweepResults.filter(r => r.passesConstraints);
  const maxFeasibleSizeUsd = passingSizes.length > 0 
    ? Math.max(...passingSizes.map(r => r.sizeUsd))
    : 0;
  
  const bestPassingSize = maxFeasibleSizeUsd * cfg.liquiditySafetyHaircut;
  
  const failedReasons = sweepResults
    .filter(r => !r.passesConstraints && r.failureReason)
    .map(r => r.failureReason!);
  const uniqueFailures = [...new Set(failedReasons)];
  
  logger.debug({
    mint: mint.slice(0, 8),
    mode,
    sweepCount: sweepResults.length,
    passingCount: passingSizes.length,
    maxFeasibleSizeUsd,
    bestPassingSize,
    haircut: cfg.liquiditySafetyHaircut,
  }, "CAPITAL_SIZE_SWEEP");
  
  return {
    maxFeasibleSizeUsd,
    sweepResults,
    bestPassingSize,
    constraintsFailed: uniqueFailures,
  };
}

export function computeEdgeCap(
  expectedMovePct: number,
  roundtripCostPct: number,
  baseSizeUsd: number
): number {
  const cfg = getCapitalConfig();
  
  const netEdge = expectedMovePct - roundtripCostPct - cfg.edgeBufferPct;
  
  if (netEdge <= 0) {
    logger.debug({
      expectedMovePct,
      roundtripCostPct,
      buffer: cfg.edgeBufferPct,
      netEdge,
      result: 0,
    }, "CAPITAL_EDGE_CAP_ZERO");
    return 0;
  }
  
  const edgeMultiplier = Math.min(netEdge / cfg.edgeBufferPct, 2.0);
  const edgeCapUsd = baseSizeUsd * edgeMultiplier;
  
  logger.debug({
    expectedMovePct,
    roundtripCostPct,
    buffer: cfg.edgeBufferPct,
    netEdge,
    edgeMultiplier,
    edgeCapUsd,
  }, "CAPITAL_EDGE_CAP");
  
  return edgeCapUsd;
}

export function computeMintExposureCap(
  equityUsd: number,
  currentMintExposureUsd: number
): number {
  const cfg = getCapitalConfig();
  const maxMintUsd = equityUsd * cfg.maxMintExposurePct;
  const remainingCap = Math.max(0, maxMintUsd - currentMintExposureUsd);
  
  logger.debug({
    equityUsd,
    maxMintPct: cfg.maxMintExposurePct,
    maxMintUsd,
    currentMintExposureUsd,
    remainingCap,
  }, "CAPITAL_MINT_EXPOSURE_CAP");
  
  return remainingCap;
}

export function checkLiquidityTierRequirements(
  mode: PositionMode,
  poolTvlUsd: number,
  volume5mUsd?: number
): { passes: boolean; reason?: string } {
  const cfg = getCapitalConfig();
  
  const minTvl = mode === "scout" ? cfg.minPoolTvlUsdScout : cfg.minPoolTvlUsdCore;
  const minVol = mode === "scout" ? cfg.min5mVolUsdScout : cfg.min5mVolUsdCore;
  
  if (poolTvlUsd < minTvl) {
    return {
      passes: false,
      reason: `pool_tvl_${poolTvlUsd.toFixed(0)}<${minTvl}`,
    };
  }
  
  if (volume5mUsd !== undefined && volume5mUsd < minVol) {
    return {
      passes: false,
      reason: `5m_vol_${volume5mUsd.toFixed(0)}<${minVol}`,
    };
  }
  
  return { passes: true };
}

export function checkParticipationCap(
  tradeSizeUsd: number,
  volume5mUsd?: number,
  volume1hUsd?: number
): { passes: boolean; reason?: string; cappedSizeUsd?: number } {
  const cfg = getCapitalConfig();
  
  let cappedSize = tradeSizeUsd;
  
  if (volume5mUsd !== undefined && volume5mUsd > 0) {
    const max5mParticipation = volume5mUsd * cfg.maxParticipation5mVolPct;
    if (tradeSizeUsd > max5mParticipation) {
      cappedSize = Math.min(cappedSize, max5mParticipation);
    }
  }
  
  if (volume1hUsd !== undefined && volume1hUsd > 0) {
    const max1hParticipation = volume1hUsd * cfg.maxParticipation1hVolPct;
    if (tradeSizeUsd > max1hParticipation) {
      cappedSize = Math.min(cappedSize, max1hParticipation);
    }
  }
  
  if (cappedSize < tradeSizeUsd) {
    return {
      passes: false,
      reason: `participation_capped_${tradeSizeUsd.toFixed(0)}->${cappedSize.toFixed(0)}`,
      cappedSizeUsd: cappedSize,
    };
  }
  
  return { passes: true, cappedSizeUsd: tradeSizeUsd };
}

export interface ChooseSizeParams {
  mint: string;
  equityUsd: number;
  solPriceUsd: number;
  mode: PositionMode;
  stopPct: number;
  expectedMovePct?: number;
  currentMintExposureUsd?: number;
  poolTvlUsd?: number;
  volume5mUsd?: number;
  volume1hUsd?: number;
  slippageBps?: number;
  skipSweep?: boolean;
}

export async function chooseSize(params: ChooseSizeParams): Promise<SizeDecision> {
  const {
    mint,
    equityUsd,
    solPriceUsd,
    mode,
    stopPct,
    expectedMovePct = 0.05,
    currentMintExposureUsd = 0,
    poolTvlUsd,
    volume5mUsd,
    volume1hUsd,
    slippageBps = 100,
    skipSweep = false,
  } = params;
  
  const cfg = getCapitalConfig();
  const config = getConfig();
  
  if (poolTvlUsd !== undefined) {
    const tierCheck = checkLiquidityTierRequirements(mode, poolTvlUsd, volume5mUsd);
    if (!tierCheck.passes) {
      return {
        finalSizeUsd: 0,
        finalSizeSol: 0,
        riskCapUsd: 0,
        liquidityCapUsd: 0,
        edgeCapUsd: 0,
        mintCapUsd: 0,
        limitingFactor: "liquidity",
        passedChecks: false,
        rejectReason: tierCheck.reason,
      };
    }
  }
  
  const riskCapUsd = computeRiskCap(equityUsd, stopPct, mode);
  
  let baseSizeUsd: number;
  if (mode === "scout") {
    baseSizeUsd = computeScoutBaseSize(equityUsd);
  } else {
    baseSizeUsd = config.minTradeUsd * 2;
  }
  
  let liquidityCapUsd = baseSizeUsd * 8;
  let sweepDetails: LiquidityCapResult | undefined;
  
  if (!skipSweep) {
    try {
      sweepDetails = await performSizeSweep(mint, baseSizeUsd, solPriceUsd, mode, slippageBps);
      liquidityCapUsd = sweepDetails.bestPassingSize;
      
      if (liquidityCapUsd <= 0 && sweepDetails.constraintsFailed.length > 0) {
        return {
          finalSizeUsd: 0,
          finalSizeSol: 0,
          riskCapUsd,
          liquidityCapUsd: 0,
          edgeCapUsd: 0,
          mintCapUsd: 0,
          limitingFactor: "liquidity",
          passedChecks: false,
          rejectReason: `sweep_failed: ${sweepDetails.constraintsFailed.join(", ")}`,
          sweepDetails,
        };
      }
    } catch (err) {
      logger.warn({ mint: mint.slice(0, 8), err: String(err) }, "Size sweep failed, using fallback");
      liquidityCapUsd = baseSizeUsd;
    }
  }
  
  const estimatedRoundtripCostPct = sweepDetails?.sweepResults[0]
    ? (1 - sweepDetails.sweepResults[0].roundtripRatio)
    : 0.06;
  
  const edgeCapUsd = computeEdgeCap(expectedMovePct, estimatedRoundtripCostPct, baseSizeUsd);
  
  const mintCapUsd = computeMintExposureCap(equityUsd, currentMintExposureUsd);
  
  let preliminarySize = Math.min(riskCapUsd, liquidityCapUsd, edgeCapUsd, mintCapUsd);
  
  const participationCheck = checkParticipationCap(preliminarySize, volume5mUsd, volume1hUsd);
  if (!participationCheck.passes && participationCheck.cappedSizeUsd !== undefined) {
    preliminarySize = participationCheck.cappedSizeUsd;
  }
  
  let limitingFactor: SizeDecision["limitingFactor"] = "risk";
  if (preliminarySize === liquidityCapUsd) {
    limitingFactor = "liquidity";
  } else if (preliminarySize === edgeCapUsd) {
    limitingFactor = "edge";
  } else if (preliminarySize === mintCapUsd) {
    limitingFactor = "mint_exposure";
  }
  
  const minTradeUsd = config.minTradeUsd;
  if (preliminarySize < minTradeUsd) {
    return {
      finalSizeUsd: 0,
      finalSizeSol: 0,
      riskCapUsd,
      liquidityCapUsd,
      edgeCapUsd,
      mintCapUsd,
      limitingFactor: "minimum",
      passedChecks: false,
      rejectReason: `size_${preliminarySize.toFixed(2)}<min_${minTradeUsd}`,
      sweepDetails,
    };
  }
  
  const finalSizeUsd = preliminarySize;
  const finalSizeSol = finalSizeUsd / Math.max(solPriceUsd, 1);
  
  logger.info({
    mint: mint.slice(0, 8),
    mode,
    equityUsd: equityUsd.toFixed(0),
    riskCapUsd: riskCapUsd.toFixed(2),
    liquidityCapUsd: liquidityCapUsd.toFixed(2),
    edgeCapUsd: edgeCapUsd.toFixed(2),
    mintCapUsd: mintCapUsd.toFixed(2),
    finalSizeUsd: finalSizeUsd.toFixed(2),
    finalSizeSol: finalSizeSol.toFixed(4),
    limitingFactor,
  }, "CAPITAL_SIZE_DECISION");
  
  return {
    finalSizeUsd,
    finalSizeSol,
    riskCapUsd,
    liquidityCapUsd,
    edgeCapUsd,
    mintCapUsd,
    limitingFactor,
    passedChecks: true,
    sweepDetails,
  };
}

export interface CapacityTelemetry {
  mint: string;
  quotedSlippagePct: number;
  realizedSlippagePct: number;
  sizeUsd: number;
  sizeBucket: "small" | "medium" | "large";
  mode: PositionMode;
  timestamp: Date;
}

const telemetryBuffer: CapacityTelemetry[] = [];
const MAX_TELEMETRY_BUFFER = 1000;

export async function recordCapacityTelemetry(telemetry: CapacityTelemetry): Promise<void> {
  telemetryBuffer.push(telemetry);
  
  if (telemetryBuffer.length > MAX_TELEMETRY_BUFFER) {
    telemetryBuffer.shift();
  }
  
  try {
    await q(`
      INSERT INTO capacity_telemetry (mint, quoted_slippage_pct, realized_slippage_pct, size_usd, size_bucket, mode, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      telemetry.mint,
      telemetry.quotedSlippagePct,
      telemetry.realizedSlippagePct,
      telemetry.sizeUsd,
      telemetry.sizeBucket,
      telemetry.mode,
      telemetry.timestamp,
    ]);
  } catch (err) {
    logger.debug({ err: String(err) }, "Failed to persist capacity telemetry");
  }
}

export interface SlippageStats {
  medianQuoted: number;
  medianRealized: number;
  slippageRatio: number;
  sampleCount: number;
}

export function computeSlippageStats(mode?: PositionMode): SlippageStats {
  const relevant = mode 
    ? telemetryBuffer.filter(t => t.mode === mode)
    : telemetryBuffer;
  
  if (relevant.length === 0) {
    return {
      medianQuoted: 0,
      medianRealized: 0,
      slippageRatio: 1,
      sampleCount: 0,
    };
  }
  
  const sortedQuoted = [...relevant].sort((a, b) => a.quotedSlippagePct - b.quotedSlippagePct);
  const sortedRealized = [...relevant].sort((a, b) => a.realizedSlippagePct - b.realizedSlippagePct);
  
  const midIdx = Math.floor(relevant.length / 2);
  const medianQuoted = sortedQuoted[midIdx].quotedSlippagePct;
  const medianRealized = sortedRealized[midIdx].realizedSlippagePct;
  
  const slippageRatio = medianQuoted > 0 ? medianRealized / medianQuoted : 1;
  
  return {
    medianQuoted,
    medianRealized,
    slippageRatio,
    sampleCount: relevant.length,
  };
}

export interface GovernorAdjustment {
  adjustHaircut: number;
  adjustMinTvl: number;
  reason: string;
}

export function computeGovernorAdjustments(): GovernorAdjustment {
  const stats = computeSlippageStats();
  const cfg = getCapitalConfig();
  
  const TARGET_SLIPPAGE_RATIO = 1.5;
  
  if (stats.sampleCount < 20) {
    return {
      adjustHaircut: 0,
      adjustMinTvl: 0,
      reason: "insufficient_samples",
    };
  }
  
  if (stats.slippageRatio > TARGET_SLIPPAGE_RATIO) {
    const severity = stats.slippageRatio / TARGET_SLIPPAGE_RATIO;
    const haircutAdjust = severity > 2 ? -0.10 : severity > 1.5 ? -0.05 : -0.02;
    const tvlAdjust = severity > 2 ? 50000 : severity > 1.5 ? 25000 : 10000;
    
    return {
      adjustHaircut: haircutAdjust,
      adjustMinTvl: tvlAdjust,
      reason: `slippage_exceeded_${(stats.slippageRatio * 100).toFixed(0)}%`,
    };
  }
  
  if (stats.slippageRatio < 0.8) {
    return {
      adjustHaircut: 0.02,
      adjustMinTvl: -5000,
      reason: "slippage_underutilized",
    };
  }
  
  return {
    adjustHaircut: 0,
    adjustMinTvl: 0,
    reason: "optimal",
  };
}

export async function applyGovernorAdjustments(): Promise<void> {
  const adjustments = computeGovernorAdjustments();
  
  if (adjustments.adjustHaircut === 0 && adjustments.adjustMinTvl === 0) {
    return;
  }
  
  const cfg = getCapitalConfig();
  
  const newHaircut = clamp(
    cfg.liquiditySafetyHaircut + adjustments.adjustHaircut,
    0.50,
    0.95
  );
  
  const newMinTvlCore = Math.max(
    50000,
    cfg.minPoolTvlUsdCore + adjustments.adjustMinTvl
  );
  
  const newMinTvlScout = Math.max(
    10000,
    cfg.minPoolTvlUsdScout + (adjustments.adjustMinTvl / 2)
  );
  
  updateCapitalConfig({
    liquiditySafetyHaircut: newHaircut,
    minPoolTvlUsdCore: newMinTvlCore,
    minPoolTvlUsdScout: newMinTvlScout,
  });
  
  logger.info({
    reason: adjustments.reason,
    newHaircut,
    newMinTvlCore,
    newMinTvlScout,
    haircutDelta: adjustments.adjustHaircut,
    tvlDelta: adjustments.adjustMinTvl,
  }, "CAPITAL_GOVERNOR_ADJUSTED");
}

export async function initCapacityTelemetryTable(): Promise<void> {
  try {
    await q(`
      CREATE TABLE IF NOT EXISTS capacity_telemetry (
        id SERIAL PRIMARY KEY,
        mint TEXT NOT NULL,
        quoted_slippage_pct REAL NOT NULL,
        realized_slippage_pct REAL NOT NULL,
        size_usd REAL NOT NULL,
        size_bucket TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    
    await q(`
      CREATE INDEX IF NOT EXISTS idx_capacity_telemetry_created 
      ON capacity_telemetry (created_at DESC)
    `);
    
    await q(`
      CREATE INDEX IF NOT EXISTS idx_capacity_telemetry_mode 
      ON capacity_telemetry (mode, created_at DESC)
    `);
    
    logger.info("Capacity telemetry table initialized");
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to init capacity telemetry table");
  }
}

export function getSizeBucket(sizeUsd: number): "small" | "medium" | "large" {
  if (sizeUsd < 30) return "small";
  if (sizeUsd < 100) return "medium";
  return "large";
}

export async function getRecentSlippageByBucket(): Promise<Record<string, SlippageStats>> {
  const result: Record<string, SlippageStats> = {};
  
  for (const bucket of ["small", "medium", "large"] as const) {
    const relevant = telemetryBuffer.filter(t => t.sizeBucket === bucket);
    if (relevant.length === 0) {
      result[bucket] = { medianQuoted: 0, medianRealized: 0, slippageRatio: 1, sampleCount: 0 };
      continue;
    }
    
    const sortedQuoted = [...relevant].sort((a, b) => a.quotedSlippagePct - b.quotedSlippagePct);
    const sortedRealized = [...relevant].sort((a, b) => a.realizedSlippagePct - b.realizedSlippagePct);
    const midIdx = Math.floor(relevant.length / 2);
    
    const medianQuoted = sortedQuoted[midIdx].quotedSlippagePct;
    const medianRealized = sortedRealized[midIdx].realizedSlippagePct;
    
    result[bucket] = {
      medianQuoted,
      medianRealized,
      slippageRatio: medianQuoted > 0 ? medianRealized / medianQuoted : 1,
      sampleCount: relevant.length,
    };
  }
  
  return result;
}

export function getCapitalManagementStatus(): {
  config: CapitalConfig;
  telemetrySampleCount: number;
  slippageStats: SlippageStats;
  governorAdjustments: GovernorAdjustment;
} {
  return {
    config: getCapitalConfig(),
    telemetrySampleCount: telemetryBuffer.length,
    slippageStats: computeSlippageStats(),
    governorAdjustments: computeGovernorAdjustments(),
  };
}
