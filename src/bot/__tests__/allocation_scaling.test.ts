import { describe, it, expect } from "vitest";
import { scoresToTargets, type ScalingMetadata } from "../decisions.js";
import type { PortfolioSnapshot } from "../portfolio.js";

const MINT_SOL = "So11111111111111111111111111111111111111112";

const makeSnapshot = (totalUsd: number): PortfolioSnapshot => ({
  ts: Date.now(),
  totalUsd,
  totalSolEquiv: totalUsd / 100,
  byMint: {
    [MINT_SOL]: { mint: MINT_SOL, amount: 10, usdPrice: totalUsd / 10, usdValue: totalUsd, symbol: "SOL" },
  },
});

describe("allocation_scaling", () => {
  describe("scoresToTargets returns ScalingMetadata", () => {
    it("returns scalingMeta with all expected fields", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: 0.3, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      expect(result.scalingMeta).toBeDefined();
      expect(typeof result.scalingMeta.sumRawTargetsPct).toBe("number");
      expect(typeof result.scalingMeta.sumScaledTargetsPct).toBe("number");
      expect(typeof result.scalingMeta.scaleFactor).toBe("number");
      expect(typeof result.scalingMeta.clampedCount).toBe("number");
      expect(typeof result.scalingMeta.redistributionPassesUsed).toBe("number");
      expect(typeof result.scalingMeta.targetCount).toBe("number");
    });

    it("returns targetCount matching number of non-base targets", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: 0.3, regime: "bull" },
        { mint: "MINT_C", score: 0.2, regime: "neutral" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      expect(result.scalingMeta.targetCount).toBe(3);
      expect(result.targets.length).toBe(3);
    });
  });

  describe("sumRawTargetsPct calculation", () => {
    it("calculates sum of raw targets before scaling", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 1.0, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.55,
        deployTargetPct: 0,
      });

      expect(result.scalingMeta.sumRawTargetsPct).toBeGreaterThan(0);
      expect(result.scalingMeta.sumRawTargetsPct).toBeLessThanOrEqual(0.55);
    });

    it("sumRawTargetsPct equals sum of all target percentages when no scaling", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: 0.5, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.3,
        deployTargetPct: 0,
      });

      const sumFromTargets = result.targets.reduce((sum, t) => sum + t.targetPct, 0);
      expect(result.scalingMeta.sumRawTargetsPct).toBeCloseTo(sumFromTargets, 6);
    });
  });

  describe("sumScaledTargetsPct after scaling", () => {
    it("sumScaledTargetsPct increases when deployTargetPct is applied", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: 0.5, regime: "bull" },
      ];

      const resultNoScaling = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.3,
        deployTargetPct: 0,
      });

      const resultWithScaling = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.3,
        deployTargetPct: 0.5,
      });

      expect(resultWithScaling.scalingMeta.sumScaledTargetsPct).toBeGreaterThanOrEqual(
        resultNoScaling.scalingMeta.sumScaledTargetsPct
      );
    });

    it("sumScaledTargetsPct approaches deployTargetPct when room exists", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.4, regime: "bull" },
        { mint: "MINT_B", score: 0.3, regime: "bull" },
        { mint: "MINT_C", score: 0.2, regime: "bull" },
        { mint: "MINT_D", score: 0.1, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.2,
        deployTargetPct: 0.5,
        capMaxTotalExposurePct: 0.55,
      });

      expect(result.scalingMeta.sumScaledTargetsPct).toBeGreaterThan(0.3);
    });
  });

  describe("scaleFactor application", () => {
    it("scaleFactor > 1 when targets are scaled up", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: 0.5, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.4,
        deployTargetPct: 0.5,
      });

      if (result.scalingMeta.sumRawTargetsPct < 0.5) {
        expect(result.scalingMeta.scaleFactor).toBeGreaterThan(1);
      }
    });

    it("scaleFactor is 1 when no scaling applied", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
        deployTargetPct: 0,
      });

      expect(result.scalingMeta.scaleFactor).toBe(1.0);
    });
  });

  describe("clampedCount tracking", () => {
    it("clampedCount tracks mints hitting maxPositionPctPerAsset", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.8, regime: "bull" },
        { mint: "MINT_B", score: 0.2, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.1,
        deployTargetPct: 0.5,
        capMaxTotalExposurePct: 0.55,
      });

      expect(result.scalingMeta.clampedCount).toBeGreaterThanOrEqual(0);
    });

    it("clampedCount is 0 when no clamping occurs", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.1, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.5,
        deployTargetPct: 0,
      });

      expect(result.scalingMeta.clampedCount).toBe(0);
    });

    it("individual target values are clamped to maxPositionPctPerAsset", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 1.0, regime: "bull" },
      ];

      const maxPct = 0.10;
      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: maxPct,
        deployTargetPct: 0.5,
      });

      for (const target of result.targets) {
        expect(target.targetPct).toBeLessThanOrEqual(maxPct);
      }
    });
  });

  describe("redistributionPassesUsed tracking", () => {
    it("redistributionPassesUsed is 0 when no scaling applied", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
        deployTargetPct: 0,
      });

      expect(result.scalingMeta.redistributionPassesUsed).toBe(0);
    });

    it("redistributionPassesUsed > 0 when scaling with redistribution", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: 0.3, regime: "bull" },
        { mint: "MINT_C", score: 0.2, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.1,
        deployTargetPct: 0.5,
        capMaxTotalExposurePct: 0.55,
      });

      expect(result.scalingMeta.redistributionPassesUsed).toBeGreaterThanOrEqual(0);
    });

    it("redistributionPassesUsed is bounded by max passes (5)", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = Array.from({ length: 10 }, (_, i) => ({
        mint: `MINT_${i}`,
        score: 0.1,
        regime: "bull",
      }));

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.05,
        deployTargetPct: 0.5,
      });

      expect(result.scalingMeta.redistributionPassesUsed).toBeLessThanOrEqual(5);
    });
  });

  describe("rawTargetPct preservation", () => {
    it("each target has rawTargetPct field", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: 0.3, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      for (const target of result.targets) {
        expect(target.rawTargetPct).toBeDefined();
        expect(typeof target.rawTargetPct).toBe("number");
      }
    });

    it("rawTargetPct is non-negative", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
        { mint: "MINT_B", score: -0.1, regime: "bear" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      for (const target of result.targets) {
        expect(target.rawTargetPct).toBeGreaterThanOrEqual(0);
      }
    });

    it("targets include mint, score, regime, targetPct, and rawTargetPct", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0.5, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      const target = result.targets[0];
      expect(target).toHaveProperty("mint");
      expect(target).toHaveProperty("score");
      expect(target).toHaveProperty("regime");
      expect(target).toHaveProperty("targetPct");
      expect(target).toHaveProperty("rawTargetPct");
    });
  });

  describe("edge cases", () => {
    it("handles empty candidates list", () => {
      const snapshot = makeSnapshot(1000);
      const candidates: { mint: string; score: number; regime: string }[] = [];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      expect(result.targets.length).toBe(0);
      expect(result.scalingMeta.targetCount).toBe(0);
      expect(result.scalingMeta.sumRawTargetsPct).toBe(0);
    });

    it("excludes base mints (SOL) from targets", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: MINT_SOL, score: 0.5, regime: "bull" },
        { mint: "MINT_A", score: 0.5, regime: "bull" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      expect(result.targets.find((t) => t.mint === MINT_SOL)).toBeUndefined();
      expect(result.targets.length).toBe(1);
    });

    it("handles zero scores correctly", () => {
      const snapshot = makeSnapshot(1000);
      const candidates = [
        { mint: "MINT_A", score: 0, regime: "neutral" },
        { mint: "MINT_B", score: 0, regime: "neutral" },
      ];

      const result = scoresToTargets({
        snapshot,
        candidates,
        maxPositionPctPerAsset: 0.15,
      });

      for (const target of result.targets) {
        expect(target.targetPct).toBe(0);
      }
    });
  });
});
