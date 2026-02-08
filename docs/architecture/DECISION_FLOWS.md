# Decision Flow Diagrams

**Generated:** 2026-01-25
**Git Commit:** 79e1e27

## Exit Decision Priority

The system evaluates positions in a strict priority order. Higher-priority exits are processed first.

```mermaid
flowchart TD
    START[Evaluate Position] --> P1{Scout Stop Loss?<br/>pnlPct <= -scoutStopLossPct}
    
    P1 -->|Yes| EXIT1[EXIT: scout_stop_loss_exit<br/>Priority 1 - Immediate]
    P1 -->|No| P2{Core Loss Exit?<br/>pnlPct <= -lossExitPct}
    
    P2 -->|Yes| EXIT2[EXIT: core_loss_exit<br/>Priority 2 - Immediate]
    P2 -->|No| P3{Scout Grace Expired?<br/>underperforming + grace elapsed}
    
    P3 -->|Yes| EXIT3[EXIT: scout_underperform_grace_expired<br/>Priority 3 - Timed]
    P3 -->|No| P4{Trailing Stop Triggered?<br/>price dropped from peak}
    
    P4 -->|Yes| EXIT4[EXIT: trailing_stop<br/>Priority 4]
    P4 -->|No| P5{Stale Position?<br/>held > staleExitHours}
    
    P5 -->|Yes| EXIT5[EXIT: stale_exit<br/>Priority 5]
    P5 -->|No| P6{Rotation Candidate?<br/>rank < threshold}
    
    P6 -->|Yes| ROT[ROTATION<br/>Priority 6]
    P6 -->|No| HOLD[HOLD Position]
```

## Scout Underperformance Flow

```mermaid
flowchart TD
    SCOUT[Scout Position] --> CHECK{PnL < 0?}
    
    CHECK -->|No| RESET[Reset underperform timer]
    CHECK -->|Yes| TIMER{Minutes held with<br/>negative PnL?}
    
    TIMER -->|< scoutUnderperformMinutes| WAIT[Continue monitoring]
    TIMER -->|>= scoutUnderperformMinutes| FLAG[Flag: scoutUnderperforming = true]
    
    FLAG --> GRACE{Grace period<br/>elapsed?}
    
    GRACE -->|< scoutGraceMinutes| GRACE_WAIT[Grace period active<br/>Position still held]
    GRACE -->|>= scoutGraceMinutes| EXPIRE[Flag: scoutGraceExpired = true]
    
    EXPIRE --> EXIT[EXIT: scout_underperform_grace_expired]
```

## Scout Entry Gating Flow (Volatility Scraper)

Entry gating prevents chasing pumps and requires pullbacks after impulse moves.

```mermaid
flowchart TD
    START[Scout Candidate<br/>from queue] --> FETCH[Fetch price bars<br/>from prices table]
    
    FETCH --> RET15{ret15 < scoutChaseRet15Max?<br/>Default: 25%}
    
    RET15 -->|No| REJECT1[REJECT: Chasing pump<br/>Token up >25% in 15m]
    RET15 -->|Yes| IMPULSE{ret15 > scoutImpulseRet15Min?<br/>Default: 10%}
    
    IMPULSE -->|No| PULLBACK_SKIP[Skip pullback check<br/>No impulse detected]
    IMPULSE -->|Yes| PULLBACK{Pullback from 15m high<br/>>= scoutPullbackFromHigh15Min?<br/>Default: 8%}
    
    PULLBACK -->|No| REJECT2[REJECT: No pullback<br/>Still at impulse highs]
    PULLBACK -->|Yes| SMA_REQ{scoutEntryRequireAboveSma?}
    
    PULLBACK_SKIP --> SMA_REQ
    
    SMA_REQ -->|No| APPROVE[APPROVE: Proceed with buy]
    SMA_REQ -->|Yes| SMA_CHECK{Price > SMA?<br/>scoutEntrySmaMinutes: 30}
    
    SMA_CHECK -->|No| REJECT3[REJECT: Below SMA<br/>Downtrend filter]
    SMA_CHECK -->|Yes| APPROVE
    
    APPROVE --> LOG[Log SCOUT_ENTRY_EVAL<br/>pass=true]
    REJECT1 --> LOG_FAIL1[Log SCOUT_ENTRY_EVAL<br/>failReason=CHASING_PUMP]
    REJECT2 --> LOG_FAIL2[Log SCOUT_ENTRY_EVAL<br/>failReason=NO_PULLBACK]
    REJECT3 --> LOG_FAIL3[Log SCOUT_ENTRY_EVAL<br/>failReason=BELOW_SMA]
```

## Position Ranking Score Calculation

