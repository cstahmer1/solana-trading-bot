import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  updateTargetState,
  evaluateRebalanceSellGate,
  clearTargetState,
  clearAllTargetStates,
  getConsecutiveTicksBelowCurrent,
  type RebalanceSellGateResult,
} from "../rebalance_hysteresis.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("rebalance_hysteresis", () => {
  beforeEach(() => {
    clearAllTargetStates();
  });

  describe("evaluateRebalanceSellGate", () => {
    describe("MIN_HOLD_BEFORE_REBALANCE_SELL gate", () => {
      it("should block rebalance sell when position age < minHoldMinutes", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 2 * 60 * 1000; // 2 minutes ago
        const minHoldMinutes = 5;

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 1000,
          minHoldMinutes,
          confirmTicks: 3,
          minTrimUsd: 10,
        });

        expect(result.allowed).toBe(false);
        expect(result.skipReason).toBe("MIN_HOLD_BEFORE_REBALANCE_SELL");
        expect(result.ageMinutes).toBeLessThan(minHoldMinutes);
      });

      it("should allow rebalance sell when position age >= minHoldMinutes", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;

        // First, set up the state to have enough confirmTicks
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 1000,
          minHoldMinutes,
          confirmTicks: 3,
          minTrimUsd: 10,
        });

        expect(result.ageMinutes).toBeGreaterThanOrEqual(minHoldMinutes);
        expect(result.skipReason).not.toBe("MIN_HOLD_BEFORE_REBALANCE_SELL");
      });

      it("should treat null entryTimeMs as Infinity age (always passes age gate)", () => {
        const minHoldMinutes = 5;
        const confirmTicks = 3;

        // Set up state with enough confirmTicks
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs: null,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 1000,
          minHoldMinutes,
          confirmTicks,
          minTrimUsd: 10,
        });

        expect(result.ageMinutes).toBe(Infinity);
        expect(result.skipReason).not.toBe("MIN_HOLD_BEFORE_REBALANCE_SELL");
      });
    });

    describe("TARGET_DROP_NOT_PERSISTENT gate", () => {
      it("should block rebalance sell when confirmTicks < requiredConfirmTicks", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;
        const confirmTicks = 5;

        // Set up state with only 2 consecutive ticks
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 1000,
          minHoldMinutes,
          confirmTicks,
          minTrimUsd: 10,
        });

        expect(result.allowed).toBe(false);
        expect(result.skipReason).toBe("TARGET_DROP_NOT_PERSISTENT");
        expect(result.confirmTicks).toBeLessThan(confirmTicks);
      });

      it("should allow when confirmTicks >= requiredConfirmTicks", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;
        const confirmTicks = 3;

        // Set up state with 3 consecutive ticks
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 1000,
          minHoldMinutes,
          confirmTicks,
          minTrimUsd: 10,
        });

        expect(result.skipReason).not.toBe("TARGET_DROP_NOT_PERSISTENT");
        expect(result.confirmTicks).toBeGreaterThanOrEqual(confirmTicks);
      });
    });

    describe("TRIM_TOO_SMALL gate", () => {
      it("should block rebalance sell when proceedsUsd < minTrimUsd", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;
        const minTrimUsd = 100;
        const proceedsUsd = 50;

        // Set up state with enough confirmTicks
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd,
          minHoldMinutes,
          confirmTicks: 3,
          minTrimUsd,
        });

        expect(result.allowed).toBe(false);
        expect(result.skipReason).toBe("TRIM_TOO_SMALL");
        expect(result.proceedsUsd).toBeLessThan(minTrimUsd);
      });

      it("should allow when proceedsUsd >= minTrimUsd", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;
        const minTrimUsd = 50;
        const proceedsUsd = 100;

        // Set up state with enough confirmTicks
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd,
          minHoldMinutes,
          confirmTicks: 3,
          minTrimUsd,
        });

        expect(result.skipReason).not.toBe("TRIM_TOO_SMALL");
        expect(result.proceedsUsd).toBeGreaterThanOrEqual(minTrimUsd);
      });
    });

    describe("All gates passed", () => {
      it("should allow rebalance sell when all conditions are met", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;
        const minTrimUsd = 50;
        const proceedsUsd = 100;
        const confirmTicks = 3;

        // Set up state with enough confirmTicks
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd,
          minHoldMinutes,
          confirmTicks,
          minTrimUsd,
        });

        expect(result.allowed).toBe(true);
        expect(result.skipReason).toBeNull();
        expect(result.ageMinutes).toBeGreaterThanOrEqual(minHoldMinutes);
        expect(result.confirmTicks).toBeGreaterThanOrEqual(confirmTicks);
        expect(result.proceedsUsd).toBeGreaterThanOrEqual(minTrimUsd);
      });

      it("should include correct metadata in result", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 20 * 60 * 1000; // 20 minutes ago
        const confirmTicks = 2;

        // Set up state
        updateTargetState("test_mint", 0.05, 0.10);
        updateTargetState("test_mint", 0.05, 0.10);

        const result = evaluateRebalanceSellGate({
          mint: "test_mint",
          symbol: "TEST",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 500,
          minHoldMinutes: 5,
          confirmTicks,
          minTrimUsd: 100,
        });

        expect(result.ageMinutes).toBeCloseTo(20, 0);
        expect(result.confirmTicks).toBe(2);
        expect(result.proceedsUsd).toBe(500);
      });
    });
  });

  describe("updateTargetState", () => {
    describe("incrementing consecutiveTicksBelowCurrent", () => {
      it("should increment when targetPct < currentPct", () => {
        const mint = "test_mint";

        // First call: should set to 1
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);

        // Second call: should increment to 2
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);

        // Third call: should increment to 3
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(3);
      });

      it("should initialize new entry with count of 1 on first below-current update", () => {
        const mint = "new_mint";

        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);
      });

      it("should track multiple mints independently", () => {
        updateTargetState("mint1", 0.05, 0.10);
        updateTargetState("mint1", 0.05, 0.10);

        updateTargetState("mint2", 0.05, 0.10);

        expect(getConsecutiveTicksBelowCurrent("mint1")).toBe(2);
        expect(getConsecutiveTicksBelowCurrent("mint2")).toBe(1);
      });

      it("should continue incrementing across many ticks", () => {
        const mint = "test_mint";

        for (let i = 0; i < 10; i++) {
          updateTargetState(mint, 0.05, 0.10);
        }

        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(10);
      });
    });

    describe("resetting when target >= current", () => {
      it("should reset counter to 0 when targetPct >= currentPct", () => {
        const mint = "test_mint";

        // Build up to 3
        updateTargetState(mint, 0.05, 0.10);
        updateTargetState(mint, 0.05, 0.10);
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(3);

        // Reset by setting targetPct >= currentPct
        updateTargetState(mint, 0.10, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);
      });

      it("should reset when target > current", () => {
        const mint = "test_mint";

        // Build up to 3
        updateTargetState(mint, 0.05, 0.10);
        updateTargetState(mint, 0.05, 0.10);
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(3);

        // Reset by setting targetPct > currentPct
        updateTargetState(mint, 0.15, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);
      });

      it("should reset even if entry already exists in state", () => {
        const mint = "test_mint";

        // Set up initial state
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);

        // Update with target >= current
        updateTargetState(mint, 0.10, 0.05);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);
      });

      it("should allow incrementing again after reset", () => {
        const mint = "test_mint";

        // Build up
        updateTargetState(mint, 0.05, 0.10);
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);

        // Reset
        updateTargetState(mint, 0.10, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);

        // Build up again
        updateTargetState(mint, 0.05, 0.10);
        updateTargetState(mint, 0.05, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);
      });
    });

    describe("boundary conditions", () => {
      it("should handle target equals current (reset case)", () => {
        const mint = "test_mint";

        updateTargetState(mint, 0.10, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);
      });

      it("should handle target slightly below current", () => {
        const mint = "test_mint";

        updateTargetState(mint, 0.0999, 0.10);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);
      });

      it("should handle very small percentages", () => {
        const mint = "test_mint";

        updateTargetState(mint, 0.0001, 0.0002);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);

        updateTargetState(mint, 0.0001, 0.0002);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);
      });

      it("should handle zero percentages", () => {
        const mint = "test_mint";

        updateTargetState(mint, 0, 0.5);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);

        updateTargetState(mint, 0, 0);
        expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);
      });
    });
  });

  describe("clearTargetState", () => {
    it("should remove tracking for a specific mint", () => {
      const mint = "test_mint";

      // Set up state
      updateTargetState(mint, 0.05, 0.10);
      updateTargetState(mint, 0.05, 0.10);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);

      // Clear state for mint
      clearTargetState(mint);

      // Should return 0 (default for non-existent entry)
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);
    });

    it("should not affect other mints", () => {
      // Set up state for two mints
      updateTargetState("mint1", 0.05, 0.10);
      updateTargetState("mint1", 0.05, 0.10);

      updateTargetState("mint2", 0.05, 0.10);

      // Clear only mint1
      clearTargetState("mint1");

      // mint1 should be cleared
      expect(getConsecutiveTicksBelowCurrent("mint1")).toBe(0);

      // mint2 should be unaffected
      expect(getConsecutiveTicksBelowCurrent("mint2")).toBe(1);
    });

    it("should handle clearing non-existent mint gracefully", () => {
      // This should not throw
      expect(() => clearTargetState("non_existent_mint")).not.toThrow();
      expect(getConsecutiveTicksBelowCurrent("non_existent_mint")).toBe(0);
    });

    it("should allow tracking to restart after clearing", () => {
      const mint = "test_mint";

      // Set up initial state
      updateTargetState(mint, 0.05, 0.10);
      updateTargetState(mint, 0.05, 0.10);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);

      // Clear
      clearTargetState(mint);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);

      // Set up state again
      updateTargetState(mint, 0.05, 0.10);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);
    });
  });

  describe("clearAllTargetStates", () => {
    it("should clear all mints from state", () => {
      // Set up state for multiple mints
      updateTargetState("mint1", 0.05, 0.10);
      updateTargetState("mint1", 0.05, 0.10);

      updateTargetState("mint2", 0.05, 0.10);

      updateTargetState("mint3", 0.05, 0.10);
      updateTargetState("mint3", 0.05, 0.10);
      updateTargetState("mint3", 0.05, 0.10);

      // Verify state is set up
      expect(getConsecutiveTicksBelowCurrent("mint1")).toBe(2);
      expect(getConsecutiveTicksBelowCurrent("mint2")).toBe(1);
      expect(getConsecutiveTicksBelowCurrent("mint3")).toBe(3);

      // Clear all
      clearAllTargetStates();

      // All should be cleared
      expect(getConsecutiveTicksBelowCurrent("mint1")).toBe(0);
      expect(getConsecutiveTicksBelowCurrent("mint2")).toBe(0);
      expect(getConsecutiveTicksBelowCurrent("mint3")).toBe(0);
    });

    it("should be called in beforeEach to isolate tests", () => {
      // This test verifies that the beforeEach hook is working
      // by expecting the state to be clean at the start

      updateTargetState("test_mint", 0.05, 0.10);
      expect(getConsecutiveTicksBelowCurrent("test_mint")).toBe(1);

      // After the test, beforeEach will be called to clear state
      // This is verified by the next test starting with clean state
    });
  });

  describe("integration scenarios", () => {
    it("should handle a realistic rebalance flow where target drops persistently", () => {
      const mint = "SOL_USDC_LP";
      const nowMs = Date.now();
      const entryTimeMs = nowMs - 15 * 60 * 1000; // 15 minutes ago

      // Simulate price dropping over multiple ticks
      updateTargetState(mint, 0.08, 0.10); // tick 1: target < current
      updateTargetState(mint, 0.08, 0.10); // tick 2: target < current
      updateTargetState(mint, 0.08, 0.10); // tick 3: target < current

      // Now evaluate the gate
      const result = evaluateRebalanceSellGate({
        mint,
        symbol: "SOL_USDC",
        entryTimeMs,
        targetPct: 0.08,
        currentPct: 0.10,
        proceedsUsd: 500,
        minHoldMinutes: 5,
        confirmTicks: 3,
        minTrimUsd: 100,
      });

      expect(result.allowed).toBe(true);
      expect(result.skipReason).toBeNull();
    });

    it("should block rebalance when price bounces back up after initial drop", () => {
      const mint = "SOL_USDC_LP";
      const nowMs = Date.now();
      const entryTimeMs = nowMs - 15 * 60 * 1000; // 15 minutes ago

      // Simulate price dropping, then bouncing back
      updateTargetState(mint, 0.08, 0.10); // tick 1: target < current
      updateTargetState(mint, 0.08, 0.10); // tick 2: target < current
      updateTargetState(mint, 0.10, 0.10); // tick 3: target >= current (RESET)
      updateTargetState(mint, 0.10, 0.10); // tick 4: target >= current

      // Now evaluate the gate - should have 0 confirmTicks
      const result = evaluateRebalanceSellGate({
        mint,
        symbol: "SOL_USDC",
        entryTimeMs,
        targetPct: 0.10,
        currentPct: 0.10,
        proceedsUsd: 500,
        minHoldMinutes: 5,
        confirmTicks: 3,
        minTrimUsd: 100,
      });

      expect(result.allowed).toBe(false);
      expect(result.skipReason).toBe("TARGET_DROP_NOT_PERSISTENT");
      expect(result.confirmTicks).toBe(0);
    });

    it("should require fresh drop confirmation after reset", () => {
      const mint = "SOL_USDC_LP";
      const nowMs = Date.now();
      const entryTimeMs = nowMs - 15 * 60 * 1000; // 15 minutes ago

      // First drop confirmation
      updateTargetState(mint, 0.08, 0.10);
      updateTargetState(mint, 0.08, 0.10);
      updateTargetState(mint, 0.08, 0.10);

      // Price bounces back
      updateTargetState(mint, 0.10, 0.10);

      // Price drops again
      updateTargetState(mint, 0.08, 0.10);
      updateTargetState(mint, 0.08, 0.10);

      // Should still not be enough (only 2 ticks, need 3)
      const result = evaluateRebalanceSellGate({
        mint,
        symbol: "SOL_USDC",
        entryTimeMs,
        targetPct: 0.08,
        currentPct: 0.10,
        proceedsUsd: 500,
        minHoldMinutes: 5,
        confirmTicks: 3,
        minTrimUsd: 100,
      });

      expect(result.allowed).toBe(false);
      expect(result.skipReason).toBe("TARGET_DROP_NOT_PERSISTENT");
      expect(result.confirmTicks).toBe(2);
    });

    it("should handle multiple gate failures, returning first failure in priority order", () => {
      const nowMs = Date.now();
      // Position entered just now (age < minHoldMinutes)
      const entryTimeMs = nowMs - 1 * 60 * 1000; // 1 minute ago
      const minHoldMinutes = 5;

      // No confirmTicks set up (confirmTicks = 0)
      // proceedsUsd too small

      const result = evaluateRebalanceSellGate({
        mint: "test_mint",
        symbol: "TEST",
        entryTimeMs,
        targetPct: 0.05,
        currentPct: 0.10,
        proceedsUsd: 10, // less than minTrimUsd
        minHoldMinutes,
        confirmTicks: 3,
        minTrimUsd: 100,
      });

      // Should fail on first gate: MIN_HOLD_BEFORE_REBALANCE_SELL
      expect(result.skipReason).toBe("MIN_HOLD_BEFORE_REBALANCE_SELL");
    });

    it("should track independent mints without interference", () => {
      const nowMs = Date.now();
      const entryTimeMs = nowMs - 15 * 60 * 1000; // 15 minutes ago

      // Build up state for mint1
      updateTargetState("mint1", 0.08, 0.10);
      updateTargetState("mint1", 0.08, 0.10);
      updateTargetState("mint1", 0.08, 0.10);

      // Build up state for mint2 (less ticks)
      updateTargetState("mint2", 0.08, 0.10);
      updateTargetState("mint2", 0.08, 0.10);

      // Evaluate both
      const result1 = evaluateRebalanceSellGate({
        mint: "mint1",
        symbol: "TEST1",
        entryTimeMs,
        targetPct: 0.08,
        currentPct: 0.10,
        proceedsUsd: 500,
        minHoldMinutes: 5,
        confirmTicks: 3,
        minTrimUsd: 100,
      });

      const result2 = evaluateRebalanceSellGate({
        mint: "mint2",
        symbol: "TEST2",
        entryTimeMs,
        targetPct: 0.08,
        currentPct: 0.10,
        proceedsUsd: 500,
        minHoldMinutes: 5,
        confirmTicks: 3,
        minTrimUsd: 100,
      });

      // mint1 should be allowed
      expect(result1.allowed).toBe(true);
      expect(result1.confirmTicks).toBe(3);

      // mint2 should be blocked
      expect(result2.allowed).toBe(false);
      expect(result2.skipReason).toBe("TARGET_DROP_NOT_PERSISTENT");
      expect(result2.confirmTicks).toBe(2);
    });
  });

  describe("getConsecutiveTicksBelowCurrent", () => {
    it("should return 0 for non-existent mint", () => {
      expect(getConsecutiveTicksBelowCurrent("non_existent")).toBe(0);
    });

    it("should return correct count after updates", () => {
      const mint = "test_mint";

      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);

      updateTargetState(mint, 0.05, 0.10);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(1);

      updateTargetState(mint, 0.05, 0.10);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);
    });

    it("should return 0 after reset", () => {
      const mint = "test_mint";

      updateTargetState(mint, 0.05, 0.10);
      updateTargetState(mint, 0.05, 0.10);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(2);

      updateTargetState(mint, 0.10, 0.10);
      expect(getConsecutiveTicksBelowCurrent(mint)).toBe(0);
    });
  });

  describe("scout vs core regime sell guard", () => {
    // Helper function that mimics the guard logic from index.ts
    function shouldSkipRegimeSellForScout(slotType: string | undefined): boolean {
      return slotType === "scout";
    }

    describe("shouldSkipRegimeSellForScout helper", () => {
      it("should return true when slotType is 'scout'", () => {
        expect(shouldSkipRegimeSellForScout("scout")).toBe(true);
      });

      it("should return false when slotType is 'core'", () => {
        expect(shouldSkipRegimeSellForScout("core")).toBe(false);
      });

      it("should return false when slotType is undefined", () => {
        expect(shouldSkipRegimeSellForScout(undefined)).toBe(false);
      });
    });

    describe("regime sell behavior", () => {
      it("should NOT allow regime sell for scout positions regardless of drift", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;
        const confirmTicks = 3;

        // Set up state with enough confirmTicks for a normal regime sell to pass
        updateTargetState("scout_mint", 0.05, 0.10);
        updateTargetState("scout_mint", 0.05, 0.10);
        updateTargetState("scout_mint", 0.05, 0.10);

        // Evaluate the hysteresis gate (would normally pass)
        const gateResult = evaluateRebalanceSellGate({
          mint: "scout_mint",
          symbol: "SCOUT",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 500,
          minHoldMinutes,
          confirmTicks,
          minTrimUsd: 100,
        });

        // Hysteresis gate should pass
        expect(gateResult.allowed).toBe(true);

        // But the scout guard should block it
        const slotType = "scout";
        expect(shouldSkipRegimeSellForScout(slotType)).toBe(true);
        
        // Verify the guard blocks regime sell regardless of other parameters
        expect(shouldSkipRegimeSellForScout("scout")).toBe(true);
      });

      it("should allow regime sell for core positions subject to hysteresis gates", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 10 * 60 * 1000; // 10 minutes ago
        const minHoldMinutes = 5;
        const confirmTicks = 3;

        // Set up state with enough confirmTicks
        updateTargetState("core_mint", 0.05, 0.10);
        updateTargetState("core_mint", 0.05, 0.10);
        updateTargetState("core_mint", 0.05, 0.10);

        // Evaluate the hysteresis gate
        const gateResult = evaluateRebalanceSellGate({
          mint: "core_mint",
          symbol: "CORE",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 500,
          minHoldMinutes,
          confirmTicks,
          minTrimUsd: 100,
        });

        // Hysteresis gate should pass
        expect(gateResult.allowed).toBe(true);

        // Core positions are not blocked by scout guard
        const slotType = "core";
        expect(shouldSkipRegimeSellForScout(slotType)).toBe(false);
        
        // Regime sell is allowed for core (gate check passed)
        expect(gateResult.skipReason).toBeNull();
      });

      it("should respect hysteresis gates even for core positions", () => {
        const nowMs = Date.now();
        const entryTimeMs = nowMs - 2 * 60 * 1000; // 2 minutes ago (too soon)
        const minHoldMinutes = 5;
        const confirmTicks = 3;

        // Set up state
        updateTargetState("core_mint2", 0.05, 0.10);
        updateTargetState("core_mint2", 0.05, 0.10);
        updateTargetState("core_mint2", 0.05, 0.10);

        // Evaluate the hysteresis gate with insufficient age
        const gateResult = evaluateRebalanceSellGate({
          mint: "core_mint2",
          symbol: "CORE2",
          entryTimeMs,
          targetPct: 0.05,
          currentPct: 0.10,
          proceedsUsd: 500,
          minHoldMinutes,
          confirmTicks,
          minTrimUsd: 100,
        });

        // Hysteresis gate should block due to age
        expect(gateResult.allowed).toBe(false);
        expect(gateResult.skipReason).toBe("MIN_HOLD_BEFORE_REBALANCE_SELL");

        // Core position still respects hysteresis gates
        const slotType = "core";
        expect(shouldSkipRegimeSellForScout(slotType)).toBe(false);
        
        // But gate blocked it due to age
        expect(gateResult.ageMinutes).toBeLessThan(minHoldMinutes);
      });
    });
  });
});
