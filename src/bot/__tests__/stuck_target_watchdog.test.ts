import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkStuckTarget,
  recordExecutionOutcome,
  clearStuckTargetState,
  getStuckTargetState,
  getStuckTargetSummary,
  type ExecutionOutcome,
} from "../stuck_target_watchdog.js";
import type { RuntimeConfig } from "../runtime_config.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const makeConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  allocationStuckWatchdogEnabled: true,
  allocationStuckMinGapPct: 0.02,
  allocationStuckMaxAttempts: 3,
  allocationStuckBackoffMinutesBase: 5,
  ...overrides,
} as RuntimeConfig);

describe("stuck_target_watchdog", () => {
  beforeEach(() => {
    clearStuckTargetState();
  });

  describe("checkStuckTarget", () => {
    it("returns blocked=false when watchdog is disabled", () => {
      const config = makeConfig({ allocationStuckWatchdogEnabled: false });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      const result = checkStuckTarget("MINT_A", config);

      expect(result.blocked).toBe(false);
    });

    it("returns blocked=false when mint has no failures", () => {
      const config = makeConfig();

      const result = checkStuckTarget("MINT_NEW", config);

      expect(result.blocked).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it("returns blocked=true when mint is in backoff", () => {
      const config = makeConfig({ allocationStuckMaxAttempts: 2 });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      const result = checkStuckTarget("MINT_A", config);

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("STUCK_BACKOFF");
      expect(result.backoffMinutesRemaining).toBeGreaterThan(0);
    });

    it("returns blocked=false after backoff expires", () => {
      const config = makeConfig({
        allocationStuckMaxAttempts: 2,
        allocationStuckBackoffMinutesBase: 0.001,
      });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      vi.useFakeTimers();
      vi.advanceTimersByTime(5 * 60 * 1000);

      const result = checkStuckTarget("MINT_A", config);

      expect(result.blocked).toBe(false);

      vi.useRealTimers();
    });
  });

  describe("recordExecutionOutcome", () => {
    it("increments failures on SKIPPED outcome", () => {
      const config = makeConfig();

      recordExecutionOutcome("MINT_A", "SKIPPED", config);

      const state = getStuckTargetState("MINT_A");
      expect(state?.consecutiveFailures).toBe(1);
      expect(state?.lastReason).toBe("SKIPPED");
    });

    it("increments failures on FAILED outcome", () => {
      const config = makeConfig();

      recordExecutionOutcome("MINT_A", "FAILED", config);

      const state = getStuckTargetState("MINT_A");
      expect(state?.consecutiveFailures).toBe(1);
      expect(state?.lastReason).toBe("FAILED");
    });

    it("increments failures cumulatively", () => {
      const config = makeConfig();

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "SKIPPED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      const state = getStuckTargetState("MINT_A");
      expect(state?.consecutiveFailures).toBe(3);
    });

    it("triggers backoff after maxAttempts", () => {
      const config = makeConfig({ allocationStuckMaxAttempts: 3 });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      let state = getStuckTargetState("MINT_A");
      expect(state?.backoffUntil).toBe(0);

      recordExecutionOutcome("MINT_A", "FAILED", config);

      state = getStuckTargetState("MINT_A");
      expect(state?.backoffUntil).toBeGreaterThan(Date.now());
    });

    it("resets state on SUBMITTED outcome", () => {
      const config = makeConfig();

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      expect(getStuckTargetState("MINT_A")).toBeDefined();

      recordExecutionOutcome("MINT_A", "SUBMITTED", config);

      expect(getStuckTargetState("MINT_A")).toBeUndefined();
    });

    it("resets state on CONFIRMED outcome", () => {
      const config = makeConfig();

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      expect(getStuckTargetState("MINT_A")).toBeDefined();

      recordExecutionOutcome("MINT_A", "CONFIRMED", config);

      expect(getStuckTargetState("MINT_A")).toBeUndefined();
    });

    it("does not track when watchdog is disabled", () => {
      const config = makeConfig({ allocationStuckWatchdogEnabled: false });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      expect(getStuckTargetState("MINT_A")).toBeUndefined();
    });
  });

  describe("exponential backoff calculation", () => {
    it("backoff increases exponentially with failures beyond maxAttempts", () => {
      const config = makeConfig({
        allocationStuckMaxAttempts: 2,
        allocationStuckBackoffMinutesBase: 5,
      });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      const state1 = getStuckTargetState("MINT_A");
      const backoff1 = state1!.backoffUntil - state1!.lastAttemptAt;

      clearStuckTargetState("MINT_A");

      recordExecutionOutcome("MINT_B", "FAILED", config);
      recordExecutionOutcome("MINT_B", "FAILED", config);
      recordExecutionOutcome("MINT_B", "FAILED", config);

      const state2 = getStuckTargetState("MINT_B");
      const backoff2 = state2!.backoffUntil - state2!.lastAttemptAt;

      expect(backoff2).toBeGreaterThan(backoff1);
      expect(backoff2).toBeCloseTo(backoff1 * 2, -3);
    });

    it("first backoff equals base minutes", () => {
      const baseMinutes = 10;
      const config = makeConfig({
        allocationStuckMaxAttempts: 2,
        allocationStuckBackoffMinutesBase: baseMinutes,
      });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      const state = getStuckTargetState("MINT_A");
      const backoffMs = state!.backoffUntil - state!.lastAttemptAt;
      const backoffMinutes = backoffMs / 60000;

      expect(backoffMinutes).toBeCloseTo(baseMinutes, 0);
    });

    it("backoff is 2^exponent times base", () => {
      const baseMinutes = 5;
      const config = makeConfig({
        allocationStuckMaxAttempts: 2,
        allocationStuckBackoffMinutesBase: baseMinutes,
      });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      const state = getStuckTargetState("MINT_A");
      const backoffMs = state!.backoffUntil - state!.lastAttemptAt;
      const backoffMinutes = backoffMs / 60000;

      const exponent = 4 - 2;
      const expectedMinutes = baseMinutes * Math.pow(2, exponent);
      expect(backoffMinutes).toBeCloseTo(expectedMinutes, 0);
    });
  });

  describe("getStuckTargetSummary", () => {
    it("returns correct totalBlocked count", () => {
      const config = makeConfig({ allocationStuckMaxAttempts: 2 });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_B", "FAILED", config);
      recordExecutionOutcome("MINT_B", "FAILED", config);

      const summary = getStuckTargetSummary();

      expect(summary.totalBlocked).toBe(2);
    });

    it("returns correct blockedMints data", () => {
      const config = makeConfig({ allocationStuckMaxAttempts: 2 });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      const summary = getStuckTargetSummary();

      expect(summary.blockedMints.length).toBe(1);
      expect(summary.blockedMints[0].mint).toBe("MINT_A");
      expect(summary.blockedMints[0].failures).toBe(2);
      expect(summary.blockedMints[0].backoffMinutesRemaining).toBeGreaterThan(0);
    });

    it("returns empty when no blocked mints", () => {
      const config = makeConfig({ allocationStuckMaxAttempts: 5 });

      recordExecutionOutcome("MINT_A", "FAILED", config);

      const summary = getStuckTargetSummary();

      expect(summary.totalBlocked).toBe(0);
      expect(summary.blockedMints.length).toBe(0);
    });

    it("excludes mints whose backoff has expired", () => {
      const config = makeConfig({
        allocationStuckMaxAttempts: 2,
        allocationStuckBackoffMinutesBase: 0.0001,
      });

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_A", "FAILED", config);

      vi.useFakeTimers();
      vi.advanceTimersByTime(60 * 1000);

      const summary = getStuckTargetSummary();
      expect(summary.totalBlocked).toBe(0);

      vi.useRealTimers();
    });
  });

  describe("clearStuckTargetState", () => {
    it("clears state for specific mint", () => {
      const config = makeConfig();

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_B", "FAILED", config);

      clearStuckTargetState("MINT_A");

      expect(getStuckTargetState("MINT_A")).toBeUndefined();
      expect(getStuckTargetState("MINT_B")).toBeDefined();
    });

    it("clears all state when no mint specified", () => {
      const config = makeConfig();

      recordExecutionOutcome("MINT_A", "FAILED", config);
      recordExecutionOutcome("MINT_B", "FAILED", config);

      clearStuckTargetState();

      expect(getStuckTargetState("MINT_A")).toBeUndefined();
      expect(getStuckTargetState("MINT_B")).toBeUndefined();
    });
  });
});
