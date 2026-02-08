import { q } from "./db.js";
import { logger } from "../utils/logger.js";
import { MINT_SOL, MINT_USDC } from "./config.js";

export interface TradeLot {
  id: number;
  lot_id: string;
  tx_sig: string;
  timestamp: Date;
  slot: number | null;
  mint: string;
  side: "buy" | "sell";
  quantity: number;
  usd_value: number;
  unit_price_usd: number;
  sol_price_usd: number | null;
  fee_usd: number;
  source: string | null;
  status: string;
}

export interface PositionLot {
  id: number;
  lot_id: string;
  mint: string;
  original_qty: number;
  remaining_qty: number;
  cost_basis_usd: number;
  unit_cost_usd: number;
  entry_timestamp: Date;
  is_closed: boolean;
}

export interface PnLEvent {
  event_id: string;
  timestamp: Date;
  mint: string;
  symbol: string | null;
  event_type: "realized_gain" | "realized_loss" | "dust_writeoff" | "fee";
  sell_lot_id: string | null;
  buy_lot_id: string | null;
  quantity: number;
  proceeds_usd: number;
  cost_basis_usd: number;
  realized_pnl_usd: number;
  fee_usd: number;
  notes: string | null;
}

export interface PnLSummary {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  todayRealizedPnl: number;
  byToken: Map<string, {
    symbol: string;
    realizedPnl: number;
    unrealizedPnl: number;
    costBasis: number;
    currentValue: number;
    quantity: number;
  }>;
}

export async function insertTradeLot(lot: {
  tx_sig: string;
  timestamp: Date;
  slot?: number | null;
  mint: string;
  side: "buy" | "sell";
  quantity: number;
  usd_value: number;
  unit_price_usd: number;
  sol_price_usd?: number | null;
  fee_usd?: number;
  source?: string | null;
  status?: string;
  decision_id?: string | null;
}): Promise<string | null> {
  try {
    // Runtime warning: Log error when trade_lot is recorded without decision_id
    // This helps track decision attribution gaps for debugging
    if (!lot.decision_id && lot.side === 'sell') {
      logger.error({
        tx_sig: lot.tx_sig,
        mint: lot.mint,
        side: lot.side,
        source: lot.source,
        usd_value: lot.usd_value,
      }, "DECISION_ATTRIBUTION_GAP: Trade lot recorded without decision_id");
    }
    
    const result = await q<{ lot_id: string }>(
      `INSERT INTO trade_lots 
       (tx_sig, timestamp, slot, mint, side, quantity, usd_value, unit_price_usd, sol_price_usd, fee_usd, source, status, decision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (tx_sig) DO NOTHING
       RETURNING lot_id`,
      [
        lot.tx_sig,
        lot.timestamp,
        lot.slot ?? null,
        lot.mint,
        lot.side,
        lot.quantity,
        lot.usd_value,
        lot.unit_price_usd,
        lot.sol_price_usd ?? null,
        lot.fee_usd ?? 0,
        lot.source ?? null,
        lot.status ?? "confirmed",
        lot.decision_id ?? null,
      ]
    );
    
    if (result.length > 0) {
      if (lot.side === "buy") {
        await createPositionLot(result[0].lot_id, lot.mint, lot.quantity, lot.usd_value, lot.unit_price_usd, lot.timestamp);
      }
      return result[0].lot_id;
    }
    return null;
  } catch (err) {
    logger.warn({ tx_sig: lot.tx_sig, err: String(err) }, "Failed to insert trade lot");
    return null;
  }
}

