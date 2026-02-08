import * as fs from 'fs';
import * as path from 'path';
import { getCSTDate } from '../utils/timezone';
import { getConfigHash } from './runtime_config.js';

const LOGS_DIR = 'logs';

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export enum EventType {
  SCAN_OPPORTUNITY = 'SCAN_OPPORTUNITY',
  QUEUE_DECISION = 'QUEUE_DECISION',
  TRADE_ENTRY = 'TRADE_ENTRY',
  TRADE_EXIT = 'TRADE_EXIT',
  SIGNAL_SNAPSHOT = 'SIGNAL_SNAPSHOT',
  PROMOTION = 'PROMOTION',
  EXIT_DECISION = 'EXIT_DECISION',
  SCOUT_TP_TRIGGER = 'SCOUT_TP_TRIGGER',
  SCOUT_TP_PROMOTE = 'SCOUT_TP_PROMOTE',
  SCOUT_TP_EXIT = 'SCOUT_TP_EXIT',
}

interface BaseEvent {
  event_id: string;
  journey_id: string;
  timestamp: string;
  event_type: EventType;
  mint: string;
  symbol: string;
}

export interface ScannerConfigSnapshot {
  minLiquidity: number;
  minVolume24h: number;
  minHolders: number;
  maxPriceChange24h: number;
  minPriceChange24h: number;
}

export interface ScanOpportunityEvent extends BaseEvent {
  event_type: EventType.SCAN_OPPORTUNITY;
  score: number;
  reasons: string[];
  price: number;
  volume24h: number;
  liquidity: number;
  holders: number;
  priceChange24h: number;
  source: string;
  scanner_config_snapshot: ScannerConfigSnapshot;
}

export interface QueueConfigSnapshot {
  autonomousScoutsEnabled: boolean;
  scoutAutoQueueScore: number;
  scoutDailyLimit: number;
  scoutBuySol: number;
}

export interface SignalReadiness {
  bar_count: number;
  has_full_history: boolean;
}

export interface ExistingQueueItem {
  status: string;
  ageMin: number;
  inProgressAgeMin: number | null;
  attempts: number;
  nextAttemptAt: Date | null;
}

export interface QueueDecisionEvent extends BaseEvent {
  event_type: EventType.QUEUE_DECISION;
  decision: 'queued' | 'skipped';
  reason: string;
  signal_readiness: SignalReadiness;
  config_snapshot: QueueConfigSnapshot;
  existing_queue_item?: ExistingQueueItem;
}

export interface SignalSnapshot {
  score: number;
  regime: 'trend' | 'range';
  bar_count: number;
  features: Record<string, number>;
}

export interface TradeEntryEvent extends BaseEvent {
  event_type: EventType.TRADE_ENTRY;
  side: 'buy';
  decision_price_usd: number;
  execution_price_usd: number;
  slippage_bps: number;
  amount_sol: number;
  signal_snapshot: SignalSnapshot | null;
  reason: string;
  mode: 'live' | 'paper';
}

export type TriggerReason = 
  | 'scout_stop_loss' 
  | 'take_profit' 
  | 'trailing_stop' 
  | 'stale_exit' 
  | 'rotation' 
  | 'concentration_rebalance'
  | 'core_loss_exit'
  | 'scout_underperform'
  | 'regime_rebalance'
  | 'scout_take_profit_exit'
  | 'scout_take_profit'
  | 'flash_close'
  | 'universe_exit';

export interface TradeExitEvent extends BaseEvent {
  event_type: EventType.TRADE_EXIT;
  side: 'sell';
  decision_price_usd: number;
  execution_price_usd: number;
  slippage_bps: number;
  realized_pnl_usd: number;
  realized_pnl_pct: number;
  holding_minutes: number;
  trigger_reason: TriggerReason;
  signal_snapshot: SignalSnapshot | null;
  mode: 'live' | 'paper';
}

