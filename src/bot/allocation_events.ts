import { q } from "./db.js";
import { logger } from "../utils/logger.js";

export type ExecutionOutcome = "NOT_ATTEMPTED" | "SUBMITTED" | "CONFIRMED" | "SKIPPED" | "FAILED" | "PENDING";

export interface GlobalGates {
  manualPause: boolean;
  riskPaused: boolean;
  lowSolMode: boolean;
  priceCoverageOk: boolean;
}

export function computeGlobalGates(
  manualPause: boolean,
  riskPaused: boolean,
  lowSolMode: boolean,
  priceCoverageOk: boolean
): GlobalGates {
  return {
    manualPause,
    riskPaused,
    lowSolMode,
    priceCoverageOk,
  };
}

export function getActiveGateNames(gates: GlobalGates): string[] {
  const active: string[] = [];
  if (gates.manualPause) active.push("manualPause");
  if (gates.riskPaused) active.push("riskPaused");
  if (gates.lowSolMode) active.push("lowSolMode");
  if (!gates.priceCoverageOk) active.push("priceCoverageNotOk");
  return active;
}

export type ExecutionResult = {
  outcome: "SUBMITTED" | "CONFIRMED" | "SKIPPED" | "FAILED";
  reason?: string;
  txSig?: string;
  executedUsd?: number;
  feePaidLamports?: number;
  feeDecision?: { priorityLevel: string; maxLamports: number; reason: string };
};

export type AllocationEvent = {
  symbol: string;
  mint: string;
  side: "buy" | "sell";
  rawTargetPct?: number;
  scaledTargetPct?: number;
  currentPct?: number;
  desiredUsd?: number;
  plannedUsd?: number;
  executedUsd?: number;
  outcome: ExecutionOutcome;
  reason?: string;
  txSig?: string;
  feeMaxLamports?: number;
  feePaidLamports?: number;
  bindingConstraint?: string;
};

export async function recordAllocationEvent(event: AllocationEvent): Promise<void> {
  try {
    await q(
      `INSERT INTO allocation_events (
        symbol, mint, side, raw_target_pct, scaled_target_pct, current_pct,
        desired_usd, planned_usd, executed_usd, outcome, reason, tx_sig,
        fee_max_lamports, fee_paid_lamports, binding_constraint
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        event.symbol,
        event.mint,
        event.side,
        event.rawTargetPct ?? null,
        event.scaledTargetPct ?? null,
        event.currentPct ?? null,
        event.desiredUsd ?? null,
        event.plannedUsd ?? null,
        event.executedUsd ?? null,
        event.outcome,
        event.reason ?? null,
        event.txSig ?? null,
        event.feeMaxLamports ?? null,
        event.feePaidLamports ?? null,
        event.bindingConstraint ?? null,
      ]
    );
    
    logger.debug({
      symbol: event.symbol,
      side: event.side,
      outcome: event.outcome,
      executedUsd: event.executedUsd,
      txSig: event.txSig?.slice(0, 12),
    }, "ALLOCATION_EVENT_RECORDED");
  } catch (err: any) {
    logger.error({ err: err.message, event }, "Failed to record allocation event");
  }
}

// SOL mint address for direction detection
const MINT_SOL_ADDR = "So11111111111111111111111111111111111111112";

export function buildExecutionResultFromSwap(
  swapResult: { status: string; txSig: string | null; quote: any; feeDecision?: any; error?: string },
  solPriceUsd: number
): ExecutionResult {
  let outcome: ExecutionResult["outcome"];
  let reason: string | undefined;
  let executedUsd: number | undefined;

  // Helper to calculate executed USD from quote
  // For buys (SOL input): use inAmount in lamports
  // For sells (SOL output): use outAmount in lamports
  const calcExecutedUsd = (quote: any): number | undefined => {
    if (!quote) return undefined;
    
    // Check if input is SOL (buy trade) or output is SOL (sell trade)
    if (quote.inputMint === MINT_SOL_ADDR && quote.inAmount) {
      // Buy trade: SOL spent
      return (Number(quote.inAmount) / 1e9) * solPriceUsd;
    } else if (quote.outputMint === MINT_SOL_ADDR && quote.outAmount) {
      // Sell trade: SOL received
      return (Number(quote.outAmount) / 1e9) * solPriceUsd;
    } else if (quote.inAmount) {
      // Fallback: assume input is SOL-denominated
      return (Number(quote.inAmount) / 1e9) * solPriceUsd;
    }
    return undefined;
  };

  switch (swapResult.status) {
    case "sent":
      outcome = "SUBMITTED";
      executedUsd = calcExecutedUsd(swapResult.quote);
      break;
    case "paper":
      outcome = "CONFIRMED";
      reason = "paper_mode";
      executedUsd = calcExecutedUsd(swapResult.quote);
      break;
    case "insufficient_funds":
      outcome = "FAILED";
      reason = "insufficient_funds";
      break;
    case "simulation_failed":
      outcome = "FAILED";
      reason = swapResult.error || "simulation_failed";
      break;
    case "error":
      outcome = "FAILED";
      reason = swapResult.error || "unknown_error";
      break;
    default:
      outcome = "FAILED";
      reason = `unknown_status_${swapResult.status}`;
  }

  return {
    outcome,
    reason,
    txSig: swapResult.txSig ?? undefined,
    executedUsd,
    feeDecision: swapResult.feeDecision ? {
      priorityLevel: swapResult.feeDecision.priorityLevel,
      maxLamports: swapResult.feeDecision.maxLamports,
      reason: swapResult.feeDecision.reason,
    } : undefined,
  };
}