async function createPositionLot(
  lotId: string,
  mint: string,
  quantity: number,
  costBasisUsd: number,
  unitCostUsd: number,
  entryTimestamp: Date
): Promise<void> {
  await q(
    `INSERT INTO position_lots 
     (lot_id, mint, original_qty, remaining_qty, cost_basis_usd, unit_cost_usd, entry_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [lotId, mint, quantity, quantity, costBasisUsd, unitCostUsd, entryTimestamp]
  );
}

export async function getOpenPositionLots(mint: string): Promise<PositionLot[]> {
  return await q<PositionLot>(
    `SELECT * FROM position_lots 
     WHERE mint = $1 AND is_closed = false AND remaining_qty > 0.000001
     ORDER BY entry_timestamp ASC`,
    [mint]
  );
}

export async function getOpenPositionLotMints(): Promise<string[]> {
  const rows = await q<{ mint: string }>(
    `SELECT DISTINCT mint FROM position_lots 
     WHERE is_closed = false AND remaining_qty > 0.000001`
  );
  return rows.map(r => r.mint);
}

// Close all existing position lots for a mint - used when re-entering after full exit
// This prevents FIFO quarantine from seeing stale lots that no longer match wallet balance
export async function closeAllPositionLots(mint: string): Promise<number> {
  const result = await q(
    `UPDATE position_lots 
     SET is_closed = true, remaining_qty = 0 
     WHERE mint = $1 AND is_closed = false`,
    [mint]
  );
  const rowCount = (result as any).rowCount || 0;
  if (rowCount > 0) {
    logger.info({ mint, lotsClosed: rowCount }, "FIFO: Closed all existing position lots for re-entry");
  }
  return rowCount;
}

// Sanity check constants for PnL validation
const MAX_REASONABLE_PNL_PCT = 5.0; // 500% return is suspicious
const MAX_PNL_TO_PROCEEDS_RATIO = 2.0; // PnL > 2x proceeds is suspicious

function isPnLSuspicious(realizedPnl: number, costBasis: number, proceeds: number): { suspicious: boolean; reason: string | null } {
  // If cost basis is very low or zero, any significant profit is suspicious
  if (costBasis < 0.01 && realizedPnl > 1) {
    return { suspicious: true, reason: `Near-zero cost basis ($${costBasis.toFixed(4)}) with profit $${realizedPnl.toFixed(2)}` };
  }
  
  // Check PnL percentage
  if (costBasis > 0) {
    const pnlPct = realizedPnl / costBasis;
    if (pnlPct > MAX_REASONABLE_PNL_PCT) {
      return { suspicious: true, reason: `PnL ${(pnlPct * 100).toFixed(0)}% exceeds ${MAX_REASONABLE_PNL_PCT * 100}% threshold` };
    }
  }
  
  // Check PnL relative to trade size
  if (proceeds > 0 && realizedPnl > proceeds * MAX_PNL_TO_PROCEEDS_RATIO) {
    return { suspicious: true, reason: `PnL $${realizedPnl.toFixed(2)} exceeds ${MAX_PNL_TO_PROCEEDS_RATIO}x proceeds $${proceeds.toFixed(2)}` };
  }
  
  return { suspicious: false, reason: null };
}

export async function processSellWithFIFO(
  sellTxSig: string,
  mint: string,
  symbol: string,
  sellQuantity: number,
  proceedsUsd: number,
  sellTimestamp: Date,
  solPriceUsd: number | null,
  portfolioDeltaUsd?: number // Optional: actual portfolio change for validation
): Promise<{ realizedPnl: number; lotsMatched: number; suspicious: boolean }> {
  const openLots = await getOpenPositionLots(mint);
  
  if (openLots.length === 0) {
    logger.warn({ mint, sellQuantity }, "No open position lots found for sell");
    
    // With no cost basis, only use portfolio delta if provided - otherwise PnL is unknown
    // We should NOT treat full proceeds as profit since that inflates P&L metrics
    const hasPortfolioDelta = portfolioDeltaUsd !== undefined;
    const effectivePnl = hasPortfolioDelta ? portfolioDeltaUsd : 0; // Unknown = $0, not proceeds
    
    const suspiciousCheck = isPnLSuspicious(effectivePnl, 0, proceedsUsd);
    
    if (suspiciousCheck.suspicious && hasPortfolioDelta) {
      logger.warn({
        mint,
        symbol,
        calculatedPnl: proceedsUsd,
        portfolioDelta: portfolioDeltaUsd,
        effectivePnl,
        reason: suspiciousCheck.reason,
      }, "SUSPICIOUS_PNL: Skipping PnL event recording due to suspicious values");
      return { realizedPnl: 0, lotsMatched: 0, suspicious: true };
    }
    
    await insertPnLEvent({
      timestamp: sellTimestamp,
      mint,
      symbol,
      event_type: effectivePnl >= 0 ? "realized_gain" : "realized_loss",
      sell_lot_id: null,
      buy_lot_id: null,
      quantity: sellQuantity,
      proceeds_usd: proceedsUsd,
      cost_basis_usd: 0,
      realized_pnl_usd: effectivePnl,
      fee_usd: 0,
      notes: hasPortfolioDelta 
        ? "No cost basis found - using portfolio delta" 
        : "No cost basis found - PnL unknown",
    });
    return { realizedPnl: effectivePnl, lotsMatched: 0, suspicious: false };
  }

  // PHASE 1: Calculate all lot matches and determine total cost basis
  // (Do NOT insert events yet - we need to check for suspicious PnL first)
  let remainingToSell = sellQuantity;
  let totalCostBasis = 0;
  let lotsMatched = 0;
  const unitProceedsUsd = sellQuantity > 0 ? proceedsUsd / sellQuantity : 0;

  // Buffer to store lot match info for later processing
  type LotMatch = {
    lotId: number;
    lotUuid: string;
    qtyToMatch: number;
    costBasisMatched: number;
    proceedsMatched: number;
    pnlMatched: number;
    newRemainingQty: number;
    isClosed: boolean;
  };
  const lotMatches: LotMatch[] = [];

  for (const lot of openLots) {
    if (remainingToSell <= 0.000001) break;

    const qtyToMatch = Math.min(remainingToSell, lot.remaining_qty);
    const costBasisMatched = qtyToMatch * lot.unit_cost_usd;
    const proceedsMatched = qtyToMatch * unitProceedsUsd;
    const pnlMatched = proceedsMatched - costBasisMatched;

    totalCostBasis += costBasisMatched;
    lotsMatched++;

    const newRemainingQty = lot.remaining_qty - qtyToMatch;
    const isClosed = newRemainingQty < 0.000001;

    lotMatches.push({
      lotId: lot.id,
      lotUuid: lot.lot_id,
      qtyToMatch,
      costBasisMatched,
      proceedsMatched,
      pnlMatched,
      newRemainingQty,
      isClosed,
    });

    remainingToSell -= qtyToMatch;
  }

  const hasUnmatchedQty = remainingToSell > 0.000001;
  const unmatchedProceeds = hasUnmatchedQty ? remainingToSell * unitProceedsUsd : 0;

  // PHASE 2: Calculate total PnL and check if suspicious BEFORE inserting any events
  const totalRealizedPnl = proceedsUsd - totalCostBasis;
  let effectivePnl = totalRealizedPnl;
  let pnlWasAdjusted = false; // Track if we adjusted away from calculated PnL
  
  // First check: is the calculated PnL suspicious on its own?
  const suspiciousCheck = isPnLSuspicious(totalRealizedPnl, totalCostBasis, proceedsUsd);
  if (suspiciousCheck.suspicious) {
    logger.warn({
      mint,
      symbol,
      calculatedPnl: totalRealizedPnl,
      costBasis: totalCostBasis,
      proceeds: proceedsUsd,
      portfolioDelta: portfolioDeltaUsd,
      reason: suspiciousCheck.reason,
    }, "SUSPICIOUS_PNL: Calculated PnL is suspicious");
    
    // If we have portfolio delta, use that instead
    if (portfolioDeltaUsd !== undefined) {
      logger.info({
        mint,
        symbol,
        oldPnl: totalRealizedPnl,
        newPnl: portfolioDeltaUsd,
      }, "SUSPICIOUS_PNL: Using portfolio delta as ground truth");
      effectivePnl = portfolioDeltaUsd;
      pnlWasAdjusted = true; // Mark that we're using adjusted value
    } else {
      // Without portfolio delta, set PnL to 0 to avoid recording garbage
      pnlWasAdjusted = true;
      effectivePnl = 0;
      logger.warn({ mint, symbol }, "SUSPICIOUS_PNL: No portfolio delta available, setting PnL to 0");
    }
  }
  
  // Second check: if portfolio delta provided, validate against it
  if (portfolioDeltaUsd !== undefined && !pnlWasAdjusted) {
    const discrepancy = Math.abs(totalRealizedPnl - portfolioDeltaUsd);
    const threshold = Math.max(1, Math.abs(proceedsUsd) * 0.5); // 50% of trade value
    
    if (discrepancy > threshold) {
      logger.warn({
        mint,
        symbol,
        calculatedPnl: totalRealizedPnl,
        portfolioDelta: portfolioDeltaUsd,
        discrepancy,
        threshold,
      }, "SUSPICIOUS_PNL: Calculated PnL differs significantly from portfolio delta - using delta");
      effectivePnl = portfolioDeltaUsd;
      pnlWasAdjusted = true;
    }
  }

  // PHASE 3: Now insert the trade lot and pnl_events with ADJUSTED values
  // If PnL was adjusted (suspicious or using portfolio delta), we use effectivePnl instead of per-lot values
  const sellLotResult = await q<{ lot_id: string }>(
    `INSERT INTO trade_lots 
     (tx_sig, timestamp, mint, side, quantity, usd_value, unit_price_usd, sol_price_usd, status)
     VALUES ($1, $2, $3, 'sell', $4, $5, $6, $7, 'confirmed')
     ON CONFLICT (tx_sig) DO NOTHING
     RETURNING lot_id`,
    [sellTxSig, sellTimestamp, mint, sellQuantity, proceedsUsd, unitProceedsUsd, solPriceUsd]
  );

  const sellLotId = sellLotResult.length > 0 ? sellLotResult[0].lot_id : null;

  // Update position lots and insert pnl_events
  // When PnL was adjusted, we allocate effectivePnl proportionally to matched cost basis
  const totalMatchedQty = lotMatches.reduce((sum, m) => sum + m.qtyToMatch, 0) + (hasUnmatchedQty ? remainingToSell : 0);
  
  for (const match of lotMatches) {
    await q(
      `UPDATE position_lots 
       SET remaining_qty = $1, is_closed = $2, last_matched_at = NOW()
       WHERE id = $3`,
      [Math.max(0, match.newRemainingQty), match.isClosed, match.lotId]
    );

    // If PnL was adjusted, allocate effectivePnl proportionally by quantity
    const adjustedPnl = pnlWasAdjusted 
      ? (totalMatchedQty > 0 ? effectivePnl * (match.qtyToMatch / totalMatchedQty) : 0)
      : match.pnlMatched;
    
    await insertPnLEvent({
      timestamp: sellTimestamp,
      mint,
      symbol,
      event_type: adjustedPnl >= 0 ? "realized_gain" : "realized_loss",
      sell_lot_id: sellLotId,
      buy_lot_id: match.lotUuid,
      quantity: match.qtyToMatch,
      proceeds_usd: match.proceedsMatched,
      cost_basis_usd: match.costBasisMatched,
      realized_pnl_usd: adjustedPnl,
      fee_usd: 0,
      notes: pnlWasAdjusted ? "PnL adjusted - using portfolio delta or zeroed" : null,
    });
  }

  if (hasUnmatchedQty) {
    logger.warn({ 
      mint, 
      remainingToSell, 
      unmatchedProceeds,
      originalQty: sellQuantity 
    }, "Sell quantity exceeded tracked position lots");

    // For unmatched quantities: if PnL was adjusted, allocate proportionally; otherwise $0
    const unmatchedAdjustedPnl = pnlWasAdjusted 
      ? (totalMatchedQty > 0 ? effectivePnl * (remainingToSell / totalMatchedQty) : 0)
      : 0; // No cost basis = unknown PnL
    
    await insertPnLEvent({
      timestamp: sellTimestamp,
      mint,
      symbol,
      event_type: unmatchedAdjustedPnl >= 0 ? "realized_gain" : "realized_loss",
      sell_lot_id: sellLotId,
      buy_lot_id: null,
      quantity: remainingToSell,
      proceeds_usd: unmatchedProceeds,
      cost_basis_usd: 0,
      realized_pnl_usd: unmatchedAdjustedPnl,
      fee_usd: 0,
      notes: pnlWasAdjusted 
        ? "PnL adjusted - no matching buy lot, using portfolio delta" 
        : "Excess sell quantity - no matching buy lot (PnL unknown)",
    });
  }

  logger.info({
    mint,
    symbol,
    sellQuantity,
    proceedsUsd: proceedsUsd.toFixed(2),
    costBasis: totalCostBasis.toFixed(2),
    calculatedPnl: totalRealizedPnl.toFixed(2),
    effectivePnl: effectivePnl.toFixed(2),
    portfolioDelta: portfolioDeltaUsd?.toFixed(2) ?? 'N/A',
    lotsMatched,
    pnlWasAdjusted,
  }, "FIFO lot matching complete");

  return { realizedPnl: effectivePnl, lotsMatched, suspicious: pnlWasAdjusted && effectivePnl === 0 };
}

async function insertPnLEvent(event: Omit<PnLEvent, "event_id">): Promise<void> {
  await q(
    `INSERT INTO pnl_events 
     (timestamp, mint, symbol, event_type, sell_lot_id, buy_lot_id, quantity, proceeds_usd, cost_basis_usd, realized_pnl_usd, fee_usd, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      event.timestamp,
      event.mint,
      event.symbol,
      event.event_type,
      event.sell_lot_id,
      event.buy_lot_id,
      event.quantity,
      event.proceeds_usd,
      event.cost_basis_usd,
      event.realized_pnl_usd,
      event.fee_usd,
      event.notes,
    ]
  );
}

