import { env } from "./config.js";
import type { RiskProfile } from "./risk_profiles.js";

export type PositionDrawdown = {
  mint: string;
  entryPrice: number;
  currentPrice: number;
  amount: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
};

export type ConcentrationMetrics = {
  largestPositionPct: number;
  top3ConcentrationPct: number;
  hhi: number;
  activePositions: number;
};

export type PortfolioRiskState = {
  positionDrawdowns: Map<string, PositionDrawdown>;
  concentration: ConcentrationMetrics;
  aggregateVolatility: number;
  activePositionCount: number;
  totalEquityUsd: number;
  lastUpdate: number;
};

export type LimitCheckResult = {
  passed: boolean;
  warnings: string[];
  blocks: string[];
};

export type PositionInfo = {
  mint: string;
  amount: number;
  usdValue: number;
  entryPrice?: number;
};

export type PriceMap = Record<string, number>;

export function newPortfolioRisk(): PortfolioRiskState {
  return {
    positionDrawdowns: new Map(),
    concentration: {
      largestPositionPct: 0,
      top3ConcentrationPct: 0,
      hhi: 0,
      activePositions: 0,
    },
    aggregateVolatility: 0,
    activePositionCount: 0,
    totalEquityUsd: 0,
    lastUpdate: Date.now(),
  };
}

export function calculateConcentration(positions: PositionInfo[], overrideTotalEquity?: number, minPositionUsd: number = 1.0): ConcentrationMetrics {
  const totalValue = overrideTotalEquity ?? positions.reduce((sum, p) => sum + p.usdValue, 0);
  
  if (totalValue === 0 || positions.length === 0) {
    return {
      largestPositionPct: 0,
      top3ConcentrationPct: 0,
      hhi: 0,
      activePositions: 0,
    };
  }

  const weights = positions
    .map(p => p.usdValue / totalValue)
    .sort((a, b) => b - a);

  const largestPositionPct = weights[0] ?? 0;
  const top3ConcentrationPct = weights.slice(0, 3).reduce((sum, w) => sum + w, 0);
  
  const hhi = weights.reduce((sum, w) => sum + w * w, 0);

  return {
    largestPositionPct,
    top3ConcentrationPct,
    hhi,
    activePositions: positions.filter(p => p.usdValue >= minPositionUsd).length,
  };
}

export function updatePortfolioRisk(
  state: PortfolioRiskState,
  positions: PositionInfo[],
  prices: PriceMap,
  volatilities?: Record<string, number>,
  minPositionUsd: number = 1.0
): PortfolioRiskState {
  const totalEquity = positions.reduce((sum, p) => sum + p.usdValue, 0);
  
  const newDrawdowns = new Map<string, PositionDrawdown>();
  
  for (const pos of positions) {
    if (pos.amount <= 0 || pos.usdValue < 0.01) continue;
    
    const currentPrice = prices[pos.mint] ?? 0;
    const existingDrawdown = state.positionDrawdowns.get(pos.mint);
    
    const entryPrice = existingDrawdown?.entryPrice ?? pos.entryPrice ?? currentPrice;
    
    const unrealizedPnl = pos.amount * (currentPrice - entryPrice);
    const unrealizedPnlPct = entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0;
    
    newDrawdowns.set(pos.mint, {
      mint: pos.mint,
      entryPrice,
      currentPrice,
      amount: pos.amount,
      unrealizedPnl,
      unrealizedPnlPct,
    });
  }

  const concentration = calculateConcentration(positions, undefined, minPositionUsd);

  let aggregateVolatility = 0;
  if (volatilities && totalEquity > 0) {
    let weightedVolSquared = 0;
    for (const pos of positions) {
      const weight = pos.usdValue / totalEquity;
      const vol = volatilities[pos.mint] ?? 0.5;
      weightedVolSquared += weight * weight * vol * vol;
    }
    aggregateVolatility = Math.sqrt(weightedVolSquared);
  } else {
    const avgWeight = concentration.activePositions > 0 
      ? 1 / concentration.activePositions 
      : 1;
    aggregateVolatility = 0.5 * Math.sqrt(avgWeight) * Math.sqrt(concentration.hhi / 0.1);
  }

  return {
    positionDrawdowns: newDrawdowns,
    concentration,
    aggregateVolatility,
    activePositionCount: concentration.activePositions,
    totalEquityUsd: totalEquity,
    lastUpdate: Date.now(),
  };
}

