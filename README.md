# Solana Trading Bot

An autonomous multi-asset trading bot for Solana. The bot discovers tokens, manages a portfolio of scout and core positions, and executes trades via Jupiter swaps. Includes a password-protected web dashboard for monitoring and control.

## Features

### Autonomous Trading
- Multi-asset portfolio management with scout/core slot hierarchy
- Smart entry filtering using SMA-based trend analysis
- Regime-based signal trading (trend vs range detection)
- Automatic token discovery via DexScreener scanner
- Re-entry logic after take-profit exits

### Risk Management
- Exit liquidity validation before sells
- Rug defense mechanisms
- Capital preservation with emergency exit-to-stables
- Automatic market re-entry when conditions improve
- Circuit breakers for daily drawdown and turnover limits
- Concentration limits to prevent over-allocation

### Web Dashboard
- Password-protected access
- Real-time status display (running/paused)
- Wallet balance monitoring
- Portfolio allocation overview
- Pause/resume controls
- Trade history with Solscan transaction links
- Settings management with live updates
- Universe and opportunities tabs

### Metrics & Auditability
- All trades recorded to PostgreSQL database
- Structured JSON logging via Pino
- PnL tracking per position
- Transaction signatures for on-chain verification

## Project Structure

```
src/
  bot/
    index.ts          # Main entry point + schedulers
    config.ts         # Environment configuration
    solana.ts         # Solana connection + transactions
    jupiter.ts        # Jupiter swap integration
    strategy.ts       # Trading logic + signals
    scanner.ts        # Token discovery via DexScreener
    portfolio.ts      # Portfolio management
    risk.ts           # Risk checks + circuit breakers
    db.ts             # PostgreSQL database client
    state.ts          # Bot state management
  dashboard/
    server.ts         # Express web dashboard
  sniper/
    index.ts          # Token sniper module
  utils/
    logger.ts         # Pino structured logging
    sleep.ts          # Retry + sleep utilities
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | Solana RPC endpoint (Helius recommended) |
| `BOT_WALLET_PRIVATE_KEY` | Base58 encoded wallet keypair |
| `DATABASE_URL` | PostgreSQL connection string |
| `DASHBOARD_PASSWORD` | Password for dashboard login |
| `SESSION_SECRET` | Secret for session encryption |

### Optional (with defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_SLIPPAGE_BPS` | `150` | Max slippage in basis points |
| `MAX_SINGLE_SWAP_SOL` | `3` | Max SOL per swap |
| `MIN_SOL_BALANCE` | `0.05` | Minimum SOL to keep for fees |
| `LOOP_SECONDS` | `60` | Main loop interval in seconds |
| `SCANNER_MIN_LIQUIDITY` | `10000` | Minimum USD liquidity for token discovery |
| `SCANNER_MIN_VOLUME_24H` | `5000` | Minimum 24h volume for token discovery |

## NPM Scripts

```bash
npm run bot       # Start the bot + dashboard
npm run init-db   # Initialize database tables
npm run build     # No-op (uses tsx for direct TypeScript execution)
```

## Safety Features

- Pauses automatically if SOL balance drops below minimum
- Daily drawdown circuit breaker (default 7%)
- Daily turnover limit to prevent overtrading
- Exit liquidity checks before selling
- Rug defense: detects and exits suspicious tokens
- Rate limits RPC calls to avoid throttling
- Structured error logging for debugging
- Graceful shutdown on SIGINT/SIGTERM

## Dashboard Access

1. Navigate to the deployed URL
2. Enter the password set in `DASHBOARD_PASSWORD`
3. View real-time status, balances, and trade history
4. Use Pause/Resume buttons to control bot operation
5. Manage universe tokens and review scanner opportunities
6. Adjust settings via the Settings tab

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript (tsx)
- **Blockchain**: @solana/web3.js, @solana/spl-token
- **Swaps**: Jupiter Aggregator API
- **Database**: PostgreSQL (Neon)
- **Web Server**: Express.js
- **Logging**: Pino (structured JSON)
- **Scheduling**: node-cron

## Deployment

Configured for Replit VM deployment (always-on). The bot runs continuously with scheduled tasks for:
- Trading loop (configurable interval, default 60s)
- Market scanning every 30 minutes
- Heartbeat logging every 5 minutes

## Disclaimer

This bot interacts with mainnet Solana and executes real token swaps. Use at your own risk. Always:
- Start with small amounts
- Monitor the dashboard regularly
- Keep the wallet funded with enough SOL for transaction fees
