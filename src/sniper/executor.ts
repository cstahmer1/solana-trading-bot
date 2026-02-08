import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../utils/logger.js";
import { SNIPER_CONFIG, MINT_SOL, type SniperPosition, type DetectedToken } from "./config.js";
import { env } from "../bot/config.js";
import { executeSwap, solToLamports, getAuthoritativeDecimals, type TradeIntent } from "../bot/execution.js";
import { insertTrade, upsertPositionTracking, deletePositionTracking } from "../bot/persist.js";
import { insertTradeLot, processSellWithFIFO } from "../bot/pnl_engine.js";
import { getTokenPrice, waitForPool } from "./pool_detector.js";
import { addPosition, removePosition, hasPosition, getPositionCount, getPosition } from "./position_tracker.js";
import { getAssetsByOwner } from "../bot/helius.js";
import { buildTradeAnalytics } from "../bot/trade_analytics.js";
import { TRADE_REASONS, type TradeReason } from "../bot/trade_reasons.js";

let botSigner: Keypair | null = null;

function getSigner(): Keypair {
  if (!botSigner) {
    const privateKey = env.BOT_WALLET_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("BOT_WALLET_PRIVATE_KEY not configured");
    }
    botSigner = Keypair.fromSecretKey(bs58.decode(privateKey));
  }
  return botSigner;
}

async function getSolPriceUsd(): Promise<number> {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const data = await response.json() as { solana?: { usd?: number } };
    return data.solana?.usd || 150;
  } catch {
    return 150;
  }
}

