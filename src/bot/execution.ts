import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { env, MINT_SOL } from "./config.js";
import { jupQuote, jupSwapTx, type QuoteResponse } from "./jupiter.js";
import { connection, sendVersionedTx } from "./solana.js";
import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import {
  getPriorityFeeLamports as feeGovGetPriorityFee,
  logFeeDecision,
  getFallbackPriorityFeeLamports,
  getFallbackPriorityLevel,
  type TradeContext,
  type FeeSettings,
  type FeeDecision,
  type Lane,
  type Side,
  type Urgency,
} from "./feeGovernor.js";

const DUST_BUFFER = 10n;
const BASE_FEE_LAMPORTS = 10_000n;
const ATA_RENT_LAMPORTS = 2_039_280n;
const SAFETY_BUFFER_LAMPORTS = 5_000_000n;

const JUPITER_ERRORS: Record<number, { name: string; action: string }> = {
  6001: { name: "SlippageToleranceExceeded", action: "Increase slippage or reduce trade size" },
  6024: { name: "InsufficientFunds", action: "Check token balance and SOL for fees/rent" },
  6000: { name: "EmptyRoute", action: "No route found, try different token pair" },
  6002: { name: "ZeroInAmount", action: "Trade amount is zero" },
  6003: { name: "ZeroOutAmount", action: "Expected output is zero" },
};

export type TradeIntent = {
  strategy: string;
  inputMint: string;
  outputMint: string;
  inAmountBaseUnits: string;
  estOutAmountBaseUnits?: string;
  slippageBps: number;
  meta?: Record<string, any>;
};

export type ExecutionMode = "live" | "paper";

export type FeeDecisionSummary = {
  maxLamports: number;
  priorityLevel: string;
  reason: string;
  skipRecommended: boolean;
  effectiveRatio: number;
};

export type SwapResult = {
  status: "sent" | "paper" | "insufficient_funds" | "simulation_failed" | "error";
  quote: QuoteResponse | null;
  txSig: string | null;
  swap: any;
  error?: string;
  preflightDetails?: PreflightDetails;
  feeDecision?: FeeDecisionSummary;
};

export type PreflightDetails = {
  tokenBalanceBaseUnits: string;
  tokenBalanceHuman: string;
  requestedAmountBaseUnits: string;
  clampedAmountBaseUnits: string;
  solBalanceLamports: string;
  solBalanceHuman: string;
  requiredLamports: string;
  requiredSolHuman: string;
  priorityFeeLamports: string;
  hasSufficientSol: boolean;
  hasSufficientToken: boolean;
};

async function getTokenBalance(owner: PublicKey, mint: string): Promise<{ balanceBaseUnits: bigint; decimals: number }> {
  if (mint === MINT_SOL) {
    const lamports = await connection.getBalance(owner, "confirmed");
    return { balanceBaseUnits: BigInt(lamports), decimals: 9 };
  }

  const mintPk = new PublicKey(mint);
  
  // Try both SPL Token and Token-2022 programs
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  
  for (const programId of programs) {
    try {
      const ata = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
      const info = await connection.getTokenAccountBalance(ata, "confirmed");
      const decimals = info.value.decimals;
      const amount = info.value.amount;
      logger.debug({ mint: mint.slice(0, 8), program: programId.toBase58().slice(0, 8), balance: amount }, "Token balance found");
      return { balanceBaseUnits: BigInt(amount), decimals };
    } catch {
      // Try next program
    }
  }
  
  // ATA doesn't exist for either program - fetch mint info to get correct decimals
  try {
    const mintInfo = await getMint(connection, mintPk);
    return { balanceBaseUnits: 0n, decimals: mintInfo.decimals };
  } catch {
    // Fallback to common default if mint fetch fails
    return { balanceBaseUnits: 0n, decimals: 9 };
  }
}

function getLegacyPriorityFeeLamports(riskProfile: string): bigint {
  switch (riskProfile) {
    case "degen": return 5_000_000n;
    case "high": return 2_000_000n;
    case "moderate": return 1_000_000n;
    default: return 500_000n;
  }
}

