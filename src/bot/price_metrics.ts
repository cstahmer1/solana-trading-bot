import { q } from "./db.js";
import { logger } from "../utils/logger.js";
import { addTrackedMint, updateLastPrice } from "./bar_writer.js";

export interface ScoutEntryEvalLog {
  mint: string;
  symbol: string;
  pass: boolean;
  failReason: string | null;
  ret15: number | null;
  ret60: number | null;
  high15: number | null;
  drawdown15: number | null;
  sma30: number | null;
  smaShort: number | null;
  smaShortBars: number;
  smaShortMinutes: number;
  smaTrend: number | null;
  smaTrendBars: number;
  smaTrendMinutes: number;
  priceNow: number;
  bars15Count: number;
  bars30Count: number;
  thresholds: {
    scoutChaseRet15Max: number;
    scoutImpulseRet15Min: number;
    scoutPullbackFromHigh15Min: number;
    scoutEntrySmaMinutes: number;
    scoutEntryRequireAboveSma: boolean;
    scoutEntryTrendSmaMinutes: number;
  };
  timestamp: number;
}

const SCOUT_ENTRY_EVAL_BUFFER_MAX = 100;
const scoutEntryEvalBuffer: ScoutEntryEvalLog[] = [];

export function recordScoutEntryEval(data: ScoutEntryEvalLog): void {
  scoutEntryEvalBuffer.push(data);
  if (scoutEntryEvalBuffer.length > SCOUT_ENTRY_EVAL_BUFFER_MAX) {
    scoutEntryEvalBuffer.shift();
  }
}

export function getRecentScoutEntryEvals(limit: number): ScoutEntryEvalLog[] {
  const start = Math.max(0, scoutEntryEvalBuffer.length - limit);
  return scoutEntryEvalBuffer.slice(start).reverse();
}

export interface PriceBar {
  ts: number;
  price: number;
}

export interface PriceMetrics {
  priceNow: number;
  ret15: number | null;
  ret60: number | null;
  high15: number | null;
  high30: number | null;
  drawdown15: number | null;
  drawdown30: number | null;
  sma30: number | null;
  sma60: number | null;
  insufficientBars: boolean;
  barCount: number;
}

export async function getRecentBars(mint: string, minutes: number): Promise<PriceBar[]> {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  const rows = await q<{ ts: Date; usd_price: number }>(
    `SELECT ts, usd_price FROM prices WHERE mint = $1 AND ts >= $2 ORDER BY ts ASC`,
    [mint, cutoff.toISOString()]
  );
  return rows.map(r => ({
    ts: new Date(r.ts).getTime(),
    price: Number(r.usd_price)
  }));
}

export function computeReturn(bars: PriceBar[], minutesBack: number): number | null {
  if (bars.length < 2) return null;
  
  const now = Date.now();
  const targetTime = now - minutesBack * 60 * 1000;
  
  const priceNow = bars[bars.length - 1].price;
  
  let closestBar: PriceBar | null = null;
  let minDiff = Infinity;
  
  for (const bar of bars) {
    const diff = Math.abs(bar.ts - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closestBar = bar;
    }
  }
  
  if (!closestBar || closestBar.price <= 0) return null;
  
  if (minDiff > minutesBack * 60 * 1000 * 0.5) return null;
  
  return (priceNow / closestBar.price) - 1;
}

export function computeHigh(bars: PriceBar[]): number | null {
  if (bars.length === 0) return null;
  return Math.max(...bars.map(b => b.price));
}

export function computeHighForPeriod(bars: PriceBar[], minutes: number): number | null {
  const now = Date.now();
  const cutoff = now - minutes * 60 * 1000;
  const filteredBars = bars.filter(b => b.ts >= cutoff);
  if (filteredBars.length === 0) return null;
  return Math.max(...filteredBars.map(b => b.price));
}

export function computeSMA(bars: PriceBar[]): number | null {
  if (bars.length === 0) return null;
  const sum = bars.reduce((acc, b) => acc + b.price, 0);
  return sum / bars.length;
}

export function computeSMAForPeriod(bars: PriceBar[], minutes: number): number | null {
  const now = Date.now();
  const cutoff = now - minutes * 60 * 1000;
  const filteredBars = bars.filter(b => b.ts >= cutoff);
  if (filteredBars.length === 0) return null;
  const sum = filteredBars.reduce((acc, b) => acc + b.price, 0);
  return sum / filteredBars.length;
}

export interface SMAWithMeta {
  sma: number | null;
  bars: number;
  minutes: number;
}