export async function executeSniperBuy(token: DetectedToken, skipPoolWait: boolean = false): Promise<SniperPosition | null> {
  const { mint, signature: detectionSig, poolAddress } = token;

  if (hasPosition(mint)) {
    logger.debug({ mint: mint.slice(0, 8) }, "SNIPER: Already have position in this token");
    return null;
  }

  if (getPositionCount() >= SNIPER_CONFIG.maxConcurrentPositions) {
    logger.warn({ count: getPositionCount(), max: SNIPER_CONFIG.maxConcurrentPositions }, "SNIPER: Max positions reached");
    return null;
  }

  let dex: string | null = null;

  if (skipPoolWait && poolAddress) {
    logger.info({ mint: mint.slice(0, 8), poolAddress: poolAddress.slice(0, 8) }, "SNIPER: Skipping pool wait - pool already detected");
    dex = "detected";
  } else {
    const poolInfo = await waitForPool(mint);
    if (!poolInfo || !poolInfo.hasPool) {
      logger.info({ mint: mint.slice(0, 8) }, "SNIPER: No pool found, skipping");
      return null;
    }
    dex = poolInfo.dex;
  }

  const signer = getSigner();
  const solPriceUsd = await getSolPriceUsd();
  const buyAmountLamports = solToLamports(SNIPER_CONFIG.buyAmountSol);

  const intent: TradeIntent = {
    strategy: SNIPER_CONFIG.strategy,
    inputMint: MINT_SOL,
    outputMint: mint,
    inAmountBaseUnits: buyAmountLamports,
    slippageBps: SNIPER_CONFIG.slippageBps,
    meta: {
      type: "sniper_buy",
      detectionSig,
      dex,
    },
  };

  logger.info({
    mint: mint.slice(0, 8),
    buyAmountSol: SNIPER_CONFIG.buyAmountSol,
    dex,
    skipPoolWait,
  }, "SNIPER: Executing buy");

  let result = await executeSwap(intent, signer, "live");
  
  if (skipPoolWait && result.status !== "sent") {
    const maxRetries = 5;
    const retryDelayMs = 2000;
    
    for (let attempt = 1; attempt <= maxRetries && result.status !== "sent"; attempt++) {
      logger.info({ 
        mint: mint.slice(0, 8), 
        attempt, 
        maxRetries,
        lastError: result.error,
      }, "SNIPER: Retrying swap - waiting for Jupiter to index pool");
      
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      result = await executeSwap(intent, signer, "live");
    }
  }

  if (result.status !== "sent" || !result.txSig) {
    logger.error({
      mint: mint.slice(0, 8),
      status: result.status,
      error: result.error,
    }, "SNIPER: Buy execution failed");

    const failedAnalytics = buildTradeAnalytics({
      reason: TRADE_REASONS.BUY_FAILED,
      quote: result.quote,
      riskProfile: "sniper",
    });

    await insertTrade({
      strategy: SNIPER_CONFIG.strategy,
      risk_profile: "sniper",
      mode: "live",
      input_mint: MINT_SOL,
      output_mint: mint,
      in_amount: buyAmountLamports,
      est_out_amount: result.quote?.outAmount,
      slippage_bps: SNIPER_CONFIG.slippageBps,
      tx_sig: null,
      status: result.status,
      meta: { error: result.error, type: "sniper_buy_failed" },
      reason_code: failedAnalytics.reason_code,
      fees_lamports: failedAnalytics.fees_lamports,
      priority_fee_lamports: failedAnalytics.priority_fee_lamports,
      settings_snapshot: failedAnalytics.settings_snapshot,
    });

    return null;
  }

  const tokenQuantity = result.quote ? parseInt(result.quote.outAmount) : 0;
  const decimals = await getAuthoritativeDecimals(mint);
  const tokenQuantityUi = tokenQuantity / Math.pow(10, decimals);
  const costBasisUsd = SNIPER_CONFIG.buyAmountSol * solPriceUsd;
  const entryPriceUsd = tokenQuantityUi > 0 ? costBasisUsd / tokenQuantityUi : 0;

  const buyAnalytics = buildTradeAnalytics({
    reason: TRADE_REASONS.BUY_SNIPER,
    quote: result.quote,
    riskProfile: "sniper",
    entryScore: 0, // Sniper doesn't use scoring
  });

  await insertTrade({
    strategy: SNIPER_CONFIG.strategy,
    risk_profile: "sniper",
    mode: "live",
    input_mint: MINT_SOL,
    output_mint: mint,
    in_amount: buyAmountLamports,
    out_amount: result.quote?.outAmount,
    est_out_amount: result.quote?.outAmount,
    price_impact_pct: result.quote?.priceImpactPct,
    slippage_bps: SNIPER_CONFIG.slippageBps,
    tx_sig: result.txSig,
    status: "confirmed",
    meta: {
      type: "sniper_buy",
      dex,
      entryPriceUsd,
      costBasisUsd,
      tokenQuantity: tokenQuantityUi,
    },
    reason_code: buyAnalytics.reason_code,
    entry_score: buyAnalytics.entry_score,
    fees_lamports: buyAnalytics.fees_lamports,
    priority_fee_lamports: buyAnalytics.priority_fee_lamports,
    route: buyAnalytics.route,
    settings_snapshot: buyAnalytics.settings_snapshot,
    liquidity_usd: buyAnalytics.liquidity_usd,
  });

  await insertTradeLot({
    tx_sig: result.txSig,
    timestamp: new Date(),
    mint,
    side: "buy",
    quantity: tokenQuantityUi,
    usd_value: costBasisUsd,
    unit_price_usd: entryPriceUsd,
    sol_price_usd: solPriceUsd,
    source: "sniper",
  });

  await upsertPositionTracking({
    mint,
    entryPrice: entryPriceUsd,
    currentPrice: entryPriceUsd,
    totalTokens: tokenQuantityUi,
    slotType: "scout",
    source: "sniper",
  });

  const position: SniperPosition = {
    id: `sniper_${Date.now()}_${mint.slice(0, 8)}`,
    mint,
    symbol: mint.slice(0, 6),
    entryPriceUsd,
    entryTimestamp: new Date(),
    tokenQuantity: tokenQuantityUi,
    costBasisSol: SNIPER_CONFIG.buyAmountSol,
    costBasisUsd,
    txSig: result.txSig,
    status: "open",
  };

  addPosition(position);

  logger.info({
    mint: mint.slice(0, 8),
    txSig: result.txSig,
    tokenQuantity: tokenQuantityUi.toFixed(4),
    entryPriceUsd: entryPriceUsd.toFixed(8),
    costBasisUsd: costBasisUsd.toFixed(4),
  }, "SNIPER: Position opened successfully");

  return position;
}