```mermaid
flowchart LR
    subgraph "Input Factors"
        SIG[Signal Score<br/>Weight: 3x]
        MOM[Momentum Score<br/>Weight: 2x]
        TRAIL[Trailing Performance<br/>Weight: 2.5x]
        FRESH[Freshness<br/>Weight: 1.5x]
        QUAL[Quality Metrics<br/>Weight: 1x]
        DECAY[Time Decay<br/>Weight: 1x]
    end
    
    subgraph "Penalties"
        STALE_PEN[Stale Penalty<br/>-2 points]
        TRAIL_PEN[Trailing Stop Penalty<br/>-10 points]
    end
    
    subgraph "Calculation"
        CALC[Weighted Sum<br/>+ Penalties]
    end
    
    SIG --> CALC
    MOM --> CALC
    TRAIL --> CALC
    FRESH --> CALC
    QUAL --> CALC
    DECAY --> CALC
    STALE_PEN --> CALC
    TRAIL_PEN --> CALC
    
    CALC --> SCORE[Final Rank Score]
```

## Promotion Decision Flow (Continuation-Only)

Promotions require continuation confirmation via price metrics to avoid buying at tops.
Take-profit always triggers full exit (never promotes) - TP acts as "cash register".

```mermaid
flowchart TD
    SCOUT[Scout Position] --> CORE_AVAIL{Core slot<br/>available?}
    
    CORE_AVAIL -->|No| NO_PROMO[No promotion<br/>Core slots full]
    CORE_AVAIL -->|Yes| PNL_CHECK{PnL >= promotionMinPnlPct?<br/>Default: 20%}
    
    PNL_CHECK -->|No| NO_PROMO2[No promotion<br/>Insufficient gains]
    PNL_CHECK -->|Yes| SIG_CHECK{Signal >= promotionMinSignalScore?<br/>Default: 1.0}
    
    SIG_CHECK -->|No| NO_PROMO3[No promotion<br/>Weak signal]
    SIG_CHECK -->|Yes| TIME_CHECK{Hours held >= promotionMinHoursHeld?<br/>Default: 1 hour}
    
    TIME_CHECK -->|No| NO_PROMO4[No promotion<br/>Too recent]
    TIME_CHECK -->|Yes| FIFO_CHECK{hasFifoDiscrepancy?}
    
    FIFO_CHECK -->|Yes| NO_PROMO5[No promotion<br/>Cost basis issue]
    FIFO_CHECK -->|No| CONT[Continuation Filters<br/>evaluatePromotionWithContinuation]
    
    subgraph "Continuation Filters (async)"
        CONT --> RET60{ret60 >= promotionRequireRet60Min?<br/>Default: 10%}
        RET60 -->|No| CONT_FAIL1[FAIL: ret60_too_low]
        RET60 -->|Yes| RET15{ret15 >= promotionRequireRet15Min?<br/>Default: 0%}
        
        RET15 -->|No| CONT_FAIL2[FAIL: ret15_negative]
        RET15 -->|Yes| DRAWDOWN{drawdown30 >= promotionAvoidTopDrawdown30?<br/>Default: 3% pullback from 30m high}
        
        DRAWDOWN -->|No| CONT_FAIL3[FAIL: at_30m_high_no_pullback]
        DRAWDOWN -->|Yes| SMA_REQ{promotionRequireAboveSma?}
        
        SMA_REQ -->|No| CONT_PASS[PASS Continuation]
        SMA_REQ -->|Yes| SMA_CHECK{Price > SMA?<br/>promotionSmaMinutes: 60}
        
        SMA_CHECK -->|No| CONT_FAIL4[FAIL: below_sma60]
        SMA_CHECK -->|Yes| CONT_PASS
    end
    
    CONT_PASS --> PROMOTE[PROMOTE to Core]
    CONT_FAIL1 --> LOG_FAIL[Log PROMO_EVAL<br/>with metrics + failReason]
    CONT_FAIL2 --> LOG_FAIL
    CONT_FAIL3 --> LOG_FAIL
    CONT_FAIL4 --> LOG_FAIL
    PROMOTE --> LOG_PASS[Log PROMO_EVAL<br/>pass=true with metrics]
```

## Scout Take-Profit Flow (Full Exit Only)

```mermaid
flowchart TD
    TP_CHECK[Scout TP Triggered<br/>pnlPct >= scoutTakeProfitPct] --> HELD{Minutes held >=<br/>scoutTpMinHoldMinutes?}
    
    HELD -->|No| SKIP[Skip: Too early<br/>Minimum hold not met]
    HELD -->|Yes| LOG_TRIGGER[Log SCOUT_TP_TRIGGER<br/>mint, pnlPct, minutesHeld]
    
    LOG_TRIGGER --> EXIT[Execute FULL EXIT<br/>closePosition with 100% qty]
    
    EXIT --> LOG_EXIT[Log SCOUT_TP_EXIT<br/>reason: volatility_harvest]
    
    %% Note: TP never promotes - TP acts as "cash register"
```

