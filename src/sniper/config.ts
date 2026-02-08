import { env } from "../bot/config.js";

export const SNIPER_CONFIG = {
  buyAmountSol: 0.01,
  takeProfitPct: 84,
  stopLossPct: 11,
  slippageBps: 1500,
  maxConcurrentPositions: 50,
  poolWaitTimeoutMs: 30_000,
  priceCheckIntervalMs: 5_000,
  minLiquidityUsd: 1000,
  strategy: "sniper",
} as const;

export function getHeliusApiKey(): string | null {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (rpcUrl.includes("helius-rpc.com")) {
    const match = rpcUrl.match(/api-key=([^&]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

export function getHeliusWsUrl(): string | null {
  // Prefer dedicated HELIUS_WS_URL secret if available
  const wsUrl = process.env.HELIUS_WS_URL;
  if (wsUrl && wsUrl.startsWith("wss://")) {
    return wsUrl;
  }
  // Fallback to extracting from RPC URL
  const apiKey = getHeliusApiKey();
  if (!apiKey) return null;
  return `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

export function getHeliusRpcUrl(): string | null {
  const apiKey = getHeliusApiKey();
  if (!apiKey) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

export const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MINT_SOL = "So11111111111111111111111111111111111111112";

export interface SniperPosition {
  id: string;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  entryTimestamp: Date;
  tokenQuantity: number;
  costBasisSol: number;
  costBasisUsd: number;
  txSig: string;
  status: "open" | "closed";
  exitPriceUsd?: number;
  exitTimestamp?: Date;
  exitTxSig?: string;
  pnlUsd?: number;
  pnlPct?: number;
  exitReason?: "take_profit" | "stop_loss" | "manual";
}

export interface DetectedToken {
  mint: string;
  signature: string;
  slot: number;
  timestamp: Date;
  creator?: string;
  poolAddress?: string;
}
