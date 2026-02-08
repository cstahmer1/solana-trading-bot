import { env, MINT_SOL, MINT_USDC } from "./config.js";
import { logger } from "../utils/logger.js";
import { loadKeypair } from "./solana.js";
import { getUniverse, buildUniverse, checkAndPruneToken, cleanupDustFromUniverse, type UniverseToken } from "./universe.js";
import { jupUsdPrices, jupQuote } from "./jupiter.js";
import { getAllTokenAccounts, getWalletBalances } from "./wallet.js";
import { buildSnapshot } from "./portfolio.js";
import { insertPrices, insertFeatures, insertTrade, loadRecentPrices, upsertEquity, insertTickTelemetry, recordWalletTransfer, getSlotCounts, updateHeartbeat, getAllPositionTracking, getPositionTracking, backfillPositionEntryTimes, updateDustSince, insertRotationLog, logDecision, updateTradeLotDecisionId, updateTradePnl, validateTradePnlConsistency, ensurePositionTrackingHealth, type PositionTrackingRow } from "./persist.js";
import { computeSignal } from "./strategy.js";
import { scoresToTargets, currentWeights, type ScalingMetadata } from "./decisions.js";
import { applyRampToTargets, computeEffectiveTargetPct, type AllocationRampSettings } from "./allocation_ramp.js";
import { initRiskProfilesFromDefaults, loadRiskProfiles } from "./risk_profiles.js";
import { newState } from "./state.js";
import { addTurnover, checkCircuit, newCircuit, updateCircuit, getRiskPauseState, updateRiskStateFromCircuit, type RiskPauseState } from "./risk.js";
import { executeSwap, solToLamports, uiToBaseUnits, getAuthoritativeDecimals } from "./execution.js";
import { runMarketScan, type ScannerToken } from "./scanner.js";
import { getConfig, initRuntimeConfig, onConfigChange, refreshConfigFromDb, forceExecutionMode, getConfigHash, getSettingsRowCount } from "./runtime_config.js";
import { getEnvContext, setWalletLabel, computeConfigHash } from "./env_context.js";
import { setLoggerContext } from "../utils/logger.js";
import { getBatchTokens, getTokenPairs } from "./dexscreener.js";
import { getCSTDate, todayKeyCST, getNextCSTMidnight as getNextCSTMidnightUtil, getNextCSTMidnightInfo as getNextCSTMidnightInfoUtil } from "../utils/timezone.js";
import { initializeDatabase } from "./init_db.js";
import { 
  initCapacityTelemetryTable, 
  checkLiquidityTierRequirements, 
  isCapitalManagementEnabled,
  syncCapitalConfigFromRuntime,
  type PositionMode,
} from "./capital_management.js";
import { 
  syncPositionTracking, 
  evaluatePortfolio, 
  executePromotion, 
  logRotationDecision, 
  getRotationSummary,
  type RotationContext,
  type RotationResult,
  type WalletHolding 
} from "./rotation.js";

function isProductionDeployment(): boolean {
  return process.env.REPLIT_DEPLOYMENT === "1" || process.env.IS_PRODUCTION === "true";
}

import { updateBotState, broadcastTelemetry, recordTickTime } from "../dashboard/server.js";
import { updateTelemetry, recordSignal, recordPrice, getLatestTelemetry, clearAllTelemetryHistory, type SignalData, type PositionData } from "./telemetry.js";
import { updatePortfolioRisk, newPortfolioRisk, getPortfolioRiskSummary, calculateConcentration, type PositionInfo } from "./portfolio_risk.js";
import { enqueueScoutCandidates, processScoutQueue } from "./scout_auto.js";
import { checkMarketConfirmation, checkExitSignal, isOnWhaleCooldown, setWhaleCooldown, clearAllWhaleCaches } from "./whaleSignal.js";
import { processSellWithFIFO, backfillMissingPositionLots, insertTradeLot, getTodayRealizedPnL, closeAllPositionLots, getOpenPositionLotMints } from "./pnl_engine.js";
import { logTradeExit, logPromotion, getJourneyId, clearJourneyId, logExitDecision, logScoutTpTrigger, logScoutTpPromote, logScoutTpExit, type SignalSnapshot, type ExitDecisionReason } from "./event_logger.js";
import { captureSettingsSnapshot, mapReasonToCode, buildTradeAnalytics } from "./trade_analytics.js";
import { TRADE_REASONS, type TradeReason } from "./trade_reasons.js";
import { enforceExitInvariant } from "./exit_invariant.js";
import { updateOrphanTracking, clearOrphanTracking, type OrphanScanResult } from "./orphan_tracker.js";
import { recordAllocationEvent, buildExecutionResultFromSwap, computeGlobalGates, getActiveGateNames, type AllocationEvent, type ExecutionResult, type GlobalGates } from "./allocation_events.js";
import { checkStuckTarget, recordExecutionOutcome, clearStuckTargetState, type ExecutionOutcome } from "./stuck_target_watchdog.js";
import { getMustPriceMints, computeMustPriceCoverage, MINT_SOL as MUST_PRICE_SOL, MINT_USDC as MUST_PRICE_USDC, MINT_USDT } from "./must_price_mints.js";
import { updateTargetState, evaluateRebalanceSellGate, clearTargetState, type RebalanceSellSkipReason } from "./rebalance_hysteresis.js";
import { isProtectiveExit, setLiquidatingState, isLiquidatingMint } from "./liquidation_lock.js";
import { initBarWriter, updateLastPrice as updateBarWriterPrice, addTrackedMint } from "./bar_writer.js";
import { checkExitLiquidityForEntry, checkPromotionExitLiquidity } from "./exit_liquidity.js";

const signer = loadKeypair();

function performStartupSafetyChecks(): void {
  const config = getConfig();
  const warnings: string[] = [];
  
  if (config.scoutStopLossPct < 0.05) {
    warnings.push(`SAFETY: scout_stop_loss_pct=${config.scoutStopLossPct} is very low (<5%). This may cause excessive stop-outs. Typical range: 0.10-0.25`);
  }
  
  if (config.lossExitPct < 0.05) {
    warnings.push(`SAFETY: loss_exit_pct=${config.lossExitPct} is very low (<5%). This may cause excessive stop-outs on core positions. Typical range: 0.10-0.30`);
  }
  
  if (config.scoutStopLossPct > 1.0) {
    warnings.push(`SAFETY: scout_stop_loss_pct=${config.scoutStopLossPct} appears to be in percentage units (>100%). Expected decimal format (e.g., 0.15 for 15%)`);
  }
  
  if (config.lossExitPct > 1.0) {
    warnings.push(`SAFETY: loss_exit_pct=${config.lossExitPct} appears to be in percentage units (>100%). Expected decimal format (e.g., 0.15 for 15%)`);
  }
  
  if (config.takeProfitPct > 10) {
    warnings.push(`SAFETY: take_profit_pct=${config.takeProfitPct} appears to be in percentage units (>1000%). Expected decimal format (e.g., 0.50 for 50%)`);
  }
  
  if (config.maxDailyDrawdownPct > 1.0) {
    warnings.push(`SAFETY: max_daily_drawdown_pct=${config.maxDailyDrawdownPct} appears to be in percentage units (>100%). Expected decimal format (e.g., 0.05 for 5%)`);
  }
  
  if (config.maxPositionPctPerAsset > 1.0) {
    warnings.push(`SAFETY: max_position_pct_per_asset=${config.maxPositionPctPerAsset} appears to be in percentage units (>100%). Expected decimal format (e.g., 0.25 for 25%)`);
  }
  
  if (config.trailingStopBasePct > 1.0) {
    warnings.push(`SAFETY: trailing_stop_base_pct=${config.trailingStopBasePct} appears to be in percentage units. Expected decimal format (e.g., 0.20 for 20%)`);
  }
  
  if (config.maxSlippageBps > 500) {
    warnings.push(`SAFETY: max_slippage_bps=${config.maxSlippageBps} is very high (>5%). This may result in unfavorable trade execution. Typical range: 50-200 bps`);
  }
  
  if (config.scoutBuySol > 0.5) {
    warnings.push(`SAFETY: scout_buy_sol=${config.scoutBuySol} is high for scout positions. Scouts are test positions - typical range: 0.02-0.1 SOL`);
  }
  
  if (config.minSolReserve < 0.05) {
    warnings.push(`SAFETY: min_sol_reserve=${config.minSolReserve} is very low. May cause insufficient balance errors. Recommended: 0.1+ SOL`);
  }
  
  for (const warning of warnings) {
    logger.warn({ check: 'startup_safety' }, warning);
  }
  
  if (warnings.length > 0) {
    logger.warn({ 
      totalWarnings: warnings.length,
      settings: {
        scoutStopLossPct: config.scoutStopLossPct,
        lossExitPct: config.lossExitPct,
        takeProfitPct: config.takeProfitPct,
        maxDailyDrawdownPct: config.maxDailyDrawdownPct,
        maxPositionPctPerAsset: config.maxPositionPctPerAsset,
        trailingStopBasePct: config.trailingStopBasePct,
        maxSlippageBps: config.maxSlippageBps,
        scoutBuySol: config.scoutBuySol,
        minSolReserve: config.minSolReserve,
      }
    }, `STARTUP_SAFETY: ${warnings.length} configuration warnings detected. Review settings.`);
  } else {
    logger.info({ check: 'startup_safety' }, "STARTUP_SAFETY: All settings validated OK");
  }
}

const BOT_INSTANCE_ID = `bot-${process.pid}-${Date.now().toString(36)}`;

function capBuyToReserve(desiredSolSpend: number, availableSol: number, minReserve: number, txFeeBuffer: number): number {
  const maxSpendable = Math.max(0, availableSol - minReserve - txFeeBuffer);
  return Math.min(desiredSolSpend, maxSpendable);
}

type RunningPortfolioState = {
  positions: Map<string, { mint: string; usdValue: number }>;
  totalEquityUsd: number;
  positionCount: number;
};

function projectPostTradeMetrics(
  runningState: RunningPortfolioState,
  buyMint: string,
  buyUsdAmount: number
): { projectedPositionCount: number; projectedTop3Pct: number; projectedVolatility: number } {
  const isNewPosition = !runningState.positions.has(buyMint) || 
    (runningState.positions.get(buyMint)?.usdValue ?? 0) < 1;

  const projectedPositionCount = isNewPosition 
    ? runningState.positionCount + 1 
    : runningState.positionCount;

  const projectedPositions: PositionInfo[] = [];
  for (const [mint, pos] of runningState.positions) {
    if (mint === buyMint) {
      projectedPositions.push({ mint, amount: 0, usdValue: pos.usdValue + buyUsdAmount });
    } else if (mint === MINT_SOL) {
      projectedPositions.push({ mint, amount: 0, usdValue: pos.usdValue - buyUsdAmount });
    } else {
      projectedPositions.push({ mint, amount: 0, usdValue: pos.usdValue });
    }
  }
  
  if (!runningState.positions.has(buyMint)) {
    projectedPositions.push({ mint: buyMint, amount: 0, usdValue: buyUsdAmount });
  }

  const projectedEquity = runningState.totalEquityUsd;
  const nonSolPositions = projectedPositions.filter(p => p.mint !== MINT_SOL && p.usdValue > 1);
  const concentration = calculateConcentration(nonSolPositions, projectedEquity);

  const avgWeight = nonSolPositions.length > 0 ? 1 / nonSolPositions.length : 1;
  const projectedVolatility = 0.5 * Math.sqrt(avgWeight) * Math.sqrt(concentration.hhi / 0.1);

  return {
    projectedPositionCount,
    projectedTop3Pct: concentration.top3ConcentrationPct,
    projectedVolatility,
  };
}

function updateRunningState(
  runningState: RunningPortfolioState,
  mint: string,
  usdDelta: number
): void {
  const current = runningState.positions.get(mint)?.usdValue ?? 0;
  const newValue = current + usdDelta;
  
  const wasSignificantPosition = current >= 1;
  const isNowSignificantPosition = newValue >= 1;
  
  if (newValue > 0.01) {
    runningState.positions.set(mint, { mint, usdValue: newValue });
  } else {
    runningState.positions.delete(mint);
  }

  if (mint !== MINT_SOL) {
    if (!wasSignificantPosition && isNowSignificantPosition) {
      runningState.positionCount++;
    } else if (wasSignificantPosition && !isNowSignificantPosition) {
      runningState.positionCount = Math.max(0, runningState.positionCount - 1);
    }
  }
}
let universe: UniverseToken[] = buildUniverse();
const state = newState();

const entryPrices: Map<string, { avgCostUsd: number; totalTokens: number }> = new Map();

async function loadEntryPricesFromDb(): Promise<void> {
  try {
    const positions = await getAllPositionTracking();
    const mints = positions.map(p => p.mint);
    
    const { getBatchPositionCostBasis } = await import("./pnl_engine.js");
    const fifoCostBasis = await getBatchPositionCostBasis(mints);
    
    for (const pos of positions) {
      const fifo = fifoCostBasis.get(pos.mint);
      if (fifo && fifo.avgCostUsd > 0 && fifo.totalQuantity > 0) {
        entryPrices.set(pos.mint, {
          avgCostUsd: fifo.avgCostUsd,
          totalTokens: fifo.totalQuantity,
        });
      } else {
        entryPrices.set(pos.mint, {
          avgCostUsd: pos.entry_price,
          totalTokens: pos.total_tokens,
        });
      }
    }
    logger.info({ count: positions.length }, "Loaded entry prices from database");
  } catch (e) {
    logger.warn({ error: e }, "Failed to load entry prices from database");
  }
}

// Re-entry tracking for tokens sold at take-profit
type ReentryCandidate = {
  mint: string;
  symbol: string;
  sellPrice: number;
  sellTimestamp: number;
  originalEntryPrice: number;
};
const reentryTracking: Map<string, ReentryCandidate> = new Map();

// Promotion grace period tracking - positions freshly promoted skip take-profit
// until a core buy executes to recalculate cost basis
const promotionGraceTracking: Map<string, { promotedAt: number; symbol: string }> = new Map();
const PROMOTION_GRACE_MS = 10 * 60 * 1000; // 10 minutes grace period

let loopTimer: ReturnType<typeof setTimeout> | null = null;
let scanIntervalTimer: ReturnType<typeof setInterval> | null = null;

let previousTotalEquityUsd: number | null = null;
let previousSolBalance: number | null = null;
let lastTradeTimestamp: number = 0;
let lastPriceCoverageFailedLog: number = 0;
let lastScoutQueuePoll: number = 0;

let latestScannerCandidates: ScannerToken[] = [];
let lastRotationResult: RotationResult | null = null;

// Scan state tracking for production diagnostics
let lastScanAt: number = 0;
let scanIntervalMs: number = 0;
let scannerEnabled: boolean = true;
let scanInProgress: boolean = false;

export function getScanStatus() {
  const config = getConfig();
  return {
    lastScanAt,
    msSinceLastScan: lastScanAt > 0 ? Date.now() - lastScanAt : null,
    scanIntervalMs,
    scannerEnabled,
    scanInProgress,
    // Queue poll status
    lastQueuePollAt: lastScoutQueuePoll,
    msSinceLastQueuePoll: lastScoutQueuePoll > 0 ? Date.now() - lastScoutQueuePoll : null,
    queuePollIntervalMs: config.scoutQueuePollSeconds * 1000,
  };
}

// Flag to signal that the bot should reset its circuit on the next tick
let pendingCircuitReset = false;

export function resetBotCircuit(): { success: boolean; message: string } {
  // Set flag to reset circuit on next tick when we have accurate equity
  pendingCircuitReset = true;
  
  // Clear ALL pause state so bot can resume fresh
  state.paused = false;
  state.pauseReason = undefined;
  state.lastTradeAt = {};
  state.circuit = null; // Will be recreated on next tick
  
  // COMPLETE CLEAN SLATE: Clear all entry prices - no prior data influences future PnL
  entryPrices.clear();
  
  // Clear re-entry tracking
  reentryTracking.clear();
  
  // Clear global trade timestamp
  lastTradeTimestamp = 0;
  
  // Clear all whale-related caches (cooldowns, flow cache, status cache)
  clearAllWhaleCaches();
  
  // Clear all telemetry history (signal history, price history)
  clearAllTelemetryHistory();
  
  // Clear stuck target watchdog state
  clearStuckTargetState();
  
  logger.info({}, "Bot circuit COMPLETE reset - all in-memory state cleared, will initialize fresh on next tick");
  
  return { 
    success: true, 
    message: "Complete reset - all cooldowns, tracking, and history cleared" 
  };
}

export function checkPendingCircuitReset(equityUsd: number): void {
  if (pendingCircuitReset) {
    const day = todayKey();
    state.circuit = newCircuit(day, equityUsd);
    state.paused = false;
    state.pauseReason = undefined;
    pendingCircuitReset = false;
    
    logger.info({ 
      day, 
      equityUsd,
      turnoverUsd: 0,
    }, "Bot circuit initialized with fresh equity after reset");
  }
}

function maskDatabaseUrl(url: string | undefined): string {
  if (!url) return "NOT_SET";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "INVALID_URL";
  }
}

function getCurrentExecutionMode(): "paper" | "live" {
  return getConfig().executionMode;
}

function todayKey(): string {
  return todayKeyCST();
}

export function getNextCSTMidnight(): Date {
  return getNextCSTMidnightUtil();
}

export function getNextCSTMidnightInfo(): { nextResetMs: number; secondsRemaining: number; dayStartedAt: number } {
  return getNextCSTMidnightInfoUtil();
}

async function getAccurateSolPrice(): Promise<number> {
  // Try Jupiter quote first - this matches the actual execution price
  try {
    const quote = await jupQuote({
      inputMint: MINT_SOL,
      outputMint: MINT_USDC,
      amount: "1000000000", // 1 SOL in lamports
      slippageBps: 50,
      swapMode: "ExactIn",
    });
    // outAmount is in USDC base units (6 decimals)
    const usdcOut = parseFloat(quote.outAmount) / 1e6;
    if (usdcOut > 0) {
      logger.info({ solPrice: usdcOut }, "Got SOL price from Jupiter quote");
      return usdcOut;
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "Failed to get SOL price from Jupiter quote");
  }

  // Fallback to DexScreener
  try {
    const solPairs = await getTokenPairs(MINT_SOL);
    if (solPairs && solPairs.length > 0) {
      const price = parseFloat(solPairs[0].priceUsd || "0");
      if (price > 0) {
        logger.info({ solPrice: price }, "Got SOL price from DexScreener (fallback)");
        return price;
      }
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "Failed to get SOL price from DexScreener");
  }
  
  // Fallback to CoinGecko
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (res.ok) {
      const json = await res.json() as { solana?: { usd?: number } };
      const price = json.solana?.usd;
      if (price && price > 0) {
        logger.info({ solPrice: price }, "Got SOL price from CoinGecko (fallback)");
        return price;
      }
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "Failed to get SOL price from CoinGecko");
  }
  
  logger.warn("Using fallback SOL price of $200");
  return 200;
}

