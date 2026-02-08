import { describe, it, expect } from "vitest";
import {
  getPriorityFeeLamports,
  DEFAULT_FEE_SETTINGS,
  type TradeContext,
  type FeeSettings,
} from "../feeGovernor.js";

describe("feeGovernor", () => {
  const baseSettings: FeeSettings = {
    ...DEFAULT_FEE_SETTINGS,
    feeGovernorEnabled: true,
  };

  describe("getPriorityFeeLamports", () => {
    it("computes ~102k lamports for 0.04 SOL scout buy at attempt 1", () => {
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.04,
        urgency: "normal",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, baseSettings);
      
      expect(decision.maxLamports).toBeLessThanOrEqual(120_000);
      expect(decision.maxLamports).toBeGreaterThan(0);
      expect(decision.priorityLevel).toBe("medium");
      expect(decision.skipRecommended).toBe(false);
    });

    it("computes higher fee for core lane", () => {
      const scoutCtx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.1,
        urgency: "normal",
        attempt: 1,
      };
      
      const coreCtx: TradeContext = {
        lane: "core",
        side: "buy",
        notionalSol: 0.1,
        urgency: "normal",
        attempt: 1,
      };
      
      const scoutDecision = getPriorityFeeLamports(scoutCtx, baseSettings);
      const coreDecision = getPriorityFeeLamports(coreCtx, baseSettings);
      
      expect(scoutDecision.maxLamports).toBeGreaterThan(coreDecision.maxLamports);
    });

    it("applies retry ladder multipliers correctly", () => {
      const settingsHighCap: FeeSettings = {
        ...baseSettings,
        maxPriorityFeeLamportsScout: 100_000_000,
      };
      
      const ctx1: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.02,
        urgency: "normal",
        attempt: 1,
      };
      
      const ctx2: TradeContext = { ...ctx1, attempt: 2 };
      const ctx3: TradeContext = { ...ctx1, attempt: 3 };
      const ctx4: TradeContext = { ...ctx1, attempt: 4 };
      
      const d1 = getPriorityFeeLamports(ctx1, settingsHighCap);
      const d2 = getPriorityFeeLamports(ctx2, settingsHighCap);
      const d3 = getPriorityFeeLamports(ctx3, settingsHighCap);
      const d4 = getPriorityFeeLamports(ctx4, settingsHighCap);
      
      expect(d2.maxLamports).toBeCloseTo(d1.maxLamports * 2, -2);
      expect(d3.maxLamports).toBeCloseTo(d1.maxLamports * 4, -2);
      expect(d4.maxLamports).toBeCloseTo(d1.maxLamports * 8, -2);
      
      expect(d2.reason).toContain("retry_attempt_2");
      expect(d3.reason).toContain("retry_attempt_3");
    });

    it("clamps retry attempts beyond ladder length to last multiplier", () => {
      const ctx5: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.1,
        urgency: "normal",
        attempt: 5,
      };
      
      const ctx10: TradeContext = { ...ctx5, attempt: 10 };
      
      const d5 = getPriorityFeeLamports(ctx5, baseSettings);
      const d10 = getPriorityFeeLamports(ctx10, baseSettings);
      
      expect(d5.maxLamports).toBe(d10.maxLamports);
    });

    it("enforces min fee for exit (sell) transactions", () => {
      const settings: FeeSettings = {
        ...baseSettings,
        minPriorityFeeLamportsExit: 100_000,
      };
      
      const ctx: TradeContext = {
        lane: "scout",
        side: "sell",
        notionalSol: 0.001,
        urgency: "high",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, settings);
      
      expect(decision.maxLamports).toBeGreaterThanOrEqual(100_000);
      expect(decision.clampedToMin).toBe(true);
      expect(decision.reason).toContain("clamped_to_min_exit");
    });

    it("enforces min fee for entry (buy) transactions", () => {
      const settings: FeeSettings = {
        ...baseSettings,
        minPriorityFeeLamportsEntry: 50_000,
      };
      
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.001,
        urgency: "normal",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, settings);
      
      expect(decision.maxLamports).toBeGreaterThanOrEqual(50_000);
      expect(decision.clampedToMin).toBe(true);
      expect(decision.reason).toContain("clamped_to_min_entry");
    });

    it("enforces max cap for scout lane", () => {
      const settings: FeeSettings = {
        ...baseSettings,
        maxPriorityFeeLamportsScout: 400_000,
      };
      
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 10,
        urgency: "normal",
        attempt: 4,
      };
      
      const decision = getPriorityFeeLamports(ctx, settings);
      
      expect(decision.maxLamports).toBeLessThanOrEqual(400_000);
      expect(decision.clampedToMax).toBe(true);
      expect(decision.reason).toContain("clamped_to_max_scout");
    });

    it("enforces max cap for core lane", () => {
      const settings: FeeSettings = {
        ...baseSettings,
        maxPriorityFeeLamportsCore: 1_000_000,
      };
      
      const ctx: TradeContext = {
        lane: "core",
        side: "buy",
        notionalSol: 100,
        urgency: "normal",
        attempt: 4,
      };
      
      const decision = getPriorityFeeLamports(ctx, settings);
      
      expect(decision.maxLamports).toBeLessThanOrEqual(1_000_000);
      expect(decision.clampedToMax).toBe(true);
      expect(decision.reason).toContain("clamped_to_max_core");
    });

    it("triggers skip recommendation when fee ratio exceeds hard cap", () => {
      const settings: FeeSettings = {
        ...baseSettings,
        feeRatioGuardEnabled: true,
        maxFeeRatioHardPerLeg: 0.01,
        minPriorityFeeLamportsExit: 500_000,
      };
      
      const ctx: TradeContext = {
        lane: "scout",
        side: "sell",
        notionalSol: 0.01,
        urgency: "high",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, settings);
      
      expect(decision.skipRecommended).toBe(true);
      expect(decision.reason).toContain("exceeds_hard_cap");
    });

    it("does not trigger skip when guard is disabled", () => {
      const settings: FeeSettings = {
        ...baseSettings,
        feeRatioGuardEnabled: false,
        minPriorityFeeLamportsExit: 500_000,
      };
      
      const ctx: TradeContext = {
        lane: "scout",
        side: "sell",
        notionalSol: 0.01,
        urgency: "high",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, settings);
      
      expect(decision.skipRecommended).toBe(false);
    });

    it("sets high priority for sells", () => {
      const ctx: TradeContext = {
        lane: "scout",
        side: "sell",
        notionalSol: 0.1,
        urgency: "normal",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, baseSettings);
      
      expect(decision.priorityLevel).toBe("high");
    });

    it("sets high priority for high urgency", () => {
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.1,
        urgency: "high",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, baseSettings);
      
      expect(decision.priorityLevel).toBe("high");
    });

    it("sets medium priority for normal buy", () => {
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.1,
        urgency: "normal",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, baseSettings);
      
      expect(decision.priorityLevel).toBe("medium");
    });

    it("applies safety haircut correctly", () => {
      const settingsNoHaircut: FeeSettings = {
        ...baseSettings,
        feeSafetyHaircut: 1.0,
        maxPriorityFeeLamportsScout: 100_000_000,
      };
      
      const settingsWithHaircut: FeeSettings = {
        ...baseSettings,
        feeSafetyHaircut: 0.85,
        maxPriorityFeeLamportsScout: 100_000_000,
      };
      
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.1,
        urgency: "normal",
        attempt: 1,
      };
      
      const noHaircut = getPriorityFeeLamports(ctx, settingsNoHaircut);
      const withHaircut = getPriorityFeeLamports(ctx, settingsWithHaircut);
      
      expect(withHaircut.maxLamports).toBeLessThan(noHaircut.maxLamports);
      expect(withHaircut.maxLamports).toBeCloseTo(noHaircut.maxLamports * 0.85, -3);
    });

    it("calculates effective ratio correctly", () => {
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.1,
        urgency: "normal",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, baseSettings);
      
      const expectedRatio = decision.maxLamports / (ctx.notionalSol * 1e9);
      expect(decision.effectiveRatio).toBeCloseTo(expectedRatio, 10);
    });

    it("is deterministic for same inputs", () => {
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0.04,
        urgency: "normal",
        attempt: 1,
      };
      
      const d1 = getPriorityFeeLamports(ctx, baseSettings);
      const d2 = getPriorityFeeLamports(ctx, baseSettings);
      const d3 = getPriorityFeeLamports(ctx, baseSettings);
      
      expect(d1.maxLamports).toBe(d2.maxLamports);
      expect(d2.maxLamports).toBe(d3.maxLamports);
      expect(d1.reason).toBe(d2.reason);
    });

    it("handles edge case of zero notional", () => {
      const ctx: TradeContext = {
        lane: "scout",
        side: "buy",
        notionalSol: 0,
        urgency: "normal",
        attempt: 1,
      };
      
      const decision = getPriorityFeeLamports(ctx, baseSettings);
      
      expect(decision.maxLamports).toBe(0);
      expect(decision.effectiveRatio).toBe(0);
    });
  });
});