## Rotation Decision Flow

```mermaid
flowchart TD
    EVAL[Evaluate Portfolio] --> RANK[Rank all positions]
    
    RANK --> BOTTOM{Bottom ranked<br/>position?}
    
    BOTTOM --> COMPARE{Compare to<br/>best candidate}
    
    COMPARE --> THRESH{Score delta ><br/>rotationThreshold?}
    
    THRESH -->|No| NO_ROT[No rotation<br/>Current holdings optimal]
    THRESH -->|Yes| SELL[SELL bottom position]
    
    SELL --> BUY[BUY better candidate]
    BUY --> UPDATE[Update slots]
```

## Trade Execution Flow

```mermaid
flowchart TD
    DECISION[Trade Decision] --> TYPE{Trade Type?}
    
    TYPE -->|Sell| SELL_FLOW[Sell Flow]
    TYPE -->|Buy| BUY_FLOW[Buy Flow]
    
    SELL_FLOW --> GET_BAL[Get token balance]
    GET_BAL --> QUOTE_S[Get Jupiter quote]
    QUOTE_S --> SLIPPAGE_S{Slippage OK?}
    
    SLIPPAGE_S -->|No| ABORT_S[Abort: High slippage]
    SLIPPAGE_S -->|Yes| EXEC_S[Execute swap]
    
    EXEC_S --> CONFIRM_S{Confirmed?}
    CONFIRM_S -->|No| RETRY_S[Retry logic]
    CONFIRM_S -->|Yes| RECORD_S[Record sale<br/>Update FIFO lots]
    
    BUY_FLOW --> SIZE[Calculate position size]
    SIZE --> RESERVE{SOL reserve OK?}
    
    RESERVE -->|No| ABORT_B[Abort: Low reserve]
    RESERVE -->|Yes| QUOTE_B[Get Jupiter quote]
    
    QUOTE_B --> IMPACT{Price impact OK?}
    IMPACT -->|No| ABORT_I[Abort: High impact]
    IMPACT -->|Yes| EXEC_B[Execute swap]
    
    EXEC_B --> CONFIRM_B{Confirmed?}
    CONFIRM_B -->|No| RETRY_B[Retry logic]
    CONFIRM_B -->|Yes| RECORD_B[Record purchase<br/>Create FIFO lot]
```

## Whale Signal Flow

```mermaid
flowchart TD
    POLL[Poll Helius API] --> TXNS[Get recent transactions]
    
    TXNS --> FILTER{Transaction ><br/>whaleMinUsd?}
    
    FILTER -->|No| IGNORE[Ignore small txn]
    FILTER -->|Yes| AGGREGATE[Aggregate by token]
    
    AGGREGATE --> NETFLOW{Net flow ><br/>whaleNetflowTriggerUsd?}
    
    NETFLOW -->|No| MONITOR[Continue monitoring]
    NETFLOW -->|Yes| COOLDOWN{Cooldown<br/>elapsed?}
    
    COOLDOWN -->|No| SKIP[Skip: Recent signal]
    COOLDOWN -->|Yes| MARKET{Market confirms?<br/>Price up marketConfirmPct%}
    
    MARKET -->|No| QUEUE_LOW[Queue with low priority]
    MARKET -->|Yes| SIGNAL[WHALE SIGNAL<br/>High priority entry]
```

## Configuration Thresholds Reference

| Setting | Default | Description |
|---------|---------|-------------|
| scoutStopLossPct | 0.50 (50%) | Scout immediate exit threshold |
| lossExitPct | 0.15 (15%) | Core forced exit threshold |
| scoutUnderperformMinutes | 30 | Minutes negative before flagging |
| scoutGraceMinutes | 10 | Grace period after flagging |
| stalePnlBandPct | 0.05 (5%) | PnL band for "stuck" detection |
| stalePositionHours | 48 | Hours before stale flag |
| staleExitHours | 72 | Hours before forced stale exit |
| trailingStopBasePct | 0.30 (30%) | Base trailing stop distance |
| trailingStopTightPct | 0.12 (12%) | Tight stop for profitable |
| trailingStopProfitThreshold | 0.50 (50%) | When to tighten stop |
| rotationThreshold | 1.5 | Minimum score delta for rotation |
| promotionMinPnlPct | 0.20 (20%) | Min PnL for promotion |
| promotionMinSignalScore | 1.0 | Min signal for promotion |
| promotionMinHoursHeld | 2 | Min hours for promotion |
| promotionDelayMinutes | 15 | Delay after purchase |