async function tick() {
  await refreshConfigFromDb();
  
  await updateHeartbeat(BOT_INSTANCE_ID).catch(e => logger.warn({ error: e }, "Failed to update heartbeat"));
  
  const execMode = getCurrentExecutionMode();
  const config = getConfig();
  
  const now = new Date();
  const ts = new Date(Math.floor(now.getTime() / 60_000) * 60_000);

  const solUsd = await getAccurateSolPrice();

  const allBalances = await getAllTokenAccounts(signer.publicKey);
  
  // Global SOL floor check - skip all trading when SOL balance is too low for fees
  const MIN_SOL_FOR_ANY_TRADE = config.minSolReserve + config.txFeeBufferSol;
  const lowSolMode = allBalances.sol <= MIN_SOL_FOR_ANY_TRADE;
  
  if (lowSolMode) {
    logger.warn({
      solBalance: allBalances.sol,
      minRequired: MIN_SOL_FOR_ANY_TRADE,
      minSolReserve: config.minSolReserve,
      feeBuffer: config.txFeeBufferSol,
    }, "LOW SOL - Skipping all trades this tick. Please top up wallet.");
  }
  
  const universeMints = new Set(universe.map((u) => u.mint));
  const walletTokenMints = Object.keys(allBalances.tokens);

  // Build priceFetchMints set FIRST - before fetching prices
  // This set determines which tokens we will price this tick
  const priceFetchMints = new Set<string>();
  
  // 1. Always include all universe mints
  for (const u of universe) {
    priceFetchMints.add(u.mint);
  }
  const universeIncluded = priceFetchMints.size;
  
  // 2. Add scout queue mints (pending/in_progress)
  let queueIncluded = 0;
  try {
    const { getQueuedScoutMints } = await import("./persist.js");
    const queueMints = await getQueuedScoutMints();
    for (const m of queueMints) {
      if (!priceFetchMints.has(m)) {
        priceFetchMints.add(m);
        queueIncluded++;
      }
    }
  } catch { /* ignore */ }
  
  // 3. Add open lot mints (positions with unclosed lots)
  let openLotsIncluded = 0;
  try {
    const { getOpenLotMints } = await import("./persist.js");
    const openLotMints = await getOpenLotMints();
    for (const m of openLotMints) {
      if (!priceFetchMints.has(m)) {
        priceFetchMints.add(m);
        openLotsIncluded++;
      }
    }
  } catch { /* ignore */ }
  
  // 4. If still under floor (50), add top wallet tokens by raw balance as safety net
  const minFloor = 50;
  let topWalletIncluded = 0;
  if (priceFetchMints.size < minFloor) {
    // Sort wallet tokens by raw balance (largest first)
    const walletBalances = walletTokenMints.map(mint => ({
      mint,
      amount: allBalances.tokens[mint]?.amount ?? 0
    })).sort((a, b) => b.amount - a.amount);
    
    for (const { mint } of walletBalances) {
      if (priceFetchMints.size >= 100) break; // Cap safety net additions at 100
      if (!priceFetchMints.has(mint)) {
        priceFetchMints.add(mint);
        topWalletIncluded++;
      }
    }
  }
  
  // 5. Cap total to maxPriceFetchMints
  const maxPriceFetch = config.maxPriceFetchMints ?? 250;
  const cappedToMax = priceFetchMints.size > maxPriceFetch;
  const priceFetchList = [...priceFetchMints].slice(0, maxPriceFetch);

  // Fetch prices for universe mints via Jupiter
  const prices = await jupUsdPrices(universe.map((u) => u.mint));
  prices[MINT_SOL] = { usdPrice: solUsd, decimals: 9, blockId: null };

  // Fetch prices for non-universe mints in priceFetchList
  const nonUniverseToPrice = priceFetchList.filter(m => m !== MINT_SOL && !prices[m]);
  if (nonUniverseToPrice.length > 0) {
    try {
      const tokenDataMap = await getBatchTokens(nonUniverseToPrice);
      for (const [mint, pairs] of tokenDataMap) {
        if (pairs && pairs.length > 0) {
          const price = parseFloat(pairs[0].priceUsd || "0");
          const decimals = pairs[0].baseToken?.decimals ?? 9;
          prices[mint] = { usdPrice: price, decimals, blockId: null };
        }
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "Failed to get prices for non-universe tokens");
    }
  }

  // Calculate pricing stats AFTER fetching
  const pricedMintsCount = priceFetchList.filter(m => prices[m]?.usdPrice > 0).length;
  const missingPricesCount = priceFetchList.filter(m => !prices[m] || prices[m].usdPrice === 0).length;
  
  // Dust classification happens AFTER pricing - compute how many wallet tokens are dust
  const minPositionUsdUsed = config.minPositionUsd ?? 1;
  let skippedDustCountAfterPricing = 0;
  for (const mint of walletTokenMints) {
    const priceData = prices[mint];
    const amount = allBalances.tokens[mint]?.amount ?? 0;
    const usdValue = (priceData?.usdPrice ?? 0) * amount;
    if (usdValue < minPositionUsdUsed) {
      skippedDustCountAfterPricing++;
    }
  }
  
  logger.info({ 
    walletTokenAccounts: walletTokenMints.length, 
    priceFetchMintsCount: priceFetchList.length,
    included: { universeCount: universeIncluded, queueCount: queueIncluded, openLotsCount: openLotsIncluded, topWalletCount: topWalletIncluded },
    cappedToMax,
    pricedMintsCount,
    missingPricesCount,
    skippedDustCountAfterPricing,
  }, "PRICE_FETCH_SUMMARY");
  
  // Error if we couldn't price anything (debugging aid)
  if (pricedMintsCount === 0 && priceFetchList.length > 0) {
    logger.error({
      why: "No prices returned from Jupiter/DexScreener",
      priceFetchMintsCount: priceFetchList.length,
      included: { universeCount: universeIncluded, queueCount: queueIncluded, openLotsCount: openLotsIncluded, topWalletCount: topWalletIncluded },
    }, "PRICE_FETCH_EMPTY");
  }

  // CRITICAL: Sync position tracking EARLY in tick - before pause checks
  // This ensures position_tracking stays updated even when bot is paused
  const walletHoldingsForSync: WalletHolding[] = Object.entries(allBalances.tokens).map(([mint, data]) => {
    const priceData = prices[mint];
    const universeToken = universe.find(u => u.mint === mint);
    return {
      mint,
      amount: data.amount,
      priceUsd: priceData?.usdPrice ?? 0,
      symbol: universeToken?.symbol ?? mint.slice(0, 6),
    };
  });
  
  await syncPositionTracking(entryPrices, walletHoldingsForSync)
    .catch(err => logger.warn({ err }, "Failed to sync position tracking"));

  // CRITICAL: Insert prices for ALL priceFetchMints (not just universe)
  // This ensures queued scouts accumulate price bars for warmup
  const priceFetchSet = new Set(priceFetchList);
  const rows = Object.entries(prices)
    .filter(([mint]) => priceFetchSet.has(mint))
    .map(([mint, p]) => ({
      mint,
      ts,
      usd_price: p.usdPrice,
      block_id: p.blockId ?? null,
    }));
  const insertResult = await insertPrices(rows);
  
  // Update bar writer price cache for fill-forward
  for (const row of rows) {
    updateBarWriterPrice(row.mint, row.usd_price);
  }
  
  // Log price bar insertion counts for debugging warmup
  const attemptedUniverseCount = rows.filter(r => universeMints.has(r.mint)).length;
  const attemptedQueueCount = rows.length - attemptedUniverseCount;
  logger.info({
    rowsAttempted: insertResult.attempted,
    rowsInserted: insertResult.inserted,
    rowsFiltered: insertResult.filtered,
    dbError: insertResult.dbError,
    attemptedUniverseCount,
    attemptedQueueCount,
    totalPriceFetchMints: priceFetchList.length,
    queueMintsSample: priceFetchList.filter(m => !universeMints.has(m)).slice(0, 5),
    tsUsed: ts.toISOString(),
  }, "PRICE_BARS_INSERTED");

  const allVals: Array<{mint: string; amount: number; usdPrice: number; usdValue: number; symbol?: string}> = [];
  
  allVals.push({
    mint: MINT_SOL,
    amount: allBalances.sol,
    usdPrice: solUsd,
    usdValue: allBalances.sol * solUsd,
    symbol: "SOL",
  });

  for (const [mint, tokenData] of Object.entries(allBalances.tokens)) {
    const priceData = prices[mint];
    const usdPrice = priceData?.usdPrice ?? 0;
    const amount = tokenData.amount;
    const usdValue = amount * usdPrice;
    
    const universeToken = universe.find((u) => u.mint === mint);
    allVals.push({
      mint,
      amount,
      usdPrice,
      usdValue,
      symbol: universeToken?.symbol ?? mint.slice(0, 6),
    });
  }

  // PRICE COVERAGE GUARD: Compute coverage over "must-price" mints only
  // Must-price = SOL/USDC/USDT + open positions (from position_tracking) + allocation targets
  // This prevents coverage from being computed over 800+ wallet dust mints
  
  // Get open positions from position_tracking (authoritative list of bot-managed positions)
  const positionTrackingRows = await getAllPositionTracking();
  const openPositionMints = positionTrackingRows.map(t => t.mint);
  
  // Build must-price set (targets will be added later after allocation computation)
  // For now, use positions + base mints - targets will be checked post-allocation
  const mustPriceMints = getMustPriceMints({
    openPositionMints,
    allocationTargetMints: [], // Will refine coverage after targets computed
  });
  
  // Build set of mints with valid prices
  const pricedMints = new Set<string>();
  for (const v of allVals) {
    if (v.usdPrice > 0) {
      pricedMints.add(v.mint);
    }
  }
  
  // Wallet-wide counts (for visibility only, NOT for gating)
  const walletHeldMintCount = allVals.filter(v => v.amount > 0).length;
  
  // Compute must-price coverage
  const coverageResult = computeMustPriceCoverage({
    mustPriceMints,
    pricedMints,
    walletHeldMintCount,
  });
  
  // Thresholds
  const equityPriceCoverageMin = config.equityPriceCoverageMin ?? 0.75;
  const executionPriceCoverageMin = config.executionPriceCoverageMin ?? 0.60;
  
  // Split gating: incompletePrices for drawdown, executionBlocked for trading
  const incompletePrices = coverageResult.coverage < equityPriceCoverageMin;
  const executionBlocked = coverageResult.coverage < executionPriceCoverageMin;
  
  if (coverageResult.mustPriceCount > 0) {
    logger.info({
      mustPriceCount: coverageResult.mustPriceCount,
      pricedCount: coverageResult.pricedCount,
      coverage: (coverageResult.coverage * 100).toFixed(1) + '%',
      equityThreshold: (equityPriceCoverageMin * 100).toFixed(1) + '%',
      executionThreshold: (executionPriceCoverageMin * 100).toFixed(1) + '%',
      incompletePrices,
      executionBlocked,
      walletHeldMintCountTotal: walletHeldMintCount,
      missingMintsSample: coverageResult.missingMints.slice(0, 3).map(m => m.slice(0, 8)),
    }, "PRICE_COVERAGE_CHECK");
  }
  
  // NOTE: PRICE_COVERAGE_FAILED log moved to AFTER allocation targets computed
  // This ensures missing target mints are included in the diagnostic

  const snap = buildSnapshot(allVals, solUsd);
  await upsertEquity(snap);

  const currentSolBalance = allBalances.sol;
  const timeSinceLastTrade = Date.now() - lastTradeTimestamp;
  const noRecentTrades = timeSinceLastTrade > 120_000;
  
  if (previousTotalEquityUsd !== null && previousSolBalance !== null && noRecentTrades) {
    const equityChange = snap.totalUsd - previousTotalEquityUsd;
    const solBalanceChange = currentSolBalance - previousSolBalance;
    const solBalanceChangeUsd = solBalanceChange * solUsd;
    
    if (Math.abs(solBalanceChangeUsd) > config.transferThresholdUsd) {
      const isDeposit = solBalanceChange > 0;
      const transferType = isDeposit ? 'deposit' : 'withdrawal';
      const amountSol = Math.abs(solBalanceChange);
      const amountUsd = Math.abs(solBalanceChangeUsd);
      
      await recordWalletTransfer(
        transferType,
        amountSol,
        amountUsd,
        previousSolBalance,
        currentSolBalance,
        `Detected ${transferType}: SOL balance changed by ${solBalanceChange.toFixed(4)} without recent trades`
      );
      
      logger.info({ 
        transferType, 
        amountSol, 
        amountUsd, 
        previousBalance: previousSolBalance, 
        newBalance: currentSolBalance 
      }, `Wallet ${transferType} detected`);
    }
  }
  
  previousTotalEquityUsd = snap.totalUsd;
  previousSolBalance = currentSolBalance;

  const day = todayKey();
  
  // Check for pending circuit reset from portfolio reset (must be before normal circuit init)
  checkPendingCircuitReset(snap.totalUsd);
  
  if (!state.circuit || state.circuit.day !== day) state.circuit = newCircuit(day, snap.totalUsd);
  
  // Fetch today's realized P&L from FIFO pnl_events (gains offset losses)
  const todayRealizedPnL = await getTodayRealizedPnL();
  
  // PRICE COVERAGE GUARD: Skip drawdown/pause updates when price coverage is incomplete
  // This prevents SOL-only valuation blips from triggering false drawdown alerts
  // NOTE: Uses positions-only coverage (not target-inclusive) because drawdown measures
  // current portfolio value, which only depends on what we HOLD, not allocation targets.
  // Execution gating (below) uses target-inclusive coverage via executionBlockedFinal.
  if (incompletePrices) {
    logger.warn({
      coverage: (coverageResult.coverage * 100).toFixed(1) + '%',
      threshold: (equityPriceCoverageMin * 100).toFixed(1) + '%',
      mustPriceCount: coverageResult.mustPriceCount,
      pricedCount: coverageResult.pricedCount,
      snapTotalUsd: snap.totalUsd.toFixed(2),
    }, "INCOMPLETE_PRICES: Skipping circuit/drawdown updates - equity may be understated");
    // CRITICAL: Do NOT update state.paused from circuit when coverage incomplete
    // This prevents stale pause state from persisting due to incomplete price data
    // The circuit's pause flag should only be trusted when we have full coverage
  } else {
    updateCircuit(state.circuit, snap.totalUsd, todayRealizedPnL);
    checkCircuit(state.circuit, snap.totalUsd, todayRealizedPnL);
    // Only update bot paused state from circuit when coverage is complete
    state.paused = state.circuit.paused;
    state.pauseReason = state.circuit.pauseReason;
  }

  // Get position tracking for slotType info
  const positionTracking = await getAllPositionTracking();
  
  // Build positionTrackingMap for quick lookup
  const positionTrackingMap = new Map<string, PositionTrackingRow>();
  for (const t of positionTracking) {
    positionTrackingMap.set(t.mint, t);
  }
  
  // Build coreSlots set from position_tracking (authoritative source)
  const coreSlots = new Set<string>();
  for (const t of positionTracking) {
    if (t.slot_type === 'core') {
      coreSlots.add(t.mint);
    }
  }
  
  // Helper to determine slot type with fallback logic
  function getSlotType(mint: string): 'core' | 'scout' {
    // 1. Check position_tracking first (authoritative)
    const tracking = positionTrackingMap.get(mint);
    if (tracking?.slot_type) return tracking.slot_type;
    
    // 2. Check if mint is in core slots state
    if (coreSlots.has(mint)) return 'core';
    
    // 3. Default to scout
    return 'scout';
  }
  
  // Get open position_lot mints for union
  const openLotMints = await getOpenPositionLotMints();
  
  // Build slotTypeMap from UNION of all sources:
  // 1. All mints in positionTracking
  // 2. All mints in wallet holdings (positionsForDashboard uses allVals)
  // 3. All mints in open position_lots
  const slotTypeAllMints = new Set<string>();
  for (const t of positionTracking) {
    if (t.mint !== MINT_SOL) slotTypeAllMints.add(t.mint);
  }
  for (const v of allVals) {
    if (v.mint !== MINT_SOL && v.usdValue > 0.5) slotTypeAllMints.add(v.mint);
  }
  for (const m of openLotMints) {
    if (m !== MINT_SOL) slotTypeAllMints.add(m);
  }
  
  const slotTypeMap = new Map<string, 'core' | 'scout'>();
  for (const mint of slotTypeAllMints) {
    slotTypeMap.set(mint, getSlotType(mint));
  }

  const candidates: { mint: string; score: number; regime: string; slotType?: 'core' | 'scout' }[] = [];
  const tickCountsByMint = new Map<string, number>();
  const symbolsByMint = new Map<string, string>();
  for (const u of universe) {
    if (u.mint === MINT_SOL) continue;
    const hist = await loadRecentPrices(u.mint, 240);
    tickCountsByMint.set(u.mint, hist.length);
    symbolsByMint.set(u.mint, u.symbol);
    const bars = hist
      .slice()
      .reverse()
      .map((r) => ({ ts: new Date(r.ts).getTime(), price: Number(r.usd_price) }));
    const sig = computeSignal(bars);
    candidates.push({ mint: u.mint, score: sig.score, regime: sig.regime, slotType: slotTypeMap.get(u.mint) });
    await insertFeatures(u.mint, ts, sig);
  }

  const maxPos = config.maxPositionPctPerAsset;
  
  // ALLOCATION DILUTION FIX: Only include tokens we actually hold in target normalization
  // Ghost positions (in universe but 0 balance) were polluting allocation calculations
  const heldMints = new Set(
    allVals
      .filter(v => v.usdValue > config.dustThresholdUsd && v.mint !== MINT_SOL && v.mint !== MINT_USDC)
      .map(v => v.mint)
  );
  
  const heldCandidates = candidates.filter(c => heldMints.has(c.mint));
  
  if (heldCandidates.length !== candidates.length) {
    const ghostCount = candidates.length - heldCandidates.length;
    logger.debug({ 
      totalCandidates: candidates.length, 
      heldCandidates: heldCandidates.length,
      ghostsExcluded: ghostCount,
    }, "ALLOCATION_DILUTION_GUARD: Filtered ghost positions from target calculation");
  }
  
  const { targets: rawTargets, scalingMeta } = scoresToTargets({
    snapshot: snap,
    candidates: heldCandidates,
    maxPositionPctPerAsset: maxPos,
    corePositionPctTarget: config.corePositionPctTarget,
    deployTargetPct: config.deployTargetPct,
    capMaxTotalExposurePct: config.capMaxTotalExposurePct,
  });

  const rampSettings: AllocationRampSettings = {
    allocationRampEnabled: config.allocationRampEnabled,
    minTicksForFullAlloc: config.minTicksForFullAlloc,
    preFullAllocMaxPct: config.preFullAllocMaxPct,
    smoothRamp: config.smoothRamp,
    hardCapBeforeFull: config.hardCapBeforeFull,
    maxPositionPctPerAsset: maxPos,
  };

  const targets = applyRampToTargets({
    targets: rawTargets,
    tickCountsByMint,
    settings: rampSettings,
    symbolsByMint,
  });

  // ========== POST-ALLOCATION COVERAGE RECHECK ==========
  // Recompute must-price coverage including allocation target mints
  // This ensures we don't try to trade mints we can't price
  const allocationTargetMints = targets.map(t => t.mint);
  const mustPriceMintsWithTargets = getMustPriceMints({
    openPositionMints,
    allocationTargetMints,
  });
  
  const coverageResultWithTargets = computeMustPriceCoverage({
    mustPriceMints: mustPriceMintsWithTargets,
    pricedMints,
    walletHeldMintCount,
  });
  
  // Use refined coverage for execution gating (includes targets)
  const executionBlockedFinal = coverageResultWithTargets.coverage < executionPriceCoverageMin;
  const incompletePricesFinal = coverageResultWithTargets.coverage < equityPriceCoverageMin;
  
  if (coverageResultWithTargets.mustPriceCount > coverageResult.mustPriceCount) {
    logger.info({
      mustPriceCountInitial: coverageResult.mustPriceCount,
      mustPriceCountWithTargets: coverageResultWithTargets.mustPriceCount,
      pricedCount: coverageResultWithTargets.pricedCount,
      coverageWithTargets: (coverageResultWithTargets.coverage * 100).toFixed(1) + '%',
      executionBlockedFinal,
      missingTargetMints: coverageResultWithTargets.missingMints
        .filter(m => allocationTargetMints.includes(m))
        .slice(0, 5)
        .map(m => m.slice(0, 8)),
    }, "PRICE_COVERAGE_WITH_TARGETS");
  }
  
  // Rate-limited PRICE_COVERAGE_FAILED log with FINAL coverage (includes targets)
  // This supersedes the initial log if coverage degraded after adding targets
  if (incompletePricesFinal && Date.now() - lastPriceCoverageFailedLog > 60_000) {
    lastPriceCoverageFailedLog = Date.now();
    
    const missingMustPriceTopFinal = coverageResultWithTargets.missingMints.slice(0, 10).map(mint => {
      const valEntry = allVals.find(v => v.mint === mint);
      const isTarget = allocationTargetMints.includes(mint);
      const isPosition = openPositionMints.includes(mint);
      return {
        symbol: valEntry?.symbol ?? mint.slice(0, 6),
        mint,
        isTarget,
        isPosition,
        reason: "no_price" as const,
      };
    });
    
    logger.warn({
      event: "PRICE_COVERAGE_FAILED",
      mustPriceCount: coverageResultWithTargets.mustPriceCount,
      pricedCount: coverageResultWithTargets.pricedCount,
      coverage: coverageResultWithTargets.coverage,
      equityPriceCoverageMin,
      executionPriceCoverageMin,
      missingMustPriceTop: missingMustPriceTopFinal,
      walletHeldMintCountTotal: walletHeldMintCount,
      openPositionCount: openPositionMints.length,
      allocationTargetCount: allocationTargetMints.length,
    }, "PRICE_COVERAGE_FAILED: Must-price coverage below threshold (includes targets)");
  }

  const curW = currentWeights(snap);

  // ========== ALLOCATION GAP DIAGNOSTIC ==========
  // Log for each asset with target > current: target, current, gap, desired add, and binding constraint
  // executionOutcome: "NOT_ATTEMPTED" | "PENDING" | "SUBMITTED" | "CONFIRMED" | "SKIPPED" | "FAILED"
  // executionReason: e.g., "fee_ratio_guard", "impact_too_high", "no_quote", "paused", "route_error", "tx_timeout", null
  const allocationGapDiagnostics: Array<{
    mint: string;
    symbol: string;
    targetPct: number;
    rawTargetPct: number;
    currentPct: number;
    gapPct: number;
    desiredAddUsd: number;
    plannedAddUsd: number;
    actualAddUsd: number; // DEPRECATED: backward compat alias for plannedAddUsd - remove after one deploy cycle
    executedAddUsd: number;
    executionOutcome: string;
    executionReason: string | null;
    txSig: string | null;
    feeGovernor: { priorityLevel: string; maxLamports: number; reason: string } | null;
    bindingConstraint: string;
  }> = [];

  const totalTargetPct = targets.reduce((sum, t) => sum + t.targetPct, 0);
  const totalCurrentPct = Object.entries(curW)
    .filter(([mint]) => mint !== MINT_SOL && mint !== MINT_USDC)
    .reduce((sum, [, pct]) => sum + pct, 0);

  for (const t of targets) {
    const currentPct = curW[t.mint] ?? 0;
    const gapPct = t.targetPct - currentPct;
    
    if (gapPct > 0.001) { // Only log if there's a meaningful gap to close
      const desiredAddUsd = gapPct * snap.totalUsd;
      let bindingConstraint = 'NONE';
      
      // Calculate all constraint caps
      const maxSingleSwapUsd = config.maxSingleSwapSol * solUsd;
      const maxMintExposureUsd = config.capMaxMintExposurePct * snap.totalUsd;
      const currentExposureUsd = currentPct * snap.totalUsd;
      const remainingMintCapUsd = Math.max(0, maxMintExposureUsd - currentExposureUsd);
      const totalExposureCurrent = totalCurrentPct * snap.totalUsd;
      const remainingTotalCapUsd = Math.max(0, config.capMaxTotalExposurePct * snap.totalUsd - totalExposureCurrent);
      
      // Determine the tightest binding constraint by finding minimum allowed add
      // Order: Check all caps, pick the smallest, then label the binding constraint
      const capConstraints: Array<{cap: number, label: string}> = [
        { cap: remainingMintCapUsd, label: 'MAX_MINT_EXPOSURE' },
        { cap: remainingTotalCapUsd, label: 'MAX_TOTAL_EXPOSURE' },
        { cap: maxSingleSwapUsd, label: 'MAX_SINGLE_SWAP' },
      ];
      
      let plannedAddUsd = desiredAddUsd;
      
      // Find the tightest cap that binds
      for (const constraint of capConstraints) {
        if (desiredAddUsd > constraint.cap && constraint.cap < plannedAddUsd) {
          plannedAddUsd = constraint.cap;
          bindingConstraint = constraint.label;
        }
      }
      
      // Check MIN_TRADE_USD after applying caps
      if (plannedAddUsd > 0 && plannedAddUsd < config.minTradeUsd) {
        bindingConstraint = plannedAddUsd < desiredAddUsd ? bindingConstraint + '+MIN_TRADE_USD' : 'MIN_TRADE_USD';
        plannedAddUsd = 0;
      }
      
      // Check cooldown using actual configured cooldown (not hardcoded)
      const lastTrade = state.lastTradeAt[t.mint] ?? 0;
      const cooldownMs = (config.loopSeconds ?? 60) * 3 * 1000; // Use 3x loop interval as trade cooldown
      if (Date.now() - lastTrade < cooldownMs) {
        bindingConstraint = 'COOLDOWN';
        plannedAddUsd = 0;
      }
      
      // LIQUIDATION_LOCK: Block ALL buys/adds for mints in liquidation
      // Liquidation takes highest priority - protective exits must complete fully
      const symbolForMint = universe.find((u) => u.mint === t.mint)?.symbol ?? t.mint.slice(0, 6);
      const isLiquidating = await isLiquidatingMint(t.mint);
      if (isLiquidating && desiredAddUsd > 0) {
        logger.info({
          mint: t.mint,
          symbol: symbolForMint,
          desiredAddUsd,
          reason: 'liquidation_lock',
        }, "BUY_SKIPPED_LIQUIDATING: Blocked allocation buy for liquidating mint");
        
        bindingConstraint = 'LIQUIDATION_LOCK';
        plannedAddUsd = 0;
      }
      
      // SCOUT_NO_TOPUP: Prevent allocation drift top-ups for existing scout positions
      // Scouts are fixed-size probes - only the initial entry can buy, no averaging down
      const candidateForMint = candidates.find(c => c.mint === t.mint);
      const slotTypeForMint = candidateForMint?.slotType ?? slotTypeMap.get(t.mint);
      const isExistingPosition = currentPct > 0;
      
      if (isExistingPosition && slotTypeForMint === 'scout' && plannedAddUsd > 0) {
        const universeTokenForLog = universe.find((u) => u.mint === t.mint);
        logger.info({
          mint: t.mint,
          symbol: universeTokenForLog?.symbol ?? t.mint.slice(0, 6),
          desiredAddUsd,
          slotType: slotTypeForMint,
        }, "SCOUT_NO_TOPUP: Prevented allocation drift top-up for existing scout");
        
        bindingConstraint = 'SCOUT_NO_TOPUP';
        plannedAddUsd = 0;
      }
      
      // Set default execution values based on plannedAddUsd and binding constraint
      // SKIPPED = allocator explicitly blocked it (cooldown, min trade, caps)
      // NOT_ATTEMPTED = no meaningful gap or other reason not to try
      // PENDING = allocator approved, awaiting execution layer
      let executionOutcome: string;
      let executionReason: string | null = null;
      
      if (plannedAddUsd === 0 && desiredAddUsd > 0) {
        // Had a gap but allocator blocked it - this is a SKIPPED
        executionOutcome = "SKIPPED";
        executionReason = bindingConstraint;
      } else if (plannedAddUsd === 0) {
        executionOutcome = "NOT_ATTEMPTED";
      } else {
        executionOutcome = "PENDING";
      }
      
      const universeToken = universe.find((u) => u.mint === t.mint);
      allocationGapDiagnostics.push({
        mint: t.mint,
        symbol: universeToken?.symbol ?? t.mint.slice(0, 6),
        targetPct: t.targetPct,
        rawTargetPct: t.rawTargetPct,
        currentPct,
        gapPct,
        desiredAddUsd,
        plannedAddUsd,
        actualAddUsd: plannedAddUsd, // DEPRECATED: backward compat alias
        executedAddUsd: 0, // Will be filled by execution layer
        executionOutcome,
        executionReason,
        txSig: null,
        feeGovernor: null,
        bindingConstraint,
      });
    }
  }

  type NonTargetReason = 'SIGNAL_OFF' | 'DETARGETED' | 'PENDING_EXIT' | 'PROMO_STATE' | 'UNKNOWN';
  type NonTargetHolding = {
    symbol: string;
    mint: string;
    currentPct: number;
    estUsd: number;
    ageMinutes: number | null;
    lane: 'scout' | 'core' | 'unknown';
    reason: NonTargetReason;
  };

  const nonTargetHoldings: NonTargetHolding[] = [];
  const nowMs = Date.now();

  for (const v of allVals) {
    if (v.mint === MINT_SOL || v.mint === MINT_USDC) continue;
    
    const currentPct = curW[v.mint] ?? 0;
    if (currentPct <= 0) continue;
    
    const targetEntry = targets.find(t => t.mint === v.mint);
    const scaledTargetPct = targetEntry?.targetPct ?? 0;
    if (scaledTargetPct > 0) continue;
    
    const candidateEntry = candidates.find(c => c.mint === v.mint);
    const tracking = positionTrackingMap.get(v.mint);
    const inPromoGrace = promotionGraceTracking.has(v.mint);
    
    let reason: NonTargetReason = 'UNKNOWN';
    if (inPromoGrace) {
      reason = 'PROMO_STATE';
    } else if (!candidateEntry || candidateEntry.score <= 0) {
      reason = 'SIGNAL_OFF';
    } else if (candidateEntry && candidateEntry.score > 0 && scaledTargetPct === 0) {
      reason = 'DETARGETED';
    }
    
    let lane: 'scout' | 'core' | 'unknown' = 'unknown';
    if (tracking) {
      lane = tracking.slot_type;
    } else if (candidateEntry?.slotType) {
      lane = candidateEntry.slotType;
    }
    
    let ageMinutes: number | null = null;
    if (tracking?.entry_time) {
      const entryMs = new Date(tracking.entry_time).getTime();
      ageMinutes = Math.round((nowMs - entryMs) / 60000);
    }
    
    nonTargetHoldings.push({
      symbol: v.symbol ?? v.mint.slice(0, 6),
      mint: v.mint,
      currentPct,
      estUsd: currentPct * snap.totalUsd,
      ageMinutes,
      lane,
      reason,
    });
  }

  nonTargetHoldings.sort((a, b) => b.currentPct - a.currentPct);
  const topNonTargetHoldings = nonTargetHoldings.slice(0, 5);
  const nonTargetTotalPct = nonTargetHoldings.reduce((sum, h) => sum + h.currentPct, 0);

  // Compute global gates for diagnostic reporting - use !executionBlockedFinal for priceCoverageOk
  // executionBlockedFinal includes both positions AND allocation targets in coverage check
  const globalGates = computeGlobalGates(config.manualPause, state.paused, lowSolMode, !executionBlockedFinal);
  const activeGates = getActiveGateNames(globalGates);

  // If any global gate is active, update PENDING diagnostics to SKIPPED
  if (activeGates.length > 0) {
    for (const diag of allocationGapDiagnostics) {
      if (diag.executionOutcome === "PENDING") {
        diag.executionOutcome = "SKIPPED";
        diag.executionReason = `GLOBAL_GATE:${activeGates[0]}`;
      }
    }
  }

  if (allocationGapDiagnostics.length > 0 || topNonTargetHoldings.length > 0) {
    logger.info({
      totalScaledTargetPct: (totalTargetPct * 100).toFixed(2) + '%',
      totalRawTargetPct: (scalingMeta.sumRawTargetsPct * 100).toFixed(2) + '%',
      totalCurrentPct: (totalCurrentPct * 100).toFixed(2) + '%',
      totalGapPct: ((totalTargetPct - totalCurrentPct) * 100).toFixed(2) + '%',
      deployTargetPct: (config.deployTargetPct * 100).toFixed(1) + '%',
      sumRawTargetsPct: (scalingMeta.sumRawTargetsPct * 100).toFixed(2) + '%',
      sumScaledTargetsPct: (scalingMeta.sumScaledTargetsPct * 100).toFixed(2) + '%',
      scaleFactor: scalingMeta.scaleFactor.toFixed(4),
      clampedCount: scalingMeta.clampedCount,
      redistributionPassesUsed: scalingMeta.redistributionPassesUsed,
      targetCount: scalingMeta.targetCount,
      maxMintExposurePct: (config.capMaxMintExposurePct * 100).toFixed(1) + '%',
      maxTotalExposurePct: (config.capMaxTotalExposurePct * 100).toFixed(1) + '%',
      equityUsd: snap.totalUsd.toFixed(0),
      activeGates: activeGates,
      gaps: allocationGapDiagnostics.map(d => ({
        symbol: d.symbol,
        target: (d.targetPct * 100).toFixed(2) + '%',
        rawTarget: (d.rawTargetPct * 100).toFixed(2) + '%',
        current: (d.currentPct * 100).toFixed(2) + '%',
        gap: (d.gapPct * 100).toFixed(2) + '%',
        desiredAddUsd: d.desiredAddUsd.toFixed(2),
        plannedAddUsd: d.plannedAddUsd.toFixed(2),
        actualAddUsd: d.actualAddUsd.toFixed(2), // DEPRECATED: backward compat alias for plannedAddUsd
        executedAddUsd: d.executedAddUsd.toFixed(2),
        executionOutcome: d.executionOutcome,
        executionReason: d.executionReason,
        txSig: d.txSig,
        feeGovernor: d.feeGovernor,
        binding: d.bindingConstraint,
      })),
      ...(topNonTargetHoldings.length > 0 ? {
        nonTargetTotalPct: (nonTargetTotalPct * 100).toFixed(2) + '%',
        nonTargetHoldings: topNonTargetHoldings.map(h => ({
          symbol: h.symbol,
          mint: h.mint.slice(0, 8) + '...',
          currentPct: (h.currentPct * 100).toFixed(2) + '%',
          estUsd: h.estUsd.toFixed(2),
          ageMinutes: h.ageMinutes,
          lane: h.lane,
          reason: h.reason,
        })),
      } : {}),
    }, "ALLOCATION_GAP_DIAGNOSTIC");
  }
  // ========== END ALLOCATION GAP DIAGNOSTIC ==========

  // Record allocation events for all gaps with planned allocation
  for (const diag of allocationGapDiagnostics) {
    if (diag.plannedAddUsd > 0 || diag.executionOutcome === "SKIPPED") {
      await recordAllocationEvent({
        symbol: diag.symbol,
        mint: diag.mint,
        side: 'buy',
        rawTargetPct: diag.rawTargetPct,
        scaledTargetPct: diag.targetPct,
        currentPct: diag.currentPct,
        desiredUsd: diag.desiredAddUsd,
        plannedUsd: diag.plannedAddUsd,
        executedUsd: diag.executedAddUsd,
        outcome: diag.executionOutcome as any,
        reason: diag.executionReason ?? undefined,
        txSig: diag.txSig ?? undefined,
        feeMaxLamports: diag.feeGovernor?.maxLamports,
        bindingConstraint: diag.bindingConstraint,
      });
    }
  }

  const signalsForDashboard: SignalData[] = candidates.map((c) => {
    const u = universe.find((x) => x.mint === c.mint);
    const target = targets.find((t) => t.mint === c.mint);
    const cw = curW[c.mint] ?? 0;
    const priceUsd = prices[c.mint]?.usdPrice ?? 0;
    recordPrice(c.mint, priceUsd, c.score, c.regime);
    const signal: SignalData = {
      mint: c.mint,
      symbol: u?.symbol ?? c.mint.slice(0, 6),
      score: c.score,
      regime: c.regime as "trend" | "range",
      targetPct: target?.targetPct ?? 0,
      currentPct: cw,
      priceUsd,
      lastUpdate: Date.now(),
    };
    recordSignal(signal);
    return signal;
  });

  const positionsForDashboard: PositionData[] = allVals
    .filter((v) => v.usdValue > 0.50)
    .map((v) => {
      const entry = entryPrices.get(v.mint);
      const costBasis = entry?.avgCostUsd ?? v.usdPrice;
      const unrealizedPnlPct = costBasis > 0 ? ((v.usdPrice - costBasis) / costBasis) * 100 : 0;
      const unrealizedPnlUsd = entry ? (v.usdPrice - costBasis) * v.amount : 0;
      return {
        mint: v.mint,
        symbol: v.symbol ?? v.mint.slice(0, 6),
        amount: v.amount,
        valueUsd: v.usdValue,
        pctOfPortfolio: snap.totalUsd > 0 ? v.usdValue / snap.totalUsd : 0,
        priceUsd: v.usdPrice,
        costBasis: entry ? costBasis : undefined,
        unrealizedPnl: entry ? unrealizedPnlPct : undefined,
        unrealizedPnlUsd: entry ? unrealizedPnlUsd : undefined,
      };
    });

  const positionCount = positionsForDashboard.filter(p => p.mint !== MINT_SOL && p.valueUsd > 1).length;
  
  const walletTokenAccounts = Object.keys(allBalances.tokens).length;
  const minPositionUsd = config.minPositionUsd;
  const valueFilteredPositions = positionsForDashboard.filter(p => p.mint !== MINT_SOL && p.valueUsd >= minPositionUsd);
  
  logger.info({
    walletTokenAccounts,
    valueFilteredPositions: valueFilteredPositions.length,
    minPositionUsdUsed: minPositionUsd,
    positionCountUsed: positionCount,
  }, "POSITION_COUNTS");
  
  // Track dust_since for ALL positions (including tiny ones filtered from dashboard)
  // Use allVals to capture everything, not just positions > $0.50
  for (const pos of allVals) {
    if (pos.mint === MINT_SOL || pos.mint === MINT_USDC) continue;
    const isDust = pos.usdValue < 1;
    await updateDustSince(pos.mint, isDust);
  }
  
  // Cleanup dust tokens from universe (runs every tick, but only removes after 24h)
  await cleanupDustFromUniverse();
  
  let portfolioRiskState = newPortfolioRisk();
  const posInfo = positionsForDashboard.map(p => ({
    mint: p.mint,
    amount: p.amount,
    usdValue: p.valueUsd,
  }));
  const pricesForRisk: Record<string, number> = {};
  positionsForDashboard.forEach(p => { pricesForRisk[p.mint] = p.priceUsd; });
  portfolioRiskState = updatePortfolioRisk(portfolioRiskState, posInfo, pricesForRisk, undefined, minPositionUsd);
  const riskSummary = getPortfolioRiskSummary(portfolioRiskState);

  updateTelemetry({
    timestamp: Date.now(),
    mode: execMode,
    riskProfile: config.riskProfile,
    paused: state.paused,
    pauseReason: state.pauseReason,
    equity: {
      current: snap.totalUsd,
      start: state.circuit?.startEquityUsd ?? snap.totalUsd,
      pnlUsd: snap.totalUsd - (state.circuit?.startEquityUsd ?? snap.totalUsd),
      pnlPct: state.circuit?.startEquityUsd
        ? (snap.totalUsd - state.circuit.startEquityUsd) / state.circuit.startEquityUsd
        : 0,
    },
    circuit: {
      drawdownPct: Math.max(0, state.circuit ? 1 - snap.totalUsd / state.circuit.startEquityUsd : 0),
      drawdownLimit: config.maxDailyDrawdownPct,
      turnoverUsd: state.circuit?.turnoverUsd ?? 0,
      turnoverLimit: config.maxTurnoverPctPerDay * (state.circuit?.startEquityUsd ?? snap.totalUsd),
      startEquityUsd: state.circuit?.startEquityUsd ?? snap.totalUsd,
      paused: state.paused,
      pauseReason: state.pauseReason,
    },
    positions: positionsForDashboard,
    signals: signalsForDashboard,
  });

  const telemetry = getLatestTelemetry();
  if (telemetry) {
    broadcastTelemetry(telemetry);
  }

  const band = config.strategyBand;
  const cooldownMs = 180_000; // Internal trade throttle: 180 seconds

  const drawdownPct = state.circuit ? 
    1 - (snap.totalUsd / Math.max(1e-9, state.circuit.startEquityUsd)) : 0;

  const { getWhaleStatusCache } = await import("./whaleSignal.js");
  const whaleCache = getWhaleStatusCache();
  const whaleStatusEntries = Array.from(whaleCache.values());

  updateBotState({
    paused: state.paused,
    pauseReason: state.pauseReason,
    risk: config.riskProfile,
    mode: execMode,
    riskProfile: config.riskProfile,
    circuit: {
      drawdownPct: Math.max(0, drawdownPct),
      turnoverUsd: state.circuit?.turnoverUsd ?? 0,
      startEquityUsd: state.circuit?.startEquityUsd ?? snap.totalUsd,
    },
    equity: snap.totalUsd,
    sol: allBalances.sol,
    positionCount,
    top3ConcentrationPct: riskSummary.top3ConcentrationPct,
    portfolioVolatility: riskSummary.estimatedVolatility,
    whaleStatus: whaleStatusEntries,
    lowSolMode,
  });

  recordTickTime();

  logger.info({
    equityUsd: snap.totalUsd,
    sol: allBalances.sol,
    paused: state.paused,
    reason: state.pauseReason,
    risk: config.riskProfile,
    mode: execMode,
    positionCount,
    topTargets: targets.slice(0, 5),
  }, "tick");

  insertTickTelemetry({
    configSnapshot: config,
    riskProfile: config.riskProfile,
    solPriceUsd: solUsd,
    totalEquityUsd: snap.totalUsd,
    positionCount,
    portfolioSnapshot: snap.byMint,
    targets: targets.slice(0, 20),
    regimeDecisions: candidates.reduce((acc, c) => { acc[c.mint] = c.regime; return acc; }, {} as Record<string, string>),
    signals: signalsForDashboard.slice(0, 20),
  }).catch(e => logger.warn({ error: e }, "Failed to insert tick telemetry"));

  // ExitAction type for unified exit tracking
  type ExitAction = {
    mint: string;
    symbol: string;
    slotType: 'scout' | 'core';
    reasonCode: string;
    pnlPct: number;
    positionUsd: number;
    holdMinutes: number;
    stopPctUsed?: number;
    tpPctUsed?: number;
    promotable?: boolean;
  };

  // EXIT_EVAL_SUMMARY tracking variables
  const exitEvalSummary = {
    scoutsEvaluated: 0,
    coreEvaluated: 0,
    scoutStopTriggered: 0,
    scoutTpTriggered: 0,
    sellsAttempted: 0,
    sellsExecuted: 0,
    sellsFailed: 0,
    sellsSuppressed: { paused: 0, minTradeUsd: 0, quoteFail: 0, balanceZero: 0, maxPerTick: 0, other: 0 },
    stopTriggeredMints: [] as Array<{mint: string, pnlPct: number, positionUsd: number, stopPctUsed: number}>,
    tpCandidateMintsTop: [] as Array<{mint: string, pnlPct: number, positionUsd: number, holdMinutes: number, tpPctUsed: number}>,
    tpTriggeredMints: [] as Array<{mint: string, pnlPct: number, holdMinutes: number, tpPctUsed: number, promotable: boolean}>,
    exitActions: [] as ExitAction[],
  };
  
  // Count scouts vs cores in positions
  for (const pos of positionsForDashboard) {
    if (pos.mint === MINT_SOL) continue;
    if (pos.valueUsd < 1) continue;
    const slotType = slotTypeMap.get(pos.mint) ?? 'scout';
    if (slotType === 'scout') {
      exitEvalSummary.scoutsEvaluated++;
    } else {
      exitEvalSummary.coreEvaluated++;
    }
  }

  // PROTECTIVE EXITS: Execute stop-loss and loss-exit sells EVEN WHEN PAUSED
  // This ensures we cut losses rather than letting positions bleed while circuit breaker is active
  let protectiveExitsExecuted = 0;
  const MAX_PROTECTIVE_EXITS_PER_TICK = 5;
  
  // Hoist protectiveResult for EXIT_EVAL_SUMMARY access
  let protectiveResult: RotationResult | null = null;
  
  try {
    const signalsMapForProtective = new Map<string, { mint: string; score: number; regime: "trend" | "range" }>();
    for (const c of candidates) {
      signalsMapForProtective.set(c.mint, { mint: c.mint, score: c.score, regime: c.regime as "trend" | "range" });
    }

    const protectiveCtx: RotationContext = {
      positions: positionsForDashboard.map(p => ({
        mint: p.mint,
        symbol: p.symbol,
        amount: p.amount,
        usdValue: p.valueUsd,
        priceUsd: p.priceUsd,
      })),
      signals: signalsMapForProtective,
      candidates: [],
      entryPrices,
    };

    protectiveResult = await evaluatePortfolio(protectiveCtx);
    
    const allForcedExits = [
      ...protectiveResult.scoutStopLossTriggers.map(t => ({ ...t, reason: 'scout_stop_loss_exit' as const })),
      ...protectiveResult.coreLossExitTriggers.map(t => ({ ...t, reason: 'core_loss_exit' as const })),
    ].sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0));

    // Track scoutStopTriggered count from evaluatePortfolio result
    exitEvalSummary.scoutStopTriggered = protectiveResult.scoutStopLossTriggers.length;

    // Populate stopTriggeredMints for EXIT_EVAL_SUMMARY
    exitEvalSummary.stopTriggeredMints = allForcedExits.slice(0, 10).map(e => ({
      mint: e.mint,
      pnlPct: e.pnlPct ?? 0,
      positionUsd: positionsForDashboard.find(p => p.mint === e.mint)?.valueUsd ?? 0,
      stopPctUsed: e.reason === 'scout_stop_loss_exit' ? config.scoutStopLossPct : config.lossExitPct
    }));

    if (allForcedExits.length > 0) {
      logger.warn({
        count: allForcedExits.length,
        paused: state.paused || config.manualPause,
        positions: allForcedExits.map(e => ({ mint: e.mint, symbol: e.symbol, pnlPct: e.pnlPct, reason: e.reason })),
      }, "PROTECTIVE_EXIT: Forced exits detected - executing even if paused");
    }

    for (const exitTarget of allForcedExits) {
      const sellPos = positionsForDashboard.find(p => p.mint === exitTarget.mint);
      const posTracking = positionTrackingMap.get(exitTarget.mint);
      const holdMinutes = posTracking ? (Date.now() - new Date(posTracking.entry_time).getTime()) / (1000 * 60) : 0;
      const stopPctUsed = exitTarget.reason === 'scout_stop_loss_exit' ? config.scoutStopLossPct : config.lossExitPct;

      if (protectiveExitsExecuted >= MAX_PROTECTIVE_EXITS_PER_TICK) {
        exitEvalSummary.sellsSuppressed.maxPerTick++;
        logger.info({ 
          mint: exitTarget.mint, 
          symbol: exitTarget.symbol, 
          reason: 'maxPerTick', 
          pnlPct: exitTarget.pnlPct, 
          positionUsd: sellPos?.valueUsd ?? 0 
        }, "EXIT_SUPPRESSED");
        continue;
      }

      const isProtective = isProtectiveExit(exitTarget.reason);
      
      if (!sellPos || sellPos.valueUsd === 0) {
        exitEvalSummary.sellsSuppressed.balanceZero++;
        logger.info({ 
          mint: exitTarget.mint, 
          symbol: exitTarget.symbol, 
          reason: 'balanceZero', 
          pnlPct: exitTarget.pnlPct, 
          positionUsd: 0 
        }, "EXIT_SUPPRESSED");
        continue;
      }
      
      if (sellPos.valueUsd < config.minTradeUsd && !isProtective) {
        exitEvalSummary.sellsSuppressed.minTradeUsd++;
        logger.info({ 
          mint: exitTarget.mint, 
          symbol: exitTarget.symbol, 
          reason: 'minTradeUsd', 
          pnlPct: exitTarget.pnlPct, 
          positionUsd: sellPos.valueUsd,
          minTradeUsd: config.minTradeUsd
        }, "EXIT_SUPPRESSED");
        continue;
      }
      
      if (sellPos.valueUsd < config.minTradeUsd && isProtective) {
        logger.warn({ 
          mint: exitTarget.mint, 
          symbol: exitTarget.symbol, 
          reasonCode: exitTarget.reason,
          pnlPct: exitTarget.pnlPct, 
          positionUsd: sellPos.valueUsd,
          minTradeUsd: config.minTradeUsd
        }, "PROTECTIVE_EXIT_BYPASS_MIN_TRADE");
      }

      // Push to exitActions for tracking
      exitEvalSummary.exitActions.push({
        mint: exitTarget.mint,
        symbol: exitTarget.symbol ?? sellPos.mint.slice(0, 6),
        slotType: (exitTarget.slotType as 'core' | 'scout') ?? 'scout',
        reasonCode: exitTarget.reason,
        pnlPct: exitTarget.pnlPct ?? 0,
        positionUsd: sellPos.valueUsd,
        holdMinutes,
        stopPctUsed,
      });

      const trackingData = await getPositionTracking(sellPos.mint);
      const peakPnlPct = trackingData?.peak_pnl_pct ?? null;
      const peakPnlUsd = trackingData && trackingData.entry_price > 0 
        ? ((trackingData.peak_price - trackingData.entry_price) / trackingData.entry_price) * sellPos.valueUsd 
        : null;
      const entry = entryPrices.get(sellPos.mint);

      logger.warn({
        mint: exitTarget.mint,
        symbol: exitTarget.symbol,
        pnlPct: exitTarget.pnlPct,
        reason: exitTarget.reason,
        threshold: exitTarget.reason === 'scout_stop_loss_exit' ? config.scoutStopLossPct : config.lossExitPct,
        paused: state.paused,
      }, `PROTECTIVE_EXIT: Executing ${exitTarget.reason} via closePosition`);

      const { closePosition } = await import("./close_position.js");
      const reasonCode = exitTarget.reason as import("./close_position.js").ClosePositionReasonCode;

      // Set liquidating state BEFORE closePosition for protective exits
      if (isProtective) {
        await setLiquidatingState(sellPos.mint, exitTarget.reason);
      }

      // Increment sellsAttempted BEFORE calling closePosition
      exitEvalSummary.sellsAttempted++;

      const closeResult = await closePosition(
        sellPos.mint,
        reasonCode,
        {
          symbol: exitTarget.symbol ?? sellPos.mint.slice(0, 6),
          pnlPct: exitTarget.pnlPct,
          entryPriceUsd: entry?.avgCostUsd ?? trackingData?.entry_price,
          currentPriceUsd: sellPos.priceUsd,
          solPriceUsd: solUsd,
          slotType: exitTarget.slotType as 'core' | 'scout' ?? 'scout',
          bypassedPause: state.paused || config.manualPause,
          peakPnlPct,
          peakPnlUsd,
        },
        signer,
        execMode
      );

      if (!closeResult.success) {
        // Increment sellsFailed AFTER closePosition fails
        exitEvalSummary.sellsFailed++;
        logExitDecision({
          mint: sellPos.mint,
          symbol: exitTarget.symbol ?? sellPos.mint.slice(0, 6),
          reason: exitTarget.reason === 'scout_stop_loss_exit' ? 'scout_stop_loss' : 'core_loss_exit',
          entry_price: trackingData?.entry_price ?? 0,
          current_price: sellPos.priceUsd,
          pnl_pct: exitTarget.pnlPct ?? 0,
          peak_price: null,
          peak_pnl_pct: null,
          threshold: exitTarget.reason === 'scout_stop_loss_exit' ? config.scoutStopLossPct : config.lossExitPct,
          condition_met: true,
          executed: false,
          suppression_reason: closeResult.error ?? 'execution_error',
          slot_type: exitTarget.slotType ?? 'scout',
        });
        continue;
      }

      // Increment sellsExecuted AFTER closePosition succeeds
      exitEvalSummary.sellsExecuted++;

      logExitDecision({
        mint: sellPos.mint,
        symbol: exitTarget.symbol ?? sellPos.mint.slice(0, 6),
        reason: exitTarget.reason === 'scout_stop_loss_exit' ? 'scout_stop_loss' : 'core_loss_exit',
        entry_price: trackingData?.entry_price ?? 0,
        current_price: sellPos.priceUsd,
        pnl_pct: exitTarget.pnlPct ?? 0,
        peak_price: null,
        peak_pnl_pct: null,
        threshold: exitTarget.reason === 'scout_stop_loss_exit' ? config.scoutStopLossPct : config.lossExitPct,
        condition_met: true,
        executed: true,
        suppression_reason: null,
        slot_type: exitTarget.slotType ?? 'scout',
      });

      protectiveExitsExecuted++;
      state.lastTradeAt[sellPos.mint] = Date.now();
      if (execMode === "live" && state.circuit) {
        addTurnover(state.circuit, sellPos.valueUsd);
      }
      
      const soldIdx = positionsForDashboard.findIndex(p => p.mint === exitTarget.mint);
      if (soldIdx >= 0) {
        positionsForDashboard.splice(soldIdx, 1);
      }

      entryPrices.delete(sellPos.mint);
      lastTradeTimestamp = Date.now();

      logger.info({
        mint: exitTarget.mint,
        symbol: exitTarget.symbol,
        pnlPct: exitTarget.pnlPct,
        realizedPnl: closeResult.realizedPnlUsd,
        proceedsUsd: closeResult.proceedsUsd,
        fullyClosed: closeResult.fullyClosed,
        remainingAmount: closeResult.remainingAmount,
        reason: exitTarget.reason,
        txSig: closeResult.txSig,
      }, "PROTECTIVE_EXIT: Successfully executed via closePosition");

      // Log SELL_BYPASS_PAUSE when executing during pause
      if (state.paused || config.manualPause) {
        logger.info({ 
          reasonCode: exitTarget.reason, 
          mint: exitTarget.mint, 
          symbol: exitTarget.symbol, 
          paused: true 
        }, "SELL_BYPASS_PAUSE");
      }
    }
  } catch (protectiveErr) {
    logger.error({ error: String(protectiveErr) }, "PROTECTIVE_EXIT: Error during protective exit evaluation");
  }

  // ========== ORPHAN POSITION LIQUIDATION (UNIVERSE_EXIT) ==========
  // Detect and liquidate positions that are held but no longer in the target universe
  // This prevents "orphan" positions from sitting unmanaged and going to zero
  let orphanExitsExecuted = 0;
  const MAX_ORPHAN_EXITS_PER_TICK = 3;
  
  try {
    // Build target mints set from current targets (tokens we actively want to hold)
    const targetMints = new Set<string>();
    for (const t of targets) {
      if (t.targetPct > 0) {
        targetMints.add(t.mint);
      }
    }
    // Also include universe mints and tracked positions
    for (const u of universe) {
      targetMints.add(u.mint);
    }
    // Include tracked positions that have active signals
    const candidateMints = new Set(candidates.map(c => c.mint));
    for (const [mint] of positionTrackingMap) {
      if (candidateMints.has(mint)) {
        targetMints.add(mint);
      }
    }
    
    // Build wallet holdings for orphan scan
    const walletHoldingsForOrphan = positionsForDashboard
      .filter(p => p.mint !== MINT_SOL && p.mint !== MINT_USDC)
      .map(p => ({
        mint: p.mint,
        symbol: p.symbol,
        usdValue: p.valueUsd,
      }));
    
    // Update orphan tracking and get orphans ready for exit
    const orphanScanResult = updateOrphanTracking(
      walletHoldingsForOrphan,
      targetMints,
      config.minTradeUsd
    );
    
    // Log telemetry counters
    if (orphanScanResult.unmanagedHeldCount > 0 || orphanScanResult.readyForExit.length > 0) {
      logger.info({
        unmanagedHeldCount: orphanScanResult.unmanagedHeldCount,
        unmanagedHeldUsd: orphanScanResult.unmanagedHeldUsd.toFixed(2),
        orphansReadyForExit: orphanScanResult.readyForExit.length,
        orphansPending: orphanScanResult.orphans.length - orphanScanResult.readyForExit.length,
        graceTicks: config.orphanExitGraceTicks,
      }, "ORPHAN_TELEMETRY: Unmanaged position scan results");
    }
    
    // Process orphans ready for exit
    for (const orphan of orphanScanResult.readyForExit) {
      if (orphanExitsExecuted >= MAX_ORPHAN_EXITS_PER_TICK) {
        logger.info({
          mint: orphan.mint,
          symbol: orphan.symbol,
          usdValue: orphan.usdValue,
          ticksMissing: orphan.ticksMissing,
          reason: 'maxPerTick',
        }, "ORPHAN_EXIT_SUPPRESSED: Max orphan exits per tick reached");
        continue;
      }
      
      const sellPos = positionsForDashboard.find(p => p.mint === orphan.mint);
      if (!sellPos || sellPos.valueUsd < config.minTradeUsd) {
        logger.info({
          mint: orphan.mint,
          symbol: orphan.symbol,
          usdValue: orphan.usdValue,
          reason: sellPos ? 'minTradeUsd' : 'notFound',
        }, "ORPHAN_EXIT_SUPPRESSED: Position too small or not found");
        continue;
      }
      
      const trackingData = positionTrackingMap.get(orphan.mint);
      const entry = entryPrices.get(orphan.mint);
      const entryPrice = entry?.avgCostUsd ?? trackingData?.entry_price ?? sellPos.priceUsd;
      const pnlPct = entryPrice > 0 ? (sellPos.priceUsd - entryPrice) / entryPrice : 0;
      const holdMinutes = trackingData 
        ? (Date.now() - new Date(trackingData.entry_time).getTime()) / (1000 * 60) 
        : 0;
      
      logger.warn({
        mint: orphan.mint,
        symbol: orphan.symbol,
        usdValue: orphan.usdValue,
        ticksMissing: orphan.ticksMissing,
        timeSinceFirstMissing: orphan.firstMissingAt.toISOString(),
        pnlPct: (pnlPct * 100).toFixed(2) + '%',
        holdMinutes: holdMinutes.toFixed(0),
      }, "UNIVERSE_EXIT: Executing exit for orphan position (not in target universe)");
      
      // Log decision before execution
      const decisionId = await logDecision({
        mint: orphan.mint,
        symbol: orphan.symbol,
        actionType: 'exit',
        reasonCode: 'universe_exit',
        reasonDetail: JSON.stringify({
          usdValue: orphan.usdValue,
          ticksMissing: orphan.ticksMissing,
          timeSinceFirstMissing: orphan.firstMissingAt.toISOString(),
          pnlPct: pnlPct,
        }),
        triggeredBy: 'orphan_tracker',
        qtyBefore: sellPos.amount,
        usdValueBefore: sellPos.valueUsd,
      });
      
      const { closePosition } = await import("./close_position.js");
      
      const closeResult = await closePosition(
        orphan.mint,
        'universe_exit',
        {
          symbol: orphan.symbol,
          pnlPct: pnlPct,
          entryPriceUsd: entryPrice,
          currentPriceUsd: sellPos.priceUsd,
          solPriceUsd: solUsd,
          slotType: (trackingData?.slot_type as 'core' | 'scout') ?? 'scout',
        },
        signer,
        execMode
      );
      
      if (closeResult.success) {
        orphanExitsExecuted++;
        
        // Update decision with tx_sig
        if (closeResult.txSig && decisionId) {
          await updateTradeLotDecisionId(closeResult.txSig, decisionId);
        }
        
        // Clear orphan tracking for this mint
        clearOrphanTracking(orphan.mint);
        
        // Update state
        state.lastTradeAt[orphan.mint] = Date.now();
        if (execMode === "live" && state.circuit) {
          addTurnover(state.circuit, sellPos.valueUsd);
        }
        
        // Remove from positions array
        const soldIdx = positionsForDashboard.findIndex(p => p.mint === orphan.mint);
        if (soldIdx >= 0) {
          positionsForDashboard.splice(soldIdx, 1);
        }
        entryPrices.delete(orphan.mint);
        
        logger.info({
          mint: orphan.mint,
          symbol: orphan.symbol,
          realizedPnl: closeResult.realizedPnlUsd,
          proceedsUsd: closeResult.proceedsUsd,
          fullyClosed: closeResult.fullyClosed,
          txSig: closeResult.txSig,
        }, "UNIVERSE_EXIT: Successfully executed orphan position exit");
      } else {
        logger.error({
          mint: orphan.mint,
          symbol: orphan.symbol,
          error: closeResult.error,
          status: closeResult.status,
        }, "UNIVERSE_EXIT: Failed to execute orphan position exit");
      }
    }
  } catch (orphanErr) {
    logger.error({ error: String(orphanErr) }, "ORPHAN_EXIT: Error during orphan exit evaluation");
  }

  // ========== SCOUT TAKE-PROFIT DECISION FLOW ==========
  // Unlike protective exits, scout TP respects the pause (placed before pause check)
  // Scouts that hit TP threshold either get promoted (if eligible) or exit with profit
  let scoutTpExecuted = 0;
  const MAX_SCOUT_TP_PER_TICK = 2;

  try {
    const scoutTpPct = config.scoutTakeProfitPct;
    if (scoutTpPct && scoutTpPct > 0) {
      // Build tpCandidateMintsTop: all scouts sorted by pnlPct desc, top 5
      const scoutCandidates: Array<{mint: string, pnlPct: number, positionUsd: number, holdMinutes: number, tpPctUsed: number}> = [];
      for (const pos of positionsForDashboard) {
        if (slotTypeMap.get(pos.mint) !== 'scout') continue;
        const entry = entryPrices.get(pos.mint);
        const pnlPct = entry && entry.avgCostUsd > 0 ? (pos.priceUsd - entry.avgCostUsd) / entry.avgCostUsd : 0;
        const tracking = positionTrackingMap.get(pos.mint);
        const minutesHeld = tracking ? (Date.now() - new Date(tracking.entry_time).getTime()) / (1000 * 60) : 0;
        scoutCandidates.push({
          mint: pos.mint,
          pnlPct,
          positionUsd: pos.valueUsd,
          holdMinutes: minutesHeld,
          tpPctUsed: scoutTpPct,
        });
      }
      scoutCandidates.sort((a, b) => b.pnlPct - a.pnlPct);
      exitEvalSummary.tpCandidateMintsTop = scoutCandidates.slice(0, 5);

      // Use positionTrackingMap from earlier in tick (built near slotTypeMap)
      for (const pos of positionsForDashboard) {
        // Skip non-scouts
        if (slotTypeMap.get(pos.mint) !== 'scout') continue;

        // Get position tracking for hold time calculation (from map, not DB)
        const tracking = positionTrackingMap.get(pos.mint);
        const minutesHeld = tracking ? (Date.now() - new Date(tracking.entry_time).getTime()) / (1000 * 60) : 0;

        // Calculate PnL % from entry prices
        const entry = entryPrices.get(pos.mint);
        const pnlPct = entry && entry.avgCostUsd > 0 ? (pos.priceUsd - entry.avgCostUsd) / entry.avgCostUsd : 0;

        // Skip if below TP threshold
        if (pnlPct < scoutTpPct) continue;

        // Skip if already at max per tick
        if (scoutTpExecuted >= MAX_SCOUT_TP_PER_TICK) {
          exitEvalSummary.sellsSuppressed.maxPerTick++;
          logger.info({ 
            mint: pos.mint, 
            symbol: pos.symbol, 
            reason: 'maxPerTick', 
            pnlPct, 
            positionUsd: pos.valueUsd 
          }, "EXIT_SUPPRESSED");
          continue;
        }

        // Skip positions below minimum trade size
        if (pos.valueUsd < config.minTradeUsd) {
          exitEvalSummary.sellsSuppressed.minTradeUsd++;
          logger.info({ 
            mint: pos.mint, 
            symbol: pos.symbol, 
            reason: 'minTradeUsd', 
            pnlPct, 
            positionUsd: pos.valueUsd,
            minTradeUsd: config.minTradeUsd
          }, "EXIT_SUPPRESSED");
          continue;
        }

        // Skip if not held long enough
        if (minutesHeld < config.scoutTpMinHoldMinutes) {
          exitEvalSummary.sellsSuppressed.other++;
          logger.info({ 
            mint: pos.mint, 
            symbol: pos.symbol, 
            reason: 'holdTimeTooShort', 
            pnlPct, 
            positionUsd: pos.valueUsd,
            minutesHeld,
            minHoldMinutes: config.scoutTpMinHoldMinutes
          }, "EXIT_SUPPRESSED");
          continue;
        }

        // TP threshold met - get signal score for logging
        const signal = candidates.find(c => c.mint === pos.mint);
        const signalScore = signal?.score ?? 0;

        // SCOUT TP = FULL EXIT (Volatility Harvest Strategy)
        // TP is the cash register - never promote on TP, always sell 100%
        logger.info({
          mint: pos.mint,
          symbol: pos.symbol ?? pos.mint.slice(0, 6),
          pnlPct,
          tpPct: scoutTpPct,
          holdMinutes: minutesHeld,
        }, "SCOUT_TP_TRIGGER");

        // Log SCOUT_TP_TRIGGER event
        logScoutTpTrigger({
          mint: pos.mint,
          symbol: pos.symbol ?? pos.mint.slice(0, 6),
          pnl_pct: pnlPct,
          scout_take_profit_pct: scoutTpPct,
          signal_score: signalScore,
          promotable: false,
          reason_if_not_promotable: 'TP_FULL_EXIT_STRATEGY',
          minutes_held: minutesHeld,
        });
        
        // Track for EXIT_EVAL_SUMMARY
        exitEvalSummary.scoutTpTriggered++;

        // Push to tpTriggeredMints for tracking
        exitEvalSummary.tpTriggeredMints.push({
          mint: pos.mint,
          pnlPct,
          holdMinutes: minutesHeld,
          tpPctUsed: scoutTpPct,
          promotable: false,
        });

        // Push to exitActions for unified tracking
        exitEvalSummary.exitActions.push({
          mint: pos.mint,
          symbol: pos.symbol ?? pos.mint.slice(0, 6),
          slotType: 'scout',
          reasonCode: 'scout_take_profit_exit',
          pnlPct,
          positionUsd: pos.valueUsd,
          holdMinutes: minutesHeld,
          tpPctUsed: scoutTpPct,
          promotable: false,
        });

        // EXIT with profit - use closePosition for wallet-based full exit
        logger.info({
          mint: pos.mint,
          symbol: pos.symbol,
          pnlPct,
          signalScore,
        }, "SCOUT_TP_EXIT: Triggering full position close (TP = cash register)");

        const { closePosition } = await import("./close_position.js");

        // Increment sellsAttempted BEFORE calling closePosition
        exitEvalSummary.sellsAttempted++;
        
        const closeResult = await closePosition(
          pos.mint,
          'scout_take_profit_exit',
          {
            symbol: pos.symbol ?? pos.mint.slice(0, 6),
            pnlPct,
            signalScore,
            entryPriceUsd: entry?.avgCostUsd,
            currentPriceUsd: pos.priceUsd,
            solPriceUsd: solUsd,
            slotType: 'scout',
            bypassedPause: state.paused || config.manualPause,
          },
          signer,
          execMode
        );

        if (!closeResult.success) {
          // Increment sellsFailed AFTER closePosition fails
          exitEvalSummary.sellsFailed++;
          logScoutTpExit({
            mint: pos.mint,
            symbol: pos.symbol ?? pos.mint.slice(0, 6),
            pnl_pct: pnlPct,
            signal_score: signalScore,
            executed: false,
            suppression_reason: closeResult.error ?? 'execution_error',
            minutes_held: minutesHeld,
          });
          continue;
        }

        // Increment sellsExecuted AFTER closePosition succeeds
        exitEvalSummary.sellsExecuted++;

        scoutTpExecuted++;
        state.lastTradeAt[pos.mint] = Date.now();
        if (execMode === "live" && state.circuit) {
          addTurnover(state.circuit, pos.valueUsd);
        }

        const soldIdx = positionsForDashboard.findIndex(p => p.mint === pos.mint);
        if (soldIdx >= 0) {
          positionsForDashboard.splice(soldIdx, 1);
        }

        logger.info({
          event: 'SCOUT_TP_EXIT_EXEC',
          mint: pos.mint,
          txSig: closeResult.txSig,
          soldAmount: closeResult.soldAmount,
          proceedsUsd: closeResult.proceedsUsd,
          fullyClosed: closeResult.fullyClosed,
        }, "SCOUT_TP_EXIT_EXEC");

        if (!closeResult.fullyClosed && closeResult.remainingAmount > 0) {
          logger.warn({
            event: 'SCOUT_TP_SUPPRESSED',
            mint: pos.mint,
            why: 'PARTIAL_REMAINING',
            remainingAmount: closeResult.remainingAmount,
          }, "SCOUT_TP_SUPPRESSED");
        }

        logScoutTpExit({
          mint: pos.mint,
          symbol: pos.symbol ?? pos.mint.slice(0, 6),
          pnl_pct: pnlPct,
          signal_score: signalScore,
          executed: true,
          suppression_reason: null,
          minutes_held: minutesHeld,
        });

        entryPrices.delete(pos.mint);
        lastTradeTimestamp = Date.now();

        logger.info({
          mint: pos.mint,
          symbol: pos.symbol,
          pnlPct,
          realizedPnl: closeResult.realizedPnlUsd,
          proceedsUsd: closeResult.proceedsUsd,
          fullyClosed: closeResult.fullyClosed,
          remainingAmount: closeResult.remainingAmount,
          txSig: closeResult.txSig,
        }, "SCOUT_TP_EXIT: Successfully closed position");

        // Log SELL_BYPASS_PAUSE when executing during pause
        if (state.paused || config.manualPause) {
          logger.info({ 
            reasonCode: 'scout_take_profit_exit', 
            mint: pos.mint, 
            symbol: pos.symbol ?? pos.mint.slice(0, 6), 
            paused: true 
          }, "SELL_BYPASS_PAUSE");
        }
      }
    }
  } catch (scoutTpErr) {
    logger.error({ error: String(scoutTpErr) }, "SCOUT_TP: Error during scout take-profit evaluation");
  }

  // EXIT_INVARIANT_VIOLATION check: Detect if triggers were detected but no sells attempted or suppressed
  const totalTriggers = exitEvalSummary.scoutStopTriggered + exitEvalSummary.scoutTpTriggered;
  const totalSuppressed = Object.values(exitEvalSummary.sellsSuppressed).reduce((a, b) => a + b, 0);
  if (totalTriggers > 0 && exitEvalSummary.sellsAttempted === 0 && totalSuppressed === 0) {
    logger.error({
      scoutStopTriggered: exitEvalSummary.scoutStopTriggered,
      scoutTpTriggered: exitEvalSummary.scoutTpTriggered,
      stopTriggeredMints: exitEvalSummary.stopTriggeredMints,
      tpTriggeredMints: exitEvalSummary.tpTriggeredMints,
      tickTs: Date.now(),
    }, 'EXIT_INVARIANT_VIOLATION: Triggers detected but no sells attempted or suppressed');
  }

  // EXIT_EVAL_SUMMARY: Log exit evaluation metrics EVERY tick (even when paused)
  logger.info({
    ts: new Date().toISOString(),
    pausedManual: config.manualPause,
    pausedRisk: state.paused,
    positionsHeldCount: positionsForDashboard.length,
    trackingRowsCount: positionTracking.length,
    scoutsEvaluated: exitEvalSummary.scoutsEvaluated,
    coreEvaluated: exitEvalSummary.coreEvaluated,
    scoutStopTriggered: exitEvalSummary.scoutStopTriggered,
    scoutTpTriggered: exitEvalSummary.scoutTpTriggered,
    scoutUnderperformTriggered: protectiveResult?.scoutUnderperformTriggers?.length ?? 0,
    sellsAttempted: exitEvalSummary.sellsAttempted,
    sellsExecuted: exitEvalSummary.sellsExecuted,
    sellsFailed: exitEvalSummary.sellsFailed,
    sellsSuppressed: exitEvalSummary.sellsSuppressed,
    exitActionsCount: exitEvalSummary.exitActions.length,
    exitActionsTop10: exitEvalSummary.exitActions.slice(0, 10),
    stopTriggeredMints: exitEvalSummary.stopTriggeredMints,
    tpCandidateMintsTop: exitEvalSummary.tpCandidateMintsTop,
    tpTriggeredMints: exitEvalSummary.tpTriggeredMints,
  }, "EXIT_EVAL_SUMMARY");

  // PAUSE GATING: Instead of early return, we block only BUY operations while allowing protective SELLs
  // Protective exit reason codes that bypass pause:
  // - scout_stop_loss_exit, scout_take_profit_exit, scout_underperform_grace_expired
  // - core_loss_exit, take_profit, trailing_stop_exit, flash_close
  const isPaused = state.paused || config.manualPause;
  
  if (isPaused) {
    if (protectiveExitsExecuted > 0 || scoutTpExecuted > 0) {
      logger.info({ protectiveExitsExecuted, scoutTpExecuted }, "Trading paused but protective exits were executed");
    } else if (config.manualPause && !state.paused) {
      logger.info("Trading paused: Manually paused by user");
    } else {
      logger.info({ pauseReason: state.pauseReason }, "Trading paused by risk circuit - allowing protective sells only");
    }
  }

  let tradesExecuted = 0;

  // ========== ALLOCATION EXECUTION LOOP ==========
  // Execute trades for PENDING allocation gaps when gates allow
  // Recompute gates FRESH right before execution to capture any state changes since diagnostics
  // Use !executionBlockedFinal which checks coverage for positions AND allocation targets
  const execGlobalGates = computeGlobalGates(config.manualPause, state.paused, lowSolMode, !executionBlockedFinal);
  const execActiveGates = getActiveGateNames(execGlobalGates);
  
  // Count pending allocations to determine if we should log gate status
  const pendingAllocations = allocationGapDiagnostics.filter(d => d.executionOutcome === "PENDING" && d.plannedAddUsd > 0);
  
  if (pendingAllocations.length > 0) {
    if (execActiveGates.length > 0) {
      logger.info({
        pendingCount: pendingAllocations.length,
        execActiveGates,
        diagnosticActiveGates: activeGates, // Show both for debugging
        reason: `GLOBAL_GATE:${execActiveGates[0]}`,
      }, "ALLOCATION_EXECUTION_BLOCKED");
    } else {
      logger.info({
        pendingCount: pendingAllocations.length,
        execActiveGates,
        diagnosticActiveGates: activeGates, // Show both for debugging
      }, "ALLOCATION_EXECUTION_PROCEEDING");
    }
  }
  
  // Execute only when no gates are active (using fresh gate state)
  if (execActiveGates.length === 0) {
    for (const diag of allocationGapDiagnostics) {
      if (diag.executionOutcome !== "PENDING" || diag.plannedAddUsd <= 0) {
        continue;
      }

      // Calculate SOL amount from planned USD
      const plannedSol = diag.plannedAddUsd / solUsd;
      const lamports = solToLamports(plannedSol);

      // Determine lane from candidates
      const candidateEntry = candidates.find(c => c.mint === diag.mint);
      const lane = candidateEntry?.slotType ?? 'core';

      // Log execution attempt
      logger.info({
        symbol: diag.symbol,
        mint: diag.mint.slice(0, 8),
        side: 'buy',
        plannedAddUsd: diag.plannedAddUsd.toFixed(2),
        plannedSol: plannedSol.toFixed(4),
        lane,
      }, "ALLOCATION_EXECUTE_ATTEMPT");

      // Exit liquidity check for allocation buys (scout or core)
      const exitLiqCheck = await checkExitLiquidityForEntry({
        lane: lane as "scout" | "core",
        inputSolLamports: lamports.toString(),
        outputMint: diag.mint,
        slippageBps: config.maxSlippageBps,
      });
      
      if (!exitLiqCheck.ok) {
        logger.warn({
          symbol: diag.symbol,
          mint: diag.mint.slice(0, 8),
          lane,
          failReason: exitLiqCheck.reason,
          roundTripRatio: exitLiqCheck.roundTripRatio?.toFixed(4),
          exitImpactPct: exitLiqCheck.estimatedExitImpactPct?.toFixed(4),
          routeHops: exitLiqCheck.routeHops,
        }, "ALLOCATION_BUY_BLOCKED: Exit liquidity check failed");
        diag.executionOutcome = "SKIPPED";
        diag.executionReason = `EXIT_LIQ_FAIL:${exitLiqCheck.reason}`;
        await recordAllocationEvent({
          mint: diag.mint,
          symbol: diag.symbol,
          side: "buy" as const,
          plannedUsd: diag.plannedAddUsd,
          scaledTargetPct: diag.targetPct,
          executedUsd: 0,
          outcome: "SKIPPED",
          reason: `EXIT_LIQ_FAIL:${exitLiqCheck.reason} (lane=${lane})`,
        });
        continue;
      }

      try {
        const swapRes = await executeSwap({
          strategy: 'allocation_buy',
          inputMint: MINT_SOL,
          outputMint: diag.mint,
          inAmountBaseUnits: lamports.toString(),
          slippageBps: config.maxSlippageBps,
          meta: {
            lane,
            symbol: diag.symbol,
            targetPct: diag.targetPct,
            plannedUsd: diag.plannedAddUsd,
          },
        }, signer, execMode);

        // Build execution result and update diagnostic
        const execResult = buildExecutionResultFromSwap(swapRes, solUsd);
        diag.executionOutcome = execResult.outcome;
        diag.executionReason = execResult.reason ?? null;
        diag.txSig = execResult.txSig ?? null;
        diag.executedAddUsd = execResult.executedUsd ?? 0;
        if (execResult.feeDecision) {
          diag.feeGovernor = {
            priorityLevel: execResult.feeDecision.priorityLevel,
            maxLamports: execResult.feeDecision.maxLamports,
            reason: execResult.feeDecision.reason,
          };
        }

        // Update the allocation event with execution result
        await recordAllocationEvent({
          symbol: diag.symbol,
          mint: diag.mint,
          side: 'buy',
          rawTargetPct: diag.rawTargetPct,
          scaledTargetPct: diag.targetPct,
          currentPct: diag.currentPct,
          desiredUsd: diag.desiredAddUsd,
          plannedUsd: diag.plannedAddUsd,
          executedUsd: diag.executedAddUsd,
          outcome: diag.executionOutcome as any,
          reason: diag.executionReason ?? undefined,
          txSig: diag.txSig ?? undefined,
          feeMaxLamports: diag.feeGovernor?.maxLamports,
          bindingConstraint: diag.bindingConstraint,
        });

        // Update trade timestamp if executed
        if (execResult.outcome === "SUBMITTED" || execResult.outcome === "CONFIRMED") {
          state.lastTradeAt[diag.mint] = Date.now();
          lastTradeTimestamp = Date.now();
          tradesExecuted++;
          
          // CRITICAL FIX: Record buy lot for FIFO PnL tracking
          // This was missing, causing positions bought via allocation to have no cost basis
          if (swapRes.quote && swapRes.quote.outAmount) {
            try {
              const fallbackDecimals = prices[diag.mint]?.decimals ?? 6;
              let tokenDecimals = fallbackDecimals;
              try {
                tokenDecimals = await getAuthoritativeDecimals(diag.mint);
              } catch (e) {
                logger.warn({ mint: diag.mint, fallbackDecimals, error: String(e) }, "ALLOCATION_BUY: Failed to get authoritative decimals, using fallback");
              }
              
              const tokensReceivedRaw = BigInt(swapRes.quote.outAmount);
              const tokensReceived = Number(tokensReceivedRaw) / Math.pow(10, tokenDecimals);
              
              if (tokensReceived > 0) {
                const actualSolSpent = Number(BigInt(swapRes.quote.inAmount)) / 1e9;
                const actualUsdSpent = actualSolSpent * solUsd;
                const effectivePrice = actualUsdSpent / tokensReceived;
                
                await insertTradeLot({
                  tx_sig: swapRes.txSig || `ALLOC_BUY_${diag.mint.slice(0, 8)}_${Date.now()}`,
                  timestamp: new Date(),
                  mint: diag.mint,
                  side: 'buy',
                  quantity: tokensReceived,
                  usd_value: actualUsdSpent,
                  unit_price_usd: effectivePrice,
                  sol_price_usd: solUsd,
                  source: 'allocation_buy',
                  status: swapRes.status === 'sent' ? 'confirmed' : swapRes.status,
                });
                
                logger.info({
                  mint: diag.mint.slice(0, 8),
                  symbol: diag.symbol,
                  tokensReceived,
                  actualUsdSpent: actualUsdSpent.toFixed(2),
                  effectivePrice,
                }, "ALLOCATION_BUY: Position lot inserted for FIFO PnL tracking");
              }
            } catch (lotErr) {
              logger.error({ mint: diag.mint, error: String(lotErr) }, "ALLOCATION_BUY: Failed to insert trade lot");
            }
          }
        }

      } catch (err: any) {
        logger.error({ err: err.message, symbol: diag.symbol }, "Allocation execution failed");
        diag.executionOutcome = "FAILED";
        diag.executionReason = `exception: ${err.message}`;
        
        // Record failed event
        await recordAllocationEvent({
          symbol: diag.symbol,
          mint: diag.mint,
          side: 'buy',
          rawTargetPct: diag.rawTargetPct,
          scaledTargetPct: diag.targetPct,
          currentPct: diag.currentPct,
          desiredUsd: diag.desiredAddUsd,
          plannedUsd: diag.plannedAddUsd,
          executedUsd: 0,
          outcome: "FAILED",
          reason: `exception: ${err.message}`,
          bindingConstraint: diag.bindingConstraint,
        });
      }
    }
  }
  // ========== END ALLOCATION EXECUTION LOOP ==========

  // Process scout queue for autonomous buying - BLOCKED when paused (BUY operation)
  if (!isPaused) {
    const scoutPollNow = Date.now();
    const pollDeltaMs = scoutPollNow - lastScoutQueuePoll;
    const pollIntervalMs = config.scoutQueuePollSeconds * 1000;
    const pollReady = pollDeltaMs >= pollIntervalMs;
    
    if (lowSolMode) {
      logger.info({ lowSolMode, solBalance: allBalances.sol }, "QUEUE_POLL: Skipped - low SOL mode active");
    } else if (!pollReady) {
      // Only log occasionally to avoid spam (every 5th tick approximately)
      if (Math.random() < 0.2) {
        logger.debug({ 
          pollDeltaMs, 
          pollIntervalMs, 
          remainingMs: pollIntervalMs - pollDeltaMs 
        }, "QUEUE_POLL: Waiting for poll interval");
      }
    } else {
      lastScoutQueuePoll = scoutPollNow;
      logger.info({ pollDeltaMs, pollIntervalMs }, "QUEUE_POLL: Processing scout queue");
      try {
        const queueResult = await processScoutQueue();
        
        const skipReasonCounts: Record<string, number> = {};
        const exampleSkipped: Array<{mint: string, symbol?: string, failReason: string | null, ret15: number | null, drawdown15: number | null, barCount: number}> = [];
        
        if ((queueResult as any).skipReason) {
          const reason = (queueResult as any).skipReason as string;
          skipReasonCounts[reason] = (skipReasonCounts[reason] || 0) + 1;
          if (exampleSkipped.length < 3 && (queueResult as any).skipExample) {
            exampleSkipped.push((queueResult as any).skipExample);
          }
        }
        
        logger.info({ 
          processed: queueResult.processed,
          bought: queueResult.bought, 
          failed: queueResult.failed, 
          skipped: queueResult.skipped,
          lastSkippedReasonCounts: Object.keys(skipReasonCounts).length > 0 ? skipReasonCounts : undefined,
          exampleSkipped: exampleSkipped.length > 0 ? exampleSkipped : undefined,
        }, "QUEUE_POLL: Result");
      } catch (err) {
        logger.warn({ err }, "Failed to process scout queue");
      }
    }
  } else {
    logger.debug("QUEUE_POLL: Skipped - paused");
  }
  
  // SCAN_WATCHDOG: Detect if scheduled scans stopped running
  if (scannerEnabled && scanIntervalMs > 0 && lastScanAt > 0) {
    const overdueMs = Date.now() - lastScanAt - scanIntervalMs;
    const overdueThreshold = scanIntervalMs * 1.5; // Allow 150% of interval before warning
    if (overdueMs > overdueThreshold) {
      logger.warn({ 
        overdueMs, 
        lastScanAt: new Date(lastScanAt).toISOString(),
        scanIntervalMs 
      }, "SCAN_WATCHDOG: scan overdue, forcing scan");
      runPeriodicScanSafe("watchdog").catch(() => {}); // Force a scan
    }
  }

  const takeProfitPct = config.takeProfitPct;
  if (!lowSolMode && takeProfitPct && takeProfitPct > 0) {
    for (const pos of positionsForDashboard) {
      if (pos.mint === MINT_SOL || pos.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") continue;
      if (pos.valueUsd < 1) continue;

      // SCOUTS EXCLUDED: Take-profit only applies to CORE positions
      // Scouts should run freely - they exit via stop loss, stale rotation, or opportunity cost rotation
      const posSlotType = slotTypeMap.get(pos.mint);
      if (posSlotType === 'scout') continue;

      // PROMOTION GRACE: Skip take-profit for freshly promoted scouts
      // They need to receive core allocation buy first to recalculate cost basis
      const promoGrace = promotionGraceTracking.get(pos.mint);
      if (promoGrace) {
        const timeSincePromotion = Date.now() - promoGrace.promotedAt;
        if (timeSincePromotion < PROMOTION_GRACE_MS) {
          logger.debug({ 
            mint: pos.mint, 
            symbol: promoGrace.symbol,
            timeSincePromotionMs: timeSincePromotion,
            graceRemainingMs: PROMOTION_GRACE_MS - timeSincePromotion,
          }, "PROMOTION_GRACE: Skipping take-profit for freshly promoted position");
          continue;
        } else {
          // Grace period expired - clear tracking
          promotionGraceTracking.delete(pos.mint);
          logger.info({ mint: pos.mint, symbol: promoGrace.symbol }, "PROMOTION_GRACE: Grace period expired");
        }
      }

      // SAFETY: Skip if price data is missing or zero to prevent erroneous sells
      if (!pos.priceUsd || pos.priceUsd <= 0) {
        logger.warn({ mint: pos.mint }, "Skipping take-profit check - no valid price data");
        continue;
      }

      const entry = entryPrices.get(pos.mint);
      
      // CRITICAL FIX: Log warning and attempt fallback when FIFO cost basis is missing
      // Previously this silently skipped positions, causing take-profit to never trigger
      if (!entry || entry.avgCostUsd <= 0) {
        // Attempt to get fallback from position tracking
        const trackingData = await getPositionTracking(pos.mint);
        if (trackingData && trackingData.entry_price > 0) {
          logger.warn({ 
            mint: pos.mint, 
            symbol: pos.symbol || pos.mint.slice(0, 6),
            trackingEntryPrice: trackingData.entry_price,
            currentPrice: pos.priceUsd,
          }, "TAKE_PROFIT_FALLBACK: FIFO cost basis missing, using position_tracking entry_price");
          
          // Use tracking data as fallback
          entryPrices.set(pos.mint, {
            avgCostUsd: trackingData.entry_price,
            totalTokens: trackingData.total_tokens,
          });
        } else {
          logger.warn({ 
            mint: pos.mint,
            symbol: pos.symbol || pos.mint.slice(0, 6),
            currentPrice: pos.priceUsd,
            valueUsd: pos.valueUsd,
          }, "TAKE_PROFIT_SKIP: No valid cost basis available (neither FIFO nor tracking) - cannot evaluate take-profit");
          continue;
        }
      }

      // Re-fetch entry after potential fallback update
      const effectiveEntry = entryPrices.get(pos.mint);
      if (!effectiveEntry || effectiveEntry.avgCostUsd <= 0) continue;

      const currentPrice = pos.priceUsd;
      const gain = (currentPrice - effectiveEntry.avgCostUsd) / effectiveEntry.avgCostUsd;

      if (gain >= takeProfitPct) {
        const universeToken = universe.find((u) => u.mint === pos.mint);
        const symbol = universeToken?.symbol ?? pos.mint.slice(0, 6);

        // Get peak metrics from position_tracking before selling
        const tpTrackingData = await getPositionTracking(pos.mint);
        const tpPeakPnlPct = tpTrackingData?.peak_pnl_pct ?? null;
        const tpPeakPnlUsd = tpTrackingData && tpTrackingData.entry_price > 0
          ? ((tpTrackingData.peak_price - tpTrackingData.entry_price) / tpTrackingData.entry_price) * pos.valueUsd
          : null;

        logger.info({
          mint: pos.mint,
          symbol,
          gain: (gain * 100).toFixed(2) + "%",
          entryPrice: effectiveEntry.avgCostUsd,
          currentPrice,
          takeProfitPct: (takeProfitPct * 100).toFixed(2) + "%",
        }, `Take-profit triggered for ${symbol} at ${(gain * 100).toFixed(2)}% gain`);

        const decimals = prices[pos.mint]?.decimals ?? 9;
        const baseUnits = uiToBaseUnits(pos.amount, decimals);

        const res = await executeSwap({
          strategy: "take_profit",
          inputMint: pos.mint,
          outputMint: MINT_SOL,
          inAmountBaseUnits: baseUnits,
          slippageBps: config.maxSlippageBps,
          meta: { take_profit: true, reasonCode: 'take_profit', gain, entryPrice: effectiveEntry.avgCostUsd, currentPrice },
        }, signer, execMode);

        if (res.status === "insufficient_funds" || res.status === "simulation_failed" || res.status === "error") {
          logger.warn({ error: res.error, preflight: res.preflightDetails }, "Take-profit swap failed - skipping");
          // Log exit decision with suppression reason for failed execution
          logExitDecision({
            mint: pos.mint,
            symbol,
            reason: 'take_profit',
            entry_price: effectiveEntry.avgCostUsd,
            current_price: currentPrice,
            pnl_pct: gain,
            peak_price: null,
            peak_pnl_pct: null,
            threshold: takeProfitPct,
            condition_met: true,
            executed: false,
            suppression_reason: res.error ?? 'execution_error',
            slot_type: posSlotType ?? 'core',
          });
          continue;
        }

        // Log successful take-profit exit decision
        logExitDecision({
          mint: pos.mint,
          symbol,
          reason: 'take_profit',
          entry_price: effectiveEntry.avgCostUsd,
          current_price: currentPrice,
          pnl_pct: gain,
          peak_price: null,
          peak_pnl_pct: null,
          threshold: takeProfitPct,
          condition_met: true,
          executed: res.status === 'sent' || res.status === 'paper',
          suppression_reason: null,
          slot_type: posSlotType ?? 'core',
        });

        state.lastTradeAt[pos.mint] = Date.now();
        if (execMode === "live") {
          addTurnover(state.circuit!, pos.valueUsd);
        }

        // CRITICAL: Wrap post-swap processing in try/catch to ensure trade is ALWAYS logged
        // even if subsequent calculations fail
        let solReceived = 0;
        let proceedsUsd = 0;
        let costBasis = 0;
        let realizedPnl = 0;
        
        try {
          const solReceivedLamports = BigInt(res.quote?.outAmount ?? "0");
          solReceived = Number(solReceivedLamports) / 1e9;
          proceedsUsd = solReceived * solUsd;
          costBasis = effectiveEntry.avgCostUsd * pos.amount;
          realizedPnl = proceedsUsd - costBasis;
        } catch (calcErr) {
          logger.error({ mint: pos.mint, error: String(calcErr) }, "TAKE_PROFIT: Failed to calculate trade details, using defaults");
        }

        const analytics = buildTradeAnalytics({
          reason: TRADE_REASONS.SELL_TAKE_PROFIT,
          quote: res.quote,
          riskProfile: config.riskProfile,
        });

        try {
          await insertTrade({
            strategy: "take_profit",
            risk_profile: config.riskProfile,
            mode: execMode,
            input_mint: pos.mint,
            output_mint: MINT_SOL,
            in_amount: baseUnits,
            out_amount: res.quote?.outAmount ?? null,
            est_out_amount: res.quote?.outAmount ?? null,
            price_impact_pct: res.quote?.priceImpactPct ?? null,
            slippage_bps: res.quote?.slippageBps ?? null,
            tx_sig: res.txSig,
            status: res.status,
            meta: { ...(res.quote ?? {}), take_profit: true, gain, entryPrice: effectiveEntry.avgCostUsd, costBasis, proceedsUsd, realizedPnl, tradeValueUsd: pos.valueUsd },
            pnl_usd: realizedPnl,
            reason_code: analytics.reason_code,
            exit_score: analytics.exit_score,
            fees_lamports: analytics.fees_lamports,
            priority_fee_lamports: analytics.priority_fee_lamports,
            route: analytics.route,
            settings_snapshot: analytics.settings_snapshot,
            peak_pnl_pct: tpPeakPnlPct,
            peak_pnl_usd: tpPeakPnlUsd,
          });
        } catch (insertErr) {
          logger.error({ mint: pos.mint, txSig: res.txSig, error: String(insertErr) }, "TAKE_PROFIT: CRITICAL - Failed to insert trade to bot_trades!");
        }
        lastTradeTimestamp = Date.now();

        // Record sell with FIFO for realized PnL tracking (works in both live and paper mode)
        if (res.status === 'sent' || res.status === 'paper') {
          try {
            const txSigForFifo = res.txSig ?? `paper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            const fifoResult = await processSellWithFIFO(
              txSigForFifo,
              pos.mint,
              symbol,
              pos.amount,
              proceedsUsd,
              new Date(),
              solUsd
            );
            logger.info({ mint: pos.mint, symbol, proceedsUsd: proceedsUsd.toFixed(2), mode: res.status }, "TAKE_PROFIT: FIFO sell recorded for PnL");
            
            // Sync bot_trades.pnl_usd with FIFO result if different
            if (res.txSig && fifoResult.realizedPnl !== realizedPnl) {
              await updateTradePnl(res.txSig, fifoResult.realizedPnl, tpPeakPnlPct ?? undefined, tpPeakPnlUsd ?? undefined);
            }
            
            // Invariant check: validate bot_trades.pnl_usd matches FIFO pnl_events
            if (res.txSig) {
              const validation = await validateTradePnlConsistency(res.txSig, fifoResult.realizedPnl);
              if (!validation.consistent) {
                logger.error({
                  mint: pos.mint, txSig: res.txSig, botTradesPnl: validation.botTradesPnl,
                  fifoPnl: validation.fifoPnl, discrepancy: validation.discrepancy
                }, "PNL_INVARIANT_VIOLATION: bot_trades.pnl_usd does not match pnl_events");
              }
            }
          } catch (fifoErr) {
            logger.error({ mint: pos.mint, txSig: res.txSig, error: String(fifoErr) }, "TAKE_PROFIT: Failed to record FIFO sell");
          }
        }

        if (res.status === 'sent' || res.status === 'paper') {
          try {
            const decisionId = await logDecision({
              mint: pos.mint,
              symbol,
              actionType: 'exit',
              reasonCode: 'take_profit',
              reasonDetail: `PnL ${(gain * 100).toFixed(1)}% exceeded threshold ${(takeProfitPct * 100).toFixed(1)}%`,
              triggeredBy: 'strategy_engine',
              txSig: res.txSig ?? undefined,
              qtyBefore: pos.amount,
              qtyAfter: 0,
              qtyDelta: -pos.amount,
              usdValueBefore: pos.valueUsd,
              usdValueAfter: 0,
              confidenceScore: undefined,
              journeyId: getJourneyId(pos.mint),
            });
            if (res.txSig && decisionId) {
              await updateTradeLotDecisionId(res.txSig, decisionId);
            }
          } catch (logErr) {
            logger.error({ mint: pos.mint, error: String(logErr) }, "TAKE_PROFIT: Failed to log position decision");
          }
        }

        // Track for potential re-entry if momentum continues
        reentryTracking.set(pos.mint, {
          mint: pos.mint,
          symbol,
          sellPrice: currentPrice,
          sellTimestamp: Date.now(),
          originalEntryPrice: effectiveEntry.avgCostUsd,
        });
        logger.info({ mint: pos.mint, symbol, sellPrice: currentPrice }, "Added to re-entry tracking after take-profit");

        const holdingMinutes = 0;
        const executionPriceUsd = solReceived > 0 && pos.amount > 0 ? (solReceived * solUsd) / pos.amount : currentPrice;
        const slippageBpsExit = currentPrice > 0 ? Math.abs(((executionPriceUsd - currentPrice) / currentPrice) * 10000) : 0;
        
        logTradeExit({
          mint: pos.mint,
          symbol,
          decision_price_usd: currentPrice,
          execution_price_usd: executionPriceUsd,
          realized_pnl_usd: realizedPnl,
          realized_pnl_pct: gain,
          holding_minutes: holdingMinutes,
          trigger_reason: 'take_profit',
          slippage_bps: slippageBpsExit,
          signal_snapshot: null,
          mode: execMode,
        });

        if (res.status === 'sent' || res.status === 'paper') {
          try {
            await insertRotationLog({
              action: 'exit',
              soldMint: pos.mint,
              soldSymbol: symbol,
              reasonCode: 'take_profit',
              meta: {
                txSig: res.txSig,
                gainPct: gain,
                realizedPnlUsd: realizedPnl,
                proceedsUsd,
                sellAmount: pos.amount,
                entryPrice: effectiveEntry.avgCostUsd,
                currentPrice,
                exitType: 'take_profit',
              },
            });
          } catch (rotLogErr) {
            logger.error({ mint: pos.mint, error: String(rotLogErr) }, "TAKE_PROFIT: Failed to insert rotation log");
          }

          await enforceExitInvariant({
            mint: pos.mint,
            symbol,
            exitReasonCode: 'take_profit',
            lastTradeTxSig: res.txSig ?? undefined,
            currentPriceUsd: currentPrice,
            solPriceUsd: solUsd,
          }, signer, execMode).catch(e => logger.error({ mint: pos.mint, error: String(e) }, "EXIT_INVARIANT: Failed to enforce cleanup"));
        }

        clearJourneyId(pos.mint);
        
        entryPrices.delete(pos.mint);

        // Log SELL_BYPASS_PAUSE when executing during pause
        if (isPaused) {
          logger.info({ 
            reasonCode: 'take_profit', 
            mint: pos.mint, 
            symbol, 
            paused: true 
          }, "SELL_BYPASS_PAUSE");
        }

        tradesExecuted++;
        if (tradesExecuted >= 3) break;
      }
    }
  }

  // Concentration-based rebalancing: sell if top-3 concentration exceeds limit
  if (!lowSolMode && tradesExecuted < 3 && config.maxTop3ConcentrationPct > 0) {
    const nonBasePositions = positionsForDashboard
      .filter(p => p.mint !== MINT_SOL && p.mint !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && p.valueUsd > 1 && p.priceUsd > 0)
      .sort((a, b) => b.valueUsd - a.valueUsd);
    
    const top3Value = nonBasePositions.slice(0, 3).reduce((sum, p) => sum + p.valueUsd, 0);
    const currentTop3Pct = snap.totalUsd > 0 ? top3Value / snap.totalUsd : 0;
    
    if (currentTop3Pct > config.maxTop3ConcentrationPct) {
      // Find the largest position and sell a portion to reduce concentration
      const largestPos = nonBasePositions[0];
      // SAFETY: Skip if price data is missing or zero
      if (largestPos && largestPos.valueUsd > config.minTradeUsd && largestPos.priceUsd > 0) {
        const excessPct = currentTop3Pct - config.maxTop3ConcentrationPct;
        const targetSellUsd = Math.min(
          excessPct * snap.totalUsd * 0.5, // Sell half of excess to avoid over-correction
          largestPos.valueUsd * config.concentrationRebalanceMaxPct, // Max % of position per tick from config
          config.maxSingleSwapSol * solUsd
        );
        
        if (targetSellUsd >= config.minTradeUsd) {
          const sellRatio = targetSellUsd / largestPos.valueUsd;
          const sellAmount = largestPos.amount * sellRatio;
          const decimals = prices[largestPos.mint]?.decimals ?? 9;
          const baseUnits = uiToBaseUnits(sellAmount, decimals);
          
          const universeToken = universe.find((u) => u.mint === largestPos.mint);
          const symbol = universeToken?.symbol ?? largestPos.mint.slice(0, 6);
          
          // Get peak metrics from position_tracking before selling
          const rebalTrackingData = await getPositionTracking(largestPos.mint);
          const rebalPeakPnlPct = rebalTrackingData?.peak_pnl_pct ?? null;
          const rebalPeakPnlUsd = rebalTrackingData && rebalTrackingData.entry_price > 0
            ? ((rebalTrackingData.peak_price - rebalTrackingData.entry_price) / rebalTrackingData.entry_price) * largestPos.valueUsd
            : null;
          
          logger.info({
            mint: largestPos.mint,
            symbol,
            currentTop3Pct: (currentTop3Pct * 100).toFixed(2) + "%",
            maxTop3Pct: (config.maxTop3ConcentrationPct * 100).toFixed(2) + "%",
            sellUsd: targetSellUsd.toFixed(2),
            positionValueUsd: largestPos.valueUsd.toFixed(2),
          }, `Concentration rebalance: selling ${symbol} to reduce top-3 concentration`);
          
          const res = await executeSwap({
            strategy: "concentration_rebalance",
            inputMint: largestPos.mint,
            outputMint: MINT_SOL,
            inAmountBaseUnits: baseUnits,
            slippageBps: config.maxSlippageBps,
            meta: { concentration_rebalance: true, reasonCode: 'concentration_rebalance', currentTop3Pct, targetSellUsd },
          }, signer, execMode);

          if (res.status === "insufficient_funds" || res.status === "simulation_failed" || res.status === "error") {
            logger.warn({ error: res.error, preflight: res.preflightDetails }, "Concentration rebalance swap failed - skipping");
          } else {
            state.lastTradeAt[largestPos.mint] = Date.now();
            if (execMode === "live") {
              addTurnover(state.circuit!, targetSellUsd);
            }
            
            // CRITICAL: Wrap post-swap processing in try/catch to ensure trade is ALWAYS logged
            let solReceived = 0;
            try {
              const solReceivedLamports = BigInt(res.quote?.outAmount ?? "0");
              solReceived = Number(solReceivedLamports) / 1e9;
            } catch (calcErr) {
              logger.error({ mint: largestPos.mint, error: String(calcErr) }, "CONCENTRATION_REBALANCE: Failed to calculate SOL received");
            }
            
            const rebalAnalytics = buildTradeAnalytics({
              reason: TRADE_REASONS.SELL_REBALANCE,
              quote: res.quote,
              riskProfile: config.riskProfile,
            });

            try {
              await insertTrade({
                strategy: "concentration_rebalance",
                risk_profile: config.riskProfile,
                mode: execMode,
                input_mint: largestPos.mint,
                output_mint: MINT_SOL,
                in_amount: baseUnits,
                out_amount: res.quote?.outAmount ?? null,
                est_out_amount: res.quote?.outAmount ?? null,
                price_impact_pct: res.quote?.priceImpactPct ?? null,
                slippage_bps: res.quote?.slippageBps ?? null,
                tx_sig: res.txSig,
                status: res.status,
                meta: { ...(res.quote ?? {}), concentration_rebalance: true, currentTop3Pct, excessPct, tradeValueUsd: targetSellUsd },
                pnl_usd: 0,
                reason_code: rebalAnalytics.reason_code,
                fees_lamports: rebalAnalytics.fees_lamports,
                priority_fee_lamports: rebalAnalytics.priority_fee_lamports,
                route: rebalAnalytics.route,
                settings_snapshot: rebalAnalytics.settings_snapshot,
                peak_pnl_pct: rebalPeakPnlPct,
                peak_pnl_usd: rebalPeakPnlUsd,
              });
            } catch (insertErr) {
              logger.error({ mint: largestPos.mint, txSig: res.txSig, error: String(insertErr) }, "CONCENTRATION_REBALANCE: CRITICAL - Failed to insert trade to bot_trades!");
            }
            lastTradeTimestamp = Date.now();
            
            // Record sell with FIFO for realized PnL tracking (works in both live and paper mode)
            if (res.status === 'sent' || res.status === 'paper') {
              try {
                const rebalanceProceedsUsd = solReceived * solUsd;
                const txSigForFifo = res.txSig ?? `paper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                const fifoResult = await processSellWithFIFO(
                  txSigForFifo,
                  largestPos.mint,
                  symbol,
                  sellAmount,
                  rebalanceProceedsUsd,
                  new Date(),
                  solUsd
                );
                logger.info({ mint: largestPos.mint, symbol, proceedsUsd: rebalanceProceedsUsd.toFixed(2), mode: res.status }, "CONCENTRATION_REBALANCE: FIFO sell recorded for PnL");
                
                // Sync bot_trades.pnl_usd with FIFO result if different
                if (res.txSig && fifoResult.realizedPnl !== 0) {
                  await updateTradePnl(res.txSig, fifoResult.realizedPnl, rebalPeakPnlPct ?? undefined, rebalPeakPnlUsd ?? undefined);
                }
                
                // Invariant check: validate bot_trades.pnl_usd matches FIFO pnl_events
                if (res.txSig) {
                  const validation = await validateTradePnlConsistency(res.txSig, fifoResult.realizedPnl);
                  if (!validation.consistent) {
                    logger.error({
                      mint: largestPos.mint, txSig: res.txSig, botTradesPnl: validation.botTradesPnl,
                      fifoPnl: validation.fifoPnl, discrepancy: validation.discrepancy
                    }, "PNL_INVARIANT_VIOLATION: bot_trades.pnl_usd does not match pnl_events");
                  }
                }
              } catch (fifoErr) {
                logger.error({ mint: largestPos.mint, txSig: res.txSig, error: String(fifoErr) }, "CONCENTRATION_REBALANCE: Failed to record FIFO sell");
              }
            }

            if (res.status === 'sent' || res.status === 'paper') {
              try {
                const remainingAmount = largestPos.amount - sellAmount;
                const remainingValueUsd = remainingAmount * largestPos.priceUsd;
                const decisionId = await logDecision({
                  mint: largestPos.mint,
                  symbol,
                  actionType: 'trim',
                  reasonCode: 'concentration_rebalance',
                  reasonDetail: `Top-3 concentration ${(currentTop3Pct * 100).toFixed(1)}% exceeds ${(config.maxTop3ConcentrationPct * 100).toFixed(1)}%`,
                  triggeredBy: 'strategy_engine',
                  txSig: res.txSig ?? undefined,
                  qtyBefore: largestPos.amount,
                  qtyAfter: remainingAmount,
                  qtyDelta: -sellAmount,
                  usdValueBefore: largestPos.valueUsd,
                  usdValueAfter: remainingValueUsd,
                  confidenceScore: undefined,
                  journeyId: getJourneyId(largestPos.mint),
                });
                if (res.txSig && decisionId) {
                  await updateTradeLotDecisionId(res.txSig, decisionId);
                }
              } catch (logErr) {
                logger.error({ mint: largestPos.mint, error: String(logErr) }, "CONCENTRATION_REBALANCE: Failed to log position decision");
              }
            }
            
            const rebalEntry = entryPrices.get(largestPos.mint);
            const rebalHoldingMinutes = 0;
            const rebalExecutionPrice = solReceived > 0 && sellAmount > 0 ? (solReceived * solUsd) / sellAmount : largestPos.priceUsd;
            const rebalSlippageBps = largestPos.priceUsd > 0 ? Math.abs(((rebalExecutionPrice - largestPos.priceUsd) / largestPos.priceUsd) * 10000) : 0;
            const rebalProceedsUsd = solReceived * solUsd;
            const rebalCostBasis = rebalEntry ? rebalEntry.avgCostUsd * sellAmount : 0;
            const rebalPnlUsd = rebalEntry ? rebalProceedsUsd - rebalCostBasis : 0;
            const rebalPnlPct = rebalEntry && rebalEntry.avgCostUsd > 0 ? (rebalExecutionPrice - rebalEntry.avgCostUsd) / rebalEntry.avgCostUsd : 0;
            
            logTradeExit({
              mint: largestPos.mint,
              symbol,
              decision_price_usd: largestPos.priceUsd,
              execution_price_usd: rebalExecutionPrice,
              realized_pnl_usd: rebalPnlUsd,
              realized_pnl_pct: rebalPnlPct,
              holding_minutes: rebalHoldingMinutes,
              trigger_reason: 'concentration_rebalance',
              slippage_bps: rebalSlippageBps,
              signal_snapshot: null,
              mode: execMode,
            });

            try {
              await insertRotationLog({
                action: 'exit',
                soldMint: largestPos.mint,
                soldSymbol: symbol,
                reasonCode: 'concentration_rebalance',
                meta: {
                  txSig: res.txSig,
                  currentTop3Pct,
                  maxTop3Pct: config.maxTop3ConcentrationPct,
                  excessPct,
                  sellUsd: targetSellUsd,
                  sellAmount,
                  realizedPnlUsd: rebalPnlUsd,
                  exitType: 'concentration_rebalance',
                },
              });
            } catch (rotLogErr) {
              logger.error({ mint: largestPos.mint, error: String(rotLogErr) }, "CONCENTRATION_REBALANCE: Failed to insert rotation log");
            }
            
            tradesExecuted++;
          }
        }
      }
    }
  }

  if (!lowSolMode && tradesExecuted < 3) {
    try {
      const signalsMap = new Map<string, { mint: string; score: number; regime: "trend" | "range" }>();
      for (const c of candidates) {
        signalsMap.set(c.mint, { mint: c.mint, score: c.score, regime: c.regime as "trend" | "range" });
      }

      const rotationCtx: RotationContext = {
        positions: positionsForDashboard.map(p => ({
          mint: p.mint,
          symbol: p.symbol,
          amount: p.amount,
          usdValue: p.valueUsd,
          priceUsd: p.priceUsd,
        })),
        signals: signalsMap,
        candidates: latestScannerCandidates.map(c => ({
          mint: c.mint,
          symbol: c.symbol,
          score: c.score,
          volume24h: c.volume24h,
          liquidity: c.liquidity,
          priceChange24h: c.priceChange24h,
          price: c.price,
        })),
        entryPrices,
      };

      const rotationResult = await evaluatePortfolio(rotationCtx);
      lastRotationResult = rotationResult;

      if (rotationResult.promotionCandidate) {
        let shouldPromote = true;
        
        if (config.whaleConfirmEnabled) {
          const whaleCheck = await checkMarketConfirmation(rotationResult.promotionCandidate.mint, config);
          
          if (config.whaleConfirmDryRun) {
            logger.info({ 
              mint: rotationResult.promotionCandidate.mint,
              symbol: rotationResult.promotionCandidate.symbol,
              confirmed: whaleCheck.confirmed,
              reason: whaleCheck.reason,
              netflowUsd: whaleCheck.netflowUsd,
              dryRun: true,
            }, "Whale check (dry run) - proceeding with promotion regardless");
          } else if (!whaleCheck.confirmed) {
            logger.info({ 
              mint: rotationResult.promotionCandidate.mint,
              symbol: rotationResult.promotionCandidate.symbol,
              reason: whaleCheck.reason,
              netflowUsd: whaleCheck.netflowUsd,
            }, "Promotion blocked - whale confirmation failed");
            shouldPromote = false;
          } else {
            setWhaleCooldown(rotationResult.promotionCandidate.mint);
          }
        }
        
        if (shouldPromote) {
          const promoMint = rotationResult.promotionCandidate.mint;
          const promoSymbol = rotationResult.promotionCandidate.symbol;
          const promoEntry = entryPrices.get(promoMint);
          const promoPos = positionsForDashboard.find(p => p.mint === promoMint);
          const promoPnlPct = promoEntry && promoEntry.avgCostUsd > 0 && promoPos 
            ? (promoPos.priceUsd - promoEntry.avgCostUsd) / promoEntry.avgCostUsd 
            : 0;
          const promoHeldMinutes = 0;
          const promoCurrentPrice = promoPos?.priceUsd ?? 0;
          
          // CRITICAL: Check promotion exit liquidity before promoting
          // This simulates the full post-promotion core-size exit
          const currentTokenQty = promoPos?.amount ?? 0;
          const coreBuyDeltaSol = config.corePositionPctTarget * snap.totalUsd / solUsd;
          
          const promoExitCheck = await checkPromotionExitLiquidity({
            mint: promoMint,
            currentTokenQty,
            coreBuyDeltaSol,
            slippageBps: config.maxSlippageBps,
          });
          
          if (!promoExitCheck.ok) {
            logger.warn({
              mint: promoMint,
              symbol: promoSymbol,
              failReason: promoExitCheck.reason,
              exitImpactPct: promoExitCheck.estimatedExitImpactPct?.toFixed(4),
              routeHops: promoExitCheck.routeHops,
              currentTokenQty,
              coreBuyDeltaSol: coreBuyDeltaSol.toFixed(4),
            }, "PROMOTION_BLOCKED: Exit liquidity check failed for core-size position");
            shouldPromote = false;
            
            await insertRotationLog({
              action: 'promotion_blocked',
              boughtMint: promoMint,
              boughtSymbol: promoSymbol,
              reasonCode: 'exit_liquidity_insufficient',
              meta: {
                failReason: promoExitCheck.reason,
                exitImpactPct: promoExitCheck.estimatedExitImpactPct,
                routeHops: promoExitCheck.routeHops,
              },
            });
          }
        }
        
        if (shouldPromote) {
          const promoMint = rotationResult.promotionCandidate.mint;
          const promoSymbol = rotationResult.promotionCandidate.symbol;
          const promoEntry = entryPrices.get(promoMint);
          const promoPos = positionsForDashboard.find(p => p.mint === promoMint);
          const promoPnlPct = promoEntry && promoEntry.avgCostUsd > 0 && promoPos 
            ? (promoPos.priceUsd - promoEntry.avgCostUsd) / promoEntry.avgCostUsd 
            : 0;
          const promoHeldMinutes = 0;
          const promoCurrentPrice = promoPos?.priceUsd ?? 0;
          
          await executePromotion(promoMint, promoSymbol, promoCurrentPrice);
          
          // Track promotion grace period - skip take-profit until core allocation buy executes
          promotionGraceTracking.set(promoMint, { promotedAt: Date.now(), symbol: promoSymbol });
          logger.info({ mint: promoMint, symbol: promoSymbol, graceMs: PROMOTION_GRACE_MS }, "PROMOTION_GRACE: Started grace period - take-profit disabled until core buy");
          
          logPromotion({
            mint: promoMint,
            symbol: promoSymbol,
            old_slot_type: 'scout',
            new_slot_type: 'core',
            pnl_pct: promoPnlPct,
            signal_score: null,
            held_minutes: promoHeldMinutes,
            criteria_snapshot: {
              promotionMinPnlPct: config.promotionMinPnlPct,
              promotionMinSignalScore: config.promotionMinSignalScore,
              promotionDelayMinutes: config.promotionDelayMinutes,
            },
          });
          
          logger.info({ 
            mint: promoMint, 
            symbol: promoSymbol,
          }, "Scout promoted to core slot");
        }
      }

      if (rotationResult.decision.shouldRotate && rotationResult.decision.sellMint) {
        const sellPos = positionsForDashboard.find(p => p.mint === rotationResult.decision.sellMint);
        
        // NEW: Check whale exit signal for additional exit pressure
        if (config.whaleConfirmEnabled && sellPos) {
          const exitCheck = await checkExitSignal(sellPos.mint, config);
          if (exitCheck.shouldExit) {
            logger.info({
              mint: sellPos.mint,
              symbol: rotationResult.decision.sellSymbol,
              netflowUsd: exitCheck.netflowUsd,
              reason: exitCheck.reason,
            }, "Whale exit signal detected - reinforcing rotation decision");
          }
        }
        
        const rotReasonCode = rotationResult.decision.reasonCode;
        const isRotationProtective = isProtectiveExit(rotReasonCode);
        
        // Protective exits (break_even_lock_exit, stale_timeout_exit) bypass minTradeUsd
        const rotPassesMinTrade = sellPos && (sellPos.valueUsd >= config.minTradeUsd || isRotationProtective);
        
        if (sellPos && sellPos.valueUsd < config.minTradeUsd && isRotationProtective) {
          logger.warn({ 
            mint: sellPos.mint, 
            symbol: rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6), 
            reasonCode: rotReasonCode,
            positionUsd: sellPos.valueUsd,
            minTradeUsd: config.minTradeUsd
          }, "PROTECTIVE_EXIT_BYPASS_MIN_TRADE");
        }
        
        if (rotPassesMinTrade) {
          const reasonCode = rotReasonCode;
          const decimals = prices[sellPos.mint]?.decimals ?? 9;
          const baseUnits = uiToBaseUnits(sellPos.amount, decimals);

          // Set liquidating state for protective exits before selling
          if (isRotationProtective) {
            await setLiquidatingState(sellPos.mint, reasonCode);
          }

          // Get peak metrics from position_tracking before selling
          const rotTrackingData = await getPositionTracking(sellPos.mint);
          const rotPeakPnlPct = rotTrackingData?.peak_pnl_pct ?? null;
          const rotPeakPnlUsd = rotTrackingData && rotTrackingData.entry_price > 0
            ? ((rotTrackingData.peak_price - rotTrackingData.entry_price) / rotTrackingData.entry_price) * sellPos.valueUsd
            : null;

          logger.info({
            sellMint: rotationResult.decision.sellMint,
            sellSymbol: rotationResult.decision.sellSymbol,
            sellRank: rotationResult.decision.sellRank,
            buyMint: rotationResult.decision.buyMint,
            buySymbol: rotationResult.decision.buySymbol,
            buyRank: rotationResult.decision.buyRank,
            rankDelta: rotationResult.decision.rankDelta,
            reasonCode,
          }, `Rotation triggered: ${reasonCode}`);

          const sellRes = await executeSwap({
            strategy: reasonCode,
            inputMint: sellPos.mint,
            outputMint: MINT_SOL,
            inAmountBaseUnits: baseUnits,
            slippageBps: config.maxSlippageBps,
            meta: { 
              rotation: true, 
              reasonCode,
              sellRank: rotationResult.decision.sellRank,
              buyMint: rotationResult.decision.buyMint,
            },
          }, signer, execMode);

          if (sellRes.status === "insufficient_funds" || sellRes.status === "simulation_failed" || sellRes.status === "error") {
            logger.warn({ error: sellRes.error, preflight: sellRes.preflightDetails }, "Rotation sell swap failed - skipping");
            // Log exit decision with suppression reason for trailing stop / stale / rotation exits
            const rotExitReason: ExitDecisionReason = reasonCode.includes('trailing_stop') ? 'trailing_stop'
              : reasonCode.includes('stale') ? 'stale_exit'
              : 'rotation_exit';
            const rotPnlPct = rotTrackingData && rotTrackingData.entry_price > 0 && sellPos.priceUsd > 0
              ? (sellPos.priceUsd - rotTrackingData.entry_price) / rotTrackingData.entry_price
              : 0;
            logExitDecision({
              mint: sellPos.mint,
              symbol: rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6),
              reason: rotExitReason,
              entry_price: rotTrackingData?.entry_price ?? 0,
              current_price: sellPos.priceUsd,
              pnl_pct: rotPnlPct,
              peak_price: rotTrackingData?.peak_price ?? null,
              peak_pnl_pct: rotPeakPnlPct,
              threshold: rotExitReason === 'trailing_stop' ? config.trailingStopBasePct
                : rotExitReason === 'stale_exit' ? config.stalePositionHours
                : 0,
              condition_met: true,
              executed: false,
              suppression_reason: sellRes.error ?? 'execution_error',
              slot_type: rotTrackingData?.slot_type ?? 'scout',
            });
          } else {
            // Log successful rotation/trailing stop/stale exit decision
            const rotExitReason: ExitDecisionReason = reasonCode.includes('trailing_stop') ? 'trailing_stop'
              : reasonCode.includes('stale') ? 'stale_exit'
              : 'rotation_exit';
            const rotPnlPct = rotTrackingData && rotTrackingData.entry_price > 0 && sellPos.priceUsd > 0
              ? (sellPos.priceUsd - rotTrackingData.entry_price) / rotTrackingData.entry_price
              : 0;
            logExitDecision({
              mint: sellPos.mint,
              symbol: rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6),
              reason: rotExitReason,
              entry_price: rotTrackingData?.entry_price ?? 0,
              current_price: sellPos.priceUsd,
              pnl_pct: rotPnlPct,
              peak_price: rotTrackingData?.peak_price ?? null,
              peak_pnl_pct: rotPeakPnlPct,
              threshold: rotExitReason === 'trailing_stop' ? config.trailingStopBasePct
                : rotExitReason === 'stale_exit' ? config.stalePositionHours
                : 0,
              condition_met: true,
              executed: sellRes.status === 'sent' || sellRes.status === 'paper',
              suppression_reason: null,
              slot_type: rotTrackingData?.slot_type ?? 'scout',
            });

            state.lastTradeAt[sellPos.mint] = Date.now();
            if (execMode === "live") {
              addTurnover(state.circuit!, sellPos.valueUsd);
            }

            // CRITICAL: Wrap post-swap processing in try/catch to ensure trade is ALWAYS logged
            const entry = entryPrices.get(sellPos.mint);
            let costBasis = 0;
            let solReceived = 0;
            let proceedsUsd = 0;
            let realizedPnl = 0;
            
            try {
              costBasis = entry ? entry.avgCostUsd * sellPos.amount : 0;
              const solReceivedLamports = BigInt(sellRes.quote?.outAmount ?? "0");
              solReceived = Number(solReceivedLamports) / 1e9;
              proceedsUsd = solReceived * solUsd;
              realizedPnl = entry ? proceedsUsd - costBasis : 0;
            } catch (calcErr) {
              logger.error({ mint: sellPos.mint, error: String(calcErr) }, "ROTATION: Failed to calculate trade details");
            }

            const rotationSellAnalytics = buildTradeAnalytics({
              reason: TRADE_REASONS.SELL_ROTATION,
              quote: sellRes.quote,
              riskProfile: config.riskProfile,
            });

            try {
              await insertTrade({
                strategy: reasonCode,
                risk_profile: config.riskProfile,
                mode: execMode,
                input_mint: sellPos.mint,
                output_mint: MINT_SOL,
                in_amount: baseUnits,
                out_amount: sellRes.quote?.outAmount ?? null,
                est_out_amount: sellRes.quote?.outAmount ?? null,
                price_impact_pct: sellRes.quote?.priceImpactPct ?? null,
                slippage_bps: sellRes.quote?.slippageBps ?? null,
                tx_sig: sellRes.txSig,
                status: sellRes.status,
                meta: { ...(sellRes.quote ?? {}), rotation: true, reasonCode, sellRank: rotationResult.decision.sellRank, tradeValueUsd: sellPos.valueUsd },
                pnl_usd: realizedPnl,
                reason_code: rotationSellAnalytics.reason_code,
                fees_lamports: rotationSellAnalytics.fees_lamports,
                priority_fee_lamports: rotationSellAnalytics.priority_fee_lamports,
                route: rotationSellAnalytics.route,
                settings_snapshot: rotationSellAnalytics.settings_snapshot,
                peak_pnl_pct: rotPeakPnlPct,
                peak_pnl_usd: rotPeakPnlUsd,
              });
            } catch (insertErr) {
              logger.error({ mint: sellPos.mint, txSig: sellRes.txSig, error: String(insertErr) }, "ROTATION: CRITICAL - Failed to insert trade to bot_trades!");
            }
            lastTradeTimestamp = Date.now();

            // CRITICAL: Log rotation decision IMMEDIATELY after trade insertion
            // This ensures rotation activity is always logged even if subsequent logging fails
            try {
              await logRotationDecision(rotationResult.decision, { execMode, realizedPnl });
            } catch (logErr) {
              logger.warn({ error: String(logErr) }, "ROTATION: Failed to log rotation decision");
            }

            // Record sell with FIFO for realized PnL tracking (works in both live and paper mode)
            if (sellRes.status === 'sent' || sellRes.status === 'paper') {
              try {
                const rotationSymbol = rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6);
                const txSigForFifo = sellRes.txSig ?? `paper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                const fifoResult = await processSellWithFIFO(
                  txSigForFifo,
                  sellPos.mint,
                  rotationSymbol,
                  sellPos.amount,
                  proceedsUsd,
                  new Date(),
                  solUsd
                );
                logger.info({ mint: sellPos.mint, symbol: rotationSymbol, proceedsUsd: proceedsUsd.toFixed(2), mode: sellRes.status }, "ROTATION: FIFO sell recorded for PnL");
                
                // Sync bot_trades.pnl_usd with FIFO result if different
                if (sellRes.txSig && fifoResult.realizedPnl !== realizedPnl) {
                  await updateTradePnl(sellRes.txSig, fifoResult.realizedPnl, rotPeakPnlPct ?? undefined, rotPeakPnlUsd ?? undefined);
                }
                
                // Invariant check: validate bot_trades.pnl_usd matches FIFO pnl_events
                if (sellRes.txSig) {
                  const validation = await validateTradePnlConsistency(sellRes.txSig, fifoResult.realizedPnl);
                  if (!validation.consistent) {
                    logger.error({
                      mint: sellPos.mint, txSig: sellRes.txSig, botTradesPnl: validation.botTradesPnl,
                      fifoPnl: validation.fifoPnl, discrepancy: validation.discrepancy
                    }, "PNL_INVARIANT_VIOLATION: bot_trades.pnl_usd does not match pnl_events");
                  }
                }
              } catch (fifoErr) {
                logger.error({ mint: sellPos.mint, txSig: sellRes.txSig, error: String(fifoErr) }, "ROTATION: Failed to record FIFO sell");
              }
            }

            if (sellRes.status === 'sent' || sellRes.status === 'paper') {
              try {
                const rotSymbol = rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6);
                const decisionId = await logDecision({
                  mint: sellPos.mint,
                  symbol: rotSymbol,
                  actionType: 'exit',
                  reasonCode: 'rotation_exit',
                  reasonDetail: `Rotation: rank ${rotationResult.decision.sellRank} -> buy ${rotationResult.decision.buySymbol ?? 'unknown'}`,
                  triggeredBy: 'rotation',
                  txSig: sellRes.txSig ?? undefined,
                  qtyBefore: sellPos.amount,
                  qtyAfter: 0,
                  qtyDelta: -sellPos.amount,
                  usdValueBefore: sellPos.valueUsd,
                  usdValueAfter: 0,
                  confidenceScore: undefined,
                  journeyId: getJourneyId(sellPos.mint),
                });
                if (sellRes.txSig && decisionId) {
                  await updateTradeLotDecisionId(sellRes.txSig, decisionId);
                }
              } catch (logErr) {
                logger.error({ mint: sellPos.mint, error: String(logErr) }, "ROTATION: Failed to log position decision");
              }
            }

            const rotHoldingMinutes = 0;
            const rotExecutionPrice = solReceived > 0 && sellPos.amount > 0 ? (solReceived * solUsd) / sellPos.amount : sellPos.priceUsd;
            const rotSlippageBps = sellPos.priceUsd > 0 ? Math.abs(((rotExecutionPrice - sellPos.priceUsd) / sellPos.priceUsd) * 10000) : 0;
            const rotGain = entry && entry.avgCostUsd > 0 ? (rotExecutionPrice - entry.avgCostUsd) / entry.avgCostUsd : 0;
            
            logTradeExit({
              mint: sellPos.mint,
              symbol: rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6),
              decision_price_usd: sellPos.priceUsd,
              execution_price_usd: rotExecutionPrice,
              realized_pnl_usd: realizedPnl,
              realized_pnl_pct: rotGain,
              holding_minutes: rotHoldingMinutes,
              trigger_reason: 'rotation',
              slippage_bps: rotSlippageBps,
              signal_snapshot: null,
              mode: execMode,
            });
            clearJourneyId(sellPos.mint);

            if (sellRes.status === 'sent' || sellRes.status === 'paper') {
              await enforceExitInvariant({
                mint: sellPos.mint,
                symbol: rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6),
                exitReasonCode: 'rotation_exit',
                lastTradeTxSig: sellRes.txSig ?? undefined,
                currentPriceUsd: sellPos.priceUsd,
                solPriceUsd: solUsd,
              }, signer, execMode).catch(e => logger.error({ mint: sellPos.mint, error: String(e) }, "EXIT_INVARIANT: Failed to enforce cleanup"));
            }

            entryPrices.delete(sellPos.mint);
            tradesExecuted++;

            // Log SELL_BYPASS_PAUSE when executing rotation/trailing_stop sell during pause
            if (isPaused) {
              const rotSellReasonCode = rotationResult.decision.reasonCode;
              logger.info({ 
                reasonCode: rotSellReasonCode, 
                mint: sellPos.mint, 
                symbol: rotationResult.decision.sellSymbol ?? sellPos.mint.slice(0, 6), 
                paused: true 
              }, "SELL_BYPASS_PAUSE");
            }

            // Rotation BUY is blocked when paused - only protective SELLS are allowed
            if (isPaused) {
              logger.info({ 
                buyMint: rotationResult.decision.buyMint, 
                buySymbol: rotationResult.decision.buySymbol,
              }, "ROTATION_BUY: Blocked - paused");
            } else if (rotationResult.decision.buyMint && tradesExecuted < 3) {
              const buyMint = rotationResult.decision.buyMint;
              const buySymbol = rotationResult.decision.buySymbol ?? buyMint.slice(0, 6);
              
              const stuckCheck = checkStuckTarget(buyMint, config);
              if (stuckCheck.blocked) {
                logger.info({
                  mint: buyMint,
                  symbol: buySymbol,
                  reason: stuckCheck.reason,
                  backoffMinutesRemaining: stuckCheck.backoffMinutesRemaining,
                }, "ROTATION_BUY: Skipped - stuck target in backoff");
                
                // Update gap diagnostic if exists, and record allocation event for stuck backoff
                const gapEntry = allocationGapDiagnostics.find(g => g.mint === buyMint);
                if (gapEntry) {
                  gapEntry.executionOutcome = "SKIPPED";
                  gapEntry.executionReason = stuckCheck.reason ?? "STUCK_BACKOFF";
                }
                await recordAllocationEvent({
                  symbol: buySymbol,
                  mint: buyMint,
                  side: "buy",
                  rawTargetPct: gapEntry?.rawTargetPct,
                  scaledTargetPct: gapEntry?.targetPct,
                  currentPct: gapEntry?.currentPct,
                  desiredUsd: gapEntry?.desiredAddUsd,
                  plannedUsd: gapEntry?.plannedAddUsd,
                  executedUsd: 0,
                  outcome: "SKIPPED",
                  reason: stuckCheck.reason ?? "STUCK_BACKOFF",
                  txSig: undefined,
                  feeMaxLamports: undefined,
                  feePaidLamports: undefined,
                  bindingConstraint: "STUCK_BACKOFF",
                });
              } else {
              const slotCounts = await getSlotCounts();
              const rawTargetPct = slotCounts.scout < config.scoutSlots 
                ? config.scoutPositionPct 
                : config.corePositionPctTarget;
              
              const rotationTicksObserved = tickCountsByMint.get(buyMint) ?? 0;
              const rotationRampResult = computeEffectiveTargetPct({
                rawTargetPct,
                ticksObserved: rotationTicksObserved,
                settings: rampSettings,
                mint: buyMint,
                symbol: buySymbol,
              });
              const targetPct = rotationRampResult.effectiveTargetPct;
              
              const buyUsd = Math.min(
                targetPct * snap.totalUsd,
                config.maxSingleSwapSol * solUsd
              );

              if (buyUsd >= config.minTradeUsd) {
                const solSpend = buyUsd / Math.max(1e-9, solUsd);
                const cappedSolSpend = capBuyToReserve(solSpend, allBalances.sol, config.minSolReserve, config.txFeeBufferSol);
                
                if (cappedSolSpend < config.minTradeUsd / solUsd) {
                  logger.info({ solSpend, cappedSolSpend, availableSol: allBalances.sol, minReserve: config.minSolReserve }, 
                    "Skipping rotation buy - would deplete SOL below reserve");
                } else {
                  const lamports = solToLamports(cappedSolSpend);
                  const cappedBuyUsd = cappedSolSpend * solUsd;

                  const buyRes = await executeSwap({
                    strategy: 'opportunity_cost_rotation',
                    inputMint: MINT_SOL,
                    outputMint: buyMint,
                    inAmountBaseUnits: lamports,
                    slippageBps: config.maxSlippageBps,
                    meta: { 
                      rotation: true, 
                      reasonCode: 'rotation_buy',
                      buyRank: rotationResult.decision.buyRank,
                      rankDelta: rotationResult.decision.rankDelta,
                    },
                  }, signer, execMode);

                  if (buyRes.status === "insufficient_funds" || buyRes.status === "simulation_failed" || buyRes.status === "error") {
                    logger.warn({ error: buyRes.error, preflight: buyRes.preflightDetails }, "Rotation buy swap failed - skipping");
                    recordExecutionOutcome(buyMint, "FAILED", config);
                  } else {
                    recordExecutionOutcome(buyMint, buyRes.status === "sent" ? "SUBMITTED" : "CONFIRMED", config);
                    state.lastTradeAt[buyMint] = Date.now();
                    if (execMode === "live") {
                      addTurnover(state.circuit!, cappedBuyUsd);
                    }

                    const rotationBuyAnalytics = buildTradeAnalytics({
                      reason: TRADE_REASONS.BUY_ROTATION,
                      quote: buyRes.quote,
                      riskProfile: config.riskProfile,
                    });

                    await insertTrade({
                      strategy: 'opportunity_cost_rotation',
                      risk_profile: config.riskProfile,
                      mode: execMode,
                      input_mint: MINT_SOL,
                      output_mint: buyMint,
                      in_amount: lamports,
                      out_amount: null,
                      est_out_amount: buyRes.quote!.outAmount,
                      price_impact_pct: buyRes.quote!.priceImpactPct,
                      slippage_bps: buyRes.quote!.slippageBps,
                      tx_sig: buyRes.txSig,
                      status: buyRes.status,
                      meta: { ...buyRes.quote!, rotation: true, buyRank: rotationResult.decision.buyRank, tradeValueUsd: cappedBuyUsd },
                      pnl_usd: 0,
                      reason_code: rotationBuyAnalytics.reason_code,
                      entry_score: rotationBuyAnalytics.entry_score,
                      fees_lamports: rotationBuyAnalytics.fees_lamports,
                      priority_fee_lamports: rotationBuyAnalytics.priority_fee_lamports,
                      route: rotationBuyAnalytics.route,
                      settings_snapshot: rotationBuyAnalytics.settings_snapshot,
                    });
                    lastTradeTimestamp = Date.now();

                    // Use authoritative decimals from chain
                    const fallbackDecimals = prices[buyMint]?.decimals ?? 6;
                    let tokenDecimals = fallbackDecimals;
                    try {
                      tokenDecimals = await getAuthoritativeDecimals(buyMint);
                    } catch (e) {
                      logger.warn({ mint: buyMint, fallbackDecimals, error: String(e) }, "Failed to get authoritative decimals, using fallback");
                    }
                    
                    const tokensReceivedRaw = BigInt(buyRes.quote!.outAmount);
                    const tokensReceived = Number(tokensReceivedRaw) / Math.pow(10, tokenDecimals);
                    
                    if (tokensReceived > 0) {
                      // Use actual executed values from quote for accurate cost basis
                      const actualSolSpent = Number(BigInt(buyRes.quote!.inAmount)) / 1e9;
                      const actualUsdSpent = actualSolSpent * solUsd;
                      const effectivePrice = actualUsdSpent / tokensReceived;
                      
                      logger.debug({
                        mint: buyMint,
                        symbol: buySymbol,
                        tokenDecimals,
                        fallbackDecimals,
                        tokensReceived,
                        actualUsdSpent,
                        effectivePrice,
                      }, "ROTATION_BUY: Cost basis calculated with authoritative decimals");
                      
                      const existingRotation = entryPrices.get(buyMint);
                      if (existingRotation && existingRotation.totalTokens > 0) {
                        const totalCost = existingRotation.avgCostUsd * existingRotation.totalTokens + effectivePrice * tokensReceived;
                        const totalTokens = existingRotation.totalTokens + tokensReceived;
                        entryPrices.set(buyMint, { avgCostUsd: totalCost / totalTokens, totalTokens });
                        logger.debug({ mint: buyMint, avgCostUsd: totalCost / totalTokens, totalTokens }, "ROTATION_BUY: Updated weighted average cost basis");
                      } else {
                        entryPrices.set(buyMint, { avgCostUsd: effectivePrice, totalTokens: tokensReceived });
                      }
                      
                      // Record buy lot for FIFO PnL tracking with actual execution data
                      await insertTradeLot({
                        tx_sig: buyRes.txSig || `BUY_${buyMint.slice(0, 8)}_${Date.now()}`,
                        timestamp: new Date(),
                        mint: buyMint,
                        side: 'buy',
                        quantity: tokensReceived,
                        usd_value: actualUsdSpent,
                        unit_price_usd: effectivePrice,
                        sol_price_usd: solUsd,
                        source: 'opportunity_cost_rotation',
                        status: buyRes.status === 'sent' ? 'confirmed' : buyRes.status,
                      });
                      
                      try {
                        const existingRotation = entryPrices.get(buyMint);
                        const isNewPosition = !existingRotation || existingRotation.totalTokens <= 0;
                        const priorUsdValue = (existingRotation?.totalTokens ?? 0) * (existingRotation?.avgCostUsd ?? 0);
                        const decisionId = await logDecision({
                          mint: buyMint,
                          symbol: buySymbol,
                          actionType: isNewPosition ? 'enter' : 'add',
                          reasonCode: 'rotation_buy',
                          reasonDetail: isNewPosition ? 'Rotation buy of new position' : 'Rotation add to existing position',
                          triggeredBy: 'rotation',
                          txSig: buyRes.txSig ?? undefined,
                          qtyBefore: existingRotation?.totalTokens ?? 0,
                          qtyAfter: (existingRotation?.totalTokens ?? 0) + tokensReceived,
                          qtyDelta: tokensReceived,
                          usdValueBefore: priorUsdValue,
                          usdValueAfter: priorUsdValue + actualUsdSpent,
                          journeyId: getJourneyId(buyMint),
                        });
                        if (buyRes.txSig && decisionId) {
                          await updateTradeLotDecisionId(buyRes.txSig, decisionId);
                        }
                      } catch (logErr) {
                        logger.error({ mint: buyMint, error: String(logErr) }, "Failed to log rotation buy decision");
                      }
                    }

                    tradesExecuted++;
                  }
                }
              }
            }
            }
          }
        }
      }

      logger.debug({ summary: getRotationSummary(rotationResult) }, "Rotation evaluation complete");
    } catch (err) {
      logger.warn({ err }, "Rotation evaluation failed");
    }
  }

  const runningState: RunningPortfolioState = {
    positions: new Map(),
    totalEquityUsd: snap.totalUsd,
    positionCount,
  };
  for (const p of positionsForDashboard) {
    runningState.positions.set(p.mint, { mint: p.mint, usdValue: p.valueUsd });
  }

  // Re-entry logic: buy back tokens that continue showing strong momentum after take-profit
  // BLOCKED when paused (BUY operation)
  if (!isPaused && !lowSolMode && tradesExecuted < 3 && reentryTracking.size > 0) {
    const nowMs = Date.now();
    const expiredMints: string[] = [];
    
    // Get re-entry config values
    const reentryCooldownMs = config.reentryCooldownMinutes * 60 * 1000;
    const reentryWindowMs = config.reentryWindowMinutes * 60 * 1000;
    const reentryMinMomentumScore = config.reentryMinMomentumScore;
    
    for (const [mint, candidate] of reentryTracking) {
      const timeSinceSell = nowMs - candidate.sellTimestamp;
      
      // LIQUIDATION_LOCK: Block re-entry for mints in liquidation
      const isLiquidating = await isLiquidatingMint(mint);
      if (isLiquidating) {
        logger.info({
          mint,
          symbol: candidate.symbol,
          reason: 'liquidation_lock',
        }, "BUY_SKIPPED_LIQUIDATING: Blocked re-entry buy for liquidating mint");
        continue;
      }
      
      // Check if re-entry is enabled
      if (!config.reentryEnabled) {
        logger.debug("Re-entry disabled by config");
        continue;
      }
      
      // Remove expired candidates
      if (timeSinceSell > reentryWindowMs) {
        expiredMints.push(mint);
        continue;
      }
      
      // Skip if still in cooldown
      if (timeSinceSell < reentryCooldownMs) {
        continue;
      }
      
      // Check if we already have a position
      const existingPosition = positionsForDashboard.find(p => p.mint === mint);
      if (existingPosition && existingPosition.valueUsd > 1) {
        expiredMints.push(mint);
        continue;
      }
      
      // Get current price and signal
      const priceData = prices[mint];
      if (!priceData || priceData.usdPrice <= 0) continue;
      
      const currentPrice = priceData.usdPrice;
      
      // Find signal for this token
      const tokenSignal = signalsForDashboard.find(s => s.mint === mint);
      
      // Log re-entry evaluation
      logger.debug({
        symbol: candidate.symbol,
        timeSinceExit: timeSinceSell,
        cooldownMs: reentryCooldownMs,
        windowMs: reentryWindowMs,
        momentumScore: tokenSignal?.score ?? 0,
        minMomentumScore: reentryMinMomentumScore,
        reentryEnabled: config.reentryEnabled,
      }, "Evaluating re-entry");
      
      // Price must be at or above sell price (still going up)
      if (currentPrice < candidate.sellPrice * 0.98) {
        logger.debug({ mint, currentPrice, sellPrice: candidate.sellPrice }, "Skipping re-entry - price dropped below sell price");
        continue;
      }
      
      if (!tokenSignal) continue;
      
      // Must be in trend regime with strong positive momentum
      if (tokenSignal.regime !== "trend" || tokenSignal.score < reentryMinMomentumScore) {
        logger.debug({ 
          mint, 
          regime: tokenSignal.regime, 
          score: tokenSignal.score,
          minScore: reentryMinMomentumScore 
        }, "Skipping re-entry - momentum not strong enough");
        continue;
      }
      
      // Calculate re-entry size first using config values
      const reentryUsd = Math.min(
        config.minTradeUsd * config.reentrySizeMultiplier,
        config.maxSingleSwapSol * solUsd * config.reentryMaxSolPct
      );
      
      if (reentryUsd < config.minTradeUsd) continue;
      
      // Check position limits before re-entry with actual trade amount
      const projected = projectPostTradeMetrics(runningState, mint, reentryUsd);
      if (projected.projectedPositionCount > config.maxPositions) {
        continue;
      }
      if (projected.projectedTop3Pct > config.maxTop3ConcentrationPct) {
        continue;
      }
      
      const solSpend = reentryUsd / Math.max(1e-9, solUsd);
      const cappedSolSpend = capBuyToReserve(solSpend, allBalances.sol, config.minSolReserve, config.txFeeBufferSol);
      
      if (cappedSolSpend < config.minTradeUsd / solUsd) {
        logger.info({ solSpend, cappedSolSpend, availableSol: allBalances.sol, minReserve: config.minSolReserve }, 
          "Skipping re-entry buy - would deplete SOL below reserve");
        continue;
      }
      
      const lamports = solToLamports(cappedSolSpend);
      const cappedReentryUsd = cappedSolSpend * solUsd;
      
      logger.info({
        mint,
        symbol: candidate.symbol,
        sellPrice: candidate.sellPrice,
        currentPrice,
        priceGainSinceSell: ((currentPrice / candidate.sellPrice - 1) * 100).toFixed(2) + "%",
        score: tokenSignal.score,
        regime: tokenSignal.regime,
        reentryUsd: cappedReentryUsd.toFixed(2),
      }, `Re-entry triggered: ${candidate.symbol} still tearing after take-profit`);
      
      const res = await executeSwap({
        strategy: "reentry_momentum",
        inputMint: MINT_SOL,
        outputMint: mint,
        inAmountBaseUnits: lamports,
        slippageBps: config.maxSlippageBps,
        meta: { 
          reentry: true, 
          sellPrice: candidate.sellPrice, 
          currentPrice,
          score: tokenSignal.score,
          regime: tokenSignal.regime,
        },
      }, signer, execMode);

      if (res.status === "insufficient_funds" || res.status === "simulation_failed" || res.status === "error") {
        logger.warn({ error: res.error, preflight: res.preflightDetails }, "Re-entry momentum swap failed - skipping");
        continue;
      }
      
      state.lastTradeAt[mint] = nowMs;
      if (execMode === "live") {
        addTurnover(state.circuit!, cappedReentryUsd);
      }
      
      const reentryAnalytics = buildTradeAnalytics({
        reason: TRADE_REASONS.BUY_REENTRY,
        quote: res.quote,
        riskProfile: config.riskProfile,
        entryScore: tokenSignal.score,
      });

      await insertTrade({
        strategy: "reentry_momentum",
        risk_profile: config.riskProfile,
        mode: execMode,
        input_mint: MINT_SOL,
        output_mint: mint,
        in_amount: lamports,
        out_amount: null,
        est_out_amount: res.quote!.outAmount,
        price_impact_pct: res.quote!.priceImpactPct,
        slippage_bps: res.quote!.slippageBps,
        tx_sig: res.txSig,
        status: res.status,
        meta: { ...res.quote!, reentry: true, sellPrice: candidate.sellPrice, tradeValueUsd: cappedReentryUsd },
        pnl_usd: 0,
        reason_code: reentryAnalytics.reason_code,
        entry_score: reentryAnalytics.entry_score,
        fees_lamports: reentryAnalytics.fees_lamports,
        priority_fee_lamports: reentryAnalytics.priority_fee_lamports,
        route: reentryAnalytics.route,
        settings_snapshot: reentryAnalytics.settings_snapshot,
      });
      lastTradeTimestamp = Date.now();
      
      // Track new entry price - use authoritative decimals from chain
      const fallbackDecimals = prices[mint]?.decimals ?? 6;
      let tokenDecimals = fallbackDecimals;
      try {
        tokenDecimals = await getAuthoritativeDecimals(mint);
      } catch (e) {
        logger.warn({ mint, fallbackDecimals, error: String(e) }, "Failed to get authoritative decimals, using fallback");
      }
      
      const tokensReceivedRaw = BigInt(res.quote!.outAmount);
      const tokensReceived = Number(tokensReceivedRaw) / Math.pow(10, tokenDecimals);
      if (tokensReceived > 0) {
        // CRITICAL: Close all existing position lots BEFORE creating new ones
        // This prevents FIFO quarantine from seeing stale lots after re-entry
        // SAFETY: Re-entry only triggers when existingPosition.valueUsd < $1 (line 1535)
        // so we know this is a true full exit scenario - closing lots is safe
        const existingEntry = entryPrices.get(mint);
        if (existingEntry) {
          logger.info({ 
            mint, 
            symbol: candidate.symbol,
            oldAvgCost: existingEntry.avgCostUsd,
            oldTotalTokens: existingEntry.totalTokens,
          }, "REENTRY_BUY: Clearing stale entry data before fresh position");
        }
        await closeAllPositionLots(mint);
        
        // Clear in-memory entry prices for fresh start
        entryPrices.delete(mint);
        
        // Use actual executed values from quote for accurate cost basis
        const actualSolSpent = Number(BigInt(res.quote!.inAmount)) / 1e9;
        const actualUsdSpent = actualSolSpent * solUsd;
        const effectivePrice = actualUsdSpent / tokensReceived;
        
        logger.debug({
          mint,
          symbol: candidate.symbol,
          tokenDecimals,
          fallbackDecimals,
          tokensReceived,
          actualUsdSpent,
          effectivePrice,
        }, "REENTRY_BUY: Cost basis calculated with authoritative decimals");
        
        // SAFETY: Seed prices[mint] immediately after buy so next tick has valid price data
        if (!prices[mint] || prices[mint].usdPrice <= 0) {
          prices[mint] = { usdPrice: effectivePrice, decimals: tokenDecimals, blockId: null };
          logger.info({ mint, seededPrice: effectivePrice, decimals: tokenDecimals }, "Seeded price data for re-entry buy");
        }
        
        // Fresh start with new cost basis - no weighted average with old position
        entryPrices.set(mint, { avgCostUsd: effectivePrice, totalTokens: tokensReceived });
        logger.info({ mint, avgCostUsd: effectivePrice, totalTokens: tokensReceived }, "REENTRY_BUY: Fresh cost basis set (old lots closed)");
        
        // Record buy lot for FIFO PnL tracking with actual execution data
        await insertTradeLot({
          tx_sig: res.txSig || `BUY_${mint.slice(0, 8)}_${Date.now()}`,
          timestamp: new Date(),
          mint,
          side: 'buy',
          quantity: tokensReceived,
          usd_value: actualUsdSpent,
          unit_price_usd: effectivePrice,
          sol_price_usd: solUsd,
          source: 'reentry_momentum',
          status: res.status === 'sent' ? 'confirmed' : res.status,
        });
        
        try {
          const decisionId = await logDecision({
            mint: mint,
            symbol: candidate.symbol,
            actionType: 'enter',
            reasonCode: 'reentry_buy',
            reasonDetail: 'Re-entry buy after take-profit with continued momentum',
            triggeredBy: 'strategy_engine',
            txSig: res.txSig ?? undefined,
            qtyBefore: 0,
            qtyAfter: tokensReceived,
            qtyDelta: tokensReceived,
            usdValueBefore: 0,
            usdValueAfter: actualUsdSpent,
            confidenceScore: tokenSignal.score,
            journeyId: getJourneyId(mint),
          });
          if (res.txSig && decisionId) {
            await updateTradeLotDecisionId(res.txSig, decisionId);
          }
        } catch (logErr) {
          logger.error({ mint, error: String(logErr) }, "Failed to log reentry buy decision");
        }
      }
      
      updateRunningState(runningState, mint, cappedReentryUsd);
      updateRunningState(runningState, MINT_SOL, -cappedReentryUsd);
      
      // Remove from re-entry tracking after successful re-entry
      expiredMints.push(mint);
      
      tradesExecuted++;
      if (tradesExecuted >= 3) break;
    }
    
    // Clean up expired candidates
    for (const mint of expiredMints) {
      reentryTracking.delete(mint);
    }
  }

  // Build tracking map for slot-based target capping (query once before loop)
  const allTracking = await getAllPositionTracking();
  const trackingMap = new Map<string, PositionTrackingRow>();
  for (const tracking of allTracking) {
    trackingMap.set(tracking.mint, tracking);
  }

  if (lowSolMode) {
    // Skip regime-based trading when SOL is too low
  } else if (isPaused) {
    // Skip regime-based trading when paused - only protective sells allowed
    logger.debug("REGIME_TRADE: Skipped - paused (buys blocked)");
  } else for (const t of targets) {
    const mint = t.mint;
    const nowMs = Date.now();
    const last = state.lastTradeAt[mint] ?? 0;
    if (nowMs - last < cooldownMs) continue;

    const cw = curW[mint] ?? 0;
    const drift = t.targetPct - cw;
    
    updateTargetState(mint, t.targetPct, cw);

    if (Math.abs(drift) < band) continue;

    const isBuyTrade = drift > 0;
    
    // For sells, we need a position to exist
    const v = snap.byMint[mint];
    if (!isBuyTrade && !v) continue;

    const wantUsd = drift * snap.totalUsd;

    if (Math.abs(wantUsd) < config.minTradeUsd) continue;

    const maxUsdBySol = config.maxSingleSwapSol * solUsd;
    const tradeUsd = Math.sign(wantUsd) * Math.min(Math.abs(wantUsd), maxUsdBySol);
    
    // For buys, this will be updated to effectiveTradeUsd after slot-based capping
    let buyTradeUsd = tradeUsd;

    if (isBuyTrade) {
      // LIQUIDATION_LOCK: Block regime buys for mints in liquidation
      const isLiquidating = await isLiquidatingMint(mint);
      if (isLiquidating) {
        const universeToken = universe.find((u) => u.mint === mint);
        logger.info({
          mint,
          symbol: universeToken?.symbol ?? mint.slice(0, 6),
          drift,
          wantUsd,
          reason: 'liquidation_lock',
        }, "BUY_SKIPPED_LIQUIDATING: Blocked regime trend buy for liquidating mint");
        continue;
      }
      
      // Check if we have any position (including dust) - allows maintenance buys
      const existingPosition = snap.byMint[mint];
      const hasPosition = existingPosition && existingPosition.usdValue > 0;
      if (!hasPosition) {
        const universeToken = universe.find((u) => u.mint === mint);
        logger.info({ 
          mint, 
          symbol: universeToken?.symbol ?? mint.slice(0, 6),
          targetPct: t.targetPct,
          drift,
        }, "Skipping regime buy for new token - must enter via scout system");
        continue;
      }

      // Check slot type and cap target for scouts
      const tracking = trackingMap.get(mint);
      const slotType = tracking?.slot_type ?? 'scout';
      const effectiveTargetPct = slotType === 'scout' 
        ? Math.min(t.targetPct, config.scoutPositionPct)
        : t.targetPct;

      // Log when targets are capped
      if (slotType === 'scout' && t.targetPct > config.scoutPositionPct) {
        logger.info({ mint, originalTarget: t.targetPct, cappedTarget: effectiveTargetPct, slotType }, 
          "Capping regime target for scout position");
      }

      // Recalculate drift with capped target
      const effectiveDrift = effectiveTargetPct - cw;
      if (Math.abs(effectiveDrift) < band) {
        logger.debug({ mint, slotType, originalTarget: t.targetPct, cappedTarget: effectiveTargetPct }, 
          "Skipping - effective drift below band after slot-based capping");
        continue;
      }

      // Use effectiveDrift instead of drift for wantUsd calculation
      const effectiveWantUsd = effectiveDrift * snap.totalUsd;
      if (Math.abs(effectiveWantUsd) < config.minTradeUsd) continue;

      const effectiveTradeUsd = Math.sign(effectiveWantUsd) * Math.min(Math.abs(effectiveWantUsd), maxUsdBySol);
      buyTradeUsd = effectiveTradeUsd;

      const projected = projectPostTradeMetrics(runningState, mint, effectiveTradeUsd);

      if (projected.projectedPositionCount > config.maxPositions) {
        logger.info({ 
          mint, 
          currentPositionCount: runningState.positionCount,
          projectedPositionCount: projected.projectedPositionCount, 
          maxPositions: config.maxPositions 
        }, "Skipping buy - projected position count would exceed limit");
        continue;
      }

      if (projected.projectedTop3Pct > config.maxTop3ConcentrationPct) {
        logger.info({ 
          mint, 
          projectedTop3Concentration: projected.projectedTop3Pct,
          maxTop3: config.maxTop3ConcentrationPct 
        }, "Skipping buy - projected top-3 concentration would exceed limit");
        continue;
      }

      if (projected.projectedVolatility > config.maxPortfolioVolatility) {
        logger.info({ 
          mint, 
          projectedVolatility: projected.projectedVolatility, 
          maxVolatility: config.maxPortfolioVolatility 
        }, "Skipping buy - projected portfolio volatility would exceed limit");
        continue;
      }

      // Capital Management: Check liquidity tier requirements for core positions
      // Note: We check liquidity at the scout entry stage; core buys here are maintenance 
      // buys on existing positions that already passed liquidity checks
      if (isCapitalManagementEnabled() && slotType === 'core') {
        syncCapitalConfigFromRuntime();
        // Log that capital management constraints are active for core buys
        logger.debug({
          mint,
          slotType,
          capitalMgmtEnabled: true,
        }, "CAPITAL_MGMT: Core buy using capacity-aware constraints");
      }
    }

    if (buyTradeUsd > 0) {
      const solSpend = buyTradeUsd / Math.max(1e-9, solUsd);
      const cappedSolSpend = capBuyToReserve(solSpend, allBalances.sol, config.minSolReserve, config.txFeeBufferSol);
      
      if (cappedSolSpend < config.minTradeUsd / solUsd) {
        logger.info({ solSpend, cappedSolSpend, availableSol: allBalances.sol, minReserve: config.minSolReserve }, 
          "Skipping regime trend buy - would deplete SOL below reserve");
        continue;
      }
      
      const lamports = solToLamports(cappedSolSpend);
      const cappedTradeUsd = cappedSolSpend * solUsd;

      const res = await executeSwap({
        strategy: "regime_trend_mr",
        inputMint: MINT_SOL,
        outputMint: mint,
        inAmountBaseUnits: lamports,
        slippageBps: config.maxSlippageBps,
        meta: { targetPct: t.targetPct, currentPct: cw, drift },
      }, signer, execMode);

      if (res.status === "insufficient_funds" || res.status === "simulation_failed" || res.status === "error") {
        logger.warn({ error: res.error, preflight: res.preflightDetails }, "Regime trend buy swap failed - skipping");
        
        // Wire execution feedback for failed buy
        const failedGapDiag = allocationGapDiagnostics.find(d => d.mint === mint);
        if (failedGapDiag) {
          const executionResult = buildExecutionResultFromSwap(res, solUsd);
          failedGapDiag.executedAddUsd = 0;
          failedGapDiag.executionOutcome = "FAILED";
          failedGapDiag.executionReason = executionResult.reason ?? res.error ?? null;
          failedGapDiag.txSig = null;
          failedGapDiag.feeGovernor = executionResult.feeDecision ?? null;
          
          await recordAllocationEvent({
            symbol: failedGapDiag.symbol,
            mint,
            side: "buy",
            rawTargetPct: failedGapDiag.rawTargetPct,
            scaledTargetPct: failedGapDiag.targetPct,
            currentPct: failedGapDiag.currentPct,
            desiredUsd: failedGapDiag.desiredAddUsd,
            plannedUsd: failedGapDiag.plannedAddUsd,
            executedUsd: 0,
            outcome: "FAILED",
            reason: executionResult.reason ?? res.error,
            feeMaxLamports: executionResult.feeDecision?.maxLamports,
            bindingConstraint: failedGapDiag.bindingConstraint,
          });
        }
        continue;
      }

      state.lastTradeAt[mint] = nowMs;
      if (execMode === "live") {
        addTurnover(state.circuit!, cappedTradeUsd);
      }

      const regimeBuyAnalytics = buildTradeAnalytics({
        reason: TRADE_REASONS.BUY_REGIME_TREND,
        quote: res.quote,
        riskProfile: config.riskProfile,
      });

      await insertTrade({
        strategy: "regime_trend_mr",
        risk_profile: config.riskProfile,
        mode: execMode,
        input_mint: MINT_SOL,
        output_mint: mint,
        in_amount: lamports,
        out_amount: null,
        est_out_amount: res.quote!.outAmount,
        price_impact_pct: res.quote!.priceImpactPct,
        slippage_bps: res.quote!.slippageBps,
        tx_sig: res.txSig,
        status: res.status,
        meta: { ...res.quote!, tradeValueUsd: cappedTradeUsd },
        pnl_usd: 0,
        reason_code: regimeBuyAnalytics.reason_code,
        entry_score: regimeBuyAnalytics.entry_score,
        fees_lamports: regimeBuyAnalytics.fees_lamports,
        priority_fee_lamports: regimeBuyAnalytics.priority_fee_lamports,
        route: regimeBuyAnalytics.route,
        settings_snapshot: regimeBuyAnalytics.settings_snapshot,
      });
      lastTradeTimestamp = Date.now();

      const universeToken = universe.find((u) => u.mint === mint);
      updateRunningState(runningState, mint, cappedTradeUsd);
      updateRunningState(runningState, MINT_SOL, -cappedTradeUsd);
      logger.debug({ 
        mint, 
        tradeUsd: cappedTradeUsd, 
        newPositionCount: runningState.positionCount,
        totalEquityUsd: runningState.totalEquityUsd
      }, "Updated running portfolio state after buy");

      // Use authoritative decimals from chain to prevent pump.fun/meme token quantity corruption
      const fallbackDecimals = prices[mint]?.decimals ?? 6;
      let tokenDecimals = fallbackDecimals;
      try {
        tokenDecimals = await getAuthoritativeDecimals(mint);
      } catch (e) {
        logger.warn({ mint, fallbackDecimals, error: String(e) }, "Failed to get authoritative decimals, using fallback");
      }
      
      const tokensReceivedRaw = BigInt(res.quote!.outAmount);
      const tokensReceived = Number(tokensReceivedRaw) / Math.pow(10, tokenDecimals);
      
      if (tokensReceived > 0) {
        // Use actual executed values from quote for accurate cost basis
        const actualSolSpent = Number(BigInt(res.quote!.inAmount)) / 1e9;
        const actualUsdSpent = actualSolSpent * solUsd;
        const effectivePrice = actualUsdSpent / tokensReceived;
        
        // Log the final values for debugging
        logger.debug({
          mint,
          symbol: universeToken?.symbol ?? mint.slice(0, 6),
          tokenDecimals,
          fallbackDecimals,
          tokensReceived,
          actualUsdSpent,
          effectivePrice,
        }, "REGIME_BUY: Cost basis calculated with authoritative decimals");
        
        // SAFETY: Seed prices[mint] immediately after buy so next tick has valid price data
        // This prevents stop-loss from triggering on "price = 0" for newly acquired tokens
        if (!prices[mint] || prices[mint].usdPrice <= 0) {
          prices[mint] = { usdPrice: effectivePrice, decimals: tokenDecimals, blockId: null };
          logger.info({ mint, seededPrice: effectivePrice, decimals: tokenDecimals }, "Seeded price data for newly bought token");
        }
        
        const existing = entryPrices.get(mint);
        if (existing && existing.totalTokens > 0) {
          const totalCost = existing.avgCostUsd * existing.totalTokens + effectivePrice * tokensReceived;
          const totalTokens = existing.totalTokens + tokensReceived;
          entryPrices.set(mint, { avgCostUsd: totalCost / totalTokens, totalTokens });
        } else {
          entryPrices.set(mint, { avgCostUsd: effectivePrice, totalTokens: tokensReceived });
        }
        logger.debug({ mint, avgCostUsd: entryPrices.get(mint)?.avgCostUsd, totalTokens: entryPrices.get(mint)?.totalTokens, tokensReceived }, "Updated entry price after buy");
        
        // Clear promotion grace if this was a core allocation buy for a promoted token
        const promoGrace = promotionGraceTracking.get(mint);
        if (promoGrace) {
          const newCostBasis = entryPrices.get(mint)?.avgCostUsd ?? effectivePrice;
          logger.info({ 
            mint, 
            symbol: promoGrace.symbol,
            oldEntryPrice: existing?.avgCostUsd,
            newCostBasis,
            tokensAdded: tokensReceived,
          }, "PROMOTION_GRACE: Core buy executed - cost basis recalculated, grace period ended");
          promotionGraceTracking.delete(mint);
        }
        
        // Record buy lot for FIFO PnL tracking with actual execution data
        await insertTradeLot({
          tx_sig: res.txSig || `BUY_${mint.slice(0, 8)}_${Date.now()}`,
          timestamp: new Date(),
          mint,
          side: 'buy',
          quantity: tokensReceived,
          usd_value: actualUsdSpent,
          unit_price_usd: effectivePrice,
          sol_price_usd: solUsd,
          source: 'regime_trend_mr',
          status: res.status === 'sent' ? 'confirmed' : res.status,
        });
        
        try {
          const existingRegime = entryPrices.get(mint);
          const isNewPosition = !existingRegime || existingRegime.totalTokens <= 0;
          const priorUsdValue = (existingRegime?.totalTokens ?? 0) * (existingRegime?.avgCostUsd ?? 0);
          const decisionId = await logDecision({
            mint: mint,
            symbol: universeToken?.symbol ?? mint.slice(0, 6),
            actionType: isNewPosition ? 'enter' : 'add',
            reasonCode: 'regime_trend_buy',
            reasonDetail: isNewPosition ? 'Regime trend buy - new position' : 'Regime trend buy - adding to position',
            triggeredBy: 'regime_engine',
            txSig: res.txSig ?? undefined,
            qtyBefore: existingRegime?.totalTokens ?? 0,
            qtyAfter: (existingRegime?.totalTokens ?? 0) + tokensReceived,
            qtyDelta: tokensReceived,
            usdValueBefore: priorUsdValue,
            usdValueAfter: priorUsdValue + actualUsdSpent,
            journeyId: getJourneyId(mint),
          });
          if (res.txSig && decisionId) {
            await updateTradeLotDecisionId(res.txSig, decisionId);
          }
        } catch (logErr) {
          logger.error({ mint, error: String(logErr) }, "Failed to log regime buy decision");
        }
      }
      
      // Wire execution feedback: update gap diagnostic and record allocation event
      const gapDiag = allocationGapDiagnostics.find(d => d.mint === mint);
      if (gapDiag) {
        const executionResult = buildExecutionResultFromSwap(res, solUsd);
        gapDiag.executedAddUsd = cappedTradeUsd;
        gapDiag.executionOutcome = executionResult.outcome;
        gapDiag.executionReason = executionResult.reason ?? null;
        gapDiag.txSig = executionResult.txSig ?? null;
        gapDiag.feeGovernor = executionResult.feeDecision ?? null;
        
        await recordAllocationEvent({
          symbol: gapDiag.symbol,
          mint,
          side: "buy",
          rawTargetPct: gapDiag.rawTargetPct,
          scaledTargetPct: gapDiag.targetPct,
          currentPct: gapDiag.currentPct,
          desiredUsd: gapDiag.desiredAddUsd,
          plannedUsd: gapDiag.plannedAddUsd,
          executedUsd: cappedTradeUsd,
          outcome: executionResult.outcome,
          reason: executionResult.reason,
          txSig: executionResult.txSig,
          feeMaxLamports: executionResult.feeDecision?.maxLamports,
          bindingConstraint: gapDiag.bindingConstraint,
        });
      }
      
      tradesExecuted++;
    } else {
      // SAFETY: Skip sell if price data is missing or zero to prevent erroneous sells
      if (!v.usdPrice || v.usdPrice <= 0) {
        logger.warn({ mint }, "Skipping regime sell - no valid price data");
        continue;
      }

      // CRITICAL GUARD: Check if this is a core position before selling
      // If position_tracking says 'core' but slotTypeMap (from candidates) has undefined/missing,
      // we have a data consistency issue - skip sell to protect core positions
      const trackingForSell = trackingMap.get(mint);
      const trackingSlotType = trackingForSell?.slot_type;
      const candidateSlotType = slotTypeMap.get(mint);
      
      // PATH A ENFORCEMENT: Scouts are lifecycle-managed, never sold by allocation/regime targets
      // Scout exits ONLY via: stop-loss, TP, trailing stop, stale, underperform, reentry rules
      if (trackingSlotType === 'scout') {
        // Silently skip - no allocation_events or rotation_log spam for expected behavior
        logger.debug({
          mint,
          slotType: 'scout',
          targetPct: t.targetPct,
          currentPct: cw,
          drift,
        }, "REGIME_SELL_SKIP: Scout positions are lifecycle-managed, not allocation-sold");
        continue;
      }
      
      if (trackingSlotType === 'core' && candidateSlotType === undefined) {
        const universeToken = universe.find((u) => u.mint === mint);
        logger.warn({
          mint,
          symbol: universeToken?.symbol ?? mint.slice(0, 6),
          trackingSlotType,
          candidateSlotType,
          targetPct: t.targetPct,
          currentPct: cw,
          drift,
        }, "REGIME_SELL_BLOCKED: Core position has missing slotType in candidates - data consistency issue, skipping sell");
        continue;
      }
      
      // Also block sells if position is core and target is suspiciously low (< baseline)
      // Core positions should never have target below their baseline allocation
      if (trackingSlotType === 'core' && t.targetPct < config.corePositionPctTarget * 0.5) {
        const universeToken = universe.find((u) => u.mint === mint);
        logger.warn({
          mint,
          symbol: universeToken?.symbol ?? mint.slice(0, 6),
          trackingSlotType,
          targetPct: t.targetPct,
          coreBaseline: config.corePositionPctTarget,
          currentPct: cw,
          drift,
        }, "REGIME_SELL_BLOCKED: Core position target is below baseline - likely scoring issue, skipping sell");
        continue;
      }

      const universeTokenForHysteresis = universe.find((u) => u.mint === mint);
      const symbolForHysteresis = universeTokenForHysteresis?.symbol ?? mint.slice(0, 6);
      const entryTimeForHysteresis = trackingForSell?.entry_time ? new Date(trackingForSell.entry_time).getTime() : null;
      const estimatedProceedsUsd = Math.abs(tradeUsd);
      
      const hysteresisResult = evaluateRebalanceSellGate({
        mint,
        symbol: symbolForHysteresis,
        entryTimeMs: entryTimeForHysteresis,
        targetPct: t.targetPct,
        currentPct: cw,
        proceedsUsd: estimatedProceedsUsd,
        minHoldMinutes: config.rebalanceSellMinHoldMinutes,
        confirmTicks: config.rebalanceSellTargetDropConfirmTicks,
        minTrimUsd: config.rebalanceSellMinTrimUsd,
      });
      
      if (!hysteresisResult.allowed) {
        await recordAllocationEvent({
          symbol: symbolForHysteresis,
          mint,
          side: "sell",
          rawTargetPct: t.targetPct,
          scaledTargetPct: t.targetPct,
          currentPct: cw,
          desiredUsd: estimatedProceedsUsd,
          plannedUsd: estimatedProceedsUsd,
          executedUsd: 0,
          outcome: "SKIPPED",
          reason: hysteresisResult.skipReason ?? undefined,
          txSig: undefined,
          feeMaxLamports: undefined,
          bindingConstraint: hysteresisResult.skipReason ?? undefined,
        });
        
        await insertRotationLog({
          action: 'skipped',
          soldMint: mint,
          soldSymbol: symbolForHysteresis,
          reasonCode: 'regime_trend_sell_gated',
          meta: {
            skipReason: hysteresisResult.skipReason,
            targetPct: t.targetPct,
            currentPct: cw,
            drift,
            ageMinutes: hysteresisResult.ageMinutes,
            confirmTicks: hysteresisResult.confirmTicks,
            proceedsUsd: hysteresisResult.proceedsUsd,
            slotType: trackingSlotType ?? 'unknown',
          },
        }).catch(e => logger.error({ mint, error: String(e) }, "REGIME_SELL: Failed to log skipped rotation"));
        
        continue;
      }

      const tokenSellUi = Math.min(v.amount, Math.abs(tradeUsd) / Math.max(1e-9, v.usdPrice));
      if (tokenSellUi <= 0) continue;

      // SAFETY: Default to 9 decimals (standard for SPL tokens) instead of 0
      const decimals = prices[mint]?.decimals ?? 9;
      const baseUnits = uiToBaseUnits(tokenSellUi, decimals);

      // Get peak metrics from position_tracking before selling
      const regimeTrackingData = await getPositionTracking(mint);
      const regimePeakPnlPct = regimeTrackingData?.peak_pnl_pct ?? null;
      const regimePeakPnlUsd = regimeTrackingData && regimeTrackingData.entry_price > 0
        ? ((regimeTrackingData.peak_price - regimeTrackingData.entry_price) / regimeTrackingData.entry_price) * v.amount * v.usdPrice
        : null;

      const res = await executeSwap({
        strategy: "regime_trend_mr",
        inputMint: mint,
        outputMint: MINT_SOL,
        inAmountBaseUnits: baseUnits,
        slippageBps: config.maxSlippageBps,
        meta: { reasonCode: 'regime_trend_mr', targetPct: t.targetPct, currentPct: cw, drift },
      }, signer, execMode);

      if (res.status === "insufficient_funds" || res.status === "simulation_failed" || res.status === "error") {
        logger.warn({ error: res.error, preflight: res.preflightDetails }, "Regime trend sell swap failed - skipping");
        continue;
      }

      state.lastTradeAt[mint] = nowMs;
      if (execMode === "live") {
        addTurnover(state.circuit!, tradeUsd);
      }

      // CRITICAL: Wrap post-swap processing in try/catch to ensure trade is ALWAYS logged
      let actualSolReceived = 0;
      let actualProceedsUsd = 0;
      
      try {
        actualSolReceived = Number(BigInt(res.quote?.outAmount ?? "0")) / 1e9;
        actualProceedsUsd = actualSolReceived * solUsd;
      } catch (calcErr) {
        logger.error({ mint, error: String(calcErr) }, "REGIME_SELL: Failed to calculate SOL received");
      }

      const regimeSellAnalytics = buildTradeAnalytics({
        reason: TRADE_REASONS.SELL_REGIME_MEAN_REVERT,
        quote: res.quote,
        riskProfile: config.riskProfile,
      });

      try {
        await insertTrade({
          strategy: "regime_trend_mr",
          risk_profile: config.riskProfile,
          mode: execMode,
          input_mint: mint,
          output_mint: MINT_SOL,
          in_amount: baseUnits,
          out_amount: null,
          est_out_amount: res.quote?.outAmount ?? null,
          price_impact_pct: res.quote?.priceImpactPct ?? null,
          slippage_bps: res.quote?.slippageBps ?? null,
          tx_sig: res.txSig,
          status: res.status,
          meta: { 
            ...(res.quote ?? {}), 
            sellProceedsUsd: actualProceedsUsd, 
            tokenAmount: tokenSellUi, 
            tradeValueUsd: actualProceedsUsd,
            targetPct: t.targetPct,
            currentPct: cw,
            drift,
            slotType: trackingSlotType ?? 'unknown',
          },
          pnl_usd: 0,
          reason_code: regimeSellAnalytics.reason_code,
          fees_lamports: regimeSellAnalytics.fees_lamports,
          priority_fee_lamports: regimeSellAnalytics.priority_fee_lamports,
          route: regimeSellAnalytics.route,
          settings_snapshot: regimeSellAnalytics.settings_snapshot,
          peak_pnl_pct: regimePeakPnlPct,
          peak_pnl_usd: regimePeakPnlUsd,
        });
      } catch (insertErr) {
        logger.error({ mint, txSig: res.txSig, error: String(insertErr) }, "REGIME_SELL: CRITICAL - Failed to insert trade to bot_trades!");
      }
      lastTradeTimestamp = Date.now();

      // Record sell with FIFO for realized PnL tracking (works in both live and paper mode)
      if (res.status === 'sent' || res.status === 'paper') {
        try {
          const universeTokenForFifo = universe.find((u) => u.mint === mint);
          const symbolForFifo = universeTokenForFifo?.symbol ?? mint.slice(0, 6);
          const txSigForFifo = res.txSig ?? `paper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const fifoResult = await processSellWithFIFO(
            txSigForFifo,
            mint,
            symbolForFifo,
            tokenSellUi,
            actualProceedsUsd,
            new Date(),
            solUsd
          );
          logger.info({ mint, symbol: symbolForFifo, proceedsUsd: actualProceedsUsd.toFixed(2), mode: res.status }, "REGIME_SELL: FIFO sell recorded for PnL");
          
          // Sync bot_trades.pnl_usd with FIFO result if different
          if (res.txSig && fifoResult.realizedPnl !== 0) {
            await updateTradePnl(res.txSig, fifoResult.realizedPnl, regimePeakPnlPct ?? undefined, regimePeakPnlUsd ?? undefined);
          }
          
          // Invariant check: validate bot_trades.pnl_usd matches FIFO pnl_events
          if (res.txSig) {
            const validation = await validateTradePnlConsistency(res.txSig, fifoResult.realizedPnl);
            if (!validation.consistent) {
              logger.error({
                mint, txSig: res.txSig, botTradesPnl: validation.botTradesPnl,
                fifoPnl: validation.fifoPnl, discrepancy: validation.discrepancy
              }, "PNL_INVARIANT_VIOLATION: bot_trades.pnl_usd does not match pnl_events");
            }
          }
        } catch (fifoErr) {
          logger.error({ mint, txSig: res.txSig, error: String(fifoErr) }, "REGIME_SELL: Failed to record FIFO sell");
        }
      }

      if (res.status === 'sent' || res.status === 'paper') {
        try {
          const regimeSymbol = universe.find((u) => u.mint === mint)?.symbol ?? mint.slice(0, 6);
          const remainingAmount = v.amount - tokenSellUi;
          const remainingValueUsd = remainingAmount * v.usdPrice;
          const isFullExit = remainingValueUsd < config.minTradeUsd;
          const decisionId = await logDecision({
            mint,
            symbol: regimeSymbol,
            actionType: isFullExit ? 'exit' : 'trim',
            reasonCode: 'regime_mean_revert',
            reasonDetail: `Regime sell: target ${(t.targetPct * 100).toFixed(1)}% current ${(cw * 100).toFixed(1)}% drift ${(drift * 100).toFixed(1)}%`,
            triggeredBy: 'strategy_engine',
            txSig: res.txSig ?? undefined,
            qtyBefore: v.amount,
            qtyAfter: remainingAmount,
            qtyDelta: -tokenSellUi,
            usdValueBefore: v.amount * v.usdPrice,
            usdValueAfter: remainingValueUsd,
            confidenceScore: t.score,
            signalSnapshot: {
              score: t.score,
              regime: t.regime,
              targetPct: t.targetPct,
            },
            journeyId: getJourneyId(mint),
          });
          if (res.txSig && decisionId) {
            await updateTradeLotDecisionId(res.txSig, decisionId);
          }
        } catch (logErr) {
          logger.error({ mint, error: String(logErr) }, "REGIME_SELL: Failed to log position decision");
        }
        
        try {
          const regimeSymbolForRotLog = universe.find((u) => u.mint === mint)?.symbol ?? mint.slice(0, 6);
          const remainingAmountForRotLog = v.amount - tokenSellUi;
          const remainingValueUsdForRotLog = remainingAmountForRotLog * v.usdPrice;
          const isFullExitForRotLog = remainingValueUsdForRotLog < config.minTradeUsd;
          
          await insertRotationLog({
            action: isFullExitForRotLog ? 'exit' : 'trim',
            soldMint: mint,
            soldSymbol: regimeSymbolForRotLog,
            reasonCode: 'regime_trend_sell',
            meta: {
              txSig: res.txSig,
              targetPct: t.targetPct,
              currentPct: cw,
              drift,
              proceedsUsd: actualProceedsUsd,
              soldAmount: tokenSellUi,
              remainingAmount: remainingAmountForRotLog,
              exitType: isFullExitForRotLog ? 'full_exit' : 'partial_trim',
              slotType: trackingSlotType ?? 'unknown',
            },
          });
        } catch (rotLogErr) {
          logger.error({ mint, error: String(rotLogErr) }, "REGIME_SELL: Failed to insert rotation log");
        }
      }

      // Log structured TRADE_EXIT event for LLM analysis
      const universeTokenSell = universe.find((u) => u.mint === mint);
      const entryForExit = entryPrices.get(mint);
      const holdingMinutesRegime = entryForExit ? 0 : 0; // Would need entry timestamp for accurate calculation
      const executionPriceRegime = tokenSellUi > 0 ? actualProceedsUsd / tokenSellUi : v.usdPrice;
      const slippageBpsRegime = v.usdPrice > 0 ? Math.abs(((executionPriceRegime - v.usdPrice) / v.usdPrice) * 10000) : 0;
      const costBasisRegime = entryForExit ? entryForExit.avgCostUsd * tokenSellUi : 0;
      const realizedPnlRegime = actualProceedsUsd - costBasisRegime;
      const realizedPnlPctRegime = costBasisRegime > 0 ? realizedPnlRegime / costBasisRegime : 0;
      
      logTradeExit({
        mint,
        symbol: universeTokenSell?.symbol ?? mint.slice(0, 6),
        decision_price_usd: v.usdPrice,
        execution_price_usd: executionPriceRegime,
        realized_pnl_usd: realizedPnlRegime,
        realized_pnl_pct: realizedPnlPctRegime,
        holding_minutes: holdingMinutesRegime,
        trigger_reason: 'regime_rebalance',
        slippage_bps: slippageBpsRegime,
        signal_snapshot: {
          score: t.score,
          regime: t.regime as 'trend' | 'range',
          bar_count: 60,
          features: {},
        },
        mode: execMode,
      });

      updateRunningState(runningState, mint, tradeUsd);
      updateRunningState(runningState, MINT_SOL, -tradeUsd);
      logger.debug({ 
        mint, 
        tradeUsd, 
        newPositionCount: runningState.positionCount,
        totalEquityUsd: runningState.totalEquityUsd
      }, "Updated running portfolio state after sell");
      
      const positionFullyExited = !runningState.positions.has(mint) || 
        (runningState.positions.get(mint)?.usdValue ?? 0) < 1;
      
      const tokenDecimalsSell = prices[mint]?.decimals ?? 9;
      let actualTokensSold = 0;
      try {
        const actualTokensSoldRaw = BigInt(res.quote?.inAmount ?? "0");
        actualTokensSold = Number(actualTokensSoldRaw) / Math.pow(10, tokenDecimalsSell);
      } catch (tokErr) {
        logger.warn({ mint, error: String(tokErr) }, "REGIME_SELL: Failed to calculate tokens sold");
      }
      
      if (positionFullyExited) {
        entryPrices.delete(mint);
        clearJourneyId(mint);
        logger.debug({ mint }, "Cleared entry price after full exit");
        
        if (res.status === 'sent' || res.status === 'paper') {
          await enforceExitInvariant({
            mint,
            symbol: universeTokenSell?.symbol ?? mint.slice(0, 6),
            exitReasonCode: 'regime_mean_revert',
            lastTradeTxSig: res.txSig ?? undefined,
            currentPriceUsd: v.usdPrice,
            solPriceUsd: solUsd,
          }, signer, execMode).catch(e => logger.error({ mint, error: String(e) }, "EXIT_INVARIANT: Failed to enforce cleanup"));
        }
        
        checkAndPruneToken(mint).catch(err => {
          logger.warn({ mint, err }, "Failed to check/prune token after sell");
        });
      } else {
        const entry = entryPrices.get(mint);
        if (entry && entry.totalTokens > 0) {
          const remainingTokens = entry.totalTokens - actualTokensSold;
          if (remainingTokens > 0) {
            entryPrices.set(mint, { avgCostUsd: entry.avgCostUsd, totalTokens: remainingTokens });
            logger.debug({ mint, remainingTokens, actualTokensSold, avgCostUsd: entry.avgCostUsd }, "Updated entry price after partial sell");
          } else {
            entryPrices.delete(mint);
            logger.debug({ mint }, "Cleared entry price (no remaining tokens)");
          }
        }
      }
      
      tradesExecuted++;
    }

    if (config.riskProfile === "low" || config.riskProfile === "medium") break;
    if (tradesExecuted >= 3) break;
  }
}