function computeRequiredLamports(riskProfile: string): bigint {
  const priorityFee = getLegacyPriorityFeeLamports(riskProfile);
  return BASE_FEE_LAMPORTS + priorityFee + ATA_RENT_LAMPORTS + SAFETY_BUFFER_LAMPORTS;
}

function inferLaneFromIntent(intent: TradeIntent): Lane {
  const strategy = intent.strategy.toLowerCase();
  if (strategy.includes("scout") || strategy.includes("autonomous")) {
    return "scout";
  }
  if (intent.meta?.lane === "scout" || intent.meta?.scoutQueueItem) {
    return "scout";
  }
  return "core";
}

function inferSideFromIntent(intent: TradeIntent): Side {
  return intent.inputMint === MINT_SOL ? "buy" : "sell";
}

function inferUrgencyFromIntent(intent: TradeIntent, side: Side): Urgency {
  if (side === "sell") return "high";
  if (intent.meta?.urgency === "high") return "high";
  const strategy = intent.strategy.toLowerCase();
  if (strategy.includes("exit") || strategy.includes("stop") || strategy.includes("trailing")) {
    return "high";
  }
  return "normal";
}

function getFeeSettingsFromConfig(config: ReturnType<typeof getConfig>): FeeSettings {
  return {
    feeGovernorEnabled: config.feeGovernorEnabled,
    feeRatioPerLegScout: config.feeRatioPerLegScout,
    feeRatioPerLegCore: config.feeRatioPerLegCore,
    minPriorityFeeLamportsEntry: config.minPriorityFeeLamportsEntry,
    minPriorityFeeLamportsExit: config.minPriorityFeeLamportsExit,
    maxPriorityFeeLamportsScout: config.maxPriorityFeeLamportsScout,
    maxPriorityFeeLamportsCore: config.maxPriorityFeeLamportsCore,
    retryLadderMultipliers: config.retryLadderMultipliers,
    feeSafetyHaircut: config.feeSafetyHaircut,
    maxFeeRatioHardPerLeg: config.maxFeeRatioHardPerLeg,
    feeRatioGuardEnabled: config.feeRatioGuardEnabled,
  };
}

async function performPreflight(
  owner: PublicKey,
  inputMint: string,
  requestedAmountBaseUnits: string,
  riskProfile: string
): Promise<PreflightDetails & { clampedAmount: bigint }> {
  const { balanceBaseUnits, decimals } = await getTokenBalance(owner, inputMint);
  const solLamports = BigInt(await connection.getBalance(owner, "confirmed"));
  
  const requested = BigInt(requestedAmountBaseUnits);
  const maxUsable = balanceBaseUnits > DUST_BUFFER ? balanceBaseUnits - DUST_BUFFER : 0n;
  const clamped = requested < maxUsable ? requested : maxUsable;
  
  const requiredLamports = computeRequiredLamports(riskProfile);
  const priorityFee = getLegacyPriorityFeeLamports(riskProfile);
  
  const divisor = 10n ** BigInt(decimals);
  const tokenHuman = Number(balanceBaseUnits) / Number(divisor);
  
  return {
    tokenBalanceBaseUnits: balanceBaseUnits.toString(),
    tokenBalanceHuman: tokenHuman.toFixed(decimals > 6 ? 6 : decimals),
    requestedAmountBaseUnits,
    clampedAmountBaseUnits: clamped.toString(),
    clampedAmount: clamped,
    solBalanceLamports: solLamports.toString(),
    solBalanceHuman: (Number(solLamports) / 1e9).toFixed(6),
    requiredLamports: requiredLamports.toString(),
    requiredSolHuman: (Number(requiredLamports) / 1e9).toFixed(6),
    priorityFeeLamports: priorityFee.toString(),
    hasSufficientSol: solLamports >= requiredLamports,
    hasSufficientToken: clamped > 0n,
  };
}

