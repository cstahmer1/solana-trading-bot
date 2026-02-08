import { describe, it, expect } from "vitest";
import { 
  getMustPriceMints, 
  computeMustPriceCoverage, 
  MINT_SOL, 
  MINT_USDC, 
  MINT_USDT 
} from "../must_price_mints.js";

describe("getMustPriceMints", () => {
  it("always includes SOL, USDC, USDT", () => {
    const result = getMustPriceMints({});
    
    expect(result.has(MINT_SOL)).toBe(true);
    expect(result.has(MINT_USDC)).toBe(true);
    expect(result.has(MINT_USDT)).toBe(true);
    expect(result.size).toBe(3);
  });

  it("includes open position mints", () => {
    const openPositionMints = ["mint1", "mint2", "mint3"];
    const result = getMustPriceMints({ openPositionMints });
    
    expect(result.has("mint1")).toBe(true);
    expect(result.has("mint2")).toBe(true);
    expect(result.has("mint3")).toBe(true);
    expect(result.size).toBe(6);
  });

  it("includes allocation target mints", () => {
    const allocationTargetMints = ["target1", "target2"];
    const result = getMustPriceMints({ allocationTargetMints });
    
    expect(result.has("target1")).toBe(true);
    expect(result.has("target2")).toBe(true);
    expect(result.size).toBe(5);
  });

  it("combines positions and targets without duplicates", () => {
    const result = getMustPriceMints({
      openPositionMints: ["mint1", "shared", "mint2"],
      allocationTargetMints: ["target1", "shared", "target2"],
    });
    
    expect(result.has("mint1")).toBe(true);
    expect(result.has("mint2")).toBe(true);
    expect(result.has("shared")).toBe(true);
    expect(result.has("target1")).toBe(true);
    expect(result.has("target2")).toBe(true);
    expect(result.size).toBe(8);
  });

  it("handles empty arrays", () => {
    const result = getMustPriceMints({
      openPositionMints: [],
      allocationTargetMints: [],
    });
    
    expect(result.size).toBe(3);
  });
});

describe("computeMustPriceCoverage", () => {
  it("returns 100% coverage when all must-price mints have prices", () => {
    const mustPriceMints = new Set([MINT_SOL, MINT_USDC, "token1", "token2"]);
    const pricedMints = new Set([MINT_SOL, MINT_USDC, "token1", "token2", "extra"]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 100,
    });
    
    expect(result.mustPriceCount).toBe(4);
    expect(result.pricedCount).toBe(4);
    expect(result.coverage).toBe(1.0);
    expect(result.missingMints).toEqual([]);
    expect(result.walletHeldMintCountTotal).toBe(100);
  });

  it("returns partial coverage when some mints missing prices", () => {
    const mustPriceMints = new Set([MINT_SOL, MINT_USDC, "token1", "token2"]);
    const pricedMints = new Set([MINT_SOL, MINT_USDC]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 800,
    });
    
    expect(result.mustPriceCount).toBe(4);
    expect(result.pricedCount).toBe(2);
    expect(result.coverage).toBe(0.5);
    expect(result.missingMints).toContain("token1");
    expect(result.missingMints).toContain("token2");
    expect(result.missingMints.length).toBe(2);
  });

  it("returns 100% coverage when mustPriceMints is empty", () => {
    const mustPriceMints = new Set<string>();
    const pricedMints = new Set(["random"]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 500,
    });
    
    expect(result.mustPriceCount).toBe(0);
    expect(result.pricedCount).toBe(0);
    expect(result.coverage).toBe(1.0);
    expect(result.missingMints).toEqual([]);
  });

  it("correctly identifies missing mints", () => {
    const mustPriceMints = new Set([MINT_SOL, "pos1", "pos2", "pos3"]);
    const pricedMints = new Set([MINT_SOL, "pos1"]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 878,
    });
    
    expect(result.mustPriceCount).toBe(4);
    expect(result.pricedCount).toBe(2);
    expect(result.coverage).toBe(0.5);
    expect(result.missingMints).toContain("pos2");
    expect(result.missingMints).toContain("pos3");
    expect(result.missingMints).not.toContain(MINT_SOL);
    expect(result.missingMints).not.toContain("pos1");
  });

  it("coverage is independent of wallet held mint count", () => {
    const mustPriceMints = new Set([MINT_SOL, MINT_USDC, MINT_USDT]);
    const pricedMints = new Set([MINT_SOL, MINT_USDC, MINT_USDT]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 878,
    });
    
    expect(result.mustPriceCount).toBe(3);
    expect(result.pricedCount).toBe(3);
    expect(result.coverage).toBe(1.0);
    expect(result.walletHeldMintCountTotal).toBe(878);
  });
});