async function runPeriodicScanInternal(): Promise<{ opportunities: number; queued: number }> {
  const scan = await runMarketScan();
  const top = scan.topOpportunities.slice(0, 5);
  
  latestScannerCandidates = scan.topOpportunities;
  
  if (top.length > 0) {
    logger.info({
      topOpportunities: top.map(t => ({
        symbol: t.symbol,
        score: t.score,
        volume24h: t.volume24h,
        reasons: t.reasons.join(", "),
      })),
    }, "Periodic scan completed - top opportunities (user approval required to add)");
  }
  
  const enqueueResult = await enqueueScoutCandidates(scan.topOpportunities);
  if (enqueueResult.queued > 0) {
    logger.info({ 
      queued: enqueueResult.queued, 
      skipped: enqueueResult.skipped 
    }, "AUTO_SCOUT: Auto-queued opportunities");
  }
  
  logger.info({
    ran: true,
    candidatesFetched: scan.stats.candidatesFetched,
    passedLiquidity: scan.stats.passedLiquidity,
    passedVolume: scan.stats.passedVolume,
    passedHolders: scan.stats.passedHolders,
    passedPriceChange: scan.stats.passedPriceChange,
    queuedCount: enqueueResult.queued,
    topFailReasons: scan.stats.topFailReasons,
    lastScanAt: Date.now(),
    nextScanDueAt: Date.now() + scanIntervalMs,
  }, "SCAN_SUMMARY");
  
  return { opportunities: scan.topOpportunities.length, queued: enqueueResult.queued };
}

