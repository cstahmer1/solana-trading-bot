# Trading Bot Workflow

## Token Lifecycle

```
Scanner Discovery → Queue → Scout Buy (small) → Hold/Monitor → Promote to Core → Full Allocation
```

**IMPORTANT**: New tokens MUST enter as scouts first. The regime/rotation system only allocates to tokens already in the portfolio.

---

## 1. Token Discovery

### Market Scanner
The bot continuously scans multiple sources for opportunities:
- Jupiter trending tokens
- DexScreener trending and new listings
- Solscan token metadata

### Scoring
Each discovered token receives a score based on:
- Trading volume
- Holder count
- Price momentum
- Liquidity depth
- Verification status

High-scoring tokens (score >= 10) become candidates for entry.

---

## 2. Entry Paths

### Path A: Manual Add
1. User sees token in Scanner tab
2. User clicks "Add to Universe"
3. Token enters as scout slot
4. Bot evaluates on next tick

### Path B: Autonomous Scout (if enabled)
1. Scanner finds high-scoring token
2. Token auto-added to scout queue
3. Queue worker processes entry
4. If whale confirmation enabled: check whale netflow first
5. Small position bought automatically
6. Token enters scout slot

---

## 3. Position Management

### Scout Positions (Small, Exploratory)
- Start with small allocation (~3% of portfolio, capped at `scoutPositionPct`)
- Monitored for promotion potential
- Subject to same exit rules as core positions
- **Regime buys capped**: Even if signal score suggests 40%, scouts only get 3%

### Core Positions (Primary Holdings)
- Larger allocation (~12% target, up to 40% max via `maxPositionPctPerAsset`)
- Promoted from successful scouts only
- Primary focus of trading activity
- **Full allocation unlocked**: After promotion, regime system can allocate to full targetPct

---

## 4. Ranking System

Every tick, all positions and candidates are ranked on the same scale:

```
Rank Score = Signal + Momentum + Freshness + Quality - Penalties
```

Components:
- **Signal**: Current trading signal strength
- **Momentum**: Unrealized PnL trajectory
- **Freshness**: How recent the signal is
- **Quality**: Token fundamentals
- **Penalties**: Staleness, near trailing stop

---

## 5. Promotion Flow

```
Scout → Core Promotion
```

A scout gets promoted to core when:
1. Position gain >= 20%
2. In trend regime (not range)
3. Signal score >= 1.0
4. Held for >= 2 hours

This filters out flash pumps and identifies sustainable winners.

### Whale Confirmation (Optional)
When `whaleConfirmEnabled` is true, promotions require whale flow confirmation:
1. Bot queries Helius for recent whale transactions
2. Calculates net whale inflow/outflow
3. Promotion blocked if netflow < threshold (unless dry run mode)
4. Cooldown prevents repeated checks on same token

---

## 6. Exit Paths

### Exit A: Take Profit
- Position reaches take profit threshold
- Entire position sold
- Token tracked for potential re-entry

### Exit B: Trailing Stop
- Price drops from peak beyond threshold
- Base: 30% drop triggers exit
- Winners (50%+ profit): Tightened to 12% drop
- Protects gains while allowing room to run

### Exit C: Stale Exit
- Position flat for too long
- Warning after 48 hours (ranking penalty)
- Force exit after 72 hours if |PnL| < 5%
- Frees capital from stagnant positions

### Exit D: Rotation
- Better opportunity found in scanner
- Worst position compared to best candidate
- If candidate ranks significantly higher (1.5+ delta)
- Sell worst, buy best

### Exit E: Flash Close (Manual)
- User clicks Flash Close button
- Immediate market sell
- No confirmation needed after initial dialog
- Emergency exit option

---

## 7. Re-Entry Logic

After a take-profit exit:
1. Token tracked for 30 minutes
2. If price holds and momentum continues
3. Bot may re-enter with larger position
4. Only if trend regime and positive signal

---

## 8. Rotation Decision Flow

```
Every Tick:
├─ Rank all held positions
├─ Rank all scanner candidates
├─ Compare worst held vs best candidate
├─ If candidate ranks 1.5+ higher:
│   ├─ Sell worst position
│   └─ Buy candidate
└─ Otherwise: Hold current positions
```

---

## 9. Slot Management

```
Total Slots = Core Slots + Scout Slots
            = 5 + 10 = 15 max positions

Core Slots:  [■][■][■][■][■]         (5 primary positions, up to 40% each)
Scout Slots: [□][□][□][□][□][□][□][□][□][□]  (10 exploratory, max 3% each)
```

When scout promotes to core:
- Scout slot freed
- Core slot filled
- Allocation cap increases from 3% to full targetPct

---

## 10. Capital Deployment Safeguards

### Why New Tokens Can't Get Full Allocation Immediately
The regime/signal system calculates optimal targetPct for all tokens, but:
1. **New tokens are unproven** - They haven't demonstrated they can hold value
2. **Prevents instant capital deployment** - Depositing SOL shouldn't immediately buy max positions
3. **Gradual scaling** - Tokens must prove themselves before receiving larger allocations

### How It Works
```
Scanner finds TRUMP with 40% targetPct
        ↓
Regime loop checks: Is TRUMP in portfolio?
        ↓
NO → Skip (must enter via scout system first)
        ↓
If autonomousScoutsEnabled: Enter queue → Small scout buy (0.02 SOL)
        ↓
Prove itself: PnL >= 20%, held >= 2hr, signal >= 1.0
        ↓
Promote to Core → Now regime loop can allocate toward 40%
```

### SOL Reserve Protection
- All buys capped by `capBuyToReserve()` to never deplete below `minSolReserve` + fee buffer
- Low SOL mode: If SOL <= 0.11, all trading skipped until topped up
- Prevents being unable to afford transaction fees for future sells

---

## 11. Complete Flow Example

```
1. Scanner finds PUMP token (score: 12)
   ↓
2. Auto-queued as scout candidate
   ↓
3. Queue worker buys 0.02 SOL worth
   ↓
4. PUMP enters scout slot at 3% allocation
   ↓
5. Next 2 hours: Price rises 25%
   ↓
6. Promotion check passes:
   - Gain: 25% ✓
   - Regime: trend ✓
   - Signal: 1.5 ✓
   - Time held: 2.1 hours ✓
   ↓
7. PUMP promoted to core slot at 12% allocation
   ↓
8. Price continues rising, trailing stop tracks peak
   ↓
9. Price drops 15% from peak
   ↓
10. Trailing stop triggered (was tightened to 12% for winners)
    ↓
11. Position sold, PnL recorded
    ↓
12. Token removed from universe (or tracked for re-entry)
```

---

## Quick Reference: Exit Reasons

| Code | Trigger | Action |
|------|---------|--------|
| `take_profit` | Hit profit target | Sell all, track for re-entry |
| `trailing_stop_exit` | Dropped from peak | Sell all |
| `stale_timeout_exit` | 72h flat | Sell all |
| `opportunity_cost_rotation` | Better candidate found | Swap positions |
| `concentration_rebalance` | Too concentrated | Trim largest |
| `flash_close` | Manual emergency | Sell all immediately |
| `reentry_momentum` | Re-entered after take profit | New position |
