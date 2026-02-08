import { getAllPositionTracking } from "./persist.js";

export const MINT_SOL = "So11111111111111111111111111111111111111112";
export const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MINT_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export interface MustPriceMintsInput {
  openPositionMints?: string[];
  allocationTargetMints?: string[];
}

export function getMustPriceMints(input: MustPriceMintsInput): Set<string> {
  const mustPrice = new Set<string>();
  
  mustPrice.add(MINT_SOL);
  mustPrice.add(MINT_USDC);
  mustPrice.add(MINT_USDT);
  
  if (input.openPositionMints) {
    for (const mint of input.openPositionMints) {
      mustPrice.add(mint);
    }
  }
  
  if (input.allocationTargetMints) {
    for (const mint of input.allocationTargetMints) {
      mustPrice.add(mint);
    }
  }
  
  return mustPrice;
}

export async function getMustPriceMintsFromDb(allocationTargetMints: string[]): Promise<Set<string>> {
  const tracking = await getAllPositionTracking();
  const openPositionMints = tracking.map(t => t.mint);
  
  return getMustPriceMints({
    openPositionMints,
    allocationTargetMints,
  });
}

export interface MustPriceCoverageResult {
  mustPriceCount: number;
  pricedCount: number;
  coverage: number;
  missingMints: string[];
  walletHeldMintCountTotal: number;
}

export function computeMustPriceCoverage(args: {
  mustPriceMints: Set<string>;
  pricedMints: Set<string>;
  walletHeldMintCount: number;
}): MustPriceCoverageResult {
  const { mustPriceMints, pricedMints, walletHeldMintCount } = args;
  
  const mustPriceCount = mustPriceMints.size;
  
  let pricedCount = 0;
  const missingMints: string[] = [];
  
  for (const mint of mustPriceMints) {
    if (pricedMints.has(mint)) {
      pricedCount++;
    } else {
      missingMints.push(mint);
    }
  }
  
  const coverage = mustPriceCount > 0 ? pricedCount / mustPriceCount : 1.0;
  
  return {
    mustPriceCount,
    pricedCount,
    coverage,
    missingMints,
    walletHeldMintCountTotal: walletHeldMintCount,
  };
}
