import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import { jupQuote } from "./jupiter.js";
import { MINT_SOL } from "./config.js";

export interface SellabilityCheckResult {
  pass: boolean;
  failReason: string | null;
  buyQuoteOutAmount: string | null;
  sellQuoteOutAmount: string | null;
  roundTripRatio: number | null;
  sellPriceImpactPct: number | null;
  buyPriceImpactPct: number | null;
}

export async function checkSellability(
  tokenMint: string,
  buyAmountLamports: string,
  slippageBps: number
): Promise<SellabilityCheckResult> {
  const config = getConfig();
  
  const result: SellabilityCheckResult = {
    pass: false,
    failReason: null,
    buyQuoteOutAmount: null,
    sellQuoteOutAmount: null,
    roundTripRatio: null,
    sellPriceImpactPct: null,
    buyPriceImpactPct: null,
  };
  
  try {
    const buyQuote = await jupQuote({
      inputMint: MINT_SOL,
      outputMint: tokenMint,
      amount: buyAmountLamports,
      slippageBps,
    });
    
    result.buyQuoteOutAmount = buyQuote.outAmount;
    result.buyPriceImpactPct = parseFloat(buyQuote.priceImpactPct);
    
    if (!buyQuote.outAmount || buyQuote.outAmount === "0") {
      result.failReason = "BUY_QUOTE_ZERO";
      logger.warn({
        tokenMint,
        buyAmountLamports,
      }, "SELLABILITY_CHECK: Buy quote returned zero output");
      return result;
    }
    
    const tokenAmountToSell = Math.floor(parseInt(buyQuote.outAmount) * 0.90).toString();
    
    let sellQuote;
    try {
      sellQuote = await jupQuote({
        inputMint: tokenMint,
        outputMint: MINT_SOL,
        amount: tokenAmountToSell,
        slippageBps: slippageBps * 2,
      });
    } catch (sellErr: any) {
      result.failReason = "SELL_QUOTE_FAILED";
      logger.warn({
        tokenMint,
        tokenAmountToSell,
        error: sellErr.message,
      }, "SELLABILITY_CHECK: Sell quote failed - possible honeypot");
      return result;
    }
    
    result.sellQuoteOutAmount = sellQuote.outAmount;
    result.sellPriceImpactPct = parseFloat(sellQuote.priceImpactPct);
    
    if (!sellQuote.outAmount || sellQuote.outAmount === "0") {
      result.failReason = "SELL_QUOTE_ZERO";
      logger.warn({
        tokenMint,
        tokenAmountToSell,
      }, "SELLABILITY_CHECK: Sell quote returned zero - honeypot detected");
      return result;
    }
    
    const buyInSol = parseInt(buyAmountLamports);
    const sellOutSol = parseInt(sellQuote.outAmount);
    const scaledSellOut = sellOutSol / 0.90;
    
    const roundTripRatio = scaledSellOut / buyInSol;
    result.roundTripRatio = roundTripRatio;
    
    const minRatio = config.prebuyRoundtripMinRatio;
    if (roundTripRatio < minRatio) {
      result.failReason = "ROUNDTRIP_RATIO_LOW";
      logger.warn({
        tokenMint,
        roundTripRatio: roundTripRatio.toFixed(4),
        minRequired: minRatio,
        buyInSol: buyInSol / 1e9,
        sellOutSol: sellOutSol / 1e9,
      }, "SELLABILITY_CHECK: Round-trip ratio too low - excessive slippage or tax");
      return result;
    }
    
    const maxSellImpact = config.prebuyMaxSellImpactPct;
    if (result.sellPriceImpactPct > maxSellImpact) {
      result.failReason = "SELL_IMPACT_HIGH";
      logger.warn({
        tokenMint,
        sellPriceImpactPct: result.sellPriceImpactPct.toFixed(4),
        maxAllowed: maxSellImpact,
      }, "SELLABILITY_CHECK: Sell price impact too high");
      return result;
    }
    
    result.pass = true;
    logger.info({
      tokenMint,
      roundTripRatio: roundTripRatio.toFixed(4),
      sellPriceImpactPct: result.sellPriceImpactPct.toFixed(4),
      buyPriceImpactPct: result.buyPriceImpactPct?.toFixed(4),
    }, "SELLABILITY_CHECK: Passed");
    
    return result;
    
  } catch (err: any) {
    result.failReason = "CHECK_ERROR";
    logger.error({
      tokenMint,
      error: err.message,
    }, "SELLABILITY_CHECK: Unexpected error");
    return result;
  }
}