export async function writeOffDustPosition(
  mint: string,
  symbol: string,
  remainingQty: number,
  remainingValueUsd: number
): Promise<void> {
  const openLots = await getOpenPositionLots(mint);
  
  let totalCostBasis = 0;
  for (const lot of openLots) {
    totalCostBasis += lot.remaining_qty * lot.unit_cost_usd;
    
    await q(
      `UPDATE position_lots 
       SET remaining_qty = 0, is_closed = true, last_matched_at = NOW()
       WHERE id = $1`,
      [lot.id]
    );
  }

  await insertPnLEvent({
    timestamp: new Date(),
    mint,
    symbol,
    event_type: "dust_writeoff",
    sell_lot_id: null,
    buy_lot_id: null,
    quantity: remainingQty,
    proceeds_usd: remainingValueUsd,
    cost_basis_usd: totalCostBasis,
    realized_pnl_usd: remainingValueUsd - totalCostBasis,
    fee_usd: 0,
    notes: `Dust position written off (value: $${remainingValueUsd.toFixed(4)})`,
  });

  logger.info({ mint, symbol, remainingQty, remainingValueUsd, costBasis: totalCostBasis }, "Dust position written off");
}

export async function getPositionCostBasis(mint: string): Promise<{ totalCostBasis: number; totalQuantity: number; avgCostUsd: number }> {
  const openLots = await getOpenPositionLots(mint);
  
  let totalCostBasis = 0;
  let totalQuantity = 0;
  
  for (const lot of openLots) {
    totalCostBasis += lot.remaining_qty * lot.unit_cost_usd;
    totalQuantity += lot.remaining_qty;
  }
  
  const avgCostUsd = totalQuantity > 0 ? totalCostBasis / totalQuantity : 0;
  
  return { totalCostBasis, totalQuantity, avgCostUsd };
}

