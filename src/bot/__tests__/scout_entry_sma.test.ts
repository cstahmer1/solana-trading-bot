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
  computeSMAWithMeta,
  evaluateScoutEntry,
  type PriceBar,
} from "../price_metrics.js";

const mockQ = vi.mocked(q);

function generateBars(count: number, basePrice: number, startMinutesAgo: number): { ts: Date; usd_price: number }[] {
  const now = Date.now();
  const bars = [];
  for (let i = 0; i < count; i++) {
    const minutesAgo = startMinutesAgo - i;
    bars.push({
      ts: new Date(now - minutesAgo * 60 * 1000),
      usd_price: basePrice + (i * 0.001),
    });
  }
  return bars;
}

describe("scout_entry_sma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("computeSMAWithMeta", () => {
    it("should return null sma when bars < requested minutes (100% required)", async () => {
      mockQ.mockResolvedValueOnce(generateBars(200, 1.0, 240));
      
      const result = await computeSMAWithMeta("TEST_MINT", 240);
      
      expect(result.sma).toBeNull();
      expect(result.bars).toBe(200);
      expect(result.minutes).toBe(240);
    });

    it("should return valid sma when bars >= requested minutes (100% required)", async () => {
      mockQ.mockResolvedValueOnce(generateBars(240, 1.0, 240));
      
      const result = await computeSMAWithMeta("TEST_MINT", 240);
      
      expect(result.sma).not.toBeNull();
      expect(result.bars).toBe(240);
      expect(result.minutes).toBe(240);
    });

    it("should compute correct average", async () => {
      const bars = [
        { ts: new Date(Date.now() - 2 * 60 * 1000), usd_price: 1.0 },
        { ts: new Date(Date.now() - 1 * 60 * 1000), usd_price: 2.0 },
        { ts: new Date(Date.now()), usd_price: 3.0 },
      ];
      mockQ.mockResolvedValueOnce(bars);
      
      const result = await computeSMAWithMeta("TEST_MINT", 3);
      
      expect(result.sma).toBeCloseTo(2.0, 5);
    });
  });

  describe("evaluateScoutEntry SMA gating", () => {
    const baseConfig = {
      scoutChaseRet15Max: 0.25,
      scoutImpulseRet15Min: 0.10,
      scoutPullbackFromHigh15Min: 0.08,
      scoutEntrySmaMinutes: 30,
      scoutEntryRequireAboveSma: true,
      scoutEntryTrendSmaMinutes: 240,
    };

    it("should FAIL with INSUFFICIENT_HISTORY when trend SMA cannot be computed", async () => {
      mockQ.mockResolvedValueOnce(generateBars(65, 1.0, 65));
      mockQ.mockResolvedValueOnce(generateBars(30, 1.0, 30));
      mockQ.mockResolvedValueOnce(generateBars(200, 1.0, 240));
      
      const result = await evaluateScoutEntry("TEST_MINT", baseConfig, "TEST");
      
      expect(result.pass).toBe(false);
      expect(result.failReason).toBe("INSUFFICIENT_HISTORY");
    });

    it("should FAIL with BELOW_TREND_SMA when price <= trend SMA", async () => {
      const currentPrice = 1.0;
      const trendSmaPrice = 1.1;
      
      mockQ.mockResolvedValueOnce([
        ...generateBars(64, trendSmaPrice, 65),
        { ts: new Date(Date.now()), usd_price: currentPrice },
      ]);
      mockQ.mockResolvedValueOnce(generateBars(30, 1.05, 30));
      mockQ.mockResolvedValueOnce(generateBars(240, trendSmaPrice, 240));
      
      const result = await evaluateScoutEntry("TEST_MINT", baseConfig, "TEST");
      
      expect(result.pass).toBe(false);
      expect(result.failReason).toBe("BELOW_TREND_SMA");
    });

    it("should PASS when price > trend SMA even if below short SMA (pullback entry)", async () => {
      const currentPrice = 1.10;
      const now = Date.now();
      
      const computePriceMetricsBars = [];
      for (let i = 0; i < 65; i++) {
        computePriceMetricsBars.push({
          ts: new Date(now - (65 - i) * 60 * 1000),
          usd_price: 1.08 + (i * 0.0005),
        });
      }
      computePriceMetricsBars[computePriceMetricsBars.length - 1].usd_price = currentPrice;
      
      const shortSmaBars = [];
      for (let i = 0; i < 30; i++) {
        shortSmaBars.push({
          ts: new Date(now - (30 - i) * 60 * 1000),
          usd_price: 1.12,
        });
      }
      
      const trendSmaBars = [];
      for (let i = 0; i < 240; i++) {
        trendSmaBars.push({
          ts: new Date(now - (240 - i) * 60 * 1000),
          usd_price: 1.0,
        });
      }
      
      mockQ.mockResolvedValueOnce(computePriceMetricsBars);
      mockQ.mockResolvedValueOnce(shortSmaBars);
      mockQ.mockResolvedValueOnce(trendSmaBars);
      
      const result = await evaluateScoutEntry("TEST_MINT", baseConfig, "TEST");
      
      expect(result.pass).toBe(true);
      expect(result.failReason).toBeNull();
    });

    it("should skip SMA gating when scoutEntryRequireAboveSma is false", async () => {
      const configOff = { ...baseConfig, scoutEntryRequireAboveSma: false };
      
      mockQ.mockResolvedValueOnce([
        ...generateBars(64, 1.0, 65),
        { ts: new Date(Date.now()), usd_price: 0.5 },
      ]);
      
      const result = await evaluateScoutEntry("TEST_MINT", configOff, "TEST");
      
      expect(result.pass).toBe(true);
      expect(result.failReason).toBeNull();
    });

    it("should still fail CHASE_RET15 before checking SMA", async () => {
      const barsWithHighRet = [
        { ts: new Date(Date.now() - 15 * 60 * 1000), usd_price: 0.5 },
        ...generateBars(63, 1.0, 14),
        { ts: new Date(Date.now()), usd_price: 1.0 },
      ];
      mockQ.mockResolvedValueOnce(barsWithHighRet);
      
      const result = await evaluateScoutEntry("TEST_MINT", baseConfig, "TEST");
      
      expect(result.pass).toBe(false);
      expect(result.failReason).toBe("CHASE_RET15");
    });

    it("should include smaTrend and smaShort metrics in result", async () => {
      const currentPrice = 1.05;
      
      mockQ.mockResolvedValueOnce([
        ...generateBars(64, 1.02, 65),
        { ts: new Date(Date.now()), usd_price: currentPrice },
      ]);
      mockQ.mockResolvedValueOnce(generateBars(30, 1.03, 30));
      mockQ.mockResolvedValueOnce(generateBars(240, 1.0, 240));
      
      const result = await evaluateScoutEntry("TEST_MINT", baseConfig, "TEST");
      
      expect(result.metrics).toHaveProperty("smaTrend");
      expect(result.metrics).toHaveProperty("smaTrendBars");
      expect(result.metrics).toHaveProperty("smaShort");
      expect(result.metrics).toHaveProperty("smaShortBars");
    });
  });
});