function decodeJupiterError(logs: string[] | null): { code: number; name: string; action: string } | null {
  if (!logs) return null;
  
  for (const log of logs) {
    const match = log.match(/custom program error: (0x[0-9a-fA-F]+|[0-9]+)/);
    if (match) {
      const code = match[1].startsWith("0x") 
        ? parseInt(match[1], 16) 
        : parseInt(match[1], 10);
      
      const errorInfo = JUPITER_ERRORS[code];
      if (errorInfo) {
        return { code, ...errorInfo };
      }
      return { code, name: `UnknownError_${code}`, action: "Check transaction logs" };
    }
  }
  return null;
}

async function simulateSwap(
  swapTxB64: string,
  signer: Keypair
): Promise<{ success: boolean; error?: string; jupiterError?: ReturnType<typeof decodeJupiterError> }> {
  try {
    const buf = Buffer.from(swapTxB64, "base64");
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([signer]);
    
    const result = await connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: true,
    });
    
    if (result.value.err) {
      const jupError = decodeJupiterError(result.value.logs);
      return { 
        success: false, 
        error: JSON.stringify(result.value.err),
        jupiterError: jupError,
      };
    }
    
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function executeSwap(
  intent: TradeIntent, 
  signer: Keypair, 
  execMode: ExecutionMode = "live"
): Promise<SwapResult> {
  const config = getConfig();
  const riskProfile = config.riskProfile;
  const user = signer.publicKey.toBase58();
  const owner = signer.publicKey;

  const preflight = await performPreflight(owner, intent.inputMint, intent.inAmountBaseUnits, riskProfile);
  
  logger.info({
    inputMint: intent.inputMint.slice(0, 8),
    tokenBalance: preflight.tokenBalanceHuman,
    requestedAmount: intent.inAmountBaseUnits,
    clampedAmount: preflight.clampedAmountBaseUnits,
    solBalance: preflight.solBalanceHuman,
    requiredSol: preflight.requiredSolHuman,
    hasSufficientSol: preflight.hasSufficientSol,
    hasSufficientToken: preflight.hasSufficientToken,
  }, "Swap preflight check");

  if (!preflight.hasSufficientSol) {
    const errorMsg = `Insufficient SOL for fees/rent. Have ${preflight.solBalanceHuman} SOL, need ~${preflight.requiredSolHuman} SOL. ` +
      `Breakdown: baseFee=${Number(BASE_FEE_LAMPORTS)/1e9}, priorityFee=${Number(preflight.priorityFeeLamports)/1e9}, ` +
      `ataRent=${Number(ATA_RENT_LAMPORTS)/1e9}, buffer=${Number(SAFETY_BUFFER_LAMPORTS)/1e9}`;
    
    logger.error({ preflight }, errorMsg);
    
    return {
      status: "insufficient_funds",
      quote: null,
      txSig: null,
      swap: null,
      error: errorMsg,
      preflightDetails: preflight,
    };
  }

  if (!preflight.hasSufficientToken) {
    const errorMsg = `Insufficient token balance. Have ${preflight.tokenBalanceHuman}, requested ${intent.inAmountBaseUnits} base units`;
    logger.error({ preflight }, errorMsg);
    
    return {
      status: "insufficient_funds",
      quote: null,
      txSig: null,
      swap: null,
      error: errorMsg,
      preflightDetails: preflight,
    };
  }

  const finalAmount = preflight.clampedAmountBaseUnits;
  
  const lane = inferLaneFromIntent(intent);
  const side = inferSideFromIntent(intent);
  const urgency = inferUrgencyFromIntent(intent, side);
  
  let quote: QuoteResponse;
  try {
    quote = await jupQuote({
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amount: finalAmount,
      slippageBps: intent.slippageBps,
      swapMode: "ExactIn",
      restrictIntermediateTokens: true,
    });
  } catch (e: any) {
    logger.error({ error: e.message, preflight }, "Jupiter quote failed");
    return {
      status: "error",
      quote: null,
      txSig: null,
      swap: null,
      error: `Quote failed: ${e.message}`,
      preflightDetails: preflight,
    };
  }

  const notionalSol = side === "buy" 
    ? Number(finalAmount) / 1e9 
    : Number(quote.outAmount) / 1e9;
  
  const feeSettings = getFeeSettingsFromConfig(config);
  const attempt = intent.meta?.attempt ?? 1;
  
  const tradeCtx: TradeContext = {
    lane,
    side,
    notionalSol,
    urgency,
    attempt,
  };
  
  let feeDecision: FeeDecision;
  let maxLamports: number;
  let priorityLevel: string;
  
  const skipFeeGovernor = intent.meta?.isUSDCToSOL === true;
  
  if (feeSettings.feeGovernorEnabled && !skipFeeGovernor) {
    feeDecision = feeGovGetPriorityFee(tradeCtx, feeSettings);
    logFeeDecision(tradeCtx, feeDecision);
    
    if (feeDecision.skipRecommended) {
      const skipMsg = `Fee governor: SKIP - fee ratio too high. ${feeDecision.reason}`;
      logger.warn({
        lane,
        side,
        notionalSol,
        attempt,
        maxLamports: feeDecision.maxLamports,
        effectiveRatioPct: (feeDecision.effectiveRatio * 100).toFixed(4),
        reason: feeDecision.reason,
      }, skipMsg);
      
      return {
        status: "error",
        quote,
        txSig: null,
        swap: null,
        error: skipMsg,
        preflightDetails: preflight,
      };
    }
    
    maxLamports = feeDecision.maxLamports;
    priorityLevel = feeDecision.priorityLevel;
  } else {
    maxLamports = getFallbackPriorityFeeLamports(riskProfile);
    priorityLevel = getFallbackPriorityLevel(riskProfile);
    
    // Create a synthetic feeDecision for legacy mode
    feeDecision = {
      maxLamports,
      priorityLevel: priorityLevel as any,
      reason: "legacy_fallback",
      skipRecommended: false,
      clampedToMin: false,
      clampedToMax: false,
      effectiveRatio: notionalSol > 0 ? maxLamports / (notionalSol * 1e9) : 0,
    };
    
    logger.debug({
      lane,
      side,
      notionalSol,
      attempt,
      maxLamports,
      priorityLevel,
      feeGovernorEnabled: feeSettings.feeGovernorEnabled,
      skipFeeGovernor,
    }, skipFeeGovernor 
      ? "Fee governor bypassed for USDC→SOL swap" 
      : "Fee governor disabled, using legacy priority fee");
  }
  
  // Build summary for callers
  const feeDecisionSummary: FeeDecisionSummary = {
    maxLamports: feeDecision.maxLamports,
    priorityLevel: feeDecision.priorityLevel,
    reason: feeDecision.reason,
    skipRecommended: feeDecision.skipRecommended,
    effectiveRatio: feeDecision.effectiveRatio,
  };

  let swap: any;
  try {
    swap = await jupSwapTx({
      quoteResponse: quote,
      userPublicKey: user,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel,
          maxLamports,
          global: false,
        },
      },
    });
  } catch (e: any) {
    logger.error({ error: e.message, preflight }, "Jupiter swap tx build failed");
    return {
      status: "error",
      quote,
      txSig: null,
      swap: null,
      error: `Swap build failed: ${e.message}`,
      preflightDetails: preflight,
    };
  }

  if (execMode === "paper") {
    logger.info({ intent, quote, preflight }, "PAPER trade (no tx sent)");
    
    if (intent.inputMint !== MINT_SOL) {
      logger.warn({
        event: "SELL_EXECUTED",
        mint: intent.inputMint,
        strategy: intent.strategy,
        status: "paper",
        txSig: null,
        inAmount: finalAmount,
        outAmount: quote.outAmount,
        reasonCode: intent.meta?.reasonCode || intent.meta?.reason || "UNKNOWN",
        meta: intent.meta,
      }, "SELL_EXECUTED: Paper sell completed - FAILSAFE LOG");
    }
    
    return { status: "paper", quote, txSig: null, swap, preflightDetails: preflight, feeDecision: feeDecisionSummary };
  }

  const simResult = await simulateSwap(swap.swapTransaction, signer);
  
  if (!simResult.success) {
    const jupErr = simResult.jupiterError;
    const errMsg = jupErr 
      ? `Jupiter error ${jupErr.code} (${jupErr.name}): ${jupErr.action}` 
      : `Simulation failed: ${simResult.error}`;
    
    logger.error({
      error: errMsg,
      jupiterError: jupErr,
      preflight,
      quote: {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct,
      },
    }, "Swap simulation failed - aborting");
    
    return {
      status: "simulation_failed",
      quote,
      txSig: null,
      swap,
      error: errMsg,
      preflightDetails: preflight,
      feeDecision: feeDecisionSummary,
    };
  }

  logger.info({ inputMint: intent.inputMint.slice(0, 8) }, "Simulation passed, sending transaction");

  try {
    const sig = await sendVersionedTx(swap.swapTransaction, signer);
    logger.info({ sig, input: intent.inputMint, output: intent.outputMint }, "Swap sent");
    
    if (intent.inputMint !== MINT_SOL) {
      logger.warn({
        event: "SELL_EXECUTED",
        mint: intent.inputMint,
        strategy: intent.strategy,
        status: "sent",
        txSig: sig,
        inAmount: finalAmount,
        outAmount: quote.outAmount,
        reasonCode: intent.meta?.reasonCode || intent.meta?.reason || "UNKNOWN",
        meta: intent.meta,
      }, "SELL_EXECUTED: Live sell completed - FAILSAFE LOG");
    }
    
    return { status: "sent", quote, txSig: sig, swap, preflightDetails: preflight, feeDecision: feeDecisionSummary };
  } catch (e: any) {
    logger.error({ error: e.message, preflight }, "Transaction send failed");
    return {
      status: "error",
      quote,
      txSig: null,
      swap,
      error: `Send failed: ${e.message}`,
      preflightDetails: preflight,
      feeDecision: feeDecisionSummary,
    };
  }
}

