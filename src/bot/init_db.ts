import { pool } from "./db.js";
import { logger } from "../utils/logger.js";

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prices (
      mint text not null,
      ts timestamptz not null,
      usd_price numeric not null,
      block_id bigint,
      primary key (mint, ts)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      mint text not null,
      ts timestamptz not null,
      features jsonb not null,
      primary key (mint, ts)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_trades (
      id bigserial primary key,
      ts timestamptz not null default now(),
      strategy text not null,
      risk_profile text not null,
      mode text not null,
      input_mint text not null,
      output_mint text not null,
      in_amount text not null,
      out_amount text,
      est_out_amount text,
      price_impact_pct text,
      slippage_bps int,
      tx_sig text,
      status text not null,
      meta jsonb
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS equity_snapshots (
      ts timestamptz primary key,
      total_usd numeric not null,
      total_sol_equiv numeric not null,
      breakdown jsonb not null
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scanner_opportunities (
      id bigserial primary key,
      ts timestamptz not null default now(),
      mint text not null,
      symbol text,
      name text,
      score numeric not null,
      volume_24h numeric,
      holders int,
      price_usd numeric,
      market_cap numeric,
      liquidity numeric,
      price_change_24h numeric,
      source text,
      meta jsonb
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_metrics (
      id bigserial primary key,
      ts timestamptz not null default now(),
      mint text not null,
      holders int,
      volume_24h numeric,
      liquidity numeric,
      price_usd numeric,
      market_cap numeric,
      transfers_24h int,
      top_holder_pct numeric,
      meta jsonb
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trending_tokens (
      id bigserial primary key,
      ts timestamptz not null default now(),
      mint text not null,
      symbol text,
      name text,
      rank int,
      price_usd numeric,
      holders int,
      volume_24h numeric,
      source text
    );
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS pnl_usd numeric DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS reason_code text;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS entry_score numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS exit_score numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS fees_lamports bigint DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS priority_fee_lamports bigint DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS route text;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS settings_snapshot jsonb;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS liquidity_usd numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS peak_pnl_pct numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS peak_pnl_usd numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS trailing_base_pct numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS trailing_tight_pct numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS trailing_threshold_pct numeric;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS threshold_in_effect text;
  `);

  await pool.query(`
    ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS promoted_at timestamptz;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS bot_trades_reason_code_idx ON bot_trades(reason_code);`);

  await pool.query(`CREATE INDEX IF NOT EXISTS prices_ts_idx ON prices(ts desc);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bot_trades_ts_idx ON bot_trades(ts desc);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bot_trades_status_idx ON bot_trades(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS scanner_opportunities_ts_idx ON scanner_opportunities(ts desc);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS scanner_opportunities_mint_idx ON scanner_opportunities(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS token_metrics_ts_idx ON token_metrics(ts desc);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS token_metrics_mint_idx ON token_metrics(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS trending_tokens_ts_idx ON trending_tokens(ts desc);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key text primary key,
      value text not null,
      updated_at timestamptz default now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_universe (
      mint text PRIMARY KEY,
      symbol text NOT NULL,
      name text,
      added_at timestamptz DEFAULT now(),
      source text,
      active boolean DEFAULT true,
      slot_type text DEFAULT 'scout'
    );
  `);

  await pool.query(`
    ALTER TABLE trading_universe ADD COLUMN IF NOT EXISTS slot_type text DEFAULT 'scout';
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS trading_universe_active_idx ON trading_universe(active);`);

  await pool.query(`
    INSERT INTO trading_universe (mint, symbol, name, source, active)
    VALUES 
      ('So11111111111111111111111111111111111111112', 'SOL', 'Solana', 'default', true),
      ('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 'USD Coin', 'default', true)
    ON CONFLICT (mint) DO NOTHING;
  `);

  // Exited token cache - tracks tokens removed from active universe for re-entry and analysis
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exited_token_cache (
      mint text PRIMARY KEY,
      symbol text,
      last_exit_time timestamptz NOT NULL DEFAULT now(),
      last_exit_reason text,
      last_exit_pnl_usd numeric,
      last_exit_pnl_pct numeric,
      cooldown_until timestamptz,
      times_reentered int DEFAULT 0,
      last_known_signal numeric,
      last_known_liquidity_usd numeric,
      last_known_price numeric,
      last_seen_time timestamptz,
      telemetry_until timestamptz,
      notes text
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS exited_token_cache_cooldown_idx ON exited_token_cache(cooldown_until);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS exited_token_cache_exit_time_idx ON exited_token_cache(last_exit_time);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS exited_token_cache_telemetry_idx ON exited_token_cache(telemetry_until);`);

  // Token telemetry - time series for post-exit price/feature logging
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_telemetry (
      id bigserial PRIMARY KEY,
      mint text NOT NULL,
      ts timestamptz NOT NULL DEFAULT now(),
      price numeric,
      liquidity_usd numeric,
      volume_24h numeric,
      holders int,
      signal numeric,
      features jsonb
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS token_telemetry_mint_ts_idx ON token_telemetry(mint, ts);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS token_telemetry_ts_idx ON token_telemetry(ts DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS risk_profiles (
      name VARCHAR(50) PRIMARY KEY,
      max_pos_pct NUMERIC(10,4) NOT NULL,
      max_drawdown NUMERIC(10,4) NOT NULL,
      entry_z NUMERIC(10,4) NOT NULL,
      take_profit_pct NUMERIC(10,4) NOT NULL,
      stop_loss_pct NUMERIC(10,4) NOT NULL,
      max_turnover NUMERIC(10,4) NOT NULL,
      slippage_bps INTEGER NOT NULL,
      max_single_swap_sol NUMERIC(10,4) NOT NULL,
      min_trade_usd NUMERIC(10,2) NOT NULL,
      cooldown_seconds INTEGER NOT NULL,
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO risk_profiles (name, max_pos_pct, max_drawdown, entry_z, take_profit_pct, stop_loss_pct, max_turnover, slippage_bps, max_single_swap_sol, min_trade_usd, cooldown_seconds, is_default)
    VALUES 
      ('low', 0.10, 0.01, 1.25, 0.03, 0.02, 0.50, 30, 0.50, 50, 1800, true),
      ('medium', 0.25, 0.03, 1.0, 0.05, 0.03, 1.00, 80, 1.50, 25, 600, true),
      ('high', 0.40, 0.07, 0.75, 0.08, 0.05, 2.00, 150, 3.00, 15, 180, true),
      ('degen', 0.60, 0.15, 0.4, 0.15, 0.10, 6.00, 300, 10.0, 10, 60, true)
    ON CONFLICT (name) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id bigserial primary key,
      ts timestamptz not null default now(),
      transfer_type text not null,
      amount_sol numeric not null,
      amount_usd numeric not null,
      previous_balance_sol numeric,
      new_balance_sol numeric,
      detected_reason text,
      tx_sig text
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS wallet_transfers_ts_idx ON wallet_transfers(ts desc);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS wallet_transfers_type_idx ON wallet_transfers(transfer_type);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_tick_telemetry (
      id bigserial primary key,
      ts timestamptz not null default now(),
      config_snapshot jsonb,
      risk_profile text,
      sol_price_usd numeric,
      total_equity_usd numeric,
      position_count int,
      portfolio_snapshot jsonb,
      targets jsonb,
      regime_decisions jsonb,
      signals jsonb
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS bot_tick_telemetry_ts_idx ON bot_tick_telemetry(ts desc);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS position_tracking (
      mint text PRIMARY KEY,
      entry_time timestamptz NOT NULL DEFAULT now(),
      entry_price numeric NOT NULL,
      peak_price numeric NOT NULL,
      peak_time timestamptz NOT NULL DEFAULT now(),
      last_price numeric NOT NULL,
      last_update timestamptz NOT NULL DEFAULT now(),
      total_tokens numeric NOT NULL DEFAULT 0,
      slot_type text DEFAULT 'scout',
      promotion_count int DEFAULT 0,
      dust_since timestamptz DEFAULT NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS position_tracking_slot_type_idx ON position_tracking(slot_type);`);
  
  // Add dust_since column if it doesn't exist (for existing databases)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE position_tracking ADD COLUMN IF NOT EXISTS dust_since timestamptz DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  // Add source column for sniper integration (bot vs sniper positions)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE position_tracking ADD COLUMN IF NOT EXISTS source text DEFAULT 'bot';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  // Add peak_pnl_pct column for trailing stop analysis
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE position_tracking ADD COLUMN IF NOT EXISTS peak_pnl_pct numeric DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  // Liquidation lock columns for rug defense
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE position_tracking ADD COLUMN IF NOT EXISTS liquidating boolean DEFAULT false;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE position_tracking ADD COLUMN IF NOT EXISTS liquidating_reason text DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE position_tracking ADD COLUMN IF NOT EXISTS liquidating_since timestamptz DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE position_tracking ADD COLUMN IF NOT EXISTS reentry_ban_until timestamptz DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS position_tracking_liquidating_idx ON position_tracking(liquidating) WHERE liquidating = true;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scout_queue (
      id bigserial primary key,
      mint text not null unique,
      symbol text,
      name text,
      score numeric not null,
      reasons jsonb,
      discovered_at timestamptz not null default now(),
      queued_at timestamptz not null default now(),
      status text not null default 'PENDING',
      last_error text,
      cooldown_until timestamptz,
      buy_attempts int default 0,
      warmup_attempts int default 0,
      tx_sig text,
      spend_sol numeric,
      in_progress_at timestamptz,
      next_attempt_at timestamptz,
      last_attempt_at timestamptz,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS scout_queue_status_idx ON scout_queue(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS scout_queue_mint_idx ON scout_queue(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS scout_queue_score_idx ON scout_queue(score desc);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS scout_queue_queued_at_idx ON scout_queue(queued_at ASC);`);

  // Add missing columns for existing databases
  await pool.query(`ALTER TABLE scout_queue ADD COLUMN IF NOT EXISTS in_progress_at timestamptz;`);
  await pool.query(`ALTER TABLE scout_queue ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;`);
  await pool.query(`ALTER TABLE scout_queue ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;`);
  await pool.query(`ALTER TABLE scout_queue ADD COLUMN IF NOT EXISTS warmup_attempts int DEFAULT 0;`);
  
  // Migrate QUEUED -> PENDING for existing databases
  await pool.query(`UPDATE scout_queue SET status = 'PENDING' WHERE status IN ('QUEUED', 'queued');`);
  
  // Backfill queued_at
  await pool.query(`UPDATE scout_queue SET queued_at = created_at WHERE queued_at IS NULL;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_log (
      id bigserial primary key,
      ts timestamptz not null default now(),
      action text not null,
      sold_mint text,
      sold_symbol text,
      bought_mint text,
      bought_symbol text,
      reason_code text not null,
      sold_rank numeric,
      bought_rank numeric,
      rank_delta numeric,
      meta jsonb
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS rotation_log_ts_idx ON rotation_log(ts desc);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_runtime_status (
      id TEXT PRIMARY KEY DEFAULT 'global',
      manual_pause BOOLEAN DEFAULT false,
      execution_mode TEXT DEFAULT 'paper',
      last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
      last_transition_at TIMESTAMPTZ DEFAULT NOW(),
      last_transition_by TEXT,
      instance_id TEXT,
      CONSTRAINT single_row CHECK (id = 'global')
    );
  `);

  await pool.query(`
    INSERT INTO bot_runtime_status (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id bigserial primary key,
      period_start timestamptz not null,
      period_end timestamptz not null,
      report_data jsonb not null,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS weekly_reports_period_idx ON weekly_reports(period_start, period_end);`);

  // Reconciled trades table (created here to ensure it exists before PnL tables reference it)
  await pool.query(`
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
  
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reconciled_trades_timestamp ON reconciled_trades(timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reconciled_trades_in_mint ON reconciled_trades(in_mint)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reconciled_trades_out_mint ON reconciled_trades(out_mint)`);

  // PnL Tracking Tables - lot-based cost tracking system
  
  // Trade lots: immutable record of each buy/sell with USD value at execution time
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_lots (
      id bigserial PRIMARY KEY,
      lot_id uuid DEFAULT gen_random_uuid() UNIQUE NOT NULL,
      tx_sig VARCHAR(128) NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      slot BIGINT,
      mint VARCHAR(64) NOT NULL,
      side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
      quantity DOUBLE PRECISION NOT NULL,
      usd_value DOUBLE PRECISION NOT NULL,
      unit_price_usd DOUBLE PRECISION NOT NULL,
      sol_price_usd DOUBLE PRECISION,
      fee_usd DOUBLE PRECISION DEFAULT 0,
      source VARCHAR(32),
      status VARCHAR(16) DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'failed', 'pending')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS trade_lots_mint_idx ON trade_lots(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS trade_lots_timestamp_idx ON trade_lots(timestamp DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS trade_lots_side_idx ON trade_lots(side);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS trade_lots_tx_sig_idx ON trade_lots(tx_sig);`);

  // Position lots: tracks remaining quantity from each buy lot (for FIFO matching)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS position_lots (
      id bigserial PRIMARY KEY,
      lot_id uuid REFERENCES trade_lots(lot_id) ON DELETE CASCADE,
      mint VARCHAR(64) NOT NULL,
      original_qty DOUBLE PRECISION NOT NULL,
      remaining_qty DOUBLE PRECISION NOT NULL,
      cost_basis_usd DOUBLE PRECISION NOT NULL,
      unit_cost_usd DOUBLE PRECISION NOT NULL,
      entry_timestamp TIMESTAMPTZ NOT NULL,
      last_matched_at TIMESTAMPTZ,
      is_closed BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS position_lots_mint_idx ON position_lots(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS position_lots_open_idx ON position_lots(mint, is_closed) WHERE is_closed = false;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS position_lots_entry_idx ON position_lots(entry_timestamp);`);

  // PnL events: realized PnL from closing positions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pnl_events (
      id bigserial PRIMARY KEY,
      event_id uuid DEFAULT gen_random_uuid() UNIQUE NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mint VARCHAR(64) NOT NULL,
      symbol VARCHAR(32),
      event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('realized_gain', 'realized_loss', 'dust_writeoff', 'fee', 'partial_exit_remaining')),
      sell_lot_id uuid REFERENCES trade_lots(lot_id),
      buy_lot_id uuid REFERENCES trade_lots(lot_id),
      quantity DOUBLE PRECISION NOT NULL,
      proceeds_usd DOUBLE PRECISION NOT NULL,
      cost_basis_usd DOUBLE PRECISION NOT NULL,
      realized_pnl_usd DOUBLE PRECISION NOT NULL,
      fee_usd DOUBLE PRECISION DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_events_mint_idx ON pnl_events(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_events_timestamp_idx ON pnl_events(timestamp DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pnl_events_type_idx ON pnl_events(event_type);`);

  // Daily position snapshots: unrealized PnL tracking over time
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_position_snapshots (
      id bigserial PRIMARY KEY,
      snapshot_date DATE NOT NULL,
      mint VARCHAR(64) NOT NULL,
      symbol VARCHAR(32),
      quantity DOUBLE PRECISION NOT NULL,
      cost_basis_usd DOUBLE PRECISION NOT NULL,
      market_value_usd DOUBLE PRECISION NOT NULL,
      unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
      price_usd DOUBLE PRECISION,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(snapshot_date, mint)
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS daily_snapshots_date_idx ON daily_position_snapshots(snapshot_date DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS daily_snapshots_mint_idx ON daily_position_snapshots(mint);`);

  // Config history: track configuration changes over time
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_config_history (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT NOW(),
      change_source VARCHAR(64) NOT NULL,
      config_snapshot jsonb NOT NULL,
      changed_fields jsonb
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS bot_config_history_ts_idx ON bot_config_history(ts DESC);`);

  // Extend reconciled_trades with USD snapshot fields
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS usd_in DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS usd_out DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS sol_price_usd DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS fee_usd DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS price_source VARCHAR(32);`);
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS side VARCHAR(4);`);
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS entry_price_usd DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE reconciled_trades ADD COLUMN IF NOT EXISTS lot_processed BOOLEAN DEFAULT false;`);

  // Position decisions: complete trade decision ledger for lifecycle tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS position_decisions (
      id bigserial PRIMARY KEY,
      decision_id uuid DEFAULT gen_random_uuid() UNIQUE NOT NULL,
      ts timestamptz NOT NULL DEFAULT NOW(),
      mint VARCHAR(64) NOT NULL,
      symbol VARCHAR(32),
      action_type VARCHAR(16) NOT NULL CHECK (action_type IN ('enter', 'add', 'trim', 'exit', 'rebalance')),
      reason_code VARCHAR(64) NOT NULL,
      reason_detail TEXT,
      triggered_by VARCHAR(32),
      tx_sig VARCHAR(128),
      qty_before DOUBLE PRECISION,
      qty_after DOUBLE PRECISION,
      qty_delta DOUBLE PRECISION,
      usd_value_before DOUBLE PRECISION,
      usd_value_after DOUBLE PRECISION,
      target_pct_before DOUBLE PRECISION,
      target_pct_after DOUBLE PRECISION,
      confidence_score DOUBLE PRECISION,
      ticks_observed INTEGER,
      signal_snapshot jsonb,
      journey_id VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS position_decisions_ts_idx ON position_decisions(ts DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS position_decisions_mint_idx ON position_decisions(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS position_decisions_action_idx ON position_decisions(action_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS position_decisions_reason_idx ON position_decisions(reason_code);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS position_decisions_journey_idx ON position_decisions(journey_id);`);

  // Add decision_id FK to trade_lots for correlation
  await pool.query(`ALTER TABLE trade_lots ADD COLUMN IF NOT EXISTS decision_id uuid;`);

  // Watch candidates: tracks tokens that failed INSUFFICIENT_BARS for re-evaluation
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watch_candidates (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      first_seen_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_bar_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watch_candidates_first_seen ON watch_candidates(first_seen_ts);`);

  // Allocation events: tracks execution feedback for allocation gap diagnostics
  await pool.query(`
    CREATE TABLE IF NOT EXISTS allocation_events (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      symbol VARCHAR(32) NOT NULL,
      mint VARCHAR(64) NOT NULL,
      side VARCHAR(8) NOT NULL,
      raw_target_pct DECIMAL(10,6),
      scaled_target_pct DECIMAL(10,6),
      current_pct DECIMAL(10,6),
      desired_usd DECIMAL(16,4),
      planned_usd DECIMAL(16,4),
      executed_usd DECIMAL(16,4),
      outcome VARCHAR(32) NOT NULL,
      reason TEXT,
      tx_sig VARCHAR(128),
      fee_max_lamports BIGINT,
      fee_paid_lamports BIGINT,
      binding_constraint VARCHAR(64)
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS allocation_events_ts_idx ON allocation_events(ts DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS allocation_events_mint_idx ON allocation_events(mint);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS allocation_events_outcome_idx ON allocation_events(outcome);`);

  // Health check for allocation_events table
  const allocEventsCheck = await pool.query(`SELECT COUNT(*) FROM allocation_events LIMIT 1`);
  logger.info({ table: 'allocation_events', rowCount: allocEventsCheck.rows[0]?.count ?? 0 }, "ALLOCATION_EVENTS_TABLE: Health check passed");

  logger.info("DB initialized with all tables");
}

// CLI entry point for running init-db standalone
async function main() {
  await initializeDatabase();
  await pool.end();
}

// Only run as CLI if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