async function runPeriodicScanSafe(reason: string): Promise<void> {
  // Guard against overlapping scans
  if (scanInProgress) {
    logger.debug({ reason }, "SCAN: skipped - scan already in progress");
    return;
  }
  
  scanInProgress = true;
  const startTime = Date.now();
  logger.info({ reason }, "SCAN: start");
  
  try {
    const result = await runPeriodicScanInternal();
    lastScanAt = Date.now();
    const durationMs = Date.now() - startTime;
    logger.info({ 
      reason, 
      durationMs, 
      opportunities: result.opportunities, 
      queued: result.queued 
    }, "SCAN: done");
  } catch (err) {
    logger.error({ 
      reason, 
      err: String(err), 
      stack: (err as Error).stack 
    }, "SCAN: failed");
  } finally {
    scanInProgress = false;
  }
}

function scheduleNextTick() {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  
  const config = getConfig();
  const intervalMs = config.loopSeconds * 1000;
  
  loopTimer = setTimeout(async () => {
    try {
      universe = await getUniverse();
      await tick();
    } catch (e) {
      logger.error({ err: String(e) }, "tick error");
    }
    scheduleNextTick();
  }, intervalMs);
  
  logger.debug({ loopSeconds: config.loopSeconds }, "Scheduled next tick");
}

