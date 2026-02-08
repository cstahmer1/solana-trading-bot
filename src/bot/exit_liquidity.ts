import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import { jupQuote, type QuoteResponse } from "./jupiter.js";
import { MINT_SOL } from "./config.js";

export type Lane = "scout" | "core";

export interface ExitLiquiditySettings {
  enabled: boolean;
  maxExitImpactPctScout: number;
  maxExitImpactPctCore: number;
  minRoundTripRatioScout: number;
  minRoundTripRatioCore: number;
  maxRouteHopsScout: number;
  maxRouteHopsCore: number;
  disallowIntermediateMints: string[];
  safetyHaircut: number;
}

export interface ExitLiquidityResult {
  ok: boolean;
  reason: string;
  lane: Lane;
  notionalSol: number;
  exitNotionalToken: number;
  buyQuoteOutToken: number;
  sellQuoteOutSol: number;
  roundTripRatio: number;
  estimatedExitImpactPct: number | null;
  routeHops: number | null;
  routeMints: string[];
}

function extractRouteInfo(routePlan: any[]): { hops: number; mints: string[] } {
  if (!routePlan || !Array.isArray(routePlan)) {
    return { hops: 0, mints: [] };
  }
  
  const mints: string[] = [];
  let hops = 0;
  
  for (const step of routePlan) {
    hops++;
    if (step.swapInfo) {
      if (step.swapInfo.inputMint) mints.push(step.swapInfo.inputMint);
      if (step.swapInfo.outputMint) mints.push(step.swapInfo.outputMint);
    }
  }
  
  const uniqueMints = [...new Set(mints)];
  return { hops, mints: uniqueMints };
}

function getThresholds(lane: Lane, settings: ExitLiquiditySettings) {
  if (lane === "scout") {
    return {
      maxImpact: settings.maxExitImpactPctScout,
      minRoundTrip: settings.minRoundTripRatioScout,
      maxHops: settings.maxRouteHopsScout,
    };
  }
  return {
    maxImpact: settings.maxExitImpactPctCore,
    minRoundTrip: settings.minRoundTripRatioCore,
    maxHops: settings.maxRouteHopsCore,
  };
}

export function getExitLiquiditySettings(): ExitLiquiditySettings {
  const config = getConfig();
  return {
    enabled: config.exitLiquidityCheckEnabled,
    maxExitImpactPctScout: config.exitLiqMaxImpactPctScout,
    maxExitImpactPctCore: config.exitLiqMaxImpactPctCore,
    minRoundTripRatioScout: config.exitLiqMinRoundTripScout,
    minRoundTripRatioCore: config.exitLiqMinRoundTripCore,
    maxRouteHopsScout: config.exitLiqMaxHopsScout,
    maxRouteHopsCore: config.exitLiqMaxHopsCore,
    disallowIntermediateMints: config.exitLiqDisallowMints.split(",").map(s => s.trim()).filter(Boolean),
    safetyHaircut: config.exitLiqSafetyHaircut,
  };
}

export interface CheckExitLiquidityParams {
  lane: Lane;
  inputSolLamports: string;
  outputMint: string;
  slippageBps: number;
  overrideExitTokens?: number;
}