export async function computeSMAWithMeta(mint: string, minutes: number): Promise<SMAWithMeta> {
  const bars = await getRecentBars(mint, minutes);
  
  if (bars.length < minutes) {
    return { sma: null, bars: bars.length, minutes };
  }
  
  const sum = bars.reduce((acc, b) => acc + b.price, 0);
  return { sma: sum / bars.length, bars: bars.length, minutes };
}

export function computeDrawdown(priceNow: number, high: number): number {
  if (high <= 0) return 0;
  return (priceNow / high) - 1;
}

export async function computePriceMetrics(mint: string): Promise<PriceMetrics> {
  const bars = await getRecentBars(mint, 65);
  
  const minBarsRequired = 15;
  const insufficientBars = bars.length < minBarsRequired;
  
  if (insufficientBars || bars.length === 0) {
    const oldestBarTs = bars.length > 0 ? bars[0].ts : null;
    const newestBarTs = bars.length > 0 ? bars[bars.length - 1].ts : null;
    logger.info({
      mint,
      barsFound: bars.length,
      barsRequired: minBarsRequired,
      oldestBarTs: oldestBarTs ? new Date(oldestBarTs).toISOString() : null,
      newestBarTs: newestBarTs ? new Date(newestBarTs).toISOString() : null,
    }, "WARMUP_BARS_STATUS");
    return {
      priceNow: 0,
      ret15: null,
      ret60: null,
      high15: null,
      high30: null,
      drawdown15: null,
      drawdown30: null,
      sma30: null,
      sma60: null,
      insufficientBars: true,
      barCount: bars.length
    };
  }
  
  const priceNow = bars[bars.length - 1].price;
  
  const ret15 = computeReturn(bars, 15);
  const ret60 = computeReturn(bars, 60);
  
  const high15 = computeHighForPeriod(bars, 15);
  const high30 = computeHighForPeriod(bars, 30);
  
  const drawdown15 = high15 !== null ? computeDrawdown(priceNow, high15) : null;
  const drawdown30 = high30 !== null ? computeDrawdown(priceNow, high30) : null;
  
  const sma30 = computeSMAForPeriod(bars, 30);
  const sma60 = computeSMAForPeriod(bars, 60);
  
  return {
    priceNow,
    ret15,
    ret60,
    high15,
    high30,
    drawdown15,
    drawdown30,
    sma30,
    sma60,
    insufficientBars: false,
    barCount: bars.length
  };
}

export interface ScoutEntryEvalResult {
  pass: boolean;
  failReason: string | null;
  metrics: {
    ret15: number | null;
    drawdown15: number | null;
    sma30: number | null;
    smaShort: number | null;
    smaShortBars: number;
    smaTrend: number | null;
    smaTrendBars: number;
    priceNow: number;
    barCount: number;
  };
}