export function checkPortfolioLimits(
  state: PortfolioRiskState,
  riskProfile: RiskProfile
): LimitCheckResult {
  const warnings: string[] = [];
  const blocks: string[] = [];

  const maxPositions = env.MAX_POSITIONS;
  if (state.activePositionCount >= maxPositions) {
    blocks.push(`Position limit reached: ${state.activePositionCount}/${maxPositions} positions`);
  } else if (state.activePositionCount >= maxPositions * 0.8) {
    warnings.push(`Approaching position limit: ${state.activePositionCount}/${maxPositions} positions`);
  }

  const maxSingleConcentration = Math.min(
    env.MAX_POSITION_PCT_PER_ASSET,
    riskProfile.maxPositionPctPerAsset
  );
  if (state.concentration.largestPositionPct > maxSingleConcentration) {
    blocks.push(
      `Single position concentration too high: ${(state.concentration.largestPositionPct * 100).toFixed(1)}% > ${(maxSingleConcentration * 100).toFixed(1)}%`
    );
  } else if (state.concentration.largestPositionPct > maxSingleConcentration * 0.9) {
    warnings.push(
      `Approaching single position limit: ${(state.concentration.largestPositionPct * 100).toFixed(1)}% / ${(maxSingleConcentration * 100).toFixed(1)}%`
    );
  }

  const maxTop3 = env.MAX_TOP3_CONCENTRATION_PCT;
  if (state.concentration.top3ConcentrationPct > maxTop3) {
    blocks.push(
      `Top-3 concentration too high: ${(state.concentration.top3ConcentrationPct * 100).toFixed(1)}% > ${(maxTop3 * 100).toFixed(1)}%`
    );
  } else if (state.concentration.top3ConcentrationPct > maxTop3 * 0.9) {
    warnings.push(
      `Approaching top-3 concentration limit: ${(state.concentration.top3ConcentrationPct * 100).toFixed(1)}% / ${(maxTop3 * 100).toFixed(1)}%`
    );
  }

  const maxVol = env.MAX_PORTFOLIO_VOLATILITY;
  if (state.aggregateVolatility > maxVol) {
    blocks.push(
      `Portfolio volatility too high: ${(state.aggregateVolatility * 100).toFixed(1)}% > ${(maxVol * 100).toFixed(1)}% annualized`
    );
  } else if (state.aggregateVolatility > maxVol * 0.85) {
    warnings.push(
      `Approaching volatility limit: ${(state.aggregateVolatility * 100).toFixed(1)}% / ${(maxVol * 100).toFixed(1)}% annualized`
    );
  }

  return {
    passed: blocks.length === 0,
    warnings,
    blocks,
  };
}

export function getPositionSizeLimit(
  state: PortfolioRiskState,
  mint: string,
  targetPct: number,
  riskProfile: RiskProfile
): { maxPct: number; reason?: string } {
  const limits = checkPortfolioLimits(state, riskProfile);
  
  if (!limits.passed) {
    const existingPosition = state.positionDrawdowns.get(mint);
    if (!existingPosition) {
      return { maxPct: 0, reason: limits.blocks[0] };
    }
  }

  const maxSinglePosition = Math.min(
    env.MAX_POSITION_PCT_PER_ASSET,
    riskProfile.maxPositionPctPerAsset
  );

  let adjustedMax = maxSinglePosition;

  const currentConcentration = state.concentration.top3ConcentrationPct;
  const maxTop3 = env.MAX_TOP3_CONCENTRATION_PCT;
  
  if (currentConcentration > maxTop3 * 0.8) {
    const reductionFactor = Math.max(0.5, 1 - (currentConcentration - maxTop3 * 0.8) / (maxTop3 * 0.2));
    adjustedMax *= reductionFactor;
  }

  const maxVol = env.MAX_PORTFOLIO_VOLATILITY;
  if (state.aggregateVolatility > maxVol * 0.8) {
    const volReduction = Math.max(0.5, 1 - (state.aggregateVolatility - maxVol * 0.8) / (maxVol * 0.2));
    adjustedMax *= volReduction;
  }

  const maxPositions = env.MAX_POSITIONS;
  const existingPosition = state.positionDrawdowns.has(mint);
  if (!existingPosition && state.activePositionCount >= maxPositions - 1) {
    adjustedMax *= 0.5;
  }

  const finalMax = Math.min(targetPct, adjustedMax);

  let reason: string | undefined;
  if (finalMax < targetPct) {
    reason = `Adjusted from ${(targetPct * 100).toFixed(1)}% to ${(finalMax * 100).toFixed(1)}% due to portfolio limits`;
  }

  return { maxPct: finalMax, reason };
}

export function getPortfolioRiskSummary(state: PortfolioRiskState): {
  activePositions: number;
  largestPositionPct: number;
  top3ConcentrationPct: number;
  hhi: number;
  estimatedVolatility: number;
  totalEquityUsd: number;
} {
  return {
    activePositions: state.activePositionCount,
    largestPositionPct: state.concentration.largestPositionPct,
    top3ConcentrationPct: state.concentration.top3ConcentrationPct,
    hhi: state.concentration.hhi,
    estimatedVolatility: state.aggregateVolatility,
    totalEquityUsd: state.totalEquityUsd,
  };
}

export function shouldBlockNewPosition(
  state: PortfolioRiskState,
  riskProfile: RiskProfile
): { blocked: boolean; reason?: string } {
  if (state.activePositionCount >= env.MAX_POSITIONS) {
    return { blocked: true, reason: `Maximum positions (${env.MAX_POSITIONS}) reached` };
  }

  const limits = checkPortfolioLimits(state, riskProfile);
  if (!limits.passed) {
    return { blocked: true, reason: limits.blocks[0] };
  }

  return { blocked: false };
}