export async function checkExitLiquidityForEntry(
  params: CheckExitLiquidityParams
): Promise<ExitLiquidityResult> {
  const { lane, inputSolLamports, outputMint, slippageBps, overrideExitTokens } = params;
  const settings = getExitLiquiditySettings();
  const thresholds = getThresholds(lane, settings);
  
  const inputSolNum = parseInt(inputSolLamports) / 1e9;
  
  const baseResult: ExitLiquidityResult = {
    ok: false,
    reason: "UNKNOWN",
    lane,
    notionalSol: inputSolNum,
    exitNotionalToken: 0,
    buyQuoteOutToken: 0,
    sellQuoteOutSol: 0,
    roundTripRatio: 0,
    estimatedExitImpactPct: null,
    routeHops: null,
    routeMints: [],
  };
  
  if (!settings.enabled) {
    return { ...baseResult, ok: true, reason: "DISABLED" };
  }
  
  const logEarlyFailure = (reason: string, extra: Record<string, any> = {}) => {
    logger.warn({
      mint: outputMint,
      lane,
      notionalSol: inputSolNum.toFixed(4),
      reason,
      ...extra,
    }, "EXIT_LIQ_CHECK_FAIL");
  };

  let buyQuote: QuoteResponse;
  try {
    buyQuote = await jupQuote({
      inputMint: MINT_SOL,
      outputMint,
      amount: inputSolLamports,
      slippageBps,
    });
  } catch (err: any) {
    logEarlyFailure("NO_BUY_QUOTE", { error: err.message });
    return { ...baseResult, reason: "NO_BUY_QUOTE" };
  }
  
  const buyQuoteOutToken = parseInt(buyQuote.outAmount);
  if (!buyQuoteOutToken || buyQuoteOutToken === 0) {
    logEarlyFailure("BUY_QUOTE_ZERO");
    return { ...baseResult, reason: "BUY_QUOTE_ZERO" };
  }
  
  baseResult.buyQuoteOutToken = buyQuoteOutToken;
  
  let exitTokens: number;
  if (overrideExitTokens !== undefined && overrideExitTokens > 0) {
    exitTokens = Math.floor(overrideExitTokens * settings.safetyHaircut);
  } else {
    exitTokens = Math.floor(buyQuoteOutToken * settings.safetyHaircut);
  }
  baseResult.exitNotionalToken = exitTokens;
  
  let sellQuote: QuoteResponse;
  try {
    sellQuote = await jupQuote({
      inputMint: outputMint,
      outputMint: MINT_SOL,
      amount: String(exitTokens),
      slippageBps: slippageBps * 2,
    });
  } catch (err: any) {
    logEarlyFailure("NO_SELL_QUOTE", { error: err.message, exitTokens });
    return { ...baseResult, reason: "NO_SELL_QUOTE" };
  }
  
  const sellQuoteOutSol = parseInt(sellQuote.outAmount);
  if (!sellQuoteOutSol || sellQuoteOutSol === 0) {
    logEarlyFailure("SELL_QUOTE_ZERO", { exitTokens });
    return { ...baseResult, reason: "SELL_QUOTE_ZERO" };
  }
  
  baseResult.sellQuoteOutSol = sellQuoteOutSol;
  
  const inputSolLamportsNum = parseInt(inputSolLamports);
  const scaledSellOut = sellQuoteOutSol / settings.safetyHaircut;
  const roundTripRatio = scaledSellOut / inputSolLamportsNum;
  baseResult.roundTripRatio = roundTripRatio;
  
  const exitImpact = parseFloat(sellQuote.priceImpactPct);
  baseResult.estimatedExitImpactPct = exitImpact;
  
  const routeInfo = extractRouteInfo(sellQuote.routePlan);
  baseResult.routeHops = routeInfo.hops;
  baseResult.routeMints = routeInfo.mints;
  
  const intermediates = routeInfo.mints.filter(
    m => m !== MINT_SOL && m !== outputMint
  );
  
  const logFailure = (reason: string) => {
    logger.warn({
      mint: outputMint,
      lane,
      notionalSol: inputSolNum.toFixed(4),
      roundTripRatio: roundTripRatio.toFixed(4),
      exitImpactPct: exitImpact.toFixed(4),
      routeHops: routeInfo.hops,
      routeIntermediates: intermediates,
      reason,
      thresholds: {
        minRoundTrip: thresholds.minRoundTrip,
        maxImpact: thresholds.maxImpact,
        maxHops: thresholds.maxHops,
      },
    }, "EXIT_LIQ_CHECK_FAIL");
  };
  
  if (roundTripRatio < thresholds.minRoundTrip) {
    logFailure("ROUNDTRIP_TOO_LOW");
    return { ...baseResult, reason: "ROUNDTRIP_TOO_LOW" };
  }
  
  if (exitImpact > thresholds.maxImpact) {
    logFailure("IMPACT_TOO_HIGH");
    return { ...baseResult, reason: "EXIT_TOO_COSTLY" };
  }
  
  if (routeInfo.hops > thresholds.maxHops) {
    logFailure("ROUTE_TOO_LONG");
    return { ...baseResult, reason: "ROUTE_TOO_FRAGMENTED" };
  }
  
  if (settings.disallowIntermediateMints.length > 0) {
    for (const mint of intermediates) {
      if (settings.disallowIntermediateMints.includes(mint)) {
        logFailure("ROUTE_BLACKLISTED");
        return { ...baseResult, reason: "ROUTE_BLACKLISTED" };
      }
    }
  }
  
  logger.info({
    outputMint,
    lane,
    roundTripRatio: roundTripRatio.toFixed(4),
    exitImpactPct: exitImpact.toFixed(4),
    routeHops: routeInfo.hops,
    inputSol: inputSolNum.toFixed(4),
    sellOutSol: (sellQuoteOutSol / 1e9).toFixed(4),
  }, "EXIT_LIQ_CHECK: Passed");
  
  return { ...baseResult, ok: true, reason: "PASSED" };
}