export async function evaluateScoutEntry(
  mint: string,
  config: {
    scoutChaseRet15Max: number;
    scoutImpulseRet15Min: number;
    scoutPullbackFromHigh15Min: number;
    scoutEntrySmaMinutes: number;
    scoutEntryRequireAboveSma: boolean;
    scoutEntryTrendSmaMinutes: number;
  },
  symbol?: string
): Promise<ScoutEntryEvalResult> {
  addTrackedMint(mint);
  
  const metrics = await computePriceMetrics(mint);
  
  if (metrics.priceNow > 0) {
    updateLastPrice(mint, metrics.priceNow);
  }
  
  const evalResult: ScoutEntryEvalResult = {
    pass: false,
    failReason: null,
    metrics: {
      ret15: metrics.ret15,
      drawdown15: metrics.drawdown15,
      sma30: metrics.sma30,
      smaShort: null,
      smaShortBars: 0,
      smaTrend: null,
      smaTrendBars: 0,
      priceNow: metrics.priceNow,
      barCount: metrics.barCount
    }
  };
  
  const baseThresholds = {
    scoutChaseRet15Max: config.scoutChaseRet15Max,
    scoutImpulseRet15Min: config.scoutImpulseRet15Min,
    scoutPullbackFromHigh15Min: config.scoutPullbackFromHigh15Min,
    scoutEntrySmaMinutes: config.scoutEntrySmaMinutes,
    scoutEntryRequireAboveSma: config.scoutEntryRequireAboveSma,
    scoutEntryTrendSmaMinutes: config.scoutEntryTrendSmaMinutes,
  };
  
  const buildEvalLog = (pass: boolean, failReason: string | null, smaShort: number | null = null, smaShortBars: number = 0, smaTrend: number | null = null, smaTrendBars: number = 0): ScoutEntryEvalLog => ({
    mint,
    symbol: symbol || mint.slice(0, 6),
    pass,
    failReason,
    ret15: metrics.ret15,
    ret60: metrics.ret60,
    high15: metrics.high15,
    drawdown15: metrics.drawdown15,
    sma30: metrics.sma30,
    smaShort,
    smaShortBars,
    smaShortMinutes: config.scoutEntrySmaMinutes,
    smaTrend,
    smaTrendBars,
    smaTrendMinutes: config.scoutEntryTrendSmaMinutes,
    priceNow: metrics.priceNow,
    bars15Count: metrics.barCount,
    bars30Count: metrics.barCount,
    thresholds: baseThresholds,
    timestamp: Date.now(),
  });
  
  if (metrics.insufficientBars) {
    evalResult.failReason = "INSUFFICIENT_BARS";
    logger.info({
      mint,
      barCount: metrics.barCount,
      pass: false,
      failReason: "INSUFFICIENT_BARS"
    }, "SCOUT_ENTRY_EVAL");
    recordScoutEntryEval(buildEvalLog(false, "INSUFFICIENT_BARS"));
    return evalResult;
  }
  
  if (metrics.ret15 !== null && metrics.ret15 > config.scoutChaseRet15Max) {
    evalResult.failReason = "CHASE_RET15";
    logger.info({
      mint,
      ret15: metrics.ret15,
      drawdown15: metrics.drawdown15,
      sma30: metrics.sma30,
      priceNow: metrics.priceNow,
      pass: false,
      failReason: "CHASE_RET15",
      threshold: config.scoutChaseRet15Max
    }, "SCOUT_ENTRY_EVAL");
    recordScoutEntryEval(buildEvalLog(false, "CHASE_RET15"));
    return evalResult;
  }
  
  if (metrics.ret15 !== null && metrics.ret15 > config.scoutImpulseRet15Min) {
    if (metrics.drawdown15 === null || metrics.drawdown15 > -config.scoutPullbackFromHigh15Min) {
      evalResult.failReason = "NO_PULLBACK";
      logger.info({
        mint,
        ret15: metrics.ret15,
        drawdown15: metrics.drawdown15,
        sma30: metrics.sma30,
        priceNow: metrics.priceNow,
        pass: false,
        failReason: "NO_PULLBACK",
        impulseThreshold: config.scoutImpulseRet15Min,
        pullbackRequired: config.scoutPullbackFromHigh15Min
      }, "SCOUT_ENTRY_EVAL");
      recordScoutEntryEval(buildEvalLog(false, "NO_PULLBACK"));
      return evalResult;
    }
  }
  
  if (config.scoutEntryRequireAboveSma) {
    const smaShortMeta = await computeSMAWithMeta(mint, config.scoutEntrySmaMinutes);
    const smaTrendMeta = await computeSMAWithMeta(mint, config.scoutEntryTrendSmaMinutes);
    
    evalResult.metrics.smaShort = smaShortMeta.sma;
    evalResult.metrics.smaShortBars = smaShortMeta.bars;
    evalResult.metrics.smaTrend = smaTrendMeta.sma;
    evalResult.metrics.smaTrendBars = smaTrendMeta.bars;
    
    if (smaTrendMeta.sma === null) {
      evalResult.failReason = "INSUFFICIENT_HISTORY";
      logger.info({
        mint,
        ret15: metrics.ret15,
        drawdown15: metrics.drawdown15,
        sma30: metrics.sma30,
        smaShort: smaShortMeta.sma,
        smaShortBars: smaShortMeta.bars,
        smaShortMinutes: config.scoutEntrySmaMinutes,
        smaTrend: smaTrendMeta.sma,
        smaTrendBars: smaTrendMeta.bars,
        smaTrendMinutes: config.scoutEntryTrendSmaMinutes,
        smaGate: null,
        smaGateBars: smaTrendMeta.bars,
        smaGateMinutesUsed: config.scoutEntryTrendSmaMinutes,
        smaGatePass: false,
        priceNow: metrics.priceNow,
        pass: false,
        failReason: "INSUFFICIENT_HISTORY"
      }, "SCOUT_ENTRY_EVAL");
      recordScoutEntryEval(buildEvalLog(false, "INSUFFICIENT_HISTORY", smaShortMeta.sma, smaShortMeta.bars, smaTrendMeta.sma, smaTrendMeta.bars));
      return evalResult;
    }
    
    const smaGatePass = metrics.priceNow > smaTrendMeta.sma;
    
    if (!smaGatePass) {
      evalResult.failReason = "BELOW_TREND_SMA";
      logger.info({
        mint,
        ret15: metrics.ret15,
        drawdown15: metrics.drawdown15,
        sma30: metrics.sma30,
        smaShort: smaShortMeta.sma,
        smaShortBars: smaShortMeta.bars,
        smaShortMinutes: config.scoutEntrySmaMinutes,
        smaTrend: smaTrendMeta.sma,
        smaTrendBars: smaTrendMeta.bars,
        smaTrendMinutes: config.scoutEntryTrendSmaMinutes,
        smaGate: smaTrendMeta.sma,
        smaGateBars: smaTrendMeta.bars,
        smaGateMinutesUsed: config.scoutEntryTrendSmaMinutes,
        smaGatePass: false,
        priceNow: metrics.priceNow,
        pass: false,
        failReason: "BELOW_TREND_SMA"
      }, "SCOUT_ENTRY_EVAL");
      recordScoutEntryEval(buildEvalLog(false, "BELOW_TREND_SMA", smaShortMeta.sma, smaShortMeta.bars, smaTrendMeta.sma, smaTrendMeta.bars));
      return evalResult;
    }
  }
  
  evalResult.pass = true;
  logger.info({
    mint,
    ret15: metrics.ret15,
    drawdown15: metrics.drawdown15,
    sma30: metrics.sma30,
    smaShort: evalResult.metrics.smaShort,
    smaShortBars: evalResult.metrics.smaShortBars,
    smaShortMinutes: config.scoutEntrySmaMinutes,
    smaTrend: evalResult.metrics.smaTrend,
    smaTrendBars: evalResult.metrics.smaTrendBars,
    smaTrendMinutes: config.scoutEntryTrendSmaMinutes,
    smaGate: evalResult.metrics.smaTrend,
    smaGateBars: evalResult.metrics.smaTrendBars,
    smaGateMinutesUsed: config.scoutEntryTrendSmaMinutes,
    smaGatePass: config.scoutEntryRequireAboveSma ? true : null,
    priceNow: metrics.priceNow,
    pass: true,
    failReason: null
  }, "SCOUT_ENTRY_EVAL");
  
  recordScoutEntryEval(buildEvalLog(true, null, evalResult.metrics.smaShort, evalResult.metrics.smaShortBars, evalResult.metrics.smaTrend, evalResult.metrics.smaTrendBars));
  
  return evalResult;
}

