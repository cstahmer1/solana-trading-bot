import { computeEffectiveTargetPct, type AllocationRampSettings } from "../src/bot/allocation_ramp.js";

const defaultSettings: AllocationRampSettings = {
  allocationRampEnabled: true,
  minTicksForFullAlloc: 30,
  preFullAllocMaxPct: 0.08,
  smoothRamp: true,
  hardCapBeforeFull: true,
  maxPositionPctPerAsset: 0.35,
};

interface TestCase {
  name: string;
  rawTargetPct: number;
  ticksObserved: number;
  settings?: Partial<AllocationRampSettings>;
  expectedConfidence?: number;
  expectedEffective?: number;
  expectedReason?: "ramp" | "hard_cap" | "none";
}

const testCases: TestCase[] = [
  {
    name: "ticks=0 => effectiveTargetPct=0",
    rawTargetPct: 0.35,
    ticksObserved: 0,
    expectedConfidence: 0,
    expectedEffective: 0,
    expectedReason: "ramp",
  },
  {
    name: "ticks=minTicksForFullAlloc => effectiveTargetPct=rawTargetPct",
    rawTargetPct: 0.35,
    ticksObserved: 30,
    expectedConfidence: 1.0,
    expectedEffective: 0.35,
    expectedReason: "none",
  },
  {
    name: "ticks=minTicksForFullAlloc/4 with smoothRamp => confidence=sqrt(0.25)=0.5",
    rawTargetPct: 0.35,
    ticksObserved: 7.5,
    expectedConfidence: 0.5,
  },
  {
    name: "hardCapBeforeFull enforces min(effective, preFullAllocMaxPct)",
    rawTargetPct: 0.35,
    ticksObserved: 20,
    expectedReason: "hard_cap",
  },
  {
    name: "allocationRampEnabled=false bypasses ramp entirely",
    rawTargetPct: 0.35,
    ticksObserved: 5,
    settings: { allocationRampEnabled: false },
    expectedEffective: 0.35,
    expectedReason: "none",
  },
  {
    name: "minTicksForFullAlloc=0 disables ramp",
    rawTargetPct: 0.35,
    ticksObserved: 5,
    settings: { minTicksForFullAlloc: 0 },
    expectedEffective: 0.35,
    expectedReason: "none",
  },
  {
    name: "smoothRamp=false uses linear confidence",
    rawTargetPct: 0.35,
    ticksObserved: 15,
    settings: { smoothRamp: false, hardCapBeforeFull: false },
    expectedConfidence: 0.5,
    expectedEffective: 0.175,
    expectedReason: "ramp",
  },
  {
    name: "hardCapBeforeFull=false allows ramped value above preFullAllocMaxPct",
    rawTargetPct: 0.35,
    ticksObserved: 25,
    settings: { hardCapBeforeFull: false },
    expectedReason: "ramp",
  },
  {
    name: "Full ticks with high raw target still capped by maxPositionPctPerAsset",
    rawTargetPct: 0.50,
    ticksObserved: 30,
    expectedEffective: 0.35,
    expectedReason: "none",
  },
];

function runTests() {
  console.log("=".repeat(60));
  console.log("ALLOCATION RAMP SANITY TESTS");
  console.log("=".repeat(60));
  console.log();

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const settings: AllocationRampSettings = { ...defaultSettings, ...tc.settings };
    
    const result = computeEffectiveTargetPct({
      rawTargetPct: tc.rawTargetPct,
      ticksObserved: tc.ticksObserved,
      settings,
      mint: "test-mint",
      symbol: "TEST",
    });

    const errors: string[] = [];

    if (tc.expectedConfidence !== undefined) {
      const confidenceDiff = Math.abs(result.confidence - tc.expectedConfidence);
      if (confidenceDiff > 0.01) {
        errors.push(`confidence: expected ${tc.expectedConfidence.toFixed(3)}, got ${result.confidence.toFixed(3)}`);
      }
    }

    if (tc.expectedEffective !== undefined) {
      const effectiveDiff = Math.abs(result.effectiveTargetPct - tc.expectedEffective);
      if (effectiveDiff > 0.001) {
        errors.push(`effectiveTargetPct: expected ${tc.expectedEffective.toFixed(4)}, got ${result.effectiveTargetPct.toFixed(4)}`);
      }
    }

    if (tc.expectedReason !== undefined && result.reason !== tc.expectedReason) {
      errors.push(`reason: expected '${tc.expectedReason}', got '${result.reason}'`);
    }

    if (errors.length === 0) {
      console.log(`✅ PASS: ${tc.name}`);
      console.log(`   ticks=${tc.ticksObserved}, raw=${(tc.rawTargetPct * 100).toFixed(1)}% => effective=${(result.effectiveTargetPct * 100).toFixed(2)}%, confidence=${result.confidence.toFixed(3)}, reason=${result.reason}`);
      passed++;
    } else {
      console.log(`❌ FAIL: ${tc.name}`);
      for (const err of errors) {
        console.log(`   - ${err}`);
      }
      console.log(`   Full result: ${JSON.stringify(result)}`);
      failed++;
    }
    console.log();
  }

  console.log("=".repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
