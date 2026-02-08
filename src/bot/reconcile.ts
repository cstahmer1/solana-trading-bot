import { getEnhancedTransactions, HeliusEnhancedTransaction, isHeliusConfigured } from "./helius.js";
import { q } from "./db.js";
import { logger } from "../utils/logger.js";
import { MINT_SOL, MINT_USDC } from "./config.js";
import { getJupiterBatchPrices } from "./jupiter.js";
import { insertTradeLot, processSellWithFIFO } from "./pnl_engine.js";

export interface TradeRecord {
  id?: number;
  signature: string;
  timestamp: Date;
  slot: number;
  source: string;
  inMint: string;
  inAmountRaw: string;
  inAmountUi: number;
  inDecimals: number;
  outMint: string;
  outAmountRaw: string;
  outAmountUi: number;
  outDecimals: number;
  feeLamports: number;
  priceUsd: number | null;
}

export interface PositionSummary {
  mint: string;
  symbol: string;
  totalBought: number;
  totalSold: number;
  netPosition: number;
  avgCostUsd: number;
  costBasisUsd: number;
  currentPriceUsd: number | null;
  currentValueUsd: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number | null;
  tradeCount: number;
}

async function ensureTradesTable(): Promise<void> {
  await q(`
    CREATE TABLE IF NOT EXISTS reconciled_trades (
      id SERIAL PRIMARY KEY,
      signature VARCHAR(128) UNIQUE NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      slot BIGINT NOT NULL,
      source VARCHAR(32) NOT NULL,
      in_mint VARCHAR(64) NOT NULL,
      in_amount_raw VARCHAR(64) NOT NULL,
      in_amount_ui DOUBLE PRECISION NOT NULL,
      in_decimals INTEGER NOT NULL,
      out_mint VARCHAR(64) NOT NULL,
      out_amount_raw VARCHAR(64) NOT NULL,
      out_amount_ui DOUBLE PRECISION NOT NULL,
      out_decimals INTEGER NOT NULL,
      fee_lamports BIGINT NOT NULL,
      price_usd DOUBLE PRECISION,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await q(`CREATE INDEX IF NOT EXISTS idx_reconciled_trades_timestamp ON reconciled_trades(timestamp DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_reconciled_trades_in_mint ON reconciled_trades(in_mint)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_reconciled_trades_out_mint ON reconciled_trades(out_mint)`);
  
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS usd_in DOUBLE PRECISION`);
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS usd_out DOUBLE PRECISION`);
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS sol_price_usd DOUBLE PRECISION`);
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS fee_usd DOUBLE PRECISION`);
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS price_source VARCHAR(32)`);
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS side VARCHAR(4)`);
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS entry_price_usd DOUBLE PRECISION`);
  await q(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS lot_processed BOOLEAN DEFAULT false`);
}

function parseSwapFromTransaction(
  tx: HeliusEnhancedTransaction,
  walletAddress: string
): TradeRecord | null {
  if (tx.type !== "SWAP") return null;

  const walletChanges = tx.accountData.find(
    (a) => a.account.toLowerCase() === walletAddress.toLowerCase()
  );

  if (!walletChanges) return null;

  let inMint = "";
  let inAmountRaw = "0";
  let inDecimals = 9;
  let outMint = "";
  let outAmountRaw = "0";
  let outDecimals = 9;

  for (const change of walletChanges.tokenBalanceChanges) {
    const rawAmount = BigInt(change.rawTokenAmount.tokenAmount);
    if (rawAmount < 0n) {
      inMint = change.mint;
      inAmountRaw = (-rawAmount).toString();
      inDecimals = change.rawTokenAmount.decimals;
    } else if (rawAmount > 0n) {
      outMint = change.mint;
      outAmountRaw = rawAmount.toString();
      outDecimals = change.rawTokenAmount.decimals;
    }
  }

  const nativeChange = walletChanges.nativeBalanceChange;
  const fee = tx.fee || 5000;
  
  if (nativeChange < 0) {
    const totalSpent = Math.abs(nativeChange);
    const swapSpent = totalSpent - fee;
    
    if (swapSpent > 10000 && !inMint) {
      inMint = MINT_SOL;
      inAmountRaw = swapSpent.toString();
      inDecimals = 9;
    }
  } else if (nativeChange > 0) {
    if (!outMint) {
      outMint = MINT_SOL;
      outAmountRaw = nativeChange.toString();
      outDecimals = 9;
    }
  } else if (nativeChange === 0 && !inMint && !outMint) {
    return null;
  }

  if (!inMint || !outMint) return null;

  const inAmountUi = Number(inAmountRaw) / Math.pow(10, inDecimals);
  const outAmountUi = Number(outAmountRaw) / Math.pow(10, outDecimals);

  return {
    signature: tx.signature,
    timestamp: new Date(tx.timestamp * 1000),
    slot: tx.slot,
    source: tx.source || "JUPITER",
    inMint,
    inAmountRaw,
    inAmountUi,
    inDecimals,
    outMint,
    outAmountRaw,
    outAmountUi,
    outDecimals,
    feeLamports: tx.fee,
    priceUsd: null,
  };
}

export async function fetchAndReconcileTrades(
  walletAddress: string,
  options: { limit?: number; lookbackDays?: number } = {}
): Promise<{ newTrades: number; totalTrades: number }> {
  if (!isHeliusConfigured()) {
    throw new Error("Helius API key not configured");
  }

  await ensureTradesTable();

  const limit = options.limit ?? 500;
  let allTransactions: HeliusEnhancedTransaction[] = [];
  let cursor: string | undefined;
  let fetchCount = 0;
  const maxFetches = Math.ceil(limit / 100);

  while (fetchCount < maxFetches) {
    const batch = await getEnhancedTransactions(walletAddress, {
      limit: Math.min(100, limit - allTransactions.length),
      before: cursor,
    });

    if (!batch || batch.length === 0) break;

    allTransactions = allTransactions.concat(batch);
    cursor = batch[batch.length - 1].signature;
    fetchCount++;

    if (allTransactions.length >= limit) break;
  }

  logger.info({ 
    fetched: allTransactions.length, 
    wallet: walletAddress.slice(0, 8) 
  }, "Fetched transactions for reconciliation");

  const swaps = allTransactions.filter(tx => tx.type === "SWAP");
  let newTrades = 0;

  for (const tx of swaps) {
    const trade = parseSwapFromTransaction(tx, walletAddress);
    if (!trade) continue;

    try {
      const existing = await q<{ id: number }[]>(
        `SELECT id FROM reconciled_trades WHERE signature = $1`,
        [trade.signature]
      );

      if (existing.length === 0) {
        await q(
          `INSERT INTO reconciled_trades 
           (signature, timestamp, slot, source, in_mint, in_amount_raw, in_amount_ui, in_decimals, 
            out_mint, out_amount_raw, out_amount_ui, out_decimals, fee_lamports)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            trade.signature,
            trade.timestamp,
            trade.slot,
            trade.source,
            trade.inMint,
            trade.inAmountRaw,
            trade.inAmountUi,
            trade.inDecimals,
            trade.outMint,
            trade.outAmountRaw,
            trade.outAmountUi,
            trade.outDecimals,
            trade.feeLamports,
          ]
        );
        newTrades++;
      }
    } catch (err) {
      logger.warn({ signature: trade.signature, err: String(err) }, "Failed to insert trade");
    }
  }

  const countResult = await q(`SELECT COUNT(*) as count FROM reconciled_trades`) as Array<{ count: string }>;
  const totalTrades = parseInt(countResult[0]?.count || "0", 10);

  logger.info({ newTrades, totalTrades, swapsFound: swaps.length }, "Reconciliation complete");

  return { newTrades, totalTrades };
}

