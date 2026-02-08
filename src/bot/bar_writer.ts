import { q } from "./db.js";
import { logger } from "../utils/logger.js";

interface TrackedMintEntry {
  mint: string;
  expiresAt: number;
}

const TRACKED_MINT_TTL_MS = 6 * 60 * 60 * 1000;
const TRACKED_MINT_MAX_SIZE = 200;
const trackedMints = new Map<string, TrackedMintEntry>();
const lastPriceByMint = new Map<string, number>();

let intervalHandle: NodeJS.Timeout | null = null;
let isInitialized = false;

export function addTrackedMint(mint: string): void {
  const now = Date.now();
  const expiresAt = now + TRACKED_MINT_TTL_MS;
  
  if (trackedMints.has(mint)) {
    trackedMints.get(mint)!.expiresAt = expiresAt;
    return;
  }
  
  if (trackedMints.size >= TRACKED_MINT_MAX_SIZE) {
    let oldestMint: string | null = null;
    let oldestExpiry = Infinity;
    for (const [m, entry] of trackedMints) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestMint = m;
      }
    }
    if (oldestMint) {
      trackedMints.delete(oldestMint);
    }
  }
  
  trackedMints.set(mint, { mint, expiresAt });
}

export function getTrackedMints(): string[] {
  pruneExpiredMints();
  return Array.from(trackedMints.keys());
}

export function getTrackedMintCount(): number {
  pruneExpiredMints();
  return trackedMints.size;
}

function pruneExpiredMints(): void {
  const now = Date.now();
  for (const [mint, entry] of trackedMints) {
    if (entry.expiresAt < now) {
      trackedMints.delete(mint);
    }
  }
}

export function updateLastPrice(mint: string, price: number): void {
  if (price > 0) {
    lastPriceByMint.set(mint, price);
  }
}

export function getLastPrice(mint: string): number | null {
  return lastPriceByMint.get(mint) ?? null;
}

export async function hydrateLastPriceCache(): Promise<number> {
  const mints = getTrackedMints();
  if (mints.length === 0) {
    return 0;
  }
  
  const placeholders = mints.map((_, i) => `$${i + 1}`).join(",");
  const rows = await q<{ mint: string; usd_price: number }>(
    `SELECT DISTINCT ON (mint) mint, usd_price 
     FROM prices 
     WHERE mint IN (${placeholders}) 
     ORDER BY mint, ts DESC`,
    mints
  );
  
  for (const row of rows) {
    if (row.usd_price > 0) {
      lastPriceByMint.set(row.mint, Number(row.usd_price));
    }
  }
  
  return rows.length;
}

export async function hydrateTrackedMintsFromDb(): Promise<number> {
  const rows = await q<{ mint: string }>(
    `SELECT DISTINCT mint FROM position_tracking`
  );
  
  for (const row of rows) {
    addTrackedMint(row.mint);
  }
  
  return rows.length;
}

function getMinuteBoundary(ts: number): Date {
  const d = new Date(ts);
  d.setSeconds(0);
  d.setMilliseconds(0);
  return d;
}

export async function fillForwardBars(): Promise<{
  minuteTs: Date;
  trackedMintCount: number;
  barsWritten: number;
  skippedNoPriceCount: number;
  skippedAlreadyExistsCount: number;
}> {
  pruneExpiredMints();
  
  const minuteTs = getMinuteBoundary(Date.now());
  const mints = Array.from(trackedMints.keys());
  
  let barsWritten = 0;
  let skippedNoPriceCount = 0;
  let skippedAlreadyExistsCount = 0;
  
  if (mints.length === 0) {
    return { minuteTs, trackedMintCount: 0, barsWritten: 0, skippedNoPriceCount: 0, skippedAlreadyExistsCount: 0 };
  }
  
  const barsToInsert: { mint: string; ts: Date; usd_price: number }[] = [];
  
  for (const mint of mints) {
    const lastPrice = lastPriceByMint.get(mint);
    if (!lastPrice || lastPrice <= 0) {
      skippedNoPriceCount++;
      continue;
    }
    
    barsToInsert.push({
      mint,
      ts: minuteTs,
      usd_price: lastPrice
    });
  }
  
  if (barsToInsert.length === 0) {
    return { minuteTs, trackedMintCount: mints.length, barsWritten: 0, skippedNoPriceCount, skippedAlreadyExistsCount: 0 };
  }
  
  const values = barsToInsert
    .map((r) => `('${r.mint}', '${r.ts.toISOString()}', ${r.usd_price}, null)`)
    .join(",");
  
  try {
    const result = await q<{ mint: string }>(
      `INSERT INTO prices(mint, ts, usd_price, block_id) 
       VALUES ${values} 
       ON CONFLICT DO NOTHING 
       RETURNING mint`
    );
    
    barsWritten = result.length;
    skippedAlreadyExistsCount = barsToInsert.length - barsWritten;
  } catch (e) {
    logger.error({ error: String(e), barsAttempted: barsToInsert.length }, "BAR_FILL_FORWARD_ERROR");
  }
  
  return {
    minuteTs,
    trackedMintCount: mints.length,
    barsWritten,
    skippedNoPriceCount,
    skippedAlreadyExistsCount
  };
}

let lastLogTime = 0;
const LOG_INTERVAL_MS = 60000;

export async function runFillForwardTick(): Promise<void> {
  const result = await fillForwardBars();
  
  const now = Date.now();
  if (now - lastLogTime >= LOG_INTERVAL_MS) {
    logger.info({
      minuteTs: result.minuteTs.toISOString(),
      trackedMintCount: result.trackedMintCount,
      barsWritten: result.barsWritten,
      skippedNoPriceCount: result.skippedNoPriceCount,
      skippedAlreadyExistsCount: result.skippedAlreadyExistsCount
    }, "BAR_FILL_FORWARD_SUMMARY");
    lastLogTime = now;
  }
}

export async function initBarWriter(): Promise<void> {
  if (isInitialized) {
    return;
  }
  
  const hydrated = await hydrateTrackedMintsFromDb();
  logger.info({ hydratedMints: hydrated }, "BAR_WRITER: Hydrated tracked mints from position_tracking");
  
  const pricesHydrated = await hydrateLastPriceCache();
  logger.info({ pricesHydrated }, "BAR_WRITER: Hydrated last price cache");
  
  const now = Date.now();
  const msUntilNextMinute = 60000 - (now % 60000);
  
  setTimeout(() => {
    runFillForwardTick();
    
    intervalHandle = setInterval(() => {
      runFillForwardTick();
    }, 60000);
  }, msUntilNextMinute);
  
  isInitialized = true;
  logger.info({ msUntilFirstTick: msUntilNextMinute }, "BAR_WRITER: Initialized, waiting for minute boundary");
}

export function stopBarWriter(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  isInitialized = false;
}

export function clearTrackedMints(): void {
  trackedMints.clear();
}

export function clearLastPriceCache(): void {
  lastPriceByMint.clear();
}

export function _getTrackedMintsMap(): Map<string, TrackedMintEntry> {
  return trackedMints;
}

export function _getLastPriceCacheMap(): Map<string, number> {
  return lastPriceByMint;
}
