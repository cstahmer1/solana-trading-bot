import { MINT_SOL, MINT_USDC } from "./config.js";

export type TokenInfo = { mint: string; symbol: string; decimals: number };

export type Valuation = {
  mint: string;
  amount: number;
  usdPrice: number;
  usdValue: number;
  symbol?: string;
};

export type PortfolioSnapshot = {
  ts: number;
  totalUsd: number;
  totalSolEquiv: number;
  byMint: Record<string, Valuation>;
};

// Convert USD total to SOL-equivalent using SOL usd price
export function usdToSol(usd: number, solUsd: number) {
  return solUsd > 0 ? usd / solUsd : 0;
}

export function buildSnapshot(vals: Valuation[], solUsd: number): PortfolioSnapshot {
  const byMint: Record<string, Valuation> = {};
  for (const v of vals) byMint[v.mint] = v;

  const totalUsd = vals.reduce((a, v) => a + v.usdValue, 0);
  const totalSolEquiv = usdToSol(totalUsd, solUsd);

  return { ts: Date.now(), totalUsd, totalSolEquiv, byMint };
}

// Helper: we treat USDC as "risk-off" bucket alongside SOL.
export function isBaseMint(mint: string) {
  return mint === MINT_SOL || mint === MINT_USDC;
}