export async function getBatchPositionCostBasis(mints: string[]): Promise<Map<string, { totalCostBasis: number; totalQuantity: number; avgCostUsd: number }>> {
  if (mints.length === 0) return new Map();
  
  const result = new Map<string, { totalCostBasis: number; totalQuantity: number; avgCostUsd: number }>();
  
  try {
    const openLots = await q<{ 
      mint: string; 
      remaining_qty: number; 
      unit_cost_usd: number 
    }>(
      `SELECT mint, remaining_qty, unit_cost_usd 
       FROM position_lots 
       WHERE mint = ANY($1) AND is_closed = false AND remaining_qty > 0`,
      [mints]
    );
    
    const lotsByMint = new Map<string, Array<{ remaining_qty: number; unit_cost_usd: number }>>();
    for (const lot of openLots) {
      if (!lotsByMint.has(lot.mint)) {
        lotsByMint.set(lot.mint, []);
      }
      lotsByMint.get(lot.mint)!.push(lot);
    }
    
    for (const mint of mints) {
      const lots = lotsByMint.get(mint) || [];
      let totalCostBasis = 0;
      let totalQuantity = 0;
      
      for (const lot of lots) {
        totalCostBasis += Number(lot.remaining_qty) * Number(lot.unit_cost_usd);
        totalQuantity += Number(lot.remaining_qty);
      }
      
      const avgCostUsd = totalQuantity > 0 ? totalCostBasis / totalQuantity : 0;
      result.set(mint, { totalCostBasis, totalQuantity, avgCostUsd });
    }
  } catch (err) {
    logger.warn({ mints: mints.length, err: String(err) }, "Failed to get batch cost basis");
    for (const mint of mints) {
      result.set(mint, { totalCostBasis: 0, totalQuantity: 0, avgCostUsd: 0 });
    }
  }
  
  return result;
}

