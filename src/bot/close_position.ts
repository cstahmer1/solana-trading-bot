import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { MINT_SOL, MINT_USDC } from "./config.js";
import { connection } from "./solana.js";
import { jupQuote, type QuoteResponse } from "./jupiter.js";
import { executeSwap, uiToBaseUnits, type ExecutionMode, type SwapResult } from "./execution.js";
import { getConfig } from "./runtime_config.js";
import { logger } from "../utils/logger.js";
import { insertTrade, insertRotationLog, deletePositionTracking, getPositionTracking, updatePositionSlotType } from "./persist.js";
import { processSellWithFIFO, closeAllPositionLots } from "./pnl_engine.js";
import { buildTradeAnalytics } from "./trade_analytics.js";
import { TRADE_REASONS, type TradeReason } from "./trade_reasons.js";
import { logTradeExit, clearJourneyId, getJourneyId, logExitDecision } from "./event_logger.js";
import { enforceExitInvariant } from "./exit_invariant.js";

export type ClosePositionReasonCode =
  | 'scout_stop_loss_exit'
  | 'scout_underperform_grace_expired'
  | 'scout_take_profit_exit'
  | 'core_loss_exit'
  | 'take_profit'
  | 'flash_close'
  | 'universe_exit';

export type ClosePositionContext = {
  symbol?: string;
  manual?: boolean;
  pnlPct?: number;
  signalScore?: number;
  entryPriceUsd?: number;
  currentPriceUsd?: number;
  solPriceUsd: number;
  slotType?: 'core' | 'scout';
  bypassedPause?: boolean;
  peakPnlPct?: number | null;
  peakPnlUsd?: number | null;
};

export type ClosePositionResult = {
  success: boolean;
  fullyClosed: boolean;
  soldAmount: number;
  remainingAmount: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  txSig: string | null;
  status: SwapResult['status'];
  error?: string;
  retried?: boolean;
};

const DUST_THRESHOLD_TOKENS = 0.0001;

async function getOnChainTokenBalance(owner: PublicKey, mint: string): Promise<{ balanceBaseUnits: bigint; balanceUi: number; decimals: number }> {
  if (mint === MINT_SOL) {
    const lamports = await connection.getBalance(owner, "confirmed");
    return { 
      balanceBaseUnits: BigInt(lamports), 
      balanceUi: lamports / 1e9,
      decimals: 9 
    };
  }

  const mintPk = new PublicKey(mint);
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  
  for (const programId of programs) {
    try {
      const ata = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
      const info = await connection.getTokenAccountBalance(ata, "confirmed");
      const decimals = info.value.decimals;
      const balanceBaseUnits = BigInt(info.value.amount);
      const balanceUi = Number(info.value.uiAmount ?? 0);
      return { balanceBaseUnits, balanceUi, decimals };
    } catch {
      // Try next program
    }
  }
  
  return { balanceBaseUnits: 0n, balanceUi: 0, decimals: 9 };
}

function mapReasonToTradeReason(reasonCode: ClosePositionReasonCode): TradeReason {
  switch (reasonCode) {
    case 'scout_stop_loss_exit':
      return TRADE_REASONS.SELL_SCOUT_STOP_LOSS;
    case 'core_loss_exit':
      return TRADE_REASONS.SELL_CORE_STOP_LOSS;
    case 'scout_underperform_grace_expired':
      return TRADE_REASONS.SELL_UNDERPERFORM_GRACE;
    case 'scout_take_profit_exit':
      return TRADE_REASONS.SELL_SCOUT_TAKE_PROFIT;
    case 'take_profit':
      return TRADE_REASONS.SELL_TAKE_PROFIT;
    case 'flash_close':
      return TRADE_REASONS.SELL_MANUAL;
    case 'universe_exit':
      return TRADE_REASONS.SELL_EXIT_OTHER;
    default:
      return TRADE_REASONS.SELL_EXIT_OTHER;
  }
}

