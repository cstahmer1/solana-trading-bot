#!/usr/bin/env tsx

import {
  getPriorityFeeLamports,
  DEFAULT_FEE_SETTINGS,
  logFeeDecision,
  type TradeContext,
  type FeeSettings,
  type Lane,
  type Side,
  type Urgency,
} from "../src/bot/feeGovernor.js";

function parseArgs(): {
  notionalSol: number;
  lane: Lane;
  side: Side;
  urgency: Urgency;
  attempt: number;
  showAll: boolean;
} {
  const args = process.argv.slice(2);
  
  let notionalSol = 0.04;
  let lane: Lane = "scout";
  let side: Side = "buy";
  let urgency: Urgency = "normal";
  let attempt = 1;
  let showAll = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    
    if (arg === "--notional" && next) {
      notionalSol = parseFloat(next);
      i++;
    } else if (arg === "--lane" && next) {
      lane = next as Lane;
      i++;
    } else if (arg === "--side" && next) {
      side = next as Side;
      i++;
    } else if (arg === "--urgency" && next) {
      urgency = next as Urgency;
      i++;
    } else if (arg === "--attempt" && next) {
      attempt = parseInt(next, 10);
      i++;
    } else if (arg === "--show-all" || arg === "-a") {
      showAll = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Fee Governor Demo CLI

Usage:
  npx tsx scripts/feeGovernorDemo.ts [options]

Options:
  --notional <sol>   Trade notional in SOL (default: 0.04)
  --lane <lane>      Lane: scout or core (default: scout)
  --side <side>      Side: buy or sell (default: buy)
  --urgency <level>  Urgency: normal or high (default: normal)
  --attempt <n>      Retry attempt number (default: 1)
  --show-all, -a     Show all combinations for comparison
  --help, -h         Show this help

Examples:
  npx tsx scripts/feeGovernorDemo.ts --notional 0.04 --lane scout --side buy --attempt 1
  npx tsx scripts/feeGovernorDemo.ts --notional 0.10 --lane scout --side buy --attempt 3
  npx tsx scripts/feeGovernorDemo.ts --notional 0.50 --lane core --side sell --attempt 1
  npx tsx scripts/feeGovernorDemo.ts --show-all
      `);
      process.exit(0);
    }
  }
  
  return { notionalSol, lane, side, urgency, attempt, showAll };
}

function printDecision(ctx: TradeContext, settings: FeeSettings): void {
  const decision = getPriorityFeeLamports(ctx, settings);
  
  console.log("┌─────────────────────────────────────────────────────────────────┐");
  console.log("│                    FEE GOVERNOR DECISION                        │");
  console.log("├─────────────────────────────────────────────────────────────────┤");
  console.log(`│ Lane:           ${ctx.lane.padEnd(48)}│`);
  console.log(`│ Side:           ${ctx.side.padEnd(48)}│`);
  console.log(`│ Notional SOL:   ${ctx.notionalSol.toFixed(6).padEnd(48)}│`);
  console.log(`│ Urgency:        ${ctx.urgency.padEnd(48)}│`);
  console.log(`│ Attempt:        ${ctx.attempt.toString().padEnd(48)}│`);
  console.log("├─────────────────────────────────────────────────────────────────┤");
  console.log(`│ Max Lamports:   ${decision.maxLamports.toLocaleString().padEnd(48)}│`);
  console.log(`│ Max SOL:        ${(decision.maxLamports / 1e9).toFixed(9).padEnd(48)}│`);
  console.log(`│ Priority Level: ${decision.priorityLevel.padEnd(48)}│`);
  console.log(`│ Effective %:    ${(decision.effectiveRatio * 100).toFixed(4).padEnd(45)}% │`);
  console.log(`│ Clamped Min:    ${decision.clampedToMin.toString().padEnd(48)}│`);
  console.log(`│ Clamped Max:    ${decision.clampedToMax.toString().padEnd(48)}│`);
  console.log(`│ Skip Rec:       ${decision.skipRecommended.toString().padEnd(48)}│`);
  console.log("├─────────────────────────────────────────────────────────────────┤");
  console.log(`│ Reason: ${decision.reason.slice(0, 56).padEnd(56)}│`);
  if (decision.reason.length > 56) {
    console.log(`│         ${decision.reason.slice(56, 112).padEnd(56)}│`);
  }
  console.log("└─────────────────────────────────────────────────────────────────┘");
}

function showAllCombinations(settings: FeeSettings): void {
  const notionals = [0.01, 0.02, 0.04, 0.10, 0.25, 0.50, 1.0, 2.0, 5.0];
  const lanes: Lane[] = ["scout", "core"];
  const sides: Side[] = ["buy", "sell"];
  const attempts = [1, 2, 3, 4];
  
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════════════════════");
  console.log("                            FEE GOVERNOR COMPARISON TABLE                           ");
  console.log("═══════════════════════════════════════════════════════════════════════════════════");
  console.log("");
  
  for (const lane of lanes) {
    for (const side of sides) {
      console.log(`\n${lane.toUpperCase()} ${side.toUpperCase()}:`);
      console.log("─".repeat(90));
      console.log(
        "Notional".padEnd(10),
        "Att 1".padEnd(12),
        "Att 2".padEnd(12),
        "Att 3".padEnd(12),
        "Att 4".padEnd(12),
        "Ratio %".padEnd(10),
        "Priority"
      );
      console.log("─".repeat(90));
      
      for (const notionalSol of notionals) {
        const urgency: Urgency = side === "sell" ? "high" : "normal";
        
        const fees = attempts.map(attempt => {
          const ctx: TradeContext = { lane, side, notionalSol, urgency, attempt };
          return getPriorityFeeLamports(ctx, settings);
        });
        
        const formatFee = (lamports: number) => {
          if (lamports >= 1_000_000) {
            return `${(lamports / 1_000_000).toFixed(2)}M`;
          } else if (lamports >= 1_000) {
            return `${(lamports / 1_000).toFixed(1)}k`;
          }
          return lamports.toString();
        };
        
        console.log(
          `${notionalSol.toFixed(2)} SOL`.padEnd(10),
          formatFee(fees[0].maxLamports).padEnd(12),
          formatFee(fees[1].maxLamports).padEnd(12),
          formatFee(fees[2].maxLamports).padEnd(12),
          formatFee(fees[3].maxLamports).padEnd(12),
          `${(fees[0].effectiveRatio * 100).toFixed(3)}%`.padEnd(10),
          fees[0].priorityLevel
        );
      }
    }
  }
  
  console.log("\n");
  console.log("Settings used:");
  console.log(`  - Scout ratio: ${(settings.feeRatioPerLegScout * 100).toFixed(2)}%`);
  console.log(`  - Core ratio: ${(settings.feeRatioPerLegCore * 100).toFixed(2)}%`);
  console.log(`  - Safety haircut: ${(settings.feeSafetyHaircut * 100).toFixed(0)}%`);
  console.log(`  - Scout max: ${settings.maxPriorityFeeLamportsScout.toLocaleString()} lamports`);
  console.log(`  - Core max: ${settings.maxPriorityFeeLamportsCore.toLocaleString()} lamports`);
  console.log(`  - Exit min: ${settings.minPriorityFeeLamportsExit.toLocaleString()} lamports`);
  console.log(`  - Retry ladder: [${settings.retryLadderMultipliers.join(", ")}]`);
}

async function main(): Promise<void> {
  const { notionalSol, lane, side, urgency, attempt, showAll } = parseArgs();
  
  const settings: FeeSettings = {
    ...DEFAULT_FEE_SETTINGS,
    feeGovernorEnabled: true,
  };
  
  if (showAll) {
    showAllCombinations(settings);
  } else {
    const ctx: TradeContext = {
      lane,
      side,
      notionalSol,
      urgency,
      attempt,
    };
    
    console.log("\n");
    printDecision(ctx, settings);
    console.log("\n");
  }
}

main().catch(console.error);