export async function getReconciledTrades(limit = 100): Promise<TradeRecord[]> {
  const rows = await q(
    `SELECT * FROM reconciled_trades ORDER BY timestamp DESC LIMIT $1`,
    [limit]
  ) as Array<{
    id: number;
    signature: string;
    timestamp: Date;
    slot: string;
    source: string;
    in_mint: string;
    in_amount_raw: string;
    in_amount_ui: number;
    in_decimals: number;
    out_mint: string;
    out_amount_raw: string;
    out_amount_ui: number;
    out_decimals: number;
    fee_lamports: string;
    price_usd: number | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    signature: r.signature,
    timestamp: r.timestamp,
    slot: Number(r.slot),
    source: r.source,
    inMint: r.in_mint,
    inAmountRaw: r.in_amount_raw,
    inAmountUi: r.in_amount_ui,
    inDecimals: r.in_decimals,
    outMint: r.out_mint,
    outAmountRaw: r.out_amount_raw,
    outAmountUi: r.out_amount_ui,
    outDecimals: r.out_decimals,
    feeLamports: Number(r.fee_lamports),
    priceUsd: r.price_usd,
  }));
}

export async function computePositionsFromTrades(
  currentHoldings: Map<string, { balance: number; symbol: string }>
): Promise<PositionSummary[]> {
  const trades = await getReconciledTrades(1000);
  
  const mintStats = new Map<string, {
    symbol: string;
    totalBought: number;
    totalSold: number;
    totalCostUsd: number;
    totalProceedsUsd: number;
    tradeCount: number;
  }>();

  const allMints = new Set<string>();
  for (const trade of trades) {
    allMints.add(trade.inMint);
    allMints.add(trade.outMint);
  }

  const prices = await getJupiterBatchPrices([...allMints]);
  const solPrice = prices[MINT_SOL] ?? 180;

  for (const trade of trades) {
    if (!mintStats.has(trade.outMint)) {
      const holding = currentHoldings.get(trade.outMint);
      mintStats.set(trade.outMint, {
        symbol: holding?.symbol || trade.outMint.slice(0, 6),
        totalBought: 0,
        totalSold: 0,
        totalCostUsd: 0,
        totalProceedsUsd: 0,
        tradeCount: 0,
      });
    }
    
    if (!mintStats.has(trade.inMint)) {
      const holding = currentHoldings.get(trade.inMint);
      mintStats.set(trade.inMint, {
        symbol: holding?.symbol || trade.inMint.slice(0, 6),
        totalBought: 0,
        totalSold: 0,
        totalCostUsd: 0,
        totalProceedsUsd: 0,
        tradeCount: 0,
      });
    }

    const inStats = mintStats.get(trade.inMint)!;
    const outStats = mintStats.get(trade.outMint)!;

    inStats.totalSold += trade.inAmountUi;
    inStats.tradeCount++;

    outStats.totalBought += trade.outAmountUi;
    outStats.tradeCount++;

    let tradeValueUsd = 0;
    if (trade.inMint === MINT_SOL) {
      tradeValueUsd = trade.inAmountUi * solPrice;
    } else if (trade.outMint === MINT_SOL) {
      tradeValueUsd = trade.outAmountUi * solPrice;
    } else {
      const inPrice = prices[trade.inMint];
      if (inPrice) {
        tradeValueUsd = trade.inAmountUi * inPrice;
      }
    }

    outStats.totalCostUsd += tradeValueUsd;
    inStats.totalProceedsUsd += tradeValueUsd;
  }

  const positions: PositionSummary[] = [];

  for (const [mint, stats] of mintStats) {
    if (mint === MINT_SOL) continue;

    const holding = currentHoldings.get(mint);
    const netPosition = holding?.balance ?? 0;
    const currentPrice = prices[mint] ?? null;
    const currentValueUsd = currentPrice !== null ? netPosition * currentPrice : null;

    const avgCostUsd = stats.totalBought > 0 ? stats.totalCostUsd / stats.totalBought : 0;
    const costBasisUsd = netPosition * avgCostUsd;

    const realizedPnlUsd = stats.totalProceedsUsd - (stats.totalSold * avgCostUsd);
    const unrealizedPnlUsd = currentValueUsd !== null ? currentValueUsd - costBasisUsd : null;

    if (stats.tradeCount > 0 || netPosition > 0) {
      positions.push({
        mint,
        symbol: stats.symbol,
        totalBought: stats.totalBought,
        totalSold: stats.totalSold,
        netPosition,
        avgCostUsd,
        costBasisUsd,
        currentPriceUsd: currentPrice,
        currentValueUsd,
        realizedPnlUsd,
        unrealizedPnlUsd,
        tradeCount: stats.tradeCount,
      });
    }
  }

  positions.sort((a, b) => {
    const aVal = a.currentValueUsd ?? 0;
    const bVal = b.currentValueUsd ?? 0;
    return bVal - aVal;
  });

  return positions;
}