export async function closePosition(
  mint: string,
  reasonCode: ClosePositionReasonCode,
  context: ClosePositionContext,
  signer: Keypair,
  execMode: ExecutionMode
): Promise<ClosePositionResult> {
  const config = getConfig();
  const owner = signer.publicKey;
  const symbol = context.symbol ?? mint.slice(0, 6);
  
  const isSOLFlashClose = mint === MINT_SOL && reasonCode === 'flash_close';
  const SOL_FLASH_CLOSE_MAX_PCT = 0.95;
  
  logger.info({
    mint,
    symbol,
    reasonCode,
    execMode,
    manual: context.manual,
    slotType: context.slotType,
    isSOLFlashClose,
  }, "CLOSE_POSITION: Starting full position close");

  const initialBalance = await getOnChainTokenBalance(owner, mint);
  
  if (initialBalance.balanceUi <= DUST_THRESHOLD_TOKENS) {
    logger.info({ mint, symbol, balance: initialBalance.balanceUi }, "CLOSE_POSITION: No balance to close");
    return {
      success: true,
      fullyClosed: true,
      soldAmount: 0,
      remainingAmount: 0,
      proceedsUsd: 0,
      realizedPnlUsd: 0,
      txSig: null,
      status: 'paper',
    };
  }

  let sellAmountBaseUnits: string;
  let sellAmountUi: number;
  let outputMint: string;
  
  if (isSOLFlashClose) {
    const maxSellLamports = BigInt(Math.floor(Number(initialBalance.balanceBaseUnits) * SOL_FLASH_CLOSE_MAX_PCT));
    const minReserveLamports = BigInt(Math.floor(0.01 * 1e9));
    const actualSellLamports = maxSellLamports > minReserveLamports 
      ? maxSellLamports - minReserveLamports 
      : 0n;
    
    if (actualSellLamports <= 0n) {
      logger.info({ 
        mint, 
        symbol, 
        balance: initialBalance.balanceUi,
        reason: "Balance too low to flash close SOL safely"
      }, "CLOSE_POSITION: SOL balance too low for flash close");
      return {
        success: false,
        fullyClosed: false,
        soldAmount: 0,
        remainingAmount: initialBalance.balanceUi,
        proceedsUsd: 0,
        realizedPnlUsd: 0,
        txSig: null,
        status: 'paper',
        error: "SOL balance too low for flash close (need reserve for fees)",
      };
    }
    
    sellAmountBaseUnits = actualSellLamports.toString();
    sellAmountUi = Number(actualSellLamports) / 1e9;
    outputMint = MINT_USDC;
    
    logger.info({
      mint,
      reasonCode,
      totalBalanceSol: initialBalance.balanceUi,
      sellAmountSol: sellAmountUi,
      reservedSol: (Number(initialBalance.balanceBaseUnits) - Number(actualSellLamports)) / 1e9,
      maxPct: SOL_FLASH_CLOSE_MAX_PCT,
      outputMint: "USDC",
    }, "SOL_FLASH_CLOSE: Selling SOL for USDC (capital preservation mode)");
  } else {
    const dustBufferTokens = 10n;
    sellAmountBaseUnits = initialBalance.balanceBaseUnits > dustBufferTokens 
      ? (initialBalance.balanceBaseUnits - dustBufferTokens).toString()
      : initialBalance.balanceBaseUnits.toString();
    sellAmountUi = initialBalance.balanceUi;
    outputMint = MINT_SOL;
  }

  logger.info({
    mint,
    reasonCode,
    balanceBefore: initialBalance.balanceUi,
    sellAmount: sellAmountUi,
    sellAmountBaseUnits,
    decimals: initialBalance.decimals,
    symbol,
    outputMint: isSOLFlashClose ? "USDC" : "SOL",
  }, "CLOSE_POSITION_START");

  const tradeReason = mapReasonToTradeReason(reasonCode);
  
  const sellRes = await executeSwap({
    strategy: reasonCode,
    inputMint: mint,
    outputMint,
    inAmountBaseUnits: sellAmountBaseUnits,
    slippageBps: config.maxSlippageBps,
    meta: {
      closePosition: true,
      reasonCode,
      manual: context.manual,
      bypassedPause: context.bypassedPause,
      fullBalanceSell: !isSOLFlashClose,
      isSOLFlashClose,
    },
  }, signer, execMode);

  if (sellRes.status === "insufficient_funds" || sellRes.status === "simulation_failed" || sellRes.status === "error") {
    logger.error({
      mint,
      symbol,
      reasonCode,
      status: sellRes.status,
      error: sellRes.error,
    }, "CLOSE_POSITION: Initial sell failed");

    return {
      success: false,
      fullyClosed: false,
      soldAmount: 0,
      remainingAmount: initialBalance.balanceUi,
      proceedsUsd: 0,
      realizedPnlUsd: 0,
      txSig: null,
      status: sellRes.status,
      error: sellRes.error,
    };
  }

  let proceedsUsd: number;
  let totalSoldAmount = sellAmountUi;
  let txSig = sellRes.txSig;
  
  if (isSOLFlashClose) {
    const usdcReceived = BigInt(sellRes.quote?.outAmount ?? "0");
    proceedsUsd = Number(usdcReceived) / 1e6;
    
    logger.info({
      mint,
      reasonCode,
      soldSol: sellAmountUi,
      receivedUsdc: proceedsUsd,
      remainingSol: (Number(initialBalance.balanceBaseUnits) - Number(BigInt(sellAmountBaseUnits))) / 1e9,
    }, "SOL_FLASH_CLOSE: Completed SOL to USDC conversion");
  } else {
    const solReceivedLamports = BigInt(sellRes.quote?.outAmount ?? "0");
    const solReceived = Number(solReceivedLamports) / 1e9;
    proceedsUsd = solReceived * context.solPriceUsd;
  }

  const analytics = buildTradeAnalytics({
    reason: tradeReason,
    quote: sellRes.quote,
    riskProfile: config.riskProfile,
    exitScore: context.pnlPct,
  });

  const costBasis = context.entryPriceUsd && totalSoldAmount > 0
    ? context.entryPriceUsd * totalSoldAmount
    : 0;
  let realizedPnlUsd = proceedsUsd - costBasis;

  await insertTrade({
    strategy: reasonCode,
    risk_profile: config.riskProfile,
    mode: execMode,
    input_mint: mint,
    output_mint: outputMint,
    in_amount: sellAmountBaseUnits,
    out_amount: sellRes.quote?.outAmount ?? null,
    est_out_amount: sellRes.quote?.outAmount ?? null,
    price_impact_pct: sellRes.quote?.priceImpactPct ?? null,
    slippage_bps: sellRes.quote?.slippageBps ?? null,
    tx_sig: sellRes.txSig,
    status: sellRes.status,
    meta: { 
      closePosition: true, 
      reasonCode, 
      manual: context.manual,
      fullBalanceSell: !isSOLFlashClose,
      isSOLFlashClose,
    },
    pnl_usd: realizedPnlUsd,
    reason_code: analytics.reason_code,
    exit_score: analytics.exit_score,
    fees_lamports: analytics.fees_lamports,
    priority_fee_lamports: analytics.priority_fee_lamports,
    route: analytics.route,
    settings_snapshot: analytics.settings_snapshot,
    peak_pnl_pct: context.peakPnlPct,
    peak_pnl_usd: context.peakPnlUsd,
  }).catch(e => logger.error({ mint, error: String(e) }, "CLOSE_POSITION: Failed to insert trade"));

  if (sellRes.status === 'sent' || sellRes.status === 'paper') {
    try {
      const txSigForFifo = sellRes.txSig ?? `paper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const fifoResult = await processSellWithFIFO(
        txSigForFifo,
        mint,
        symbol,
        totalSoldAmount,
        proceedsUsd,
        new Date(),
        context.solPriceUsd
      );
      realizedPnlUsd = fifoResult.realizedPnl;
      logger.info({ mint, symbol, proceedsUsd: proceedsUsd.toFixed(2), realizedPnl: realizedPnlUsd.toFixed(2) }, "CLOSE_POSITION: FIFO sell recorded");
    } catch (fifoErr) {
      logger.error({ mint, error: String(fifoErr) }, "CLOSE_POSITION: Failed to record FIFO sell");
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  const postSellBalance = await getOnChainTokenBalance(owner, mint);
  
  const dustThresholdUsd = config.dustThresholdUsd ?? 1.0;
  const remainingValueUsd = postSellBalance.balanceUi * (context.currentPriceUsd ?? 0);
  let retried = false;
  
  if (postSellBalance.balanceUi > DUST_THRESHOLD_TOKENS && remainingValueUsd > dustThresholdUsd) {
    logger.warn({
      mint,
      symbol,
      remainingBalance: postSellBalance.balanceUi,
      remainingValueUsd,
      dustThresholdUsd,
    }, "CLOSE_POSITION: Remaining balance above dust - attempting retry sell");

    retried = true;
    const retryDustBuffer = 10n;
    const retryAmountBaseUnits = postSellBalance.balanceBaseUnits > retryDustBuffer
      ? (postSellBalance.balanceBaseUnits - retryDustBuffer).toString()
      : postSellBalance.balanceBaseUnits.toString();

    try {
      const retryRes = await executeSwap({
        strategy: `${reasonCode}_retry`,
        inputMint: mint,
        outputMint: MINT_SOL,
        inAmountBaseUnits: retryAmountBaseUnits,
        slippageBps: Math.min(config.maxSlippageBps * 2, 500),
        meta: {
          closePosition: true,
          reasonCode,
          retry: true,
        },
      }, signer, execMode);

      if (retryRes.status === 'sent' || retryRes.status === 'paper') {
        const retrySolReceived = Number(BigInt(retryRes.quote?.outAmount ?? "0")) / 1e9;
        const retryProceedsUsd = retrySolReceived * context.solPriceUsd;
        proceedsUsd += retryProceedsUsd;
        totalSoldAmount += postSellBalance.balanceUi;
        
        if (retryRes.txSig) {
          txSig = retryRes.txSig;
        }

        logger.info({
          mint,
          symbol,
          retryProceedsUsd,
          totalProceedsUsd: proceedsUsd,
        }, "CLOSE_POSITION: Retry sell succeeded");

        if (retryRes.status === 'sent' || retryRes.status === 'paper') {
          try {
            const retrySigForFifo = retryRes.txSig ?? `paper-retry-${Date.now()}`;
            const retryFifo = await processSellWithFIFO(
              retrySigForFifo,
              mint,
              symbol,
              postSellBalance.balanceUi,
              retryProceedsUsd,
              new Date(),
              context.solPriceUsd
            );
            realizedPnlUsd += retryFifo.realizedPnl;
          } catch (e) {
            logger.warn({ mint, error: String(e) }, "CLOSE_POSITION: Failed to record retry FIFO");
          }
        }
      } else {
        logger.warn({
          mint,
          symbol,
          error: retryRes.error,
          remainingBalance: postSellBalance.balanceUi,
        }, "CLOSE_POSITION: Retry sell failed - partial exit remaining");
      }
    } catch (retryErr) {
      logger.error({ mint, error: String(retryErr) }, "CLOSE_POSITION: Retry sell threw exception");
    }
  }

  const finalBalance = await getOnChainTokenBalance(owner, mint);
  const finalValueUsd = finalBalance.balanceUi * (context.currentPriceUsd ?? 0);
  const fullyClosed = finalBalance.balanceUi <= DUST_THRESHOLD_TOKENS || finalValueUsd <= dustThresholdUsd;

  if (!fullyClosed) {
    logger.warn({
      mint,
      reasonCode,
      balanceRemaining: finalBalance.balanceUi,
      usdRemaining: finalValueUsd,
      symbol,
      dustThresholdUsd,
    }, "PARTIAL_EXIT_REMAINING");
  }

  if (sellRes.status === 'sent' || sellRes.status === 'paper') {
    try {
      await insertRotationLog({
        action: 'exit',
        soldMint: mint,
        soldSymbol: symbol,
        reasonCode,
        meta: {
          txSig,
          soldAmount: totalSoldAmount,
          proceedsUsd,
          realizedPnlUsd,
          pnlPct: context.pnlPct,
          slotType: context.slotType,
          manual: context.manual,
          fullyClosed,
          remainingBalance: finalBalance.balanceUi,
          retried,
          exitType: reasonCode,
          ...(reasonCode === 'flash_close' ? { source: 'dashboard' } : {}),
        },
      });
    } catch (rotLogErr) {
      logger.error({ mint, error: String(rotLogErr) }, "CLOSE_POSITION: Failed to insert rotation log");
    }

    const triggerReasonMap: Record<ClosePositionReasonCode, import('./event_logger.js').TriggerReason> = {
      'scout_stop_loss_exit': 'scout_stop_loss',
      'core_loss_exit': 'core_loss_exit',
      'scout_underperform_grace_expired': 'scout_underperform',
      'scout_take_profit_exit': 'scout_take_profit',
      'take_profit': 'take_profit',
      'flash_close': 'flash_close',
      'universe_exit': 'universe_exit',
    };

    logTradeExit({
      mint,
      symbol,
      decision_price_usd: context.currentPriceUsd ?? 0,
      execution_price_usd: totalSoldAmount > 0 ? proceedsUsd / totalSoldAmount : (context.currentPriceUsd ?? 0),
      realized_pnl_usd: realizedPnlUsd,
      realized_pnl_pct: context.pnlPct ?? 0,
      holding_minutes: 0,
      trigger_reason: triggerReasonMap[reasonCode],
      slippage_bps: 0,
      signal_snapshot: null,
      mode: execMode,
    });

    await enforceExitInvariant({
      mint,
      symbol,
      exitReasonCode: reasonCode,
      lastTradeTxSig: txSig ?? undefined,
      currentPriceUsd: context.currentPriceUsd ?? 0,
      solPriceUsd: context.solPriceUsd,
    }, signer, execMode).catch(e => logger.error({ mint, error: String(e) }, "CLOSE_POSITION: Exit invariant failed"));

    clearJourneyId(mint);
  }

  if (fullyClosed) {
    try {
      await deletePositionTracking(mint);
      if (context.slotType === 'core') {
        logger.info({ mint, symbol, slotType: 'core' }, "CLOSE_POSITION: Core slot freed - position tracking deleted");
      } else {
        logger.info({ mint, symbol, slotType: context.slotType ?? 'unknown' }, "CLOSE_POSITION: Position tracking deleted");
      }
    } catch (e) {
      logger.error({ mint, error: String(e) }, "CLOSE_POSITION: Failed to delete position tracking");
    }
  }

  logger.info({
    mint,
    reasonCode,
    balanceAfter: finalBalance.balanceUi,
    fullyClosed,
    soldAmount: totalSoldAmount,
    proceedsUsd,
    realizedPnlUsd,
    txSig,
    retried,
    symbol,
  }, "CLOSE_POSITION_DONE");

  return {
    success: true,
    fullyClosed,
    soldAmount: totalSoldAmount,
    remainingAmount: finalBalance.balanceUi,
    proceedsUsd,
    realizedPnlUsd,
    txSig,
    status: sellRes.status,
    retried,
  };
}

export async function closePositionForFlashClose(
  mint: string,
  context: ClosePositionContext & { amount?: number; decimals?: number },
  signer: Keypair,
  execMode: ExecutionMode
): Promise<ClosePositionResult & { coreSlotFreed: boolean }> {
  const trackingData = await getPositionTracking(mint);
  const slotType = trackingData?.slot_type as 'core' | 'scout' | undefined;
  const entryPrice = trackingData?.entry_price ?? context.entryPriceUsd;

  const result = await closePosition(
    mint,
    'flash_close',
    {
      ...context,
      slotType,
      entryPriceUsd: entryPrice,
      manual: true,
    },
    signer,
    execMode
  );

  let coreSlotFreed = false;
  
  if (result.success && result.fullyClosed && slotType === 'core') {
    coreSlotFreed = true;
    logger.info({ mint, symbol: context.symbol }, "FLASH_CLOSE: Core slot freed");
  }

  return {
    ...result,
    coreSlotFreed,
  };
}