export async function calculateUnrealizedPnL(
  positions: Array<{ mint: string; quantity: number; currentPriceUsd: number }>
): Promise<Map<string, { unrealizedPnl: number; costBasis: number; marketValue: number }>> {
  const result = new Map<string, { unrealizedPnl: number; costBasis: number; marketValue: number }>();
  
  for (const pos of positions) {
    if (pos.mint === MINT_SOL || pos.mint === MINT_USDC) continue;
    
    const { totalCostBasis } = await getPositionCostBasis(pos.mint);
    const marketValue = pos.quantity * pos.currentPriceUsd;
    const unrealizedPnl = marketValue - totalCostBasis;
    
    result.set(pos.mint, { unrealizedPnl, costBasis: totalCostBasis, marketValue });
  }
  
  return result;
}

export async function getPnLSummary(): Promise<PnLSummary> {
  const realizedResult = await q<{ mint: string; symbol: string; total_pnl: string }>(
    `SELECT mint, symbol, SUM(realized_pnl_usd) as total_pnl
     FROM pnl_events
     GROUP BY mint, symbol`
  );

  const todayResult = await q<{ total: string }>(
    `SELECT COALESCE(SUM(realized_pnl_usd), 0) as total
     FROM pnl_events
     WHERE timestamp >= CURRENT_DATE`
  );

  const openPositions = await q<{ mint: string; symbol: string; remaining_qty: number; cost_basis: number }>(
    `SELECT pl.mint, 
            COALESCE(tu.symbol, pl.mint) as symbol,
            SUM(pl.remaining_qty) as remaining_qty,
            SUM(pl.remaining_qty * pl.unit_cost_usd) as cost_basis
     FROM position_lots pl
     LEFT JOIN trading_universe tu ON pl.mint = tu.mint
     WHERE pl.is_closed = false AND pl.remaining_qty > 0.000001
     GROUP BY pl.mint, tu.symbol`
  );

  let totalRealizedPnl = 0;
  const byToken = new Map<string, {
    symbol: string;
    realizedPnl: number;
    unrealizedPnl: number;
    costBasis: number;
    currentValue: number;
    quantity: number;
  }>();

  for (const row of realizedResult) {
    const pnl = Number(row.total_pnl) || 0;
    totalRealizedPnl += pnl;
    byToken.set(row.mint, {
      symbol: row.symbol || row.mint.slice(0, 6),
      realizedPnl: pnl,
      unrealizedPnl: 0,
      costBasis: 0,
      currentValue: 0,
      quantity: 0,
    });
  }

  for (const pos of openPositions) {
    const existing = byToken.get(pos.mint) || {
      symbol: pos.symbol || pos.mint.slice(0, 6),
      realizedPnl: 0,
      unrealizedPnl: 0,
      costBasis: 0,
      currentValue: 0,
      quantity: 0,
    };
    existing.costBasis = Number(pos.cost_basis) || 0;
    existing.quantity = Number(pos.remaining_qty) || 0;
    byToken.set(pos.mint, existing);
  }

  const todayRealizedPnl = Number(todayResult[0]?.total) || 0;

  return {
    totalRealizedPnl,
    totalUnrealizedPnl: 0,
    todayRealizedPnl,
    byToken,
  };
}