export async function getPnlSummary(
  walletAddress: string,
  currentHoldings: Map<string, { balance: number; symbol: string }>
): Promise<{
  positions: PositionSummary[];
  totals: {
    totalValueUsd: number;
    totalCostBasisUsd: number;
    totalRealizedPnlUsd: number;
    totalUnrealizedPnlUsd: number;
  };
}> {
  const positions = await computePositionsFromTrades(currentHoldings);

  let totalValueUsd = 0;
  let totalCostBasisUsd = 0;
  let totalRealizedPnlUsd = 0;
  let totalUnrealizedPnlUsd = 0;

  for (const pos of positions) {
    totalValueUsd += pos.currentValueUsd ?? 0;
    totalCostBasisUsd += pos.costBasisUsd;
    totalRealizedPnlUsd += pos.realizedPnlUsd;
    totalUnrealizedPnlUsd += pos.unrealizedPnlUsd ?? 0;
  }

  return {
    positions,
    totals: {
      totalValueUsd,
      totalCostBasisUsd,
      totalRealizedPnlUsd,
      totalUnrealizedPnlUsd,
    },
  };
}

export async function processTradesIntoLots(
  symbolMap: Map<string, string>
): Promise<{ processed: number; errors: number }> {
  const unprocessedTrades = await q<{
    id: number;
    signature: string;
    timestamp: Date;
    slot: string;
    source: string;
    in_mint: string;
    in_amount_ui: number;
    in_decimals: number;
    out_mint: string;
    out_amount_ui: number;
    out_decimals: number;
    fee_lamports: string;
    usd_in: number | null;
    usd_out: number | null;
    sol_price_usd: number | null;
    side: string | null;
  }>(
    `SELECT * FROM reconciled_trades 
     WHERE lot_processed = false OR lot_processed IS NULL
     ORDER BY timestamp ASC`
  );

  if (unprocessedTrades.length === 0) {
    return { processed: 0, errors: 0 };
  }

  const allMints = new Set<string>();
  for (const trade of unprocessedTrades) {
    allMints.add(trade.in_mint);
    allMints.add(trade.out_mint);
  }

  const prices = await getJupiterBatchPrices([...allMints]);
  const solPrice = prices[MINT_SOL] ?? 180;

  let processed = 0;
  let errors = 0;

  for (const trade of unprocessedTrades) {
    try {
      const isBuy = trade.in_mint === MINT_SOL || trade.in_mint === MINT_USDC;
      const isSell = trade.out_mint === MINT_SOL || trade.out_mint === MINT_USDC;
      
      if (!isBuy && !isSell) {
        await q(`UPDATE reconciled_trades SET lot_processed = true WHERE id = $1`, [trade.id]);
        processed++;
        continue;
      }

      let usdValue = trade.usd_in ?? trade.usd_out ?? 0;
      let tradesolPrice = trade.sol_price_usd ?? solPrice;
      
      if (usdValue === 0) {
        if (trade.in_mint === MINT_SOL) {
          usdValue = trade.in_amount_ui * tradesolPrice;
        } else if (trade.out_mint === MINT_SOL) {
          usdValue = trade.out_amount_ui * tradesolPrice;
        } else if (trade.in_mint === MINT_USDC) {
          usdValue = trade.in_amount_ui;
        } else if (trade.out_mint === MINT_USDC) {
          usdValue = trade.out_amount_ui;
        }
      }

      const feeUsd = (Number(trade.fee_lamports) / 1e9) * tradesolPrice;

      await q(
        `UPDATE reconciled_trades 
         SET usd_in = $1, usd_out = $2, sol_price_usd = $3, fee_usd = $4, side = $5
         WHERE id = $6`,
        [
          isBuy ? usdValue : null,
          isSell ? usdValue : null,
          tradesolPrice,
          feeUsd,
          isBuy ? 'buy' : 'sell',
          trade.id,
        ]
      );

      if (isBuy) {
        const tokenMint = trade.out_mint;
        const tokenQty = trade.out_amount_ui;
        const unitPrice = tokenQty > 0 ? usdValue / tokenQty : 0;
        const symbol = symbolMap.get(tokenMint) || tokenMint.slice(0, 6);

        await insertTradeLot({
          tx_sig: trade.signature,
          timestamp: trade.timestamp,
          slot: Number(trade.slot),
          mint: tokenMint,
          side: "buy",
          quantity: tokenQty,
          usd_value: usdValue,
          unit_price_usd: unitPrice,
          sol_price_usd: tradesolPrice,
          fee_usd: feeUsd,
          source: trade.source,
        });

        logger.debug({
          signature: trade.signature.slice(0, 8),
          mint: tokenMint.slice(0, 8),
          symbol,
          qty: tokenQty,
          usdValue: usdValue.toFixed(2),
        }, "Created buy lot from reconciled trade");
      } else if (isSell) {
        const tokenMint = trade.in_mint;
        const tokenQty = trade.in_amount_ui;
        const symbol = symbolMap.get(tokenMint) || tokenMint.slice(0, 6);

        await processSellWithFIFO(
          trade.signature,
          tokenMint,
          symbol,
          tokenQty,
          usdValue,
          trade.timestamp,
          tradesolPrice
        );

        logger.debug({
          signature: trade.signature.slice(0, 8),
          mint: tokenMint.slice(0, 8),
          symbol,
          qty: tokenQty,
          proceeds: usdValue.toFixed(2),
        }, "Processed sell through FIFO matching");
      }

      await q(`UPDATE reconciled_trades SET lot_processed = true WHERE id = $1`, [trade.id]);
      processed++;
    } catch (err) {
      logger.warn({ signature: trade.signature, err: String(err) }, "Failed to process trade into lot");
      errors++;
    }
  }

  logger.info({ processed, errors, total: unprocessedTrades.length }, "Processed reconciled trades into lots");
  return { processed, errors };
}

export async function backfillTradesFromReconciled(
  walletAddress: string,
  symbolMap: Map<string, string>
): Promise<{ synced: number; processed: number }> {
  const result = await fetchAndReconcileTrades(walletAddress, { limit: 500 });
  const lotResult = await processTradesIntoLots(symbolMap);
  
  return {
    synced: result.newTrades,
    processed: lotResult.processed,
  };
}
