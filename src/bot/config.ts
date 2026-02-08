import "dotenv/config";
import { z } from "zod";

export type RiskProfileName = "low" | "medium" | "high" | "degen";
export type ExecutionMode = "paper" | "live";

function buildRpcUrl(): string {
  const raw = process.env.SOLANA_RPC_URL || "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }
  if (raw.length > 0) {
    return `https://mainnet.helius-rpc.com/?api-key=${raw}`;
  }
  return "https://api.mainnet-beta.solana.com";
}

const schema = z.object({
  SOLANA_RPC_URL: z.string().default(""),
  SOLANA_WSS_URL: z.string().optional(),
  BOT_WALLET_PRIVATE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  PROD_DATABASE_URL: z.string().optional(),
  IS_PRODUCTION: z.string().optional(),

  JUP_BASE_URL: z.string().default("https://api.jup.ag"),
  JUP_API_KEY: z.string().default(""),

  DASHBOARD_PASSWORD: z.string().default("admin"),
  SESSION_SECRET: z.string().default("change-me-to-a-random-secret"),

  UNIVERSE_MINTS: z.string().optional(),

  RISK_PROFILE: z.enum(["low", "medium", "high", "degen"]).default("medium"),
  EXECUTION_MODE: z.enum(["paper", "live"]).default("paper"),

  LOOP_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),

  MAX_DAILY_DRAWDOWN_PCT: z.coerce.number().min(0.0).max(0.99).default(0.05),
  MAX_POSITION_PCT_PER_ASSET: z.coerce.number().min(0.01).max(0.99).default(0.25),
  MAX_TURNOVER_PCT_PER_DAY: z.coerce.number().min(0.1).max(1000).default(1.0),

  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2000).default(80),
  MAX_SINGLE_SWAP_SOL: z.coerce.number().min(0.01).max(1000).default(1.5),
  MIN_TRADE_USD: z.coerce.number().min(1).max(1_000_000).default(25),

  MAX_POSITIONS: z.coerce.number().int().min(1).max(100).default(10),
  MAX_TOP3_CONCENTRATION_PCT: z.coerce.number().min(0.1).max(1.0).default(0.70),
  MAX_PORTFOLIO_VOLATILITY: z.coerce.number().min(0.1).max(100).default(0.50),

  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  SOLANA_RPC_URL: buildRpcUrl(),
};

export const MINT_SOL = "So11111111111111111111111111111111111111112";
export const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