export async function saveDailyPositionSnapshot(
  positions: Array<{ mint: string; symbol: string; quantity: number; currentPriceUsd: number }>
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  
  for (const pos of positions) {
    if (pos.mint === MINT_SOL || pos.mint === MINT_USDC) continue;
    if (pos.quantity < 0.000001) continue;
    
    const { totalCostBasis } = await getPositionCostBasis(pos.mint);
    const marketValue = pos.quantity * pos.currentPriceUsd;
    const unrealizedPnl = marketValue - totalCostBasis;
    
    await q(
      `INSERT INTO daily_position_snapshots 
       (snapshot_date, mint, symbol, quantity, cost_basis_usd, market_value_usd, unrealized_pnl_usd, price_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (snapshot_date, mint) 
       DO UPDATE SET 
         quantity = EXCLUDED.quantity,
         cost_basis_usd = EXCLUDED.cost_basis_usd,
         market_value_usd = EXCLUDED.market_value_usd,
         unrealized_pnl_usd = EXCLUDED.unrealized_pnl_usd,
         price_usd = EXCLUDED.price_usd`,
      [today, pos.mint, pos.symbol, pos.quantity, totalCostBasis, marketValue, unrealizedPnl, pos.currentPriceUsd]
    );
  }
  
  logger.debug({ date: today, positionCount: positions.length }, "Daily position snapshot saved");
}

export async function getRecentPnLEvents(limit = 50): Promise<PnLEvent[]> {
  return await q<PnLEvent>(
    `SELECT * FROM pnl_events ORDER BY timestamp DESC LIMIT $1`,
    [limit]
  );
}

export async function getTotalRealizedPnL(): Promise<number> {
  const result = await q<{ total: string }>(
    `SELECT COALESCE(SUM(realized_pnl_usd), 0) as total FROM pnl_events`
  );
  return Number(result[0]?.total) || 0;
}

export async function getTodayRealizedPnL(): Promise<number> {
  const result = await q<{ total: string }>(
    `SELECT COALESCE(SUM(realized_pnl_usd), 0) as total 
     FROM pnl_events 
     WHERE timestamp >= CURRENT_DATE`
  );
  return Number(result[0]?.total) || 0;
}

export async function getRealizedPnLForPeriod(startDate: Date): Promise<number> {
  const result = await q<{ total: string }>(
    `SELECT COALESCE(SUM(realized_pnl_usd), 0) as total 
     FROM pnl_events 
     WHERE timestamp >= $1`,
    [startDate.toISOString()]
  );
  return Number(result[0]?.total) || 0;
}

export async function getPnLEventsForPeriod(startDate: Date): Promise<{
  wins: number;
  losses: number;
  bestTrade: number;
  worstTrade: number;
  totalRealized: number;
}> {
  const result = await q<{ 
    wins: string; 
    losses: string; 
    best: string; 
    worst: string; 
    total: string;
  }>(
    `SELECT 
       COUNT(*) FILTER (WHERE realized_pnl_usd > 0) as wins,
       COUNT(*) FILTER (WHERE realized_pnl_usd < 0) as losses,
       COALESCE(MAX(realized_pnl_usd), 0) as best,
       COALESCE(MIN(realized_pnl_usd), 0) as worst,
       COALESCE(SUM(realized_pnl_usd), 0) as total
     FROM pnl_events 
     WHERE timestamp >= $1`,
    [startDate.toISOString()]
  );
  const row = result[0] || {};
  return {
    wins: Number(row.wins) || 0,
    losses: Number(row.losses) || 0,
    bestTrade: Number(row.best) || 0,
    worstTrade: Number(row.worst) || 0,
    totalRealized: Number(row.total) || 0,
  };
}

export interface PositionPnLData {
  mint: string;
  symbol: string;
  quantity: number;
  costBasisUsd: number;
  unitCostUsd: number;
  currentPriceUsd: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  realizedPnlUsd: number;
  lotCount: number;
}

