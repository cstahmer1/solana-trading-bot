import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import { 
  insertScoutQueueItem, 
  isScoutOnCooldown, 
  countTodayScoutEntries, 
  getSlotCounts,
  getAllPositionTracking,
  getNextQueuedScout,
  updateScoutQueueStatus,
  rescheduleScoutQueueItem,
  incrementBuyAttempts,
  setScoutCooldown,
  insertTrade,
  upsertPositionTracking,
  loadRecentPrices,
  logDecision,
  updateTradeLotDecisionId,
  upsertWatchCandidate,
  getWatchCandidateAge,
  removeWatchCandidate,
  cleanupOldWatchCandidates,
  getQueueHealth,
  recoverStuckItems,
  claimNextQueuedScout,
} from "./persist.js";
import { getUniverse, addToUniverse } from "./universe.js";
import { executeSwap, solToLamports, getAuthoritativeDecimals } from "./execution.js";
import { MINT_SOL } from "./config.js";
import { getAllTokenAccounts } from "./wallet.js";
import { loadKeypair } from "./solana.js";
import { getTokenPairs } from "./dexscreener.js";
import type { ScannerToken } from "./scanner.js";
import { checkMarketConfirmation, checkExitSignal, isOnWhaleCooldown } from "./whaleSignal.js";
import { insertTradeLot } from "./pnl_engine.js";
import { logQueueDecision, logTradeEntry, getOrCreateJourneyId, type SignalSnapshot } from "./event_logger.js";
import { buildTradeAnalytics } from "./trade_analytics.js";
import { TRADE_REASONS } from "./trade_reasons.js";
import { evaluateScoutEntry } from "./price_metrics.js";
import { checkSellability } from "./sellability.js";
import { checkExitLiquidityForEntry } from "./exit_liquidity.js";
import { 
  chooseSize, 
  computeScoutBaseSize, 
  isCapitalManagementEnabled, 
  syncCapitalConfigFromRuntime, 
  initCapacityTelemetryTable 
} from "./capital_management.js";
import { isLiquidatingMint } from "./liquidation_lock.js";

export async function enqueueScoutCandidates(opportunities: ScannerToken[]): Promise<{queued: number, queuedRefreshed: number, skipped: number, reasons: string[]}> {
  const config = getConfig();
  
  logger.info({ 
    enabled: config.autonomousScoutsEnabled, 
    dryRun: config.autonomousDryRun,
    minScore: config.scoutAutoQueueScore,
    candidateCount: opportunities.length 
  }, "AUTO_SCOUT: Starting enqueue evaluation");
  
  if (!config.autonomousScoutsEnabled) {
    logger.info("AUTO_SCOUT: Autonomous scouts DISABLED - skipping all candidates");
    return { queued: 0, queuedRefreshed: 0, skipped: 0, reasons: ["Autonomous scouts disabled"] };
  }
  
  const reasons: string[] = [];
  let queued = 0;
  let queuedRefreshed = 0;
  let skipped = 0;
  let skippedLowScore = 0;
  
  const universe = await getUniverse();
  const universeMints = new Set(universe.map(u => u.mint));
  
  const positions = await getAllPositionTracking();
  const positionMints = new Set(positions.map(p => p.mint));
  
  const todayCount = await countTodayScoutEntries();
  if (todayCount >= config.scoutDailyLimit) {
    logger.info({ todayCount, limit: config.scoutDailyLimit }, "AUTO_SCOUT: Daily limit reached");
    return { queued: 0, queuedRefreshed: 0, skipped: opportunities.length, reasons: ["Daily limit reached"] };
  }
  
  const slotCounts = await getSlotCounts();
  const availableSlots = config.scoutSlots - slotCounts.scout;
  logger.info({ 
    currentScouts: slotCounts.scout, 
    maxSlots: config.scoutSlots, 
    availableSlots,
    todayCount,
    dailyLimit: config.scoutDailyLimit
  }, "AUTO_SCOUT: Slot and limit status");
  
  if (availableSlots <= 0) {
    logger.info({ scoutSlots: slotCounts.scout, maxSlots: config.scoutSlots }, "AUTO_SCOUT: No scout slots available");
    return { queued: 0, queuedRefreshed: 0, skipped: opportunities.length, reasons: ["No scout slots available"] };
  }
  
  const minScore = config.scoutAutoQueueScore;
  
  const minTicks = config.minTicksForSignals;
  const barCountCache: Map<string, number> = new Map();
  for (const opp of opportunities) {
    try {
      const recentPrices = await loadRecentPrices(opp.mint, minTicks);
      barCountCache.set(opp.mint, recentPrices.length);
    } catch {
      barCountCache.set(opp.mint, 0);
    }
  }
  
  const queueConfigSnapshot = {
    autonomousScoutsEnabled: config.autonomousScoutsEnabled,
    scoutAutoQueueScore: config.scoutAutoQueueScore,
    scoutDailyLimit: config.scoutDailyLimit,
    scoutBuySol: config.scoutBuySol,
  };
  
  for (const opp of opportunities) {
    const barCount = barCountCache.get(opp.mint) ?? 0;
    const signalReadiness = { bar_count: barCount, has_full_history: barCount >= minTicks, required_ticks: minTicks };
    
    if (opp.score < minScore) {
      skipped++;
      skippedLowScore++;
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'score_below_threshold',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
      continue;
    }
    
    if (universeMints.has(opp.mint)) {
      skipped++;
      reasons.push(`${opp.symbol}: Already in universe`);
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'already_in_universe',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
      continue;
    }
    
    if (positionMints.has(opp.mint)) {
      skipped++;
      reasons.push(`${opp.symbol}: Already a position`);
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'already_a_position',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
      continue;
    }
    
    const onCooldown = await isScoutOnCooldown(opp.mint);
    if (onCooldown) {
      skipped++;
      reasons.push(`${opp.symbol}: On cooldown`);
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'on_cooldown',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
      continue;
    }
    
    const isLiquidating = await isLiquidatingMint(opp.mint);
    if (isLiquidating) {
      skipped++;
      reasons.push(`${opp.symbol}: Mint in liquidation - reentry banned`);
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'liquidation_lock',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
      continue;
    }
    
    if (queued + todayCount >= config.scoutDailyLimit) {
      skipped++;
      reasons.push(`${opp.symbol}: Daily limit would be exceeded`);
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'daily_limit_exceeded',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
      continue;
    }
    
    if (queued >= availableSlots) {
      skipped++;
      reasons.push(`${opp.symbol}: Scout slots full`);
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'scout_slots_full',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
      continue;
    }
    
    const result = await insertScoutQueueItem({
      mint: opp.mint,
      symbol: opp.symbol,
      name: opp.name,
      score: opp.score,
      reasons: opp.reasons,
      spendSol: config.scoutBuySol,
    });
    
    if (result.inserted) {
      queued++;
      logger.info({ 
        mint: opp.mint, 
        symbol: opp.symbol, 
        score: opp.score 
      }, "AUTO_SCOUT: queued");
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'queued',
        reason: 'passed_filters',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
    } else if (result.refreshed) {
      queuedRefreshed++;
      logger.info({ 
        mint: opp.mint, 
        symbol: opp.symbol, 
        score: opp.score 
      }, "AUTO_SCOUT: refreshed stale queue item");
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'queued',
        reason: 'refreshed_stale',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
      });
    } else {
      skipped++;
      const ex = result.existing;
      const detailedReason = ex 
        ? `${opp.symbol}: Already in queue (status=${ex.status}, ageMin=${ex.ageMin}, attempts=${ex.attempts}${ex.nextAttemptAt ? `, nextAttempt=${ex.nextAttemptAt}` : ''})`
        : `${opp.symbol}: Already in queue`;
      reasons.push(detailedReason);
      logQueueDecision({
        mint: opp.mint,
        symbol: opp.symbol,
        decision: 'skipped',
        reason: 'already_in_queue',
        signal_readiness: signalReadiness,
        config_snapshot: queueConfigSnapshot,
        existing_queue_item: ex,
      });
    }
  }
  
  logger.info({ 
    queued, 
    queuedRefreshed,
    skipped, 
    skippedLowScore,
    skippedOtherReasons: skipped - skippedLowScore,
    reasons: reasons.slice(0, 10)
  }, "AUTO_SCOUT: Enqueue complete");
  
  return { queued, queuedRefreshed, skipped, reasons };
}

