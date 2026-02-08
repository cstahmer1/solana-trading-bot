#!/usr/bin/env npx tsx
import { getConfig } from '../src/bot/runtime_config';

interface MockPosition {
  mint: string;
  symbol: string;
  slotType: 'scout' | 'core';
  entryPrice: number;
  currentPrice: number;
  minutesHeld: number;
  signalScore: number;
  regime: 'trend' | 'range';
}

interface ScoutTpResult {
  triggered: boolean;
  promotable: boolean;
  action: 'none' | 'promote' | 'exit';
  reason?: string;
}

function evaluateScoutTp(pos: MockPosition, config: ReturnType<typeof getConfig>): ScoutTpResult {
  if (pos.slotType !== 'scout') {
    return { triggered: false, promotable: false, action: 'none', reason: 'not_a_scout' };
  }

  if (pos.minutesHeld < config.scoutTpMinHoldMinutes) {
    return { triggered: false, promotable: false, action: 'none', reason: 'min_hold_not_met' };
  }

  const pnlPct = pos.entryPrice > 0 ? (pos.currentPrice - pos.entryPrice) / pos.entryPrice : 0;
  
  if (pnlPct < config.scoutTakeProfitPct) {
    return { triggered: false, promotable: false, action: 'none', reason: 'below_tp_threshold' };
  }

  const hoursHeld = pos.minutesHeld / 60;
  const minHoursRequired = config.promotionDelayMinutes / 60;
  
  const promotable = 
    pos.regime === 'trend' &&
    pnlPct >= config.promotionMinPnlPct &&
    pos.signalScore >= config.promotionMinSignalScore &&
    hoursHeld >= minHoursRequired;

  const reasons: string[] = [];
  if (pos.regime !== 'trend') reasons.push('regime_not_trend');
  if (pnlPct < config.promotionMinPnlPct) reasons.push('pnl_below_promotion_threshold');
  if (pos.signalScore < config.promotionMinSignalScore) reasons.push('signal_below_threshold');
  if (hoursHeld < minHoursRequired) reasons.push('hold_time_below_threshold');

  return {
    triggered: true,
    promotable,
    action: promotable ? 'promote' : 'exit',
    reason: promotable ? 'all_criteria_met' : reasons.join(', '),
  };
}

async function runSanityTests() {
  console.log('=== Scout Take-Profit Sanity Tests ===\n');

  const config = getConfig();
  console.log('Config values:');
  console.log(`  scoutTakeProfitPct: ${config.scoutTakeProfitPct} (${(config.scoutTakeProfitPct * 100).toFixed(1)}%)`);
  console.log(`  scoutTpMinHoldMinutes: ${config.scoutTpMinHoldMinutes}`);
  console.log(`  promotionMinPnlPct: ${config.promotionMinPnlPct} (${(config.promotionMinPnlPct * 100).toFixed(1)}%)`);
  console.log(`  promotionMinSignalScore: ${config.promotionMinSignalScore}`);
  console.log(`  promotionDelayMinutes: ${config.promotionDelayMinutes}`);
  console.log('');

  const testCases: { name: string; pos: MockPosition; expected: ScoutTpResult }[] = [
    {
      name: 'Scout with TP threshold met and promotable',
      pos: {
        mint: 'PROMO1',
        symbol: 'PROMO1',
        slotType: 'scout',
        entryPrice: 1.0,
        currentPrice: 1.25,
        minutesHeld: 30,
        signalScore: 3.0,
        regime: 'trend',
      },
      expected: { triggered: true, promotable: true, action: 'promote' },
    },
    {
      name: 'Scout with TP threshold met but NOT promotable (range regime)',
      pos: {
        mint: 'EXIT1',
        symbol: 'EXIT1',
        slotType: 'scout',
        entryPrice: 1.0,
        currentPrice: 1.10,
        minutesHeld: 30,
        signalScore: 3.0,
        regime: 'range',
      },
      expected: { triggered: true, promotable: false, action: 'exit' },
    },
    {
      name: 'Scout with TP threshold met but NOT promotable (low signal)',
      pos: {
        mint: 'EXIT2',
        symbol: 'EXIT2',
        slotType: 'scout',
        entryPrice: 1.0,
        currentPrice: 1.30,
        minutesHeld: 30,
        signalScore: 0.5,
        regime: 'trend',
      },
      expected: { triggered: true, promotable: false, action: 'exit' },
    },
    {
      name: 'Scout with PnL below TP threshold',
      pos: {
        mint: 'NOTP1',
        symbol: 'NOTP1',
        slotType: 'scout',
        entryPrice: 1.0,
        currentPrice: 1.05,
        minutesHeld: 30,
        signalScore: 3.0,
        regime: 'trend',
      },
      expected: { triggered: false, promotable: false, action: 'none' },
    },
    {
      name: 'Core position (TP rule should not apply)',
      pos: {
        mint: 'CORE1',
        symbol: 'CORE1',
        slotType: 'core',
        entryPrice: 1.0,
        currentPrice: 1.50,
        minutesHeld: 60,
        signalScore: 5.0,
        regime: 'trend',
      },
      expected: { triggered: false, promotable: false, action: 'none' },
    },
    {
      name: 'Scout held less than min hold time',
      pos: {
        mint: 'SHORT1',
        symbol: 'SHORT1',
        slotType: 'scout',
        entryPrice: 1.0,
        currentPrice: 1.20,
        minutesHeld: 2,
        signalScore: 3.0,
        regime: 'trend',
      },
      expected: { triggered: false, promotable: false, action: 'none' },
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const result = evaluateScoutTp(tc.pos, config);
    const success = 
      result.triggered === tc.expected.triggered &&
      result.promotable === tc.expected.promotable &&
      result.action === tc.expected.action;

    if (success) {
      console.log(`[PASS] ${tc.name}`);
      passed++;
    } else {
      console.log(`[FAIL] ${tc.name}`);
      console.log(`  Expected: triggered=${tc.expected.triggered}, promotable=${tc.expected.promotable}, action=${tc.expected.action}`);
      console.log(`  Got:      triggered=${result.triggered}, promotable=${result.promotable}, action=${result.action}`);
      if (result.reason) console.log(`  Reason: ${result.reason}`);
      failed++;
    }
  }

  console.log('');
  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

runSanityTests().catch(err => {
  console.error('Error running sanity tests:', err);
  process.exit(1);
});