function setupScanInterval(): void {
  if (scanIntervalTimer) {
    clearInterval(scanIntervalTimer);
    scanIntervalTimer = null;
  }
  
  const config = getConfig();
  scanIntervalMs = config.scanIntervalMinutes * 60 * 1000;
  scannerEnabled = config.scanIntervalMinutes > 0;
  
  if (!scannerEnabled || scanIntervalMs <= 0) {
    logger.warn({ scanIntervalMinutes: config.scanIntervalMinutes }, "SCAN: Scanner disabled (interval <= 0)");
    return;
  }
  
  scanIntervalTimer = setInterval(() => {
    runPeriodicScanSafe("interval").catch(() => {}); // Fire-and-forget, errors logged inside
  }, scanIntervalMs);
  
  logger.info({ 
    scanIntervalMinutes: config.scanIntervalMinutes, 
    scanIntervalMs,
    timerSet: !!scanIntervalTimer 
  }, "SCAN: Interval timer configured");
}

function logBootBanner(reason: string = "BOOT"): void {
  const envCtx = getEnvContext();
  const config = getConfig();
  const configHash = getConfigHash();
  
  const isModeMismatch = (envCtx.envName === "prod" && config.executionMode === "paper") ||
                          (envCtx.envName === "dev" && config.executionMode === "live");

  logger.info({
    reason,
    env: envCtx.envName,
    deploymentId: envCtx.deploymentId,
    dbLabel: envCtx.dbLabel,
    walletLabel: envCtx.walletLabel,
    executionMode: config.executionMode,
    configHash,
    scannerMinLiquidity: config.scannerMinLiquidity,
    settingsRowCount: getSettingsRowCount(),
    modeMismatch: isModeMismatch,
  }, `BOOT_BANNER env=${envCtx.envName} deployment=${envCtx.deploymentId} db=${envCtx.dbLabel} executionMode=${config.executionMode} configHash=${configHash} scanner_min_liquidity=${config.scannerMinLiquidity}`);

  if (isModeMismatch) {
    logger.warn({
      env: envCtx.envName,
      executionMode: config.executionMode,
    }, `ENVIRONMENT_MISMATCH: ${envCtx.envName.toUpperCase()} environment running in ${config.executionMode} mode!`);
  }
}

