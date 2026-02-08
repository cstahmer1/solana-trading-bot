import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetStaleBuyingScoutQueue, DEFAULT_WATCHDOG_CONFIG } from "../scoutQueueWatchdog.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  q: (...args: any[]) => mockQuery(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("scoutQueueWatchdog", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("resetStaleBuyingScoutQueue", () => {
    it("returns empty result when no stale rows found", async () => {
      mockQuery.mockResolvedValueOnce([]);

      const result = await resetStaleBuyingScoutQueue();

      expect(result).toEqual({
        resetToPending: 0,
        markedSkipped: 0,
        resetMints: [],
        skippedMints: [],
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("resets stale row to PENDING with incremented buy_attempts and backoff", async () => {
      const staleRow = {
        mint: "test-mint-123",
        symbol: "TEST",
        buy_attempts: 0,
        in_progress_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      mockQuery
        .mockResolvedValueOnce([staleRow])
        .mockResolvedValueOnce([]);

      const result = await resetStaleBuyingScoutQueue({
        staleMinutes: 5,
        maxBuyAttempts: 3,
        baseBackoffMinutes: 2,
      });

      expect(result.resetToPending).toBe(1);
      expect(result.markedSkipped).toBe(0);
      expect(result.resetMints).toContain("test-mint-123");

      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'PENDING'");
      expect(updateCall[1][0]).toBe("test-mint-123");
      expect(updateCall[1][1]).toBe(1);
      expect(updateCall[1][2]).toContain("STALE_CLAIM_RESET");
    });

    it("marks row SKIPPED after max retry attempts exceeded", async () => {
      const staleRow = {
        mint: "test-mint-max-retries",
        symbol: "MAXR",
        buy_attempts: 2,
        in_progress_at: new Date(Date.now() - 10 * 60 * 1000),
      };

      mockQuery
        .mockResolvedValueOnce([staleRow])
        .mockResolvedValueOnce([]);

      const result = await resetStaleBuyingScoutQueue({
        staleMinutes: 5,
        maxBuyAttempts: 3,
        baseBackoffMinutes: 2,
      });

      expect(result.resetToPending).toBe(0);
      expect(result.markedSkipped).toBe(1);
      expect(result.skippedMints).toContain("test-mint-max-retries");

      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'SKIPPED'");
      expect(updateCall[1][0]).toBe("test-mint-max-retries");
      expect(updateCall[1][1]).toBe(3);
      expect(updateCall[1][2]).toContain("STALE_CLAIM_MAX_RETRIES");
    });

    it("applies exponential backoff correctly", async () => {
      const staleRows = [
        {
          mint: "mint-attempt-1",
          symbol: "T1",
          buy_attempts: 0,
          in_progress_at: new Date(Date.now() - 10 * 60 * 1000),
        },
        {
          mint: "mint-attempt-2",
          symbol: "T2",
          buy_attempts: 1,
          in_progress_at: new Date(Date.now() - 10 * 60 * 1000),
        },
      ];

      mockQuery
        .mockResolvedValueOnce(staleRows)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const baseBackoffMinutes = 2;
      const result = await resetStaleBuyingScoutQueue({
        staleMinutes: 5,
        maxBuyAttempts: 5,
        baseBackoffMinutes,
      });

      expect(result.resetToPending).toBe(2);
      expect(result.markedSkipped).toBe(0);

      const call1 = mockQuery.mock.calls[1];
      const nextAttempt1 = new Date(call1[1][3]);
      const expectedBackoff1 = baseBackoffMinutes * Math.pow(2, 0);
      const actualBackoff1 = (nextAttempt1.getTime() - Date.now()) / 60000;
      expect(actualBackoff1).toBeCloseTo(expectedBackoff1, 0);

      const call2 = mockQuery.mock.calls[2];
      const nextAttempt2 = new Date(call2[1][3]);
      const expectedBackoff2 = baseBackoffMinutes * Math.pow(2, 1);
      const actualBackoff2 = (nextAttempt2.getTime() - Date.now()) / 60000;
      expect(actualBackoff2).toBeCloseTo(expectedBackoff2, 0);
    });

    it("processes mix of reset and skip rows", async () => {
      const staleRows = [
        {
          mint: "mint-reset",
          symbol: "RES",
          buy_attempts: 1,
          in_progress_at: new Date(Date.now() - 10 * 60 * 1000),
        },
        {
          mint: "mint-skip",
          symbol: "SKP",
          buy_attempts: 2,
          in_progress_at: new Date(Date.now() - 10 * 60 * 1000),
        },
      ];

      mockQuery
        .mockResolvedValueOnce(staleRows)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await resetStaleBuyingScoutQueue({
        staleMinutes: 5,
        maxBuyAttempts: 3,
        baseBackoffMinutes: 2,
      });

      expect(result.resetToPending).toBe(1);
      expect(result.markedSkipped).toBe(1);
      expect(result.resetMints).toContain("mint-reset");
      expect(result.skippedMints).toContain("mint-skip");
    });

    it("uses default config when not provided", async () => {
      mockQuery.mockResolvedValueOnce([]);

      await resetStaleBuyingScoutQueue();

      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[1][0]).toBe(DEFAULT_WATCHDOG_CONFIG.staleMinutes);
    });
  });
});
