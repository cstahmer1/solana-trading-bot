import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isProtectiveExit,
  PROTECTIVE_EXIT_REASONS,
} from "../liquidation_lock.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("liquidation_lock", () => {
  describe("isProtectiveExit", () => {
    it("should return true for scout_stop_loss_exit", () => {
      expect(isProtectiveExit("scout_stop_loss_exit")).toBe(true);
    });

    it("should return true for break_even_exit", () => {
      expect(isProtectiveExit("break_even_exit")).toBe(true);
    });

    it("should return true for break_even_lock_exit", () => {
      expect(isProtectiveExit("break_even_lock_exit")).toBe(true);
    });

    it("should return true for stale_timeout_exit", () => {
      expect(isProtectiveExit("stale_timeout_exit")).toBe(true);
    });

    it("should return true for core_loss_exit", () => {
      expect(isProtectiveExit("core_loss_exit")).toBe(true);
    });

    it("should return false for scout_take_profit_exit (non-protective)", () => {
      expect(isProtectiveExit("scout_take_profit_exit")).toBe(false);
    });

    it("should return false for take_profit (non-protective)", () => {
      expect(isProtectiveExit("take_profit")).toBe(false);
    });

    it("should return false for flash_close (non-protective)", () => {
      expect(isProtectiveExit("flash_close")).toBe(false);
    });

    it("should return false for universe_exit (non-protective)", () => {
      expect(isProtectiveExit("universe_exit")).toBe(false);
    });

    it("should return false for arbitrary unknown reason", () => {
      expect(isProtectiveExit("unknown_reason")).toBe(false);
      expect(isProtectiveExit("")).toBe(false);
      expect(isProtectiveExit("random_text")).toBe(false);
    });

    it("should match all declared PROTECTIVE_EXIT_REASONS", () => {
      for (const reason of PROTECTIVE_EXIT_REASONS) {
        expect(isProtectiveExit(reason)).toBe(true);
      }
    });
  });

  describe("PROTECTIVE_EXIT_REASONS", () => {
    it("should contain exactly 5 protective exit reasons", () => {
      expect(PROTECTIVE_EXIT_REASONS.length).toBe(5);
    });

    it("should include scout_stop_loss_exit", () => {
      expect(PROTECTIVE_EXIT_REASONS).toContain("scout_stop_loss_exit");
    });

    it("should include break_even_exit", () => {
      expect(PROTECTIVE_EXIT_REASONS).toContain("break_even_exit");
    });

    it("should include break_even_lock_exit", () => {
      expect(PROTECTIVE_EXIT_REASONS).toContain("break_even_lock_exit");
    });

    it("should include stale_timeout_exit", () => {
      expect(PROTECTIVE_EXIT_REASONS).toContain("stale_timeout_exit");
    });

    it("should include core_loss_exit", () => {
      expect(PROTECTIVE_EXIT_REASONS).toContain("core_loss_exit");
    });

    it("should NOT include scout_take_profit_exit", () => {
      expect(PROTECTIVE_EXIT_REASONS).not.toContain("scout_take_profit_exit");
    });

    it("should NOT include take_profit", () => {
      expect(PROTECTIVE_EXIT_REASONS).not.toContain("take_profit");
    });
  });
});
