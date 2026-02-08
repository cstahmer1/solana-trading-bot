import { clamp, mean, std } from "./math.js";
import { getConfig } from "./runtime_config.js";
import { logger } from "../utils/logger.js";

export type Bar = { ts: number; price: number };
export type Signal = {
  score: number;           // positive => want LONG token vs SOL, negative => reduce/short (on spot => go to SOL/USDC)
  regime: "trend" | "range";
  features: Record<string, number>;
};

// Build a tiny feature vector (trend + mean reversion + vol) from recent prices.
export function computeSignal(prices: Bar[], symbol?: string): Signal {
  const config = getConfig();
  const trendThreshold = config.strategyTrendThreshold;
  const momentumFactor = config.strategyMomentumFactor;
  const band = config.strategyBand;
  const minTicks = config.minTicksForSignals;

  // Need enough history (configurable, default 60 points = 60 minutes if 1m bars)
  if (prices.length < minTicks) {
    logger.info({
      symbol,
      currentTicks: prices.length,
      requiredTicks: minTicks,
      reason: 'INSUFFICIENT_TICKS',
    }, "Signal computation blocked - insufficient tick data");
    return { 
      score: 0, 
      regime: "range", 
      features: { 
        n: prices.length, 
        insufficientTicks: 1,
        requiredTicks: minTicks,
        currentTicks: prices.length,
      } 
    };
  }

  const ps = prices.map((b) => b.price);
  const n = ps.length;
  
  // Safely compute returns with available data (guard against insufficient history)
  const ret1 = n >= 2 ? Math.log(ps[n - 1] / ps[n - 2]) : 0;
  const ret5 = n >= 6 ? Math.log(ps[n - 1] / ps[n - 6]) : ret1;
  const ret30 = n >= 31 ? Math.log(ps[n - 1] / ps[n - 31]) : ret5;

  // Use available data for moving averages (slice handles short arrays gracefully)
  const maFastWindow = Math.min(10, n);
  const maSlowWindow = Math.min(60, n);
  const volWindow = Math.min(30, n);
  
  const maFast = mean(ps.slice(-maFastWindow));
  const maSlow = mean(ps.slice(-maSlowWindow));
  const vol30 = std(ps.slice(-volWindow).map((p, i, arr) => i === 0 ? 0 : Math.log(arr[i] / arr[i-1])));

  const trend = vol30 === 0 ? 0 : (maFast - maSlow) / (maSlow * vol30);  // normalized trend strength
  const mr = vol30 === 0 ? 0 : (ps[ps.length - 1] - maSlow) / (maSlow * vol30); // deviation from mean

  // Regime switch: strong trend => trend-following, else mean reversion
  const regime: "trend" | "range" = Math.abs(trend) > trendThreshold ? "trend" : "range";

  let score = 0;
  let bandSuppressed = false;
  
  if (regime === "trend") {
    // In trend regime, apply band as dead-zone near zero trend
    if (Math.abs(trend) <= band) {
      score = 0;
      bandSuppressed = true;
    } else {
      score = clamp(trend, -3, 3);
    }
  } else {
    // In range regime, apply band as dead-zone around mean (ignore small deviations)
    if (Math.abs(mr) <= band) {
      score = 0;
      bandSuppressed = true;
    } else {
      score = clamp(-mr, -3, 3); // pull back to mean
    }
  }

  // Tiny momentum confirmation to avoid fighting tape too hard (only if not suppressed)
  if (!bandSuppressed) {
    score += momentumFactor * clamp(ret5 / Math.max(1e-8, vol30), -2, 2);
  }

  logger.debug({
    symbol,
    regime,
    band,
    bandSuppressed,
    trendThreshold,
    momentumFactor,
    rawTrend: trend,
    rawMr: mr,
  }, "Strategy computed with config");

  return {
    score,
    regime,
    features: { ret1, ret5, ret30, maFast, maSlow, vol30, trend, mr, band },
  };
}