export async function checkPromotionExitLiquidity(params: {
  mint: string;
  currentTokenQty: number;
  coreBuyDeltaSol: number;
  slippageBps: number;
}): Promise<ExitLiquidityResult> {
  const { mint, currentTokenQty, coreBuyDeltaSol, slippageBps } = params;
  const settings = getExitLiquiditySettings();
  
  const baseResult: ExitLiquidityResult = {
    ok: false,
    reason: "UNKNOWN",
    lane: "core",
    notionalSol: coreBuyDeltaSol,
    exitNotionalToken: 0,
    buyQuoteOutToken: 0,
    sellQuoteOutSol: 0,
    roundTripRatio: 0,
    estimatedExitImpactPct: null,
    routeHops: null,
    routeMints: [],
  };
  
  if (!settings.enabled) {
    return { ...baseResult, ok: true, reason: "DISABLED" };
  }
  
  const coreBuyLamports = String(Math.floor(coreBuyDeltaSol * 1e9));
  
  const logPromoFailure = (reason: string, extra: Record<string, any> = {}) => {
    logger.warn({
      mint,
      lane: "core",
      notionalSol: coreBuyDeltaSol.toFixed(4),
      currentTokenQty,
      reason,
      ...extra,
    }, "PROMOTION_EXIT_LIQ_FAIL");
  };
  
  let buyQuote: QuoteResponse;
  try {
    buyQuote = await jupQuote({
      inputMint: MINT_SOL,
      outputMint: mint,
      amount: coreBuyLamports,
      slippageBps,
    });
  } catch (err: any) {
    logPromoFailure("NO_BUY_QUOTE", { error: err.message });
    return { ...baseResult, reason: "PROMO_NO_BUY_QUOTE" };
  }
  
  const additionalTokens = parseInt(buyQuote.outAmount);
  if (!additionalTokens || additionalTokens === 0) {
    logPromoFailure("BUY_QUOTE_ZERO");
    return { ...baseResult, reason: "PROMO_BUY_QUOTE_ZERO" };
  }
  
  baseResult.buyQuoteOutToken = additionalTokens;
  
  const totalTokensPostPromo = currentTokenQty + additionalTokens;
  const exitTokens = Math.floor(totalTokensPostPromo * settings.safetyHaircut);
  baseResult.exitNotionalToken = exitTokens;
  
  let sellQuote: QuoteResponse;
  try {
    sellQuote = await jupQuote({
      inputMint: mint,
      outputMint: MINT_SOL,
      amount: String(exitTokens),
      slippageBps: slippageBps * 2,
    });
  } catch (err: any) {
    logPromoFailure("NO_SELL_QUOTE", { error: err.message, exitTokens, totalTokensPostPromo });
    return { ...baseResult, reason: "PROMO_NO_SELL_QUOTE" };
  }
  
  const sellQuoteOutSol = parseInt(sellQuote.outAmount);
  if (!sellQuoteOutSol || sellQuoteOutSol === 0) {
    logPromoFailure("SELL_QUOTE_ZERO", { exitTokens, totalTokensPostPromo });
    return { ...baseResult, reason: "PROMO_SELL_QUOTE_ZERO" };
  }
  
  baseResult.sellQuoteOutSol = sellQuoteOutSol;
  
  const expectedTotalSol = coreBuyDeltaSol * 1e9 + (currentTokenQty > 0 ? coreBuyDeltaSol * 1e9 * 0.5 : 0);
  const scaledSellOut = sellQuoteOutSol / settings.safetyHaircut;
  const roundTripRatio = scaledSellOut / (parseInt(coreBuyLamports) + (currentTokenQty > 0 ? parseInt(coreBuyLamports) * 0.3 : 0));
  baseResult.roundTripRatio = Math.min(roundTripRatio, 1.5);
  
  const exitImpact = parseFloat(sellQuote.priceImpactPct);
  baseResult.estimatedExitImpactPct = exitImpact;
  
  const routeInfo = extractRouteInfo(sellQuote.routePlan);
  baseResult.routeHops = routeInfo.hops;
  baseResult.routeMints = routeInfo.mints;
  
  const thresholds = getThresholds("core", settings);
  const intermediates = routeInfo.mints.filter(m => m !== MINT_SOL && m !== mint);
  
  if (exitImpact > thresholds.maxImpact) {
    logPromoFailure("IMPACT_TOO_HIGH", {
      exitImpactPct: exitImpact.toFixed(4),
      routeHops: routeInfo.hops,
      routeIntermediates: intermediates,
      totalTokensPostPromo,
      thresholds: { maxImpact: thresholds.maxImpact, maxHops: thresholds.maxHops },
    });
    return { ...baseResult, reason: "PROMO_EXIT_TOO_COSTLY" };
  }
  
  if (routeInfo.hops > thresholds.maxHops) {
    logPromoFailure("ROUTE_TOO_LONG", {
      exitImpactPct: exitImpact.toFixed(4),
      routeHops: routeInfo.hops,
      routeIntermediates: intermediates,
      totalTokensPostPromo,
      thresholds: { maxImpact: thresholds.maxImpact, maxHops: thresholds.maxHops },
    });
    return { ...baseResult, reason: "PROMO_ROUTE_TOO_FRAGMENTED" };
  }
  
  logger.info({
    mint,
    currentTokenQty,
    additionalTokens,
    totalTokensPostPromo,
    exitImpactPct: exitImpact.toFixed(4),
    routeHops: routeInfo.hops,
  }, "PROMO_EXIT_LIQ: Promotion exit liquidity check passed");
  
  return { ...baseResult, ok: true, reason: "PASSED" };
}