export interface SignalSnapshotEvent extends BaseEvent {
  event_type: EventType.SIGNAL_SNAPSHOT;
  signal_score: number;
  regime: 'trend' | 'range';
  bar_count: number;
  features: Record<string, number>;
  current_price: number;
}

export interface PromotionCriteriaSnapshot {
  promotionMinPnlPct: number;
  promotionMinSignalScore: number;
  promotionDelayMinutes: number;
}

export interface PromotionEvent extends BaseEvent {
  event_type: EventType.PROMOTION;
  old_slot_type: 'scout' | 'core';
  new_slot_type: 'scout' | 'core';
  pnl_pct: number;
  signal_score: number | null;
  held_minutes: number;
  criteria_snapshot: PromotionCriteriaSnapshot;
}

export type LLMEvent = 
  | ScanOpportunityEvent 
  | QueueDecisionEvent 
  | TradeEntryEvent 
  | TradeExitEvent 
  | SignalSnapshotEvent 
  | PromotionEvent
  | ExitDecisionBreadcrumb
  | ScoutTpTriggerEvent
  | ScoutTpPromoteEvent
  | ScoutTpExitEvent;

const journeyIdMap: Map<string, string> = new Map();

export function generateJourneyId(mint: string): string {
  return `${mint}:${Date.now()}`;
}

export function getOrCreateJourneyId(mint: string): string {
  let journeyId = journeyIdMap.get(mint);
  if (!journeyId) {
    journeyId = generateJourneyId(mint);
    journeyIdMap.set(mint, journeyId);
  }
  return journeyId;
}

export function getJourneyId(mint: string): string | undefined {
  return journeyIdMap.get(mint);
}

export function setJourneyId(mint: string, journeyId: string): void {
  journeyIdMap.set(mint, journeyId);
}