export async function getPositionsPnLData(
  prices: Map<string, number>
): Promise<PositionPnLData[]> {
  const openLots = await q<{
    mint: string;
    remaining_qty: string;
    cost_basis: string;
    lot_count: string;
  }>(
    `SELECT 
       mint,
       SUM(remaining_qty) as remaining_qty,
       SUM(cost_basis_usd * remaining_qty / NULLIF(original_qty, 0)) as cost_basis,
       COUNT(*) as lot_count
     FROM position_lots 
     WHERE is_closed = false AND remaining_qty > 0
     GROUP BY mint`
  );

  const realizedByMint = await q<{ mint: string; total: string }>(
    `SELECT mint, COALESCE(SUM(realized_pnl_usd), 0) as total 
     FROM pnl_events 
     GROUP BY mint`
  );
  
  const realizedMap = new Map<string, number>();
  for (const row of realizedByMint) {
    realizedMap.set(row.mint, Number(row.total) || 0);
  }

  const results: PositionPnLData[] = [];
  
  for (const lot of openLots) {
    const quantity = Number(lot.remaining_qty) || 0;
    const costBasis = Number(lot.cost_basis) || 0;
    const unitCost = quantity > 0 ? costBasis / quantity : 0;
    const currentPrice = prices.get(lot.mint) || 0;
    const currentValue = quantity * currentPrice;
    const unrealizedPnl = currentValue - costBasis;
    const unrealizedPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;
    const realizedPnl = realizedMap.get(lot.mint) || 0;
    
    if (lot.mint === MINT_SOL || lot.mint === MINT_USDC) continue;
    
    results.push({
      mint: lot.mint,
      symbol: lot.mint.slice(0, 6),
      quantity,
      costBasisUsd: costBasis,
      unitCostUsd: unitCost,
      currentPriceUsd: currentPrice,
      currentValueUsd: currentValue,
      unrealizedPnlUsd: unrealizedPnl,
      unrealizedPnlPct: unrealizedPct,
      realizedPnlUsd: realizedPnl,
      lotCount: Number(lot.lot_count) || 0,
    });
  }
  
  return results;
}

export async function getTotalUnrealizedPnL(prices: Map<string, number>): Promise<number> {
  const positions = await getPositionsPnLData(prices);
  return positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);
}

export async function backfillMissingPositionLots(): Promise<{ backfilled: number; skipped: number }> {
  const positionsWithoutLots = await q<{
    mint: string;
    entry_price: string;
    total_tokens: string;
    entry_time: Date | string | null;
  }>(
    `SELECT pt.mint, pt.entry_price, pt.total_tokens, pt.entry_time
     FROM position_tracking pt
     LEFT JOIN position_lots pl ON pt.mint = pl.mint AND pl.is_closed = false AND pl.remaining_qty > 0
     WHERE pl.mint IS NULL AND pt.total_tokens > 0`
  );
  
  let backfilled = 0;
  let skipped = 0;
  
  for (const pos of positionsWithoutLots) {
    const entryPrice = Number(pos.entry_price) || 0;
    const totalTokens = Number(pos.total_tokens) || 0;
    
    if (entryPrice <= 0 || totalTokens <= 0) {
      skipped++;
      continue;
    }
    
    const costBasisUsd = entryPrice * totalTokens;
    const entryTime = pos.entry_time 
      ? (typeof pos.entry_time === 'string' ? new Date(pos.entry_time) : pos.entry_time)
      : new Date();
    
    const lotId = await insertTradeLot({
      tx_sig: `BACKFILL_${pos.mint.slice(0, 8)}_${Date.now()}`,
      timestamp: entryTime,
      mint: pos.mint,
      side: 'buy',
      quantity: totalTokens,
      usd_value: costBasisUsd,
      unit_price_usd: entryPrice,
      sol_price_usd: null,
      source: 'backfill_migration',
      status: 'confirmed',
    });
    
    if (lotId) {
      backfilled++;
      logger.info({ 
        mint: pos.mint, 
        entryPrice, 
        totalTokens, 
        costBasisUsd 
      }, "Backfilled missing position lot");
    } else {
      skipped++;
    }
  }
  
  logger.info({ backfilled, skipped }, "Position lots backfill complete");
  return { backfilled, skipped };
}

/**
 * DATA INTEGRITY CHECK: Compare position_lots FIFO data against position_tracking
 * Logs warnings for any positions where FIFO data is missing or significantly different
 * from tracking data. This helps identify positions that may have exit condition issues.
 */
