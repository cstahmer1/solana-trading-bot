import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import { getRemainingExposure, insertPartialExitEvent } from "./persist.js";
import { insertTradeLot } from "./pnl_engine.js";
import { executeSwap, getAuthoritativeDecimals, uiToBaseUnits } from "./execution.js";
import { MINT_SOL } from "./config.js";
import type { Keypair } from "@solana/web3.js";

export const EXIT_REASON_CODES = [
  'scout_stop_loss_exit',
  'rotation_exit',
  'regime_mean_revert',
  'core_loss_exit',
  'take_profit',
  'trailing_stop_exit',
  'stale_exit',
  'concentration_rebalance',
] as const;

export type ExitReasonCode = typeof EXIT_REASON_CODES[number];

export function isExitReason(code: string): code is ExitReasonCode {
  return EXIT_REASON_CODES.includes(code as ExitReasonCode);
}

export interface ExitInvariantContext {
  mint: string;
  symbol?: string;
  exitReasonCode: string;
  lastTradeTxSig?: string;
  decisionId?: string;
  currentPriceUsd?: number;
  solPriceUsd: number;
}

export interface ExitInvariantResult {
  status: 'ok' | 'triggered_cleanup' | 'failed';
  retriesUsed: number;
  finalRemainingQty: number;
  finalRemainingUsd: number;
  cleanupTxSigs: string[];
  eventId?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function enforceExitInvariant(
  ctx: ExitInvariantContext,
  signer: Keypair,
  execMode: 'paper' | 'live'
): Promise<ExitInvariantResult> {
  const config = getConfig();
  
  if (!config.exitInvariantEnabled) {
    logger.debug({ mint: ctx.mint }, "Exit invariant check disabled, skipping");
    return {
      status: 'ok',
      retriesUsed: 0,
      finalRemainingQty: 0,
      finalRemainingUsd: 0,
      cleanupTxSigs: [],
    };
  }

  const {
    exitInvariantMaxRetries,
    exitInvariantRetryDelayMs,
    exitInvariantMinRemainingQty,
    exitInvariantMinRemainingUsd,
    exitInvariantSlippageBps,
    exitInvariantForceExactClose,
  } = config;

  let exposure = await getRemainingExposure(ctx.mint, ctx.currentPriceUsd);
  
  if (exposure.remainingQty <= exitInvariantMinRemainingQty || 
      exposure.remainingUsd <= exitInvariantMinRemainingUsd) {
    logger.info({
      mint: ctx.mint,
      symbol: ctx.symbol,
      remainingQty: exposure.remainingQty,
      remainingUsd: exposure.remainingUsd,
      thresholdQty: exitInvariantMinRemainingQty,
      thresholdUsd: exitInvariantMinRemainingUsd,
    }, "exit_invariant_ok - position fully closed");
    
    return {
      status: 'ok',
      retriesUsed: 0,
      finalRemainingQty: exposure.remainingQty,
      finalRemainingUsd: exposure.remainingUsd,
      cleanupTxSigs: [],
    };
  }

  logger.warn({
    mint: ctx.mint,
    symbol: ctx.symbol,
    remainingQty: exposure.remainingQty,
    remainingUsd: exposure.remainingUsd,
    exitReasonCode: ctx.exitReasonCode,
    lastTradeTxSig: ctx.lastTradeTxSig,
    thresholdQty: exitInvariantMinRemainingQty,
    thresholdUsd: exitInvariantMinRemainingUsd,
  }, "exit_invariant_triggered - remaining exposure above threshold, attempting cleanup");

  const cleanupTxSigs: string[] = [];
  let retryCount = 0;
  const maxRetries = exitInvariantForceExactClose ? 10 : exitInvariantMaxRetries;

  while (retryCount < maxRetries) {
    retryCount++;

    if (exposure.remainingQty <= exitInvariantMinRemainingQty || 
        exposure.remainingUsd <= exitInvariantMinRemainingUsd) {
      break;
    }

    logger.info({
      mint: ctx.mint,
      symbol: ctx.symbol,
      attempt: retryCount,
      maxRetries,
      remainingQty: exposure.remainingQty,
      remainingUsd: exposure.remainingUsd,
    }, "exit_invariant_cleanup_attempt");

    try {
      const decimals = await getAuthoritativeDecimals(ctx.mint);
      const sellAmountUi = exposure.remainingQty;
      const sellAmountBase = uiToBaseUnits(sellAmountUi, decimals);
      
      if (sellAmountBase === '0' || parseFloat(sellAmountBase) <= 0) {
        logger.warn({
          mint: ctx.mint,
          symbol: ctx.symbol,
          remainingQty: exposure.remainingQty,
          decimals,
          sellAmountBase,
        }, "exit_invariant_skipping - sell amount too small for base units");
        break;
      }

      logger.debug({
        mint: ctx.mint,
        symbol: ctx.symbol,
        decimals,
        sellAmountUi,
        sellAmountBase,
      }, "exit_invariant_cleanup - calculated sell amount");

      const sellRes = await executeSwap({
        strategy: 'exit_invariant_cleanup',
        inputMint: ctx.mint,
        outputMint: MINT_SOL,
        inAmountBaseUnits: sellAmountBase,
        slippageBps: exitInvariantSlippageBps,
        meta: {
          cleanup: true,
          reasonCode: 'exit_invariant_cleanup',
          parentReasonCode: ctx.exitReasonCode,
          cleanupAttempt: retryCount,
          remainingQtyUi: sellAmountUi,
          decimals,
        },
      }, signer, execMode);

      if (sellRes.status === 'sent' || sellRes.status === 'paper') {
        if (sellRes.txSig) {
          cleanupTxSigs.push(sellRes.txSig);
        }

        const outAmount = sellRes.quote?.outAmount ? Number(sellRes.quote.outAmount) : 0;
        const solReceived = outAmount / 1e9;
        const actualUsdReceived = solReceived * ctx.solPriceUsd;

        const soldQtyUi = sellAmountUi;
        
        logger.info({
          mint: ctx.mint,
          symbol: ctx.symbol,
          txSig: sellRes.txSig,
          soldQtyUi,
          decimals,
          solReceived,
          usdReceived: actualUsdReceived,
          attempt: retryCount,
        }, "exit_invariant_cleanup_trade_executed");

        if (execMode === 'live' && sellRes.txSig) {
          const effectivePrice = soldQtyUi > 0 
            ? actualUsdReceived / soldQtyUi 
            : ctx.currentPriceUsd ?? 0;
          
          await insertTradeLot({
            tx_sig: sellRes.txSig,
            timestamp: new Date(),
            mint: ctx.mint,
            side: 'sell',
            quantity: soldQtyUi,
            usd_value: actualUsdReceived,
            unit_price_usd: effectivePrice,
            sol_price_usd: ctx.solPriceUsd,
            source: 'exit_invariant_cleanup',
            status: 'confirmed',
          });
        }
        
        await delay(500);
      } else {
        logger.warn({
          mint: ctx.mint,
          symbol: ctx.symbol,
          status: sellRes.status,
          error: sellRes.error,
          attempt: retryCount,
        }, "exit_invariant_cleanup_trade_failed");
      }
    } catch (e: any) {
      logger.error({
        mint: ctx.mint,
        symbol: ctx.symbol,
        error: e.message,
        attempt: retryCount,
      }, "exit_invariant_cleanup_error");
    }

    if (retryCount < maxRetries) {
      await delay(exitInvariantRetryDelayMs);
    }

    exposure = await getRemainingExposure(ctx.mint, ctx.currentPriceUsd);
  }

  if (exposure.remainingQty > exitInvariantMinRemainingQty && 
      exposure.remainingUsd > exitInvariantMinRemainingUsd) {
    logger.error({
      mint: ctx.mint,
      symbol: ctx.symbol,
      remainingQty: exposure.remainingQty,
      remainingUsd: exposure.remainingUsd,
      parentReasonCode: ctx.exitReasonCode,
      retriesUsed: retryCount,
      lastTradeTxSig: cleanupTxSigs[cleanupTxSigs.length - 1] ?? ctx.lastTradeTxSig,
    }, "exit_invariant_failed - unable to fully close position after retries");

    const eventId = await insertPartialExitEvent({
      mint: ctx.mint,
      symbol: ctx.symbol,
      remainingQty: exposure.remainingQty,
      remainingUsd: exposure.remainingUsd,
      parentReasonCode: ctx.exitReasonCode,
      retriesUsed: retryCount,
      lastTradeTxSig: cleanupTxSigs[cleanupTxSigs.length - 1] ?? ctx.lastTradeTxSig,
      notes: `Failed to close position after ${retryCount} cleanup attempts`,
    });

    return {
      status: 'failed',
      retriesUsed: retryCount,
      finalRemainingQty: exposure.remainingQty,
      finalRemainingUsd: exposure.remainingUsd,
      cleanupTxSigs,
      eventId,
    };
  }

  logger.info({
    mint: ctx.mint,
    symbol: ctx.symbol,
    retriesUsed: retryCount,
    finalRemainingQty: exposure.remainingQty,
    finalRemainingUsd: exposure.remainingUsd,
    cleanupTxSigs,
  }, "exit_invariant_cleanup_success - position closed after retries");

  return {
    status: 'triggered_cleanup',
    retriesUsed: retryCount,
    finalRemainingQty: exposure.remainingQty,
    finalRemainingUsd: exposure.remainingUsd,
    cleanupTxSigs,
  };
}