export function clearJourneyId(mint: string): void {
  journeyIdMap.delete(mint);
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getEventLogFilename(): string {
  const date = getCSTDate();
  const dateStr = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  return path.join(LOGS_DIR, `events_${dateStr}.jsonl`);
}

function appendToFile(filename: string, data: any): void {
  try {
    const line = JSON.stringify(data) + '\n';
    fs.appendFileSync(filename, line, 'utf8');
  } catch (err) {
    console.error(`Failed to write to ${filename}:`, err);
  }
}

export function logEvent(event: LLMEvent): void {
  appendToFile(getEventLogFilename(), event);
}

export function logScanOpportunity(params: {
  mint: string;
  symbol: string;
  score: number;
  reasons: string[];
  price: number;
  volume24h: number;
  liquidity: number;
  holders: number;
  priceChange24h: number;
  source: string;
  scanner_config_snapshot: ScannerConfigSnapshot;
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: ScanOpportunityEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.SCAN_OPPORTUNITY,
    mint: params.mint,
    symbol: params.symbol,
    score: params.score,
    reasons: params.reasons,
    price: params.price,
    volume24h: params.volume24h,
    liquidity: params.liquidity,
    holders: params.holders,
    priceChange24h: params.priceChange24h,
    source: params.source,
    scanner_config_snapshot: params.scanner_config_snapshot,
  };
  
  logEvent(event);
}

export function logQueueDecision(params: {
  mint: string;
  symbol: string;
  decision: 'queued' | 'skipped';
  reason: string;
  signal_readiness: SignalReadiness;
  config_snapshot: QueueConfigSnapshot;
  existing_queue_item?: ExistingQueueItem;
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: QueueDecisionEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.QUEUE_DECISION,
    mint: params.mint,
    symbol: params.symbol,
    decision: params.decision,
    reason: params.reason,
    signal_readiness: params.signal_readiness,
    config_snapshot: params.config_snapshot,
    existing_queue_item: params.existing_queue_item,
  };
  
  logEvent(event);
}

export function logTradeEntry(params: {
  mint: string;
  symbol: string;
  decision_price_usd: number;
  execution_price_usd: number;
  slippage_bps: number;
  amount_sol: number;
  signal_snapshot: SignalSnapshot | null;
  reason: string;
  mode: 'live' | 'paper';
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: TradeEntryEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.TRADE_ENTRY,
    mint: params.mint,
    symbol: params.symbol,
    side: 'buy',
    decision_price_usd: params.decision_price_usd,
    execution_price_usd: params.execution_price_usd,
    slippage_bps: params.slippage_bps,
    amount_sol: params.amount_sol,
    signal_snapshot: params.signal_snapshot,
    reason: params.reason,
    mode: params.mode,
  };
  
  logEvent(event);
}

export function logTradeExit(params: {
  mint: string;
  symbol: string;
  decision_price_usd: number;
  execution_price_usd: number;
  slippage_bps: number;
  realized_pnl_usd: number;
  realized_pnl_pct: number;
  holding_minutes: number;
  trigger_reason: TriggerReason;
  signal_snapshot: SignalSnapshot | null;
  mode: 'live' | 'paper';
}): void {
  const journeyId = getJourneyId(params.mint);
  
  const event: TradeExitEvent = {
    event_id: generateEventId(),
    journey_id: journeyId ?? generateJourneyId(params.mint),
    timestamp: new Date().toISOString(),
    event_type: EventType.TRADE_EXIT,
    mint: params.mint,
    symbol: params.symbol,
    side: 'sell',
    decision_price_usd: params.decision_price_usd,
    execution_price_usd: params.execution_price_usd,
    slippage_bps: params.slippage_bps,
    realized_pnl_usd: params.realized_pnl_usd,
    realized_pnl_pct: params.realized_pnl_pct,
    holding_minutes: params.holding_minutes,
    trigger_reason: params.trigger_reason,
    signal_snapshot: params.signal_snapshot,
    mode: params.mode,
  };
  
  logEvent(event);
  
  clearJourneyId(params.mint);
}

export function logSignalSnapshot(params: {
  mint: string;
  symbol: string;
  signal_score: number;
  regime: 'trend' | 'range';
  bar_count: number;
  features: Record<string, number>;
  current_price: number;
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: SignalSnapshotEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.SIGNAL_SNAPSHOT,
    mint: params.mint,
    symbol: params.symbol,
    signal_score: params.signal_score,
    regime: params.regime,
    bar_count: params.bar_count,
    features: params.features,
    current_price: params.current_price,
  };
  
  logEvent(event);
}

export function logPromotion(params: {
  mint: string;
  symbol: string;
  old_slot_type: 'scout' | 'core';
  new_slot_type: 'scout' | 'core';
  pnl_pct: number;
  signal_score: number | null;
  held_minutes: number;
  criteria_snapshot: PromotionCriteriaSnapshot;
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: PromotionEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.PROMOTION,
    mint: params.mint,
    symbol: params.symbol,
    old_slot_type: params.old_slot_type,
    new_slot_type: params.new_slot_type,
    pnl_pct: params.pnl_pct,
    signal_score: params.signal_score,
    held_minutes: params.held_minutes,
    criteria_snapshot: params.criteria_snapshot,
  };
  
  logEvent(event);
}

export type ExitDecisionReason = 'take_profit' | 'trailing_stop' | 'scout_stop_loss' | 'core_loss_exit' | 'stale_exit' | 'rotation_exit';

export interface ExitDecisionBreadcrumb {
  event_id: string;
  journey_id: string;
  timestamp: string;
  event_type: EventType.EXIT_DECISION;
  mint: string;
  symbol: string;
  reason: ExitDecisionReason;
  entry_price: number;
  current_price: number;
  pnl_pct: number;
  peak_price: number | null;
  peak_pnl_pct: number | null;
  threshold: number;
  condition_met: boolean;
  executed: boolean;
  suppression_reason: string | null;
  slot_type: 'scout' | 'core';
}

export function logExitDecision(params: {
  mint: string;
  symbol: string;
  reason: ExitDecisionReason;
  entry_price: number;
  current_price: number;
  pnl_pct: number;
  peak_price: number | null;
  peak_pnl_pct: number | null;
  threshold: number;
  condition_met: boolean;
  executed: boolean;
  suppression_reason: string | null;
  slot_type: 'scout' | 'core';
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: ExitDecisionBreadcrumb = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.EXIT_DECISION,
    mint: params.mint,
    symbol: params.symbol,
    reason: params.reason,
    entry_price: params.entry_price,
    current_price: params.current_price,
    pnl_pct: params.pnl_pct,
    peak_price: params.peak_price,
    peak_pnl_pct: params.peak_pnl_pct,
    threshold: params.threshold,
    condition_met: params.condition_met,
    executed: params.executed,
    suppression_reason: params.suppression_reason,
    slot_type: params.slot_type,
  };
  
  logEvent(event);
}

export interface ScoutTpTriggerEvent extends BaseEvent {
  event_type: EventType.SCOUT_TP_TRIGGER;
  reason_code: 'scout_tp_trigger';
  pnl_pct: number;
  scout_take_profit_pct: number;
  signal_score: number | null;
  promotable: boolean;
  reason_if_not_promotable: string | null;
  minutes_held: number;
  settings_hash: string;
}

export interface ScoutTpPromoteEvent extends BaseEvent {
  event_type: EventType.SCOUT_TP_PROMOTE;
  reason_code: 'scout_tp_promote';
  pnl_pct: number;
  signal_score: number | null;
  promoted_to: 'core';
  minutes_held: number;
  settings_hash: string;
}

export interface ScoutTpExitEvent extends BaseEvent {
  event_type: EventType.SCOUT_TP_EXIT;
  reason_code: 'scout_take_profit_exit';
  pnl_pct: number;
  signal_score: number | null;
  executed: boolean;
  suppression_reason: string | null;
  minutes_held: number;
  settings_hash: string;
}

export function logScoutTpTrigger(params: {
  mint: string;
  symbol: string;
  pnl_pct: number;
  scout_take_profit_pct: number;
  signal_score: number | null;
  promotable: boolean;
  reason_if_not_promotable: string | null;
  minutes_held: number;
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: ScoutTpTriggerEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.SCOUT_TP_TRIGGER,
    reason_code: 'scout_tp_trigger',
    mint: params.mint,
    symbol: params.symbol,
    pnl_pct: params.pnl_pct,
    scout_take_profit_pct: params.scout_take_profit_pct,
    signal_score: params.signal_score,
    promotable: params.promotable,
    reason_if_not_promotable: params.reason_if_not_promotable,
    minutes_held: params.minutes_held,
    settings_hash: getConfigHash(),
  };
  
  logEvent(event);
}

export function logScoutTpPromote(params: {
  mint: string;
  symbol: string;
  pnl_pct: number;
  signal_score: number | null;
  minutes_held: number;
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: ScoutTpPromoteEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.SCOUT_TP_PROMOTE,
    reason_code: 'scout_tp_promote',
    mint: params.mint,
    symbol: params.symbol,
    pnl_pct: params.pnl_pct,
    signal_score: params.signal_score,
    promoted_to: 'core',
    minutes_held: params.minutes_held,
    settings_hash: getConfigHash(),
  };
  
  logEvent(event);
}

export function logScoutTpExit(params: {
  mint: string;
  symbol: string;
  pnl_pct: number;
  signal_score: number | null;
  executed: boolean;
  suppression_reason: string | null;
  minutes_held: number;
}): void {
  const journeyId = getOrCreateJourneyId(params.mint);
  
  const event: ScoutTpExitEvent = {
    event_id: generateEventId(),
    journey_id: journeyId,
    timestamp: new Date().toISOString(),
    event_type: EventType.SCOUT_TP_EXIT,
    reason_code: 'scout_take_profit_exit',
    mint: params.mint,
    symbol: params.symbol,
    pnl_pct: params.pnl_pct,
    signal_score: params.signal_score,
    executed: params.executed,
    suppression_reason: params.suppression_reason,
    minutes_held: params.minutes_held,
    settings_hash: getConfigHash(),
  };
  
  logEvent(event);
}
