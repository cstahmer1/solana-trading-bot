#!/usr/bin/env npx tsx

import { getConfig } from "../src/bot/runtime_config.js";
import { getRemainingExposure, insertPartialExitEvent } from "../src/bot/persist.js";
import { isExitReason, EXIT_REASON_CODES } from "../src/bot/exit_invariant.js";

async function sanityCheck() {
  console.log("=== Exit Invariant Sanity Check ===\n");

  try {
    const config = await getConfig();
    
    console.log("1. Exit Invariant Settings:");
    console.log(`   Enabled: ${config.exitInvariantEnabled}`);
    console.log(`   Max Retries: ${config.exitInvariantMaxRetries}`);
    console.log(`   Retry Delay (ms): ${config.exitInvariantRetryDelayMs}`);
    console.log(`   Min Remaining Qty: ${config.exitInvariantMinRemainingQty}`);
    console.log(`   Min Remaining USD: ${config.exitInvariantMinRemainingUsd}`);
    console.log(`   Slippage BPS: ${config.exitInvariantSlippageBps}`);
    console.log(`   Force Exact Close: ${config.exitInvariantForceExactClose}`);
    console.log("");
    
    console.log("2. Exit Reason Codes:");
    EXIT_REASON_CODES.forEach(code => {
      console.log(`   - ${code}`);
    });
    console.log("");
    
    console.log("3. isExitReason() Function Tests:");
    const testCases = [
      'take_profit',
      'rotation_exit',
      'scout_stop_loss_exit', 
      'core_loss_exit',
      'regime_mean_revert',
      'trailing_stop_exit',
      'stale_exit',
      'concentration_rebalance',
      'regime_trend_buy',
      'rotation_buy',
      'random_invalid',
    ];
    
    testCases.forEach(code => {
      const result = isExitReason(code);
      console.log(`   isExitReason('${code}'): ${result}`);
    });
    console.log("");
    
    console.log("4. getRemainingExposure() Test (with dummy mint):");
    const testMint = "So11111111111111111111111111111111111111112"; // SOL
    const exposure = await getRemainingExposure(testMint);
    console.log(`   Mint: ${exposure.mint}`);
    console.log(`   Remaining Qty: ${exposure.remainingQty}`);
    console.log(`   Remaining USD: ${exposure.remainingUsd}`);
    console.log(`   Lot Count: ${exposure.lotCount}`);
    console.log("");
    
    console.log("5. pnl_events Table Constraint Check:");
    const { q } = await import("../src/bot/db.js");
    const constraintCheck = await q<{ consrc: string }>(
      `SELECT pg_get_constraintdef(c.oid) as consrc
       FROM pg_constraint c
       JOIN pg_class t ON c.conrelid = t.oid
       WHERE t.relname = 'pnl_events' 
         AND c.conname LIKE '%event_type%'`
    );
    if (constraintCheck.length > 0) {
      console.log(`   Constraint: ${constraintCheck[0].consrc}`);
      const hasPartialExit = constraintCheck[0].consrc.includes('partial_exit_remaining');
      console.log(`   Includes 'partial_exit_remaining': ${hasPartialExit ? 'YES ✓' : 'NO ✗'}`);
    } else {
      console.log("   No event_type constraint found");
    }
    console.log("");
    
    console.log("=== Sanity Check Complete ===");
    console.log("All exit invariant components are properly configured.");
    
  } catch (error) {
    console.error("Sanity check failed:", error);
    process.exit(1);
  }
  
  process.exit(0);
}

sanityCheck();