export function solToLamports(sol: number) {
  return Math.floor(sol * 1e9).toString();
}

export function usdToLamportsSol(usd: number, solUsd: number) {
  const sol = solUsd > 0 ? usd / solUsd : 0;
  return solToLamports(sol);
}

export function uiToBaseUnits(ui: number, decimals: number) {
  const m = Math.pow(10, decimals);
  return Math.floor(ui * m).toString();
}

export function uiToBaseUnitsBigInt(ui: number, decimals: number): bigint {
  const factor = BigInt(10 ** decimals);
  const wholePart = BigInt(Math.floor(ui));
  const fracPart = BigInt(Math.round((ui - Math.floor(ui)) * Number(factor)));
  return wholePart * factor + fracPart;
}

/**
 * Fetch authoritative token decimals from the Solana chain.
 * This bypasses DexScreener/Jupiter which can have stale or incorrect metadata.
 * 
 * @param mint - Token mint address
 * @returns Token decimals (6 for pump.fun, 9 for most SPL tokens, etc.)
 */
export async function getAuthoritativeDecimals(mint: string): Promise<number> {
  if (mint === MINT_SOL) {
    return 9;
  }
  
  const mintPk = new PublicKey(mint);
  
  // Try SPL Token program first, then Token-2022
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const mintInfo = await getMint(connection, mintPk, 'confirmed', programId);
      logger.debug({ mint: mint.slice(0, 8), decimals: mintInfo.decimals, program: programId.toBase58().slice(0, 8) }, "Got authoritative decimals from chain");
      return mintInfo.decimals;
    } catch {
      // Try next program
    }
  }
  
  // Fallback to 6 (common for pump.fun tokens) rather than 9
  // This is safer than 9 since it prevents quantity undercount
  logger.warn({ mint: mint.slice(0, 8) }, "Failed to fetch mint info - defaulting to 6 decimals (pump.fun default)");
  return 6;
}