async function start() {
  // Initialize environment context early - BEFORE any logging
  const envCtx = getEnvContext();
  
  // Set wallet label in env context now that signer is available
  setWalletLabel(signer.publicKey.toBase58());
  
  // Set logger context FIRST so all logs have environment identification
  setLoggerContext({
    envName: envCtx.envName,
    deploymentId: envCtx.deploymentId,
    dbLabel: envCtx.dbLabel,
    walletLabel: signer.publicKey.toBase58().slice(-6),
  });
  
  // Initialize database tables on startup
  logger.info("Initializing database tables...");
  await initializeDatabase();
  
  // Initialize bar writer for fill-forward price bars
  await initBarWriter();
  
  // Initialize capital management telemetry table
  try {
    await initCapacityTelemetryTable();
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to initialize capacity telemetry table - capital management may not work properly");
  }
  
  await initRuntimeConfig();
  
  // CRITICAL: Run position tracking health check at startup BEFORE other initialization
  // This runs regardless of pause state - health maintenance is not affected by pauses
  try {
    const healthResult = await ensurePositionTrackingHealth();
    if (healthResult.createdMints.length > 0) {
      logger.warn({
        created: healthResult.createdMints.length,
        mints: healthResult.createdMints.slice(0, 5),
      }, "STARTUP_HEALTH: Created missing position_tracking entries");
    }
  } catch (e) {
    logger.error({ err: String(e) }, "STARTUP_HEALTH: Position tracking health check failed");
  }
  
  // Set up hourly position tracking health check (runs regardless of pause state)
  setInterval(async () => {
    try {
      await ensurePositionTrackingHealth();
    } catch (e) {
      logger.error({ err: String(e) }, "HOURLY_HEALTH: Position tracking health check failed");
    }
  }, 60 * 60 * 1000);
  logger.info({}, "HEALTH_INTERVAL: Hourly position tracking health check scheduled");
  
  // Load entry prices from database to restore P&L tracking after restart
  await loadEntryPricesFromDb();
  
  // Backfill position entry times from reconciled trades (fixes timer reset issue)
  try {
    const backfilled = await backfillPositionEntryTimes();
    if (backfilled > 0) {
      logger.info({ count: backfilled }, "Backfilled position entry times from trade history");
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "Failed to backfill position entry times");
  }
  
  // Backfill missing position lots for FIFO PnL tracking (fixes extreme PnL bug)
  try {
    const { backfilled, skipped } = await backfillMissingPositionLots();
    if (backfilled > 0) {
      logger.info({ backfilled, skipped }, "Backfilled missing position lots for PnL tracking");
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "Failed to backfill position lots");
  }
  
  // CRITICAL: Backfill position_tracking from position_lots for existing positions
  // This fixes empty position_tracking which breaks scout exit logic
  try {
    const { backfillPositionTrackingFromLots } = await import("./persist.js");
    const backfillResult = await backfillPositionTrackingFromLots();
    if (backfillResult.created > 0) {
      logger.warn({ 
        created: backfillResult.created, 
        mints: backfillResult.mints.slice(0, 5),
      }, "CRITICAL_BACKFILL: Created missing position_tracking entries from position_lots");
    }
  } catch (e) {
    logger.error({ err: String(e) }, "Failed to backfill position tracking from lots");
  }
  
  // Force paper mode in development to prevent accidental live trades
  if (!isProductionDeployment()) {
    forceExecutionMode('paper', true);
    logger.info({ isProduction: false }, "Development environment detected - forced to paper mode");
  }
  
  await initRiskProfilesFromDefaults();
  await loadRiskProfiles();
  
  onConfigChange((newConfig) => {
    logger.info({ 
      riskProfile: newConfig.riskProfile, 
      executionMode: newConfig.executionMode,
      loopSeconds: newConfig.loopSeconds 
    }, "Runtime config changed");
    
    // Reconfigure scan interval if it changed
    const newIntervalMs = newConfig.scanIntervalMinutes * 60 * 1000;
    if (newIntervalMs !== scanIntervalMs) {
      logger.info({ 
        oldIntervalMs: scanIntervalMs, 
        newIntervalMs 
      }, "SCAN: Reconfiguring interval due to config change");
      setupScanInterval();
    }
  });
  
  universe = await getUniverse();
  
  const config = getConfig();
  
  performStartupSafetyChecks();
  
  // CRITICAL: Log scout exit thresholds at startup for verification
  logger.warn({
    scoutStopLossPct: config.scoutStopLossPct,
    scoutStopLossPctDisplay: `${(config.scoutStopLossPct * 100).toFixed(1)}%`,
    scoutTakeProfitPct: config.scoutTakeProfitPct,
    scoutTakeProfitPctDisplay: `${(config.scoutTakeProfitPct * 100).toFixed(1)}%`,
    scoutTpMinHoldMinutes: config.scoutTpMinHoldMinutes,
    scoutGraceMinutes: config.scoutGraceMinutes,
    lossExitPct: config.lossExitPct,
    lossExitPctDisplay: `${(config.lossExitPct * 100).toFixed(1)}%`,
  }, "SCOUT_EXIT_THRESHOLDS: Startup validation - verify these match expected values");
  
  // Log boot banner at startup
  logBootBanner("STARTUP");
  
  logger.info({
    deployTargetPct: (config.deployTargetPct * 100).toFixed(1) + '%',
    capMaxMintExposurePct: (config.capMaxMintExposurePct * 100).toFixed(1) + '%',
    capMaxTotalExposurePct: (config.capMaxTotalExposurePct * 100).toFixed(1) + '%',
  }, "ALLOCATION_CONFIG_STARTUP");
  
  logger.info({ 
    pubkey: signer.publicKey.toBase58(), 
    universeCount: universe.length,
    riskProfile: config.riskProfile,
    executionMode: getCurrentExecutionMode(),
    loopSeconds: config.loopSeconds,
    isProduction: isProductionDeployment(),
  }, "bot starting");

  await tick().catch((e) => logger.error({ err: String(e) }, "tick error"));

  scheduleNextTick();

  setInterval(() => {
    const execMode = getCurrentExecutionMode();
    const config = getConfig();
    logger.info({ 
      paused: state.paused, 
      reason: state.pauseReason,
      riskProfile: config.riskProfile,
      executionMode: execMode,
    }, "heartbeat");
  }, 5 * 60 * 1000);

  // Log boot banner every 10 minutes for observability
  setInterval(() => {
    logBootBanner("PERIODIC");
  }, 10 * 60 * 1000);

  // Run initial scan immediately (fire-and-forget)
  runPeriodicScanSafe("startup").catch(() => {});
  
  // Setup interval-based scan scheduling
  setupScanInterval();

  // Start background telemetry logger for post-exit tracking
  try {
    const { startTelemetryLogger } = await import("./telemetry_logger.js");
    startTelemetryLogger();
    logger.info({}, "TELEMETRY: Background logger started");
  } catch (err) {
    logger.warn({ err: String(err) }, "TELEMETRY: Failed to start background logger");
  }

  // Start sniper module if in production, live mode, AND feature flag enabled
  const sniperFeatureEnabled = getConfig().sniperEnabled;
  if (isProductionDeployment() && sniperFeatureEnabled) {
    try {
      const { startSniper, stopSniper } = await import("../sniper/index.js");
      const sniperStarted = await startSniper();
      if (sniperStarted) {
        logger.info("SNIPER: Module started in production mode");
      } else {
        logger.warn("SNIPER: Failed to start - check Helius API key configuration");
      }
      
      process.on("SIGINT", () => {
        stopSniper();
        if (loopTimer) clearTimeout(loopTimer);
        if (scanIntervalTimer) clearInterval(scanIntervalTimer);
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        stopSniper();
        if (loopTimer) clearTimeout(loopTimer);
        if (scanIntervalTimer) clearInterval(scanIntervalTimer);
        process.exit(0);
      });
    } catch (err) {
      logger.error({ err: String(err) }, "SNIPER: Failed to initialize module");
      process.on("SIGINT", () => {
        if (loopTimer) clearTimeout(loopTimer);
        if (scanIntervalTimer) clearInterval(scanIntervalTimer);
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        if (loopTimer) clearTimeout(loopTimer);
        if (scanIntervalTimer) clearInterval(scanIntervalTimer);
        process.exit(0);
      });
    }
  } else {
    const sniperDisabledReason = !isProductionDeployment() 
      ? "development mode" 
      : !sniperFeatureEnabled 
        ? "sniperEnabled=false" 
        : "unknown";
    logger.info({ reason: sniperDisabledReason }, "SNIPER: Module disabled");
    process.on("SIGINT", () => {
      if (loopTimer) clearTimeout(loopTimer);
      if (scanIntervalTimer) clearInterval(scanIntervalTimer);
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      if (loopTimer) clearTimeout(loopTimer);
      if (scanIntervalTimer) clearInterval(scanIntervalTimer);
      process.exit(0);
    });
  }
}

start().catch((e) => {
  logger.error({ err: String(e) }, "fatal");
  process.exit(1);
});