describe("coverage gating thresholds", () => {
  const EXECUTION_THRESHOLD = 0.60;
  const EQUITY_THRESHOLD = 0.75;

  it("blocks execution when coverage < 60%", () => {
    const mustPriceMints = new Set([MINT_SOL, "t1", "t2", "t3", "t4"]);
    const pricedMints = new Set([MINT_SOL, "t1"]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 100,
    });
    
    expect(result.coverage).toBe(0.4);
    expect(result.coverage < EXECUTION_THRESHOLD).toBe(true);
    expect(result.coverage < EQUITY_THRESHOLD).toBe(true);
  });

  it("allows execution but blocks equity updates at 65% coverage", () => {
    const mustPriceMints = new Set([MINT_SOL, "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    const pricedMints = new Set([MINT_SOL, "t1", "t2", "t3", "t4", "t5"]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 100,
    });
    
    expect(result.coverage).toBe(0.6);
    expect(result.coverage >= EXECUTION_THRESHOLD).toBe(true);
    expect(result.coverage < EQUITY_THRESHOLD).toBe(true);
  });

  it("allows everything at 80% coverage", () => {
    const mustPriceMints = new Set([MINT_SOL, "t1", "t2", "t3", "t4"]);
    const pricedMints = new Set([MINT_SOL, "t1", "t2", "t3"]);
    
    const result = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 100,
    });
    
    expect(result.coverage).toBe(0.8);
    expect(result.coverage >= EXECUTION_THRESHOLD).toBe(true);
    expect(result.coverage >= EQUITY_THRESHOLD).toBe(true);
  });
});

describe("target-inclusive coverage regression", () => {
  const EXECUTION_THRESHOLD = 0.60;
  const EQUITY_THRESHOLD = 0.75;
  
  it("missing allocation target reduces coverage and blocks execution", () => {
    // Positions only - 100% coverage
    const positionOnlyMints = getMustPriceMints({ openPositionMints: ["pos1", "pos2"] });
    const pricedMints = new Set([MINT_SOL, MINT_USDC, MINT_USDT, "pos1", "pos2"]);
    
    const positionOnlyCoverage = computeMustPriceCoverage({
      mustPriceMints: positionOnlyMints,
      pricedMints,
      walletHeldMintCount: 800,
    });
    
    expect(positionOnlyCoverage.coverage).toBe(1.0);
    expect(positionOnlyCoverage.coverage >= EXECUTION_THRESHOLD).toBe(true);
    
    // With targets - one target missing price
    const withTargetsMints = getMustPriceMints({
      openPositionMints: ["pos1", "pos2"],
      allocationTargetMints: ["target1_no_price", "pos1"], // pos1 already priced, target1 not
    });
    
    const withTargetsCoverage = computeMustPriceCoverage({
      mustPriceMints: withTargetsMints,
      pricedMints, // target1_no_price not in priced set
      walletHeldMintCount: 800,
    });
    
    // 5 priced out of 6 must-price mints = 83.3% coverage
    expect(withTargetsCoverage.mustPriceCount).toBe(6);
    expect(withTargetsCoverage.pricedCount).toBe(5);
    expect(withTargetsCoverage.coverage).toBeCloseTo(0.833, 2);
    expect(withTargetsCoverage.missingMints).toContain("target1_no_price");
    expect(withTargetsCoverage.coverage >= EXECUTION_THRESHOLD).toBe(true);
  });
  
  it("multiple missing targets can block execution", () => {
    // 3 positions, 3 targets without prices
    const mustPriceMints = getMustPriceMints({
      openPositionMints: ["pos1", "pos2", "pos3"],
      allocationTargetMints: ["no_price_1", "no_price_2", "no_price_3"],
    });
    
    // Only base mints + positions have prices
    const pricedMints = new Set([MINT_SOL, MINT_USDC, MINT_USDT, "pos1", "pos2", "pos3"]);
    
    const coverage = computeMustPriceCoverage({
      mustPriceMints,
      pricedMints,
      walletHeldMintCount: 800,
    });
    
    // 6 priced out of 9 = 66.7%
    expect(coverage.mustPriceCount).toBe(9);
    expect(coverage.pricedCount).toBe(6);
    expect(coverage.coverage).toBeCloseTo(0.667, 2);
    expect(coverage.missingMints).toContain("no_price_1");
    expect(coverage.missingMints).toContain("no_price_2");
    expect(coverage.missingMints).toContain("no_price_3");
    expect(coverage.coverage >= EXECUTION_THRESHOLD).toBe(true);
    expect(coverage.coverage < EQUITY_THRESHOLD).toBe(true);
  });
});
