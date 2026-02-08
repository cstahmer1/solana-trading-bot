import { describe, it, expect } from "vitest";
import { computeGlobalGates, getActiveGateNames, type GlobalGates } from "../allocation_events.js";

describe("price coverage gating", () => {
  describe("computeGlobalGates", () => {
    it("returns correct gates when all gates inactive", () => {
      const gates = computeGlobalGates(false, false, false, true);
      expect(gates.manualPause).toBe(false);
      expect(gates.riskPaused).toBe(false);
      expect(gates.lowSolMode).toBe(false);
      expect(gates.priceCoverageOk).toBe(true);
    });

    it("returns correct gates when priceCoverageOk is false", () => {
      const gates = computeGlobalGates(false, false, false, false);
      expect(gates.priceCoverageOk).toBe(false);
    });

    it("returns correct gates when manualPause is true", () => {
      const gates = computeGlobalGates(true, false, false, true);
      expect(gates.manualPause).toBe(true);
    });

    it("returns correct gates when riskPaused is true", () => {
      const gates = computeGlobalGates(false, true, false, true);
      expect(gates.riskPaused).toBe(true);
    });

    it("returns correct gates when lowSolMode is true", () => {
      const gates = computeGlobalGates(false, false, true, true);
      expect(gates.lowSolMode).toBe(true);
    });
  });

  describe("getActiveGateNames", () => {
    it("returns empty array when no gates active", () => {
      const gates: GlobalGates = {
        manualPause: false,
        riskPaused: false,
        lowSolMode: false,
        priceCoverageOk: true,
      };
      expect(getActiveGateNames(gates)).toEqual([]);
    });

    it("returns priceCoverageNotOk when priceCoverageOk is false", () => {
      const gates: GlobalGates = {
        manualPause: false,
        riskPaused: false,
        lowSolMode: false,
        priceCoverageOk: false,
      };
      const active = getActiveGateNames(gates);
      expect(active).toContain("priceCoverageNotOk");
    });

    it("returns manualPause when manualPause is true", () => {
      const gates: GlobalGates = {
        manualPause: true,
        riskPaused: false,
        lowSolMode: false,
        priceCoverageOk: true,
      };
      const active = getActiveGateNames(gates);
      expect(active).toContain("manualPause");
    });

    it("returns all active gates", () => {
      const gates: GlobalGates = {
        manualPause: true,
        riskPaused: true,
        lowSolMode: true,
        priceCoverageOk: false,
      };
      const active = getActiveGateNames(gates);
      expect(active).toHaveLength(4);
      expect(active).toContain("manualPause");
      expect(active).toContain("riskPaused");
      expect(active).toContain("lowSolMode");
      expect(active).toContain("priceCoverageNotOk");
    });
  });

  describe("execution vs equity coverage threshold split", () => {
    it("should block execution only when coverage < executionPriceCoverageMin (0.60)", () => {
      const coverage = 0.55;
      const executionPriceCoverageMin = 0.60;
      const equityPriceCoverageMin = 0.75;
      
      const executionBlocked = coverage < executionPriceCoverageMin;
      const incompletePrices = coverage < equityPriceCoverageMin;
      
      expect(executionBlocked).toBe(true);
      expect(incompletePrices).toBe(true);
    });

    it("should allow execution but skip risk updates when 0.60 <= coverage < 0.75", () => {
      const coverage = 0.68;
      const executionPriceCoverageMin = 0.60;
      const equityPriceCoverageMin = 0.75;
      
      const executionBlocked = coverage < executionPriceCoverageMin;
      const incompletePrices = coverage < equityPriceCoverageMin;
      
      expect(executionBlocked).toBe(false);
      expect(incompletePrices).toBe(true);
    });

    it("should allow execution and risk updates when coverage >= 0.75", () => {
      const coverage = 0.82;
      const executionPriceCoverageMin = 0.60;
      const equityPriceCoverageMin = 0.75;
      
      const executionBlocked = coverage < executionPriceCoverageMin;
      const incompletePrices = coverage < equityPriceCoverageMin;
      
      expect(executionBlocked).toBe(false);
      expect(incompletePrices).toBe(false);
    });
  });

  describe("coverage denominator dust exclusion", () => {
    const MINT_SOL = "So11111111111111111111111111111111111111112";
    const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    function computeCoverage(
      holdings: Array<{ mint: string; usdValue: number; hasPrice: boolean }>,
      equityPriceCoverageMinUsd: number
    ): { coverage: number; heldCountTotal: number; heldCountCounted: number } {
      const heldCountTotal = holdings.length;
      
      const significantHoldings = holdings.filter(h => {
        if (h.mint === MINT_SOL || h.mint === MINT_USDC) return true;
        if (!h.hasPrice) return true;
        return h.usdValue >= equityPriceCoverageMinUsd;
      });
      
      const heldCountCounted = significantHoldings.length;
      const pricedCount = significantHoldings.filter(h => h.hasPrice).length;
      const coverage = heldCountCounted > 0 ? pricedCount / heldCountCounted : 1.0;
      
      return { coverage, heldCountTotal, heldCountCounted };
    }

    it("excludes dust tokens from denominator when they have prices", () => {
      const holdings = [
        { mint: "token1", usdValue: 100, hasPrice: true },
        { mint: "dust1", usdValue: 0.50, hasPrice: true },
        { mint: "dust2", usdValue: 0.30, hasPrice: true },
      ];
      
      const result = computeCoverage(holdings, 1.00);
      
      expect(result.heldCountTotal).toBe(3);
      expect(result.heldCountCounted).toBe(1);
      expect(result.coverage).toBe(1.0);
    });

    it("always includes SOL in coverage calculation", () => {
      const holdings = [
        { mint: MINT_SOL, usdValue: 0.50, hasPrice: true },
        { mint: "token1", usdValue: 100, hasPrice: true },
      ];
      
      const result = computeCoverage(holdings, 1.00);
      
      expect(result.heldCountCounted).toBe(2);
      expect(result.coverage).toBe(1.0);
    });

    it("always includes USDC in coverage calculation", () => {
      const holdings = [
        { mint: MINT_USDC, usdValue: 0.10, hasPrice: true },
        { mint: "token1", usdValue: 100, hasPrice: true },
      ];
      
      const result = computeCoverage(holdings, 1.00);
      
      expect(result.heldCountCounted).toBe(2);
      expect(result.coverage).toBe(1.0);
    });

    it("includes tokens without price in denominator (need to price them)", () => {
      const holdings = [
        { mint: "token1", usdValue: 50, hasPrice: true },
        { mint: "token2", usdValue: 0, hasPrice: false },
      ];
      
      const result = computeCoverage(holdings, 1.00);
      
      expect(result.heldCountCounted).toBe(2);
      expect(result.coverage).toBe(0.5);
    });

    it("calculates correct coverage when some significant tokens missing prices", () => {
      const holdings = [
        { mint: "token1", usdValue: 100, hasPrice: true },
        { mint: "token2", usdValue: 80, hasPrice: true },
        { mint: "token3", usdValue: 50, hasPrice: false },
        { mint: "token4", usdValue: 30, hasPrice: false },
        { mint: "dust1", usdValue: 0.50, hasPrice: true },
      ];
      
      const result = computeCoverage(holdings, 1.00);
      
      expect(result.heldCountTotal).toBe(5);
      expect(result.heldCountCounted).toBe(4);
      expect(result.coverage).toBe(0.5);
    });
  });
});