export async function checkPositionDataIntegrity(): Promise<{
  totalPositions: number;
  fifoMissing: number;
  quantityMismatch: number;
  priceMismatch: number;
  healthy: number;
  issues: Array<{
    mint: string;
    symbol: string;
    issueType: 'fifo_missing' | 'quantity_mismatch' | 'price_mismatch';
    details: string;
  }>;
}> {
  const issues: Array<{
    mint: string;
    symbol: string;
    issueType: 'fifo_missing' | 'quantity_mismatch' | 'price_mismatch';
    details: string;
  }> = [];
  
  let fifoMissing = 0;
  let quantityMismatch = 0;
  let priceMismatch = 0;
  let healthy = 0;
  
  // Get all positions from tracking
  const tracking = await q<{
    mint: string;
    entry_price: number;
    total_tokens: number;
    slot_type: string;
  }>(
    `SELECT mint, entry_price, total_tokens, slot_type 
     FROM position_tracking 
     WHERE total_tokens > 0`
  );
  
  if (tracking.length === 0) {
    return { totalPositions: 0, fifoMissing: 0, quantityMismatch: 0, priceMismatch: 0, healthy: 0, issues };
  }
  
  const mints = tracking.map(t => t.mint);
  const fifoCostBasis = await getBatchPositionCostBasis(mints);
  
  // Build symbol map for better logging
  const symbolMap = await q<{ mint: string; symbol: string }>(
    `SELECT mint, symbol FROM trading_universe WHERE mint = ANY($1)`,
    [mints]
  );
  const mintToSymbol = new Map<string, string>();
  for (const s of symbolMap) {
    mintToSymbol.set(s.mint, s.symbol);
  }
  
  for (const pos of tracking) {
    const symbol = mintToSymbol.get(pos.mint) || pos.mint.slice(0, 6);
    const fifo = fifoCostBasis.get(pos.mint);
    const trackingQty = Number(pos.total_tokens) || 0;
    const trackingPrice = Number(pos.entry_price) || 0;
    
    // Check 1: FIFO data missing entirely
    if (!fifo || (fifo.totalQuantity <= 0 && fifo.avgCostUsd <= 0)) {
      fifoMissing++;
      issues.push({
        mint: pos.mint,
        symbol,
        issueType: 'fifo_missing',
        details: `No open position lots found. Tracking has ${trackingQty.toFixed(2)} tokens @ $${trackingPrice.toFixed(6)}`
      });
      logger.warn({
        mint: pos.mint,
        symbol,
        slotType: pos.slot_type,
        trackingQty,
        trackingPrice,
      }, "DATA_INTEGRITY: FIFO data missing for tracked position - exit conditions may not work correctly");
      continue;
    }
    
    // Check 2: Quantity mismatch (>20% difference)
    const qtyRatio = trackingQty > 0 ? fifo.totalQuantity / trackingQty : 1;
    if (qtyRatio < 0.8 || qtyRatio > 1.2) {
      quantityMismatch++;
      issues.push({
        mint: pos.mint,
        symbol,
        issueType: 'quantity_mismatch',
        details: `FIFO qty: ${fifo.totalQuantity.toFixed(2)}, Tracking qty: ${trackingQty.toFixed(2)} (${(qtyRatio * 100).toFixed(0)}% coverage)`
      });
      logger.warn({
        mint: pos.mint,
        symbol,
        slotType: pos.slot_type,
        fifoQty: fifo.totalQuantity,
        trackingQty,
        coverageRatio: (qtyRatio * 100).toFixed(1) + '%',
      }, "DATA_INTEGRITY: FIFO quantity doesn't match tracking quantity");
      continue;
    }
    
    // Check 3: Entry price mismatch (>50% difference)
    if (trackingPrice > 0 && fifo.avgCostUsd > 0) {
      const priceRatio = fifo.avgCostUsd / trackingPrice;
      if (priceRatio < 0.5 || priceRatio > 2.0) {
        priceMismatch++;
        issues.push({
          mint: pos.mint,
          symbol,
          issueType: 'price_mismatch',
          details: `FIFO avg: $${fifo.avgCostUsd.toFixed(6)}, Tracking entry: $${trackingPrice.toFixed(6)} (${(priceRatio * 100).toFixed(0)}%)`
        });
        logger.warn({
          mint: pos.mint,
          symbol,
          slotType: pos.slot_type,
          fifoAvgCost: fifo.avgCostUsd,
          trackingEntryPrice: trackingPrice,
          priceRatio: (priceRatio * 100).toFixed(1) + '%',
        }, "DATA_INTEGRITY: FIFO entry price significantly differs from tracking entry price");
        continue;
      }
    }
    
    healthy++;
  }
  
  const result = {
    totalPositions: tracking.length,
    fifoMissing,
    quantityMismatch,
    priceMismatch,
    healthy,
    issues,
  };
  
  if (issues.length > 0) {
    logger.info({
      totalPositions: tracking.length,
      fifoMissing,
      quantityMismatch,
      priceMismatch,
      healthy,
    }, "DATA_INTEGRITY: Position data check complete - issues found");
  } else {
    logger.debug({
      totalPositions: tracking.length,
      healthy,
    }, "DATA_INTEGRITY: All positions have consistent FIFO and tracking data");
  }
  
  return result;
}