export interface PromotionEvalResult {
  pass: boolean;
  failReason: string | null;
  metrics: {
    ret15: number | null;
    ret60: number | null;
    drawdown30: number | null;
    sma60: number | null;
    priceNow: number;
    barCount: number;
  };
}

export async function evaluatePromotionContinuation(
  mint: string,
  config: {
    promotionRequireRet60Min: number;
    promotionRequireRet15Min: number;
    promotionAvoidTopDrawdown30: number;
    promotionSmaMinutes: number;
    promotionRequireAboveSma: boolean;
  }
): Promise<PromotionEvalResult> {
  const metrics = await computePriceMetrics(mint);
  
  const evalResult: PromotionEvalResult = {
    pass: false,
    failReason: null,
    metrics: {
      ret15: metrics.ret15,
      ret60: metrics.ret60,
      drawdown30: metrics.drawdown30,
      sma60: metrics.sma60,
      priceNow: metrics.priceNow,
      barCount: metrics.barCount
    }
  };
  
  if (metrics.insufficientBars) {
    evalResult.failReason = "INSUFFICIENT_BARS_PROMO";
    return evalResult;
  }
  
  if (metrics.ret60 === null || metrics.ret60 < config.promotionRequireRet60Min) {
    evalResult.failReason = "RET60_TOO_LOW";
    return evalResult;
  }
  
  if (metrics.ret15 === null || metrics.ret15 < config.promotionRequireRet15Min) {
    evalResult.failReason = "RET15_TOO_LOW";
    return evalResult;
  }
  
  if (metrics.drawdown30 === null || metrics.drawdown30 > -config.promotionAvoidTopDrawdown30) {
    evalResult.failReason = "AT_TOP";
    return evalResult;
  }
  
  if (config.promotionRequireAboveSma) {
    const sma = metrics.sma60;
    if (sma !== null && metrics.priceNow <= sma) {
      evalResult.failReason = "BELOW_SMA";
      return evalResult;
    }
  }
  
  evalResult.pass = true;
  return evalResult;
}
