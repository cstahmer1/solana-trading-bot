import type { CircuitState } from "./risk.js";

export type BotState = {
  paused: boolean;
  pauseReason?: string;
  lastTradeAt: Record<string, number>; // mint -> ms
  circuit: CircuitState | null;
};

export function newState(): BotState {
  return {
    paused: false,
    lastTradeAt: {},
    circuit: null,
  };
}