export async function executeSniperSell(
  position: SniperPosition, 
  currentPriceUsd: number, 
  reason: "take_profit" | "stop_loss" | "manual"
): Promise<boolean> {
  const { mint, tokenQuantity, entryPriceUsd, costBasisUsd } = position;
  
  const signer = getSigner();
  const solPriceUsd = await getSolPriceUsd();

  const holdings = await getAssetsByOwner(signer.publicKey.toBase58());
  const tokenInfo = holdings?.tokens.find(t => t.mint === mint);
  
  if (!tokenInfo || tokenInfo.balance <= 0) {
    logger.warn({ mint: mint.slice(0, 8) }, "SNIPER: No token balance found for sell");
    removePosition(mint);
    return false;
  }

  const decimals = await getAuthoritativeDecimals(mint);
  const sellAmountBaseUnits = Math.floor(tokenInfo.balance * Math.pow(10, decimals)).toString();

  const intent: TradeIntent = {
    strategy: SNIPER_CONFIG.strategy,
    inputMint: mint,
    outputMint: MINT_SOL,
    inAmountBaseUnits: sellAmountBaseUnits,
    slippageBps: SNIPER_CONFIG.slippageBps,
    meta: {
      type: "sniper_sell",
      reasonCode: `sniper_${reason}`,
      reason,
      entryPriceUsd,
      currentPriceUsd,
    },
  };

  logger.info({
    mint: mint.slice(0, 8),
    reason,
    tokenQuantity: tokenInfo.balance.toFixed(4),
    entryPriceUsd: entryPriceUsd.toFixed(8),
    currentPriceUsd: currentPriceUsd.toFixed(8),
  }, "SNIPER: Executing sell");

  const result = await executeSwap(intent, signer, "live");

  if (result.status !== "sent" || !result.txSig) {
    logger.error({
      mint: mint.slice(0, 8),
      status: result.status,
      error: result.error,
    }, "SNIPER: Sell execution failed");

    const sellFailedAnalytics = buildTradeAnalytics({
      reason: TRADE_REASONS.SELL_FAILED,
      quote: result.quote,
      riskProfile: "sniper",
    });

    await insertTrade({
      strategy: SNIPER_CONFIG.strategy,
      risk_profile: "sniper",
      mode: "live",
      input_mint: mint,
      output_mint: MINT_SOL,
      in_amount: sellAmountBaseUnits,
      est_out_amount: result.quote?.outAmount,
      slippage_bps: SNIPER_CONFIG.slippageBps,
      tx_sig: null,
      status: result.status,
      meta: { error: result.error, type: "sniper_sell_failed", reason },
      reason_code: sellFailedAnalytics.reason_code,
      fees_lamports: sellFailedAnalytics.fees_lamports,
      priority_fee_lamports: sellFailedAnalytics.priority_fee_lamports,
      settings_snapshot: sellFailedAnalytics.settings_snapshot,
    });

    return false;
  }

  const soldSolLamports = result.quote ? parseInt(result.quote.outAmount) : 0;
  const proceedsSOL = soldSolLamports / 1e9;
  const proceedsUsd = proceedsSOL * solPriceUsd;
  const realizedPnlUsd = proceedsUsd - costBasisUsd;
  const pnlPct = costBasisUsd > 0 ? ((proceedsUsd - costBasisUsd) / costBasisUsd) * 100 : 0;

  // Map sniper reason to TRADE_REASONS code
  const reasonCodeMap: Record<string, TradeReason> = {
    take_profit: TRADE_REASONS.SELL_TAKE_PROFIT,
    stop_loss: TRADE_REASONS.SELL_STOP_LOSS,
    timeout: TRADE_REASONS.SELL_TIMEOUT,
    manual: TRADE_REASONS.SELL_MANUAL,
  };
  const sellReasonCode = reasonCodeMap[reason] ?? TRADE_REASONS.SELL_EXIT_OTHER;

  const sellAnalytics = buildTradeAnalytics({
    reason: sellReasonCode,
    quote: result.quote,
    riskProfile: "sniper",
    exitScore: pnlPct,
  });

  await insertTrade({
    strategy: SNIPER_CONFIG.strategy,
    risk_profile: "sniper",
    mode: "live",
    input_mint: mint,
    output_mint: MINT_SOL,
    in_amount: sellAmountBaseUnits,
    out_amount: result.quote?.outAmount,
    est_out_amount: result.quote?.outAmount,
    price_impact_pct: result.quote?.priceImpactPct,
    slippage_bps: SNIPER_CONFIG.slippageBps,
    tx_sig: result.txSig,
    status: "confirmed",
    pnl_usd: realizedPnlUsd,
    meta: {
      type: "sniper_sell",
      reason,
      entryPriceUsd,
      exitPriceUsd: currentPriceUsd,
      costBasisUsd,
      proceedsUsd,
      realizedPnlUsd,
      pnlPct,
    },
    reason_code: sellAnalytics.reason_code,
    exit_score: sellAnalytics.exit_score,
    fees_lamports: sellAnalytics.fees_lamports,
    priority_fee_lamports: sellAnalytics.priority_fee_lamports,
    route: sellAnalytics.route,
    settings_snapshot: sellAnalytics.settings_snapshot,
    liquidity_usd: sellAnalytics.liquidity_usd,
  });

  await processSellWithFIFO(
    result.txSig,
    mint,
    position.symbol,
    tokenInfo.balance,
    proceedsUsd,
    new Date(),
    solPriceUsd
  );

  position.status = "closed";
  position.exitPriceUsd = currentPriceUsd;
  position.exitTimestamp = new Date();
  position.exitTxSig = result.txSig;
  position.pnlUsd = realizedPnlUsd;
  position.pnlPct = pnlPct;
  position.exitReason = reason;

  removePosition(mint);
  await deletePositionTracking(mint);

  logger.info({
    mint: mint.slice(0, 8),
    txSig: result.txSig,
    reason,
    proceedsUsd: proceedsUsd.toFixed(4),
    realizedPnlUsd: realizedPnlUsd.toFixed(4),
    pnlPct: pnlPct.toFixed(2),
  }, "SNIPER: Position closed successfully");

  return true;
}
