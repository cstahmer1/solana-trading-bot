import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../db.js", () => ({
  q: vi.fn(),
}));

import { q } from "../db.js";
import {
  addTrackedMint,
  getTrackedMints,
  getTrackedMintCount,
  updateLastPrice,
  getLastPrice,
  fillForwardBars,
  clearTrackedMints,
  clearLastPriceCache,
  _getTrackedMintsMap,
  _getLastPriceCacheMap,
  hydrateLastPriceCache,
  hydrateTrackedMintsFromDb,
} from "../bar_writer.js";

const mockQ = vi.mocked(q);

describe("bar_writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTrackedMints();
    clearLastPriceCache();
  });

  describe("trackedMints management", () => {
    it("should add a mint to tracked set", () => {
      addTrackedMint("MINT_A");
      
      expect(getTrackedMints()).toContain("MINT_A");
      expect(getTrackedMintCount()).toBe(1);
    });

    it("should update expiry when adding same mint again", () => {
      addTrackedMint("MINT_A");
      const map = _getTrackedMintsMap();
      const firstExpiry = map.get("MINT_A")!.expiresAt;
      
      addTrackedMint("MINT_A");
      const secondExpiry = map.get("MINT_A")!.expiresAt;
      
      expect(getTrackedMintCount()).toBe(1);
      expect(secondExpiry).toBeGreaterThanOrEqual(firstExpiry);
    });

    it("should evict oldest mint when at capacity (200)", () => {
      for (let i = 0; i < 200; i++) {
        addTrackedMint(`MINT_${i}`);
      }
      expect(getTrackedMintCount()).toBe(200);
      
      addTrackedMint("NEW_MINT");
      
      expect(getTrackedMintCount()).toBe(200);
      expect(getTrackedMints()).toContain("NEW_MINT");
      expect(getTrackedMints()).not.toContain("MINT_0");
    });
  });

  describe("lastPrice cache", () => {
    it("should store and retrieve last price", () => {
      updateLastPrice("MINT_A", 1.5);
      
      expect(getLastPrice("MINT_A")).toBe(1.5);
    });

    it("should return null for unknown mint", () => {
      expect(getLastPrice("UNKNOWN")).toBeNull();
    });

    it("should not store zero or negative prices", () => {
      updateLastPrice("MINT_A", 0);
      updateLastPrice("MINT_B", -1);
      
      expect(getLastPrice("MINT_A")).toBeNull();
      expect(getLastPrice("MINT_B")).toBeNull();
    });
  });

  describe("fillForwardBars", () => {
    it("should insert bar when mint is tracked and has last price", async () => {
      addTrackedMint("MINT_A");
      updateLastPrice("MINT_A", 1.5);
      
      mockQ.mockResolvedValueOnce([{ mint: "MINT_A" }]);
      
      const result = await fillForwardBars();
      
      expect(result.trackedMintCount).toBe(1);
      expect(result.barsWritten).toBe(1);
      expect(result.skippedNoPriceCount).toBe(0);
      expect(mockQ).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO prices")
      );
    });

    it("should skip mint if no last price available", async () => {
      addTrackedMint("MINT_A");
      
      const result = await fillForwardBars();
      
      expect(result.trackedMintCount).toBe(1);
      expect(result.barsWritten).toBe(0);
      expect(result.skippedNoPriceCount).toBe(1);
      expect(mockQ).not.toHaveBeenCalled();
    });

    it("should count conflicts as skippedAlreadyExists", async () => {
      addTrackedMint("MINT_A");
      addTrackedMint("MINT_B");
      updateLastPrice("MINT_A", 1.5);
      updateLastPrice("MINT_B", 2.0);
      
      mockQ.mockResolvedValueOnce([{ mint: "MINT_A" }]);
      
      const result = await fillForwardBars();
      
      expect(result.trackedMintCount).toBe(2);
      expect(result.barsWritten).toBe(1);
      expect(result.skippedAlreadyExistsCount).toBe(1);
    });

    it("should return empty result if no tracked mints", async () => {
      const result = await fillForwardBars();
      
      expect(result.trackedMintCount).toBe(0);
      expect(result.barsWritten).toBe(0);
      expect(mockQ).not.toHaveBeenCalled();
    });
  });

  describe("hydration", () => {
    it("should hydrate tracked mints from position_tracking", async () => {
      mockQ.mockResolvedValueOnce([
        { mint: "MINT_A" },
        { mint: "MINT_B" },
      ]);
      
      const count = await hydrateTrackedMintsFromDb();
      
      expect(count).toBe(2);
      expect(getTrackedMints()).toContain("MINT_A");
      expect(getTrackedMints()).toContain("MINT_B");
    });

    it("should hydrate last prices from DB", async () => {
      addTrackedMint("MINT_A");
      addTrackedMint("MINT_B");
      
      mockQ.mockResolvedValueOnce([
        { mint: "MINT_A", usd_price: 1.5 },
        { mint: "MINT_B", usd_price: 2.5 },
      ]);
      
      const count = await hydrateLastPriceCache();
      
      expect(count).toBe(2);
      expect(getLastPrice("MINT_A")).toBe(1.5);
      expect(getLastPrice("MINT_B")).toBe(2.5);
    });
  });

  describe("SMA integration", () => {
    it("after 60 bars, SMA should be computable", async () => {
      addTrackedMint("MINT_A");
      updateLastPrice("MINT_A", 1.0);
      
      for (let i = 0; i < 60; i++) {
        mockQ.mockResolvedValueOnce([{ mint: "MINT_A" }]);
        await fillForwardBars();
      }
      
      expect(mockQ).toHaveBeenCalledTimes(60);
    });
  });
});