export async function processScoutQueue(): Promise<{processed: number, bought: number, failed: number, skipped: number}> {
  const config = getConfig();
  
  if (!config.autonomousScoutsEnabled) {
    logger.debug("PROCESS_QUEUE: Autonomous scouts disabled");
    return { processed: 0, bought: 0, failed: 0, skipped: 0 };
  }
  
  // CRITICAL: Check global pause gates BEFORE claiming any rows
  // This prevents zombie IN_PROGRESS rows when paused
  if (config.manualPause) {
    logger.debug("PROCESS_QUEUE: Skipped - manually paused (checked before claim)");
    return { processed: 0, bought: 0, failed: 0, skipped: 0 };
  }
  
  // Run both recovery mechanisms: legacy IN_PROGRESS and new enhanced watchdog
  const recovery = await recoverStuckItems();
  
  // Enhanced watchdog with retry limits and exponential backoff
  const { resetStaleBuyingScoutQueue } = await import("./scoutQueueWatchdog.js");
  const watchdogResult = await resetStaleBuyingScoutQueue({
    staleMinutes: config.scoutQueueStaleMinutes,
    maxBuyAttempts: config.scoutQueueMaxBuyAttempts,
    baseBackoffMinutes: 2,
  });
  
  const health = await getQueueHealth();
  
  logger.info({
    total: health.total,
    byStatus: health.byStatus,
    oldestPendingAgeMin: health.oldestPendingAgeMin,
    oldestInProgressAgeMin: health.oldestInProgressAgeMin,
    recoveredInProgress: recovery.recoveredInProgress,
    expiredStale: recovery.expiredStale,
    watchdog: {
      resetToPending: watchdogResult.resetToPending,
      markedSkipped: watchdogResult.markedSkipped,
    },
  }, "QUEUE_HEALTH");
  
  let processed = 0;
  let bought = 0;
  let failed = 0;
  let skipped = 0;
  
  const item = await claimNextQueuedScout();
  if (!item) {
    logger.debug("PROCESS_QUEUE: No pending items in queue");
    return { processed: 0, bought: 0, failed: 0, skipped: 0 };
  }
  
  logger.info({ mint: item.mint, symbol: item.symbol, score: item.score }, "PROCESS_QUEUE: Processing queued scout");
  
  processed++;
  
  const isLiquidatingNow = await isLiquidatingMint(item.mint);
  if (isLiquidatingNow) {
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
    }, "BUY_SKIPPED_LIQUIDATING: Scout buy blocked - mint in liquidation");
    await updateScoutQueueStatus(item.mint, 'SKIPPED', 'liquidation_lock');
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'skipped',
      reason: 'liquidation_lock',
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return { processed: 1, bought: 0, failed: 0, skipped: 1 };
  }
  
  const todayCount = await countTodayScoutEntries();
  if (todayCount >= config.scoutDailyLimit) {
    logger.info({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Daily limit reached, skipping");
    await updateScoutQueueStatus(item.mint, 'SKIPPED', 'Daily limit reached');
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'skipped',
      reason: 'Daily limit reached',
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return { processed: 1, bought: 0, failed: 0, skipped: 1 };
  }
  
  const slotCounts = await getSlotCounts();
  if (slotCounts.scout >= config.scoutSlots) {
    logger.info({ mint: item.mint, symbol: item.symbol, slots: slotCounts.scout }, "AUTO_BUY: Scout slots full, skipping");
    await updateScoutQueueStatus(item.mint, 'SKIPPED', 'Scout slots full');
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'skipped',
      reason: 'Scout slots full',
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return { processed: 1, bought: 0, failed: 0, skipped: 1 };
  }
  
  const signer = loadKeypair();
  const balances = await getAllTokenAccounts(signer.publicKey);
  const solBalance = balances.sol;
  const requiredSol = config.scoutBuySol + config.minSolReserve + config.txFeeBufferSol;
  
  if (solBalance < requiredSol) {
    const reason = `Insufficient SOL: ${solBalance.toFixed(4)} < ${requiredSol.toFixed(4)}`;
    logger.warn({ 
      mint: item.mint, 
      symbol: item.symbol, 
      solBalance, 
      required: requiredSol 
    }, "AUTO_BUY: Insufficient SOL, skipping");
    await updateScoutQueueStatus(item.mint, 'SKIPPED', reason);
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'skipped',
      reason,
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return { processed: 1, bought: 0, failed: 0, skipped: 1 };
  }
  
  // Status already set to IN_PROGRESS by claimNextQueuedScout() - no need to update again
  
  if (config.autonomousDryRun) {
    logger.info({ 
      mint: item.mint, 
      symbol: item.symbol, 
      score: item.score,
      spendSol: config.scoutBuySol
    }, "AUTO_BUY: DRY RUN - would buy scout position");
    
    await setScoutCooldown(item.mint, config.scoutTokenCooldownHours);
    await updateScoutQueueStatus(item.mint, 'BOUGHT', undefined, 'DRY_RUN');
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'bought',
      reason: 'DRY_RUN',
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return { processed: 1, bought: 1, failed: 0, skipped: 0 };
  }
  
  if (config.whaleConfirmEnabled) {
    const whaleCheck = await checkMarketConfirmation(item.mint, config);
    
    if (config.whaleConfirmDryRun) {
      logger.info({ 
        mint: item.mint,
        symbol: item.symbol,
        confirmed: whaleCheck.confirmed,
        reason: whaleCheck.reason,
        netflowUsd: whaleCheck.netflowUsd,
        dryRun: true,
      }, "AUTO_BUY: Whale check (dry run) - proceeding with entry regardless");
    } else if (!whaleCheck.confirmed) {
      const reason = `Whale check failed: ${whaleCheck.reason}`;
      logger.info({ 
        mint: item.mint,
        symbol: item.symbol,
        reason: whaleCheck.reason,
        netflowUsd: whaleCheck.netflowUsd,
      }, "AUTO_BUY: Skipped - whale confirmation failed");
      await updateScoutQueueStatus(item.mint, 'SKIPPED', reason);
      logger.info({
        mint: item.mint,
        symbol: item.symbol,
        status: 'skipped',
        reason,
        attempts: (item.buy_attempts ?? 0) + 1,
        nextAttemptAt: null,
      }, "QUEUE_ITEM_RESULT");
      return { processed: 1, bought: 0, failed: 0, skipped: 1 };
    } else {
      logger.info({ 
        mint: item.mint,
        symbol: item.symbol,
        netflowUsd: whaleCheck.netflowUsd,
      }, "AUTO_BUY: Whale confirmation passed");
    }
  }
  
  const entryEval = await evaluateScoutEntry(item.mint, {
    scoutChaseRet15Max: config.scoutChaseRet15Max,
    scoutImpulseRet15Min: config.scoutImpulseRet15Min,
    scoutPullbackFromHigh15Min: config.scoutPullbackFromHigh15Min,
    scoutEntrySmaMinutes: config.scoutEntrySmaMinutes,
    scoutEntryRequireAboveSma: config.scoutEntryRequireAboveSma,
    scoutEntryTrendSmaMinutes: config.scoutEntryTrendSmaMinutes,
  }, item.symbol);
  
  if (!entryEval.pass) {
    if (entryEval.failReason === "INSUFFICIENT_BARS") {
      await upsertWatchCandidate(item.mint, item.symbol || 'Unknown', entryEval.metrics.barCount);
      const watchAge = await getWatchCandidateAge(item.mint);
      
      // Warmup timeout escape hatch - skip if warming up > 20 minutes
      const WARMUP_TIMEOUT_MINUTES = 20;
      if (watchAge !== null && watchAge > WARMUP_TIMEOUT_MINUTES) {
        const reason = `WARMUP_TIMEOUT: ${watchAge.toFixed(1)} min > ${WARMUP_TIMEOUT_MINUTES} min`;
        logger.warn({ 
          mint: item.mint,
          symbol: item.symbol,
          watchAgeMinutes: watchAge,
          timeoutMinutes: WARMUP_TIMEOUT_MINUTES,
          barCount: entryEval.metrics.barCount,
        }, "AUTO_BUY: Warmup timeout - dropping from queue");
        await removeWatchCandidate(item.mint);
        await updateScoutQueueStatus(item.mint, 'SKIPPED', reason);
        logger.info({
          mint: item.mint,
          symbol: item.symbol,
          status: 'skipped',
          reason: 'WARMUP_TIMEOUT',
          watchAgeMinutes: watchAge,
          barCount: entryEval.metrics.barCount,
        }, "QUEUE_ITEM_RESULT");
        return { 
          processed: 1, 
          bought: 0, 
          failed: 0, 
          skipped: 1, 
          skipReason: "WARMUP_TIMEOUT" as const,
          skipExample: { mint: item.mint, symbol: item.symbol, failReason: "WARMUP_TIMEOUT", ret15: null, drawdown15: null, barCount: entryEval.metrics.barCount }
        } as any;
      }
      
      const nextAttemptAt = await rescheduleScoutQueueItem(item.mint, 'Warming up - insufficient bars', 2, true);
      logger.info({ 
        mint: item.mint,
        symbol: item.symbol,
        failReason: entryEval.failReason,
        barCount: entryEval.metrics.barCount,
        watchAgeMinutes: watchAge,
      }, "AUTO_BUY: Added to watch_candidates - insufficient bars");
      logger.info({
        mint: item.mint,
        symbol: item.symbol,
        status: 'rescheduled',
        reason: 'INSUFFICIENT_BARS',
        warmup_attempts: ((item as any).warmup_attempts ?? 0) + 1,
        buy_attempts: item.buy_attempts ?? 0,
        nextAttemptAt: nextAttemptAt.toISOString(),
      }, "QUEUE_ITEM_RESULT");
      return { 
        processed: 1, 
        bought: 0, 
        failed: 0, 
        skipped: 1, 
        skipReason: "INSUFFICIENT_BARS" as const,
        skipExample: { mint: item.mint, symbol: item.symbol, failReason: "INSUFFICIENT_BARS", ret15: null, drawdown15: null, barCount: entryEval.metrics.barCount }
      } as any;
    }
    
    const reason = `Entry gating failed: ${entryEval.failReason}`;
    logger.info({ 
      mint: item.mint,
      symbol: item.symbol,
      failReason: entryEval.failReason,
      ret15: entryEval.metrics.ret15,
      drawdown15: entryEval.metrics.drawdown15,
      sma30: entryEval.metrics.sma30,
      smaShort: entryEval.metrics.smaShort,
      smaShortBars: entryEval.metrics.smaShortBars,
      smaTrend: entryEval.metrics.smaTrend,
      smaTrendBars: entryEval.metrics.smaTrendBars,
      priceNow: entryEval.metrics.priceNow,
    }, "AUTO_BUY: Skipped - entry gating failed");
    await updateScoutQueueStatus(item.mint, 'SKIPPED', reason);
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'skipped',
      reason,
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return { 
      processed: 1, 
      bought: 0, 
      failed: 0, 
      skipped: 1,
      skipReason: entryEval.failReason as string,
      skipExample: { mint: item.mint, symbol: item.symbol, failReason: entryEval.failReason, ret15: entryEval.metrics.ret15, drawdown15: entryEval.metrics.drawdown15, barCount: entryEval.metrics.barCount }
    } as any;
  }
  
  await removeWatchCandidate(item.mint);
  
  logger.info({ 
    mint: item.mint,
    symbol: item.symbol,
    ret15: entryEval.metrics.ret15,
    drawdown15: entryEval.metrics.drawdown15,
  }, "AUTO_BUY: Entry gating passed");
  
  let spendSol = config.scoutBuySol;
  if (isCapitalManagementEnabled()) {
    try {
      syncCapitalConfigFromRuntime();
      
      let solPriceUsd = 150;
      try {
        const solPairs = await getTokenPairs(MINT_SOL);
        if (solPairs && solPairs.length > 0) {
          solPriceUsd = parseFloat(solPairs[0].priceUsd || "150");
        }
      } catch {
        logger.debug({ mint: item.mint }, "Failed to fetch SOL price, using fallback estimate");
      }
      
      const equityUsd = solBalance * solPriceUsd;
      const sizeDecision = await chooseSize({
        mint: item.mint,
        equityUsd,
        solPriceUsd,
        mode: 'scout',
        stopPct: config.scoutStopLossPct || 0.07,
        skipSweep: false,
      });
      
      if (sizeDecision.passedChecks && sizeDecision.finalSizeSol > 0) {
        spendSol = sizeDecision.finalSizeSol;
        logger.info({
          mint: item.mint.slice(0, 8),
          symbol: item.symbol,
          capitalMgmtSizeSol: spendSol.toFixed(6),
          fallbackSizeSol: config.scoutBuySol,
          limitingFactor: sizeDecision.limitingFactor,
          equityUsd: equityUsd.toFixed(2),
          solPriceUsd: solPriceUsd.toFixed(2),
        }, "CAPITAL_MGMT: Using capacity-aware scout size");
      } else {
        // CRITICAL: Skip trade entirely when capital management rejects it
        // Don't fall back to legacy sizing - that defeats the purpose
        const reason = `Capital management rejected: ${sizeDecision.rejectReason || sizeDecision.limitingFactor}`;
        logger.info({
          mint: item.mint.slice(0, 8),
          symbol: item.symbol,
          reason: sizeDecision.rejectReason,
          limitingFactor: sizeDecision.limitingFactor,
          riskCapUsd: sizeDecision.riskCapUsd?.toFixed(2),
          liquidityCapUsd: sizeDecision.liquidityCapUsd?.toFixed(2),
          edgeCapUsd: sizeDecision.edgeCapUsd?.toFixed(2),
        }, "CAPITAL_MGMT: Scout entry REJECTED - skipping trade");
        
        await updateScoutQueueStatus(item.mint, 'SKIPPED', reason);
        logger.info({
          mint: item.mint,
          symbol: item.symbol,
          status: 'skipped',
          reason,
          attempts: (item.buy_attempts ?? 0) + 1,
          nextAttemptAt: null,
        }, "QUEUE_ITEM_RESULT");
        return {
          processed: 1,
          bought: 0,
          failed: 0,
          skipped: 1,
          skipReason: 'capital_management_rejected',
        } as any;
      }
    } catch (capitalMgmtErr) {
      // Only fall back on exceptions (not rejections) to maintain safety
      logger.warn({
        mint: item.mint,
        symbol: item.symbol,
        error: String(capitalMgmtErr),
        fallbackSizeSol: config.scoutBuySol,
      }, "CAPITAL_MGMT: Exception during sizing, falling back to default");
    }
  }
  
  const spendLamports = solToLamports(spendSol);
  
  const sellabilityCheck = await checkSellability(
    item.mint,
    spendLamports,
    config.maxSlippageBps
  );
  
  if (!sellabilityCheck.pass) {
    const reason = `Sellability check failed: ${sellabilityCheck.failReason}`;
    logger.warn({
      mint: item.mint,
      symbol: item.symbol,
      failReason: sellabilityCheck.failReason,
      roundTripRatio: sellabilityCheck.roundTripRatio,
      sellPriceImpactPct: sellabilityCheck.sellPriceImpactPct,
    }, "AUTO_BUY: Rejected - failed sellability check (possible honeypot)");
    await updateScoutQueueStatus(item.mint, 'SKIPPED', reason);
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'skipped',
      reason,
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return {
      processed: 1,
      bought: 0,
      failed: 0,
      skipped: 1,
      skipReason: sellabilityCheck.failReason as string,
    } as any;
  }
  
  logger.info({
    mint: item.mint,
    symbol: item.symbol,
    roundTripRatio: sellabilityCheck.roundTripRatio?.toFixed(4),
    sellPriceImpactPct: sellabilityCheck.sellPriceImpactPct?.toFixed(4),
  }, "AUTO_BUY: Sellability check passed");
  
  const exitLiqCheck = await checkExitLiquidityForEntry({
    lane: "scout",
    inputSolLamports: spendLamports,
    outputMint: item.mint,
    slippageBps: config.maxSlippageBps,
  });
  
  if (!exitLiqCheck.ok) {
    const reason = `EXIT_LIQ_FAIL:${exitLiqCheck.reason}`;
    logger.warn({
      mint: item.mint,
      symbol: item.symbol,
      failReason: exitLiqCheck.reason,
      roundTripRatio: exitLiqCheck.roundTripRatio?.toFixed(4),
      exitImpactPct: exitLiqCheck.estimatedExitImpactPct?.toFixed(4),
      routeHops: exitLiqCheck.routeHops,
    }, "AUTO_BUY: Rejected - exit liquidity check failed");
    await updateScoutQueueStatus(item.mint, 'SKIPPED', reason);
    logger.info({
      mint: item.mint,
      symbol: item.symbol,
      status: 'skipped',
      reason,
      attempts: (item.buy_attempts ?? 0) + 1,
      nextAttemptAt: null,
    }, "QUEUE_ITEM_RESULT");
    return {
      processed: 1,
      bought: 0,
      failed: 0,
      skipped: 1,
      skipReason: reason,
    } as any;
  }
  
  logger.info({
    mint: item.mint,
    symbol: item.symbol,
    roundTripRatio: exitLiqCheck.roundTripRatio?.toFixed(4),
    exitImpactPct: exitLiqCheck.estimatedExitImpactPct?.toFixed(4),
    routeHops: exitLiqCheck.routeHops,
  }, "AUTO_BUY: Exit liquidity check passed");
  
  try {
    const execMode = config.executionMode;
    
    await incrementBuyAttempts(item.mint);
    
    const result = await executeSwap({
      strategy: 'autonomous_scout',
      inputMint: MINT_SOL,
      outputMint: item.mint,
      inAmountBaseUnits: spendLamports,
      slippageBps: config.maxSlippageBps,
      meta: { scoutQueueItem: true, score: item.score },
    }, signer, execMode);
    
    if (result.status === 'sent' && result.txSig) {
      logger.info({ 
        mint: item.mint, 
        symbol: item.symbol, 
        txSig: result.txSig 
      }, "AUTO_BUY: Scout position opened");
      
      try {
        const universeAdded = await addToUniverse(item.mint, item.symbol || 'Unknown', item.name ?? undefined, 'autonomous_scout');
        if (!universeAdded) {
          logger.warn({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Failed to add token to universe");
        }
      } catch (universeErr) {
        logger.error({ mint: item.mint, symbol: item.symbol, error: String(universeErr) }, "AUTO_BUY: Exception adding to universe");
      }
      
      const analytics = buildTradeAnalytics({
        reason: TRADE_REASONS.BUY_SCOUT_AUTO,
        quote: result.quote,
        riskProfile: config.riskProfile,
        entryScore: item.score,
        feeDecision: result.feeDecision,
      });

      const tradeInserted = await insertTrade({
        strategy: 'autonomous_scout',
        risk_profile: config.riskProfile,
        mode: execMode,
        input_mint: MINT_SOL,
        output_mint: item.mint,
        in_amount: String(spendLamports),
        out_amount: result.quote?.outAmount ?? null,
        est_out_amount: result.quote?.outAmount ?? null,
        price_impact_pct: result.quote?.priceImpactPct ?? null,
        slippage_bps: result.quote?.slippageBps ?? null,
        tx_sig: result.txSig,
        status: result.status,
        meta: { scoutQueueItem: true, score: item.score, symbol: item.symbol, feeGovernor: analytics.fee_governor_meta },
        pnl_usd: 0,
        reason_code: analytics.reason_code,
        entry_score: analytics.entry_score,
        fees_lamports: analytics.fees_lamports,
        priority_fee_lamports: analytics.priority_fee_lamports,
        route: analytics.route,
        settings_snapshot: analytics.settings_snapshot,
        liquidity_usd: analytics.liquidity_usd,
      });
      if (tradeInserted) {
        logger.info({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Trade history recorded");
      } else {
        logger.error({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Failed to insert trade history");
      }
      
      // Store entry price for PnL tracking
      try {
        let solPrice = 180; // fallback
        
        try {
          const solPairs = await getTokenPairs(MINT_SOL);
          if (solPairs && solPairs.length > 0) {
            solPrice = parseFloat(solPairs[0].priceUsd || "180");
          }
        } catch {}
        
        // CRITICAL: Use authoritative decimals from chain, not DexScreener
        let tokenDecimals = 6; // fallback for pump.fun tokens
        let decimalsSource = 'fallback';
        try {
          tokenDecimals = await getAuthoritativeDecimals(item.mint);
          decimalsSource = 'chain';
        } catch (e) {
          logger.warn({ mint: item.mint, error: String(e) }, "AUTO_BUY: Failed to get chain decimals, using fallback");
        }
        
        const outAmountRaw = result.quote?.outAmount ? parseFloat(result.quote.outAmount) : 0;
        const tokensReceived = outAmountRaw / Math.pow(10, tokenDecimals);
        // CRITICAL: Use actual spendSol (possibly adjusted by capital management) not config.scoutBuySol
        const spentUsd = spendSol * solPrice;
        const entryPriceUsd = tokensReceived > 0 ? spentUsd / tokensReceived : 0;
        
        // Log decimals info for debugging - include capital management adjustment detection
        const sizeWasAdjusted = Math.abs(spendSol - config.scoutBuySol) > 0.0001;
        // Log core info at info level, sensitive sizing details at debug level
        logger.info({
          mint: item.mint,
          symbol: item.symbol,
          tokenDecimals,
          decimalsSource,
          tokensReceived,
          entryPriceUsd,
          spentUsd,
          sizeWasAdjusted,
        }, sizeWasAdjusted 
          ? "AUTO_BUY: Cost basis calculated (CAPITAL_MGMT adjusted size)"
          : "AUTO_BUY: Cost basis calculated with authoritative decimals");
        // Detailed sizing comparison only at debug level to avoid leaking strategy details
        if (sizeWasAdjusted) {
          logger.debug({
            mint: item.mint,
            spendSolActual: spendSol,
            spendSolConfig: config.scoutBuySol,
          }, "AUTO_BUY: Capital management size adjustment details");
        }
        
        if (entryPriceUsd > 0 && tokensReceived > 0) {
          await upsertPositionTracking({
            mint: item.mint,
            entryPrice: entryPriceUsd,
            currentPrice: entryPriceUsd,
            totalTokens: tokensReceived,
            slotType: 'scout',
          });
          logger.info({ mint: item.mint, symbol: item.symbol, entryPriceUsd, tokensReceived, tokenDecimals }, "AUTO_BUY: Position tracking stored");
          
          await insertTradeLot({
            tx_sig: result.txSig || `LIVE_${Date.now()}`,
            timestamp: new Date(),
            mint: item.mint,
            side: 'buy',
            quantity: tokensReceived,
            usd_value: spentUsd,
            unit_price_usd: entryPriceUsd,
            sol_price_usd: solPrice,
            source: 'autonomous_scout',
            status: 'confirmed',
          });
          logger.info({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Position lot inserted for PnL tracking");
          
          try {
            const decisionId = await logDecision({
              mint: item.mint,
              symbol: item.symbol || 'Unknown',
              actionType: 'enter',
              reasonCode: 'scout_auto_buy',
              reasonDetail: 'Scout auto-buy of new position (live)',
              triggeredBy: 'scout_auto',
              txSig: result.txSig ?? undefined,
              qtyBefore: 0,
              qtyAfter: tokensReceived,
              qtyDelta: tokensReceived,
              usdValueBefore: 0,
              usdValueAfter: spentUsd,
              confidenceScore: item.score,
              journeyId: getOrCreateJourneyId(item.mint),
            });
            if (result.txSig && decisionId) {
              await updateTradeLotDecisionId(result.txSig, decisionId);
            }
          } catch (logErr) {
            logger.error({ mint: item.mint, error: String(logErr) }, "Failed to log scout auto-buy decision");
          }
          
          let decisionPriceUsd = 0;
          try {
            const tokenPairs = await getTokenPairs(item.mint);
            if (tokenPairs && tokenPairs.length > 0) {
              decisionPriceUsd = parseFloat(tokenPairs[0].priceUsd || "0");
            }
          } catch {}
          
          const slippageBps = decisionPriceUsd > 0 
            ? Math.abs(((entryPriceUsd - decisionPriceUsd) / decisionPriceUsd) * 10000)
            : 0;
          
          getOrCreateJourneyId(item.mint);
          logTradeEntry({
            mint: item.mint,
            symbol: item.symbol || 'Unknown',
            decision_price_usd: decisionPriceUsd,
            execution_price_usd: entryPriceUsd,
            slippage_bps: slippageBps,
            amount_sol: spendSol,
            signal_snapshot: null,
            reason: 'scout_queue',
            mode: 'live',
          });
          
        }
      } catch (trackErr) {
        logger.warn({ mint: item.mint, error: String(trackErr) }, "AUTO_BUY: Failed to store position tracking");
      }
      
      await setScoutCooldown(item.mint, config.scoutTokenCooldownHours);
      await updateScoutQueueStatus(item.mint, 'BOUGHT', undefined, result.txSig);
      logger.info({
        mint: item.mint,
        symbol: item.symbol,
        status: 'bought',
        reason: 'Live trade successful',
        attempts: (item.buy_attempts ?? 0) + 1,
        nextAttemptAt: null,
      }, "QUEUE_ITEM_RESULT");
      bought++;
    } else if (result.status === 'paper') {
      logger.info({ 
        mint: item.mint, 
        symbol: item.symbol, 
      }, "AUTO_BUY: Paper trade - scout position simulated");
      
      try {
        const universeAdded = await addToUniverse(item.mint, item.symbol || 'Unknown', item.name ?? undefined, 'autonomous_scout');
        if (!universeAdded) {
          logger.warn({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Failed to add token to universe (paper)");
        }
      } catch (universeErr) {
        logger.error({ mint: item.mint, symbol: item.symbol, error: String(universeErr) }, "AUTO_BUY: Exception adding to universe (paper)");
      }
      
      const paperAnalytics = buildTradeAnalytics({
        reason: TRADE_REASONS.BUY_SCOUT_AUTO,
        quote: result.quote,
        riskProfile: config.riskProfile,
        entryScore: item.score,
        feeDecision: result.feeDecision,
      });

      const tradeInserted = await insertTrade({
        strategy: 'autonomous_scout',
        risk_profile: config.riskProfile,
        mode: execMode,
        input_mint: MINT_SOL,
        output_mint: item.mint,
        in_amount: String(spendLamports),
        out_amount: null,
        est_out_amount: result.quote?.outAmount ?? null,
        price_impact_pct: result.quote?.priceImpactPct ?? null,
        slippage_bps: result.quote?.slippageBps ?? null,
        tx_sig: 'PAPER',
        status: 'paper',
        meta: { scoutQueueItem: true, score: item.score, symbol: item.symbol, paper: true, feeGovernor: paperAnalytics.fee_governor_meta },
        pnl_usd: 0,
        reason_code: paperAnalytics.reason_code,
        entry_score: paperAnalytics.entry_score,
        fees_lamports: paperAnalytics.fees_lamports,
        priority_fee_lamports: paperAnalytics.priority_fee_lamports,
        route: paperAnalytics.route,
        settings_snapshot: paperAnalytics.settings_snapshot,
      });
      if (tradeInserted) {
        logger.info({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Trade history recorded (paper)");
      } else {
        logger.error({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Failed to insert trade history (paper)");
      }
      
      // Store entry price for PnL tracking (paper mode)
      try {
        let solPrice = 180; // fallback
        let tokenDecimals = 6; // most SPL tokens use 6 decimals
        let marketPriceUsd = 0; // Current market price for sanity check
        let decimalsSource = 'fallback';
        
        try {
          const solPairs = await getTokenPairs(MINT_SOL);
          if (solPairs && solPairs.length > 0) {
            solPrice = parseFloat(solPairs[0].priceUsd || "180");
          }
        } catch {}
        
        // Fetch token decimals and current market price from DexScreener
        try {
          const tokenPairs = await getTokenPairs(item.mint);
          if (tokenPairs && tokenPairs.length > 0) {
            tokenDecimals = tokenPairs[0].baseToken?.decimals ?? 6;
            decimalsSource = 'dexscreener';
            marketPriceUsd = parseFloat(tokenPairs[0].priceUsd || "0");
          }
        } catch {}
        
        const outAmountRaw = result.quote?.outAmount ? parseFloat(result.quote.outAmount) : 0;
        const tokensReceived = outAmountRaw / Math.pow(10, tokenDecimals); // Convert base units to human-readable
        // CRITICAL: Use actual spendSol (possibly adjusted by capital management) not config.scoutBuySol
        const spentUsd = spendSol * solPrice;
        const entryPriceUsd = tokensReceived > 0 ? spentUsd / tokensReceived : 0;
        
        // SANITY CHECK: Compare calculated entry price against market price
        let priceValid = true;
        if (marketPriceUsd > 0 && entryPriceUsd > 0) {
          const priceRatio = entryPriceUsd / marketPriceUsd;
          if (priceRatio > 10 || priceRatio < 0.1) {
            logger.error({
              mint: item.mint,
              symbol: item.symbol,
              calculatedEntryPrice: entryPriceUsd,
              marketPrice: marketPriceUsd,
              priceRatio,
              tokenDecimals,
              decimalsSource,
            }, "AUTO_BUY: PRICE_SANITY_FAIL (paper) - Calculated entry price differs from market by >10x");
            priceValid = false;
          }
        }
        
        // Log decimals info for debugging - include capital management adjustment detection
        const sizeWasAdjustedPaper = Math.abs(spendSol - config.scoutBuySol) > 0.0001;
        // Log core info at info level, sensitive sizing details at debug level
        logger.info({
          mint: item.mint,
          symbol: item.symbol,
          tokenDecimals,
          decimalsSource,
          entryPriceUsd,
          marketPriceUsd,
          priceValid,
          spentUsd,
          sizeWasAdjusted: sizeWasAdjustedPaper,
        }, sizeWasAdjustedPaper
          ? "AUTO_BUY: Decimal conversion details (paper) - CAPITAL_MGMT adjusted size"
          : "AUTO_BUY: Decimal conversion details (paper)");
        // Detailed sizing comparison only at debug level to avoid leaking strategy details
        if (sizeWasAdjustedPaper) {
          logger.debug({
            mint: item.mint,
            spendSolActual: spendSol,
            spendSolConfig: config.scoutBuySol,
          }, "AUTO_BUY: Capital management size adjustment details (paper)");
        }
        
        if (entryPriceUsd > 0 && tokensReceived > 0 && priceValid) {
          await upsertPositionTracking({
            mint: item.mint,
            entryPrice: entryPriceUsd,
            currentPrice: entryPriceUsd,
            totalTokens: tokensReceived,
            slotType: 'scout',
          });
          logger.info({ mint: item.mint, symbol: item.symbol, entryPriceUsd, tokensReceived, tokenDecimals }, "AUTO_BUY: Position tracking stored (paper)");
          
          const paperTxSig = `PAPER_${Date.now()}`;
          await insertTradeLot({
            tx_sig: paperTxSig,
            timestamp: new Date(),
            mint: item.mint,
            side: 'buy',
            quantity: tokensReceived,
            usd_value: spentUsd,
            unit_price_usd: entryPriceUsd,
            sol_price_usd: solPrice,
            source: 'autonomous_scout',
            status: 'paper',
          });
          logger.info({ mint: item.mint, symbol: item.symbol }, "AUTO_BUY: Position lot inserted for PnL tracking (paper)");
          
          try {
            const decisionId = await logDecision({
              mint: item.mint,
              symbol: item.symbol || 'Unknown',
              actionType: 'enter',
              reasonCode: 'scout_auto_buy',
              reasonDetail: 'Scout auto-buy of new position (paper)',
              triggeredBy: 'scout_auto',
              txSig: paperTxSig,
              qtyBefore: 0,
              qtyAfter: tokensReceived,
              qtyDelta: tokensReceived,
              usdValueBefore: 0,
              usdValueAfter: spentUsd,
              confidenceScore: item.score,
              journeyId: getOrCreateJourneyId(item.mint),
            });
            if (decisionId) {
              await updateTradeLotDecisionId(paperTxSig, decisionId);
            }
          } catch (logErr) {
            logger.error({ mint: item.mint, error: String(logErr) }, "Failed to log scout auto-buy decision (paper)");
          }
          
          const slippageBpsPaper = marketPriceUsd > 0 
            ? Math.abs(((entryPriceUsd - marketPriceUsd) / marketPriceUsd) * 10000)
            : 0;
          
          getOrCreateJourneyId(item.mint);
          logTradeEntry({
            mint: item.mint,
            symbol: item.symbol || 'Unknown',
            decision_price_usd: marketPriceUsd,
            execution_price_usd: entryPriceUsd,
            slippage_bps: slippageBpsPaper,
            amount_sol: spendSol,
            signal_snapshot: null,
            reason: 'scout_queue',
            mode: 'paper',
          });
          
        } else if (!priceValid) {
          // Use market price as fallback when sanity check fails
          // CRITICAL: Must also recalculate quantity to match the corrected price
          const fallbackEntryPrice = marketPriceUsd > 0 ? marketPriceUsd : entryPriceUsd;
          const correctedTokensReceived = fallbackEntryPrice > 0 ? spentUsd / fallbackEntryPrice : tokensReceived;
          
          logger.warn({
            mint: item.mint,
            symbol: item.symbol,
            originalEntryPrice: entryPriceUsd,
            fallbackEntryPrice,
            originalQuantity: tokensReceived,
            correctedQuantity: correctedTokensReceived,
          }, "AUTO_BUY: Using market price as fallback due to sanity check failure (paper)");
          
          await upsertPositionTracking({
            mint: item.mint,
            entryPrice: fallbackEntryPrice,
            currentPrice: fallbackEntryPrice,
            totalTokens: correctedTokensReceived,
            slotType: 'scout',
          });
          
          const paperCorrectedTxSig = `PAPER_${Date.now()}`;
          await insertTradeLot({
            tx_sig: paperCorrectedTxSig,
            timestamp: new Date(),
            mint: item.mint,
            side: 'buy',
            quantity: correctedTokensReceived,
            usd_value: spentUsd,
            unit_price_usd: fallbackEntryPrice,
            sol_price_usd: solPrice,
            source: 'autonomous_scout',
            status: 'paper',
          });
          logger.info({ mint: item.mint, symbol: item.symbol, fallbackEntryPrice, correctedQuantity: correctedTokensReceived }, "AUTO_BUY: Position lot inserted with fallback price and corrected quantity (paper)");
          
          try {
            const decisionId = await logDecision({
              mint: item.mint,
              symbol: item.symbol || 'Unknown',
              actionType: 'enter',
              reasonCode: 'scout_auto_buy',
              reasonDetail: 'Scout auto-buy of new position (paper, price corrected)',
              triggeredBy: 'scout_auto',
              txSig: paperCorrectedTxSig,
              qtyBefore: 0,
              qtyAfter: correctedTokensReceived,
              qtyDelta: correctedTokensReceived,
              usdValueBefore: 0,
              usdValueAfter: spentUsd,
              confidenceScore: item.score,
              journeyId: getOrCreateJourneyId(item.mint),
            });
            if (decisionId) {
              await updateTradeLotDecisionId(paperCorrectedTxSig, decisionId);
            }
          } catch (logErr) {
            logger.error({ mint: item.mint, error: String(logErr) }, "Failed to log scout auto-buy decision (paper corrected)");
          }
          
        }
      } catch (trackErr) {
        logger.warn({ mint: item.mint, error: String(trackErr) }, "AUTO_BUY: Failed to store position tracking (paper)");
      }
      
      await setScoutCooldown(item.mint, config.scoutTokenCooldownHours);
      await updateScoutQueueStatus(item.mint, 'BOUGHT', undefined, 'PAPER');
      logger.info({
        mint: item.mint,
        symbol: item.symbol,
        status: 'bought',
        reason: 'Paper trade successful',
        attempts: (item.buy_attempts ?? 0) + 1,
        nextAttemptAt: null,
      }, "QUEUE_ITEM_RESULT");
      bought++;
    } else {
      const errorReason = result.error || 'Swap failed';
      logger.error({ 
        mint: item.mint, 
        symbol: item.symbol, 
        status: result.status,
        error: result.error 
      }, "AUTO_BUY: Swap failed");
      
      const maxAttempts = 3;
      const currentAttempts = (item.buy_attempts ?? 0) + 1;
      
      if (currentAttempts < maxAttempts) {
        const nextAttemptAt = await rescheduleScoutQueueItem(item.mint, errorReason, 5);
        logger.info({
          mint: item.mint,
          symbol: item.symbol,
          status: 'rescheduled',
          reason: errorReason,
          attempts: currentAttempts,
          nextAttemptAt: nextAttemptAt.toISOString(),
        }, "QUEUE_ITEM_RESULT");
      } else {
        await setScoutCooldown(item.mint, 1);
        await updateScoutQueueStatus(item.mint, 'FAILED', errorReason);
        logger.info({
          mint: item.mint,
          symbol: item.symbol,
          status: 'failed',
          reason: `${errorReason} (max attempts reached)`,
          attempts: currentAttempts,
          nextAttemptAt: null,
        }, "QUEUE_ITEM_RESULT");
        failed++;
      }
    }
  } catch (err) {
    const errorReason = String(err);
    logger.error({ mint: item.mint, err }, "AUTO_BUY: Exception during swap");
    
    const maxAttempts = 3;
    const currentAttempts = (item.buy_attempts ?? 0) + 1;
    
    if (currentAttempts < maxAttempts) {
      const nextAttemptAt = await rescheduleScoutQueueItem(item.mint, errorReason, 5);
      logger.info({
        mint: item.mint,
        symbol: item.symbol,
        status: 'rescheduled',
        reason: errorReason,
        attempts: currentAttempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
      }, "QUEUE_ITEM_RESULT");
    } else {
      await setScoutCooldown(item.mint, 1);
      await updateScoutQueueStatus(item.mint, 'FAILED', errorReason);
      logger.info({
        mint: item.mint,
        symbol: item.symbol,
        status: 'failed',
        reason: `${errorReason} (max attempts reached)`,
        attempts: currentAttempts,
        nextAttemptAt: null,
      }, "QUEUE_ITEM_RESULT");
      failed++;
    }
  }
  
  return { processed, bought, failed, skipped };
}

export type ManualScoutBuyResult = {
  status: 'bought' | 'paper' | 'skipped' | 'failed' | 'disabled';
  txSig?: string;
  error?: string;
  reason?: string;
};

export async function executeManualScoutBuy(
  mint: string, 
  symbol: string, 
  name?: string
): Promise<ManualScoutBuyResult> {
  const config = getConfig();
  
  if (!config.manualScoutBuyEnabled) {
    return { status: 'disabled', reason: 'Manual scout buy disabled in settings' };
  }
  
  // Check slot availability
  const slotCounts = await getSlotCounts();
  if (slotCounts.scout >= config.scoutSlots) {
    logger.info({ mint, symbol, slots: slotCounts.scout }, "MANUAL_BUY: Scout slots full");
    return { status: 'skipped', reason: 'Scout slots full' };
  }
  
  // Check SOL balance
  const signer = loadKeypair();
  const balances = await getAllTokenAccounts(signer.publicKey);
  const solBalance = balances.sol;
  const requiredSol = config.scoutBuySol + config.minSolReserve + config.txFeeBufferSol;
  
  if (solBalance < requiredSol) {
    logger.warn({ mint, symbol, solBalance, required: requiredSol }, "MANUAL_BUY: Insufficient SOL");
    return { status: 'skipped', reason: `Insufficient SOL: ${solBalance.toFixed(4)} < ${requiredSol.toFixed(4)}` };
  }
  
  // Check if already in position
  const positions = await getAllPositionTracking();
  const hasPosition = positions.some(p => p.mint === mint && p.total_tokens > 0);
  if (hasPosition) {
    logger.info({ mint, symbol }, "MANUAL_BUY: Already have position");
    return { status: 'skipped', reason: 'Already have position in this token' };
  }
  
  // Optional whale confirmation check (if enabled and not dry run)
  if (config.whaleConfirmEnabled && !config.whaleConfirmDryRun) {
    const whaleCheck = await checkMarketConfirmation(mint, config);
    if (!whaleCheck.confirmed) {
      logger.info({ mint, symbol, reason: whaleCheck.reason }, "MANUAL_BUY: Whale confirmation failed");
      return { status: 'skipped', reason: `Whale check failed: ${whaleCheck.reason}` };
    }
  }
  
  const execMode = config.executionMode;
  
  // Execute the scout buy
  try {
    const lamports = solToLamports(config.scoutBuySol);
    
    const result = await executeSwap({
      strategy: "manual_scout_buy",
      inputMint: MINT_SOL,
      outputMint: mint,
      inAmountBaseUnits: lamports,
      slippageBps: config.maxSlippageBps,
      meta: { manualScoutBuy: true, symbol },
    }, signer, execMode);
    
    if (result.status === 'sent' && result.txSig) {
      logger.info({ mint, symbol, txSig: result.txSig }, "MANUAL_BUY: Scout position opened");
      await setScoutCooldown(mint, config.scoutTokenCooldownHours);
      return { status: 'bought', txSig: result.txSig };
    } else if (result.status === 'paper') {
      logger.info({ mint, symbol }, "MANUAL_BUY: Paper trade - scout position simulated");
      await setScoutCooldown(mint, config.scoutTokenCooldownHours);
      return { status: 'paper', txSig: 'PAPER' };
    } else {
      logger.error({ mint, symbol, status: result.status, error: result.error }, "MANUAL_BUY: Swap failed");
      return { status: 'failed', error: result.error || 'Swap failed' };
    }
  } catch (err) {
    logger.error({ mint, symbol, err }, "MANUAL_BUY: Exception during swap");
    return { status: 'failed', error: String(err) };
  }
}
