import crypto from "crypto";
import { env as envVars } from "./config.js";

export interface EnvContext {
  envName: "dev" | "prod";
  deploymentId: string;
  gitSha: string;
  dbLabel: string;
  walletLabel: string;
  processId: number;
  bootTime: string;
}

let cachedContext: EnvContext | null = null;

export function getEnvContext(): EnvContext {
  if (cachedContext) return cachedContext;

  const isProduction = process.env.REPLIT_DEPLOYMENT === "1" || process.env.IS_PRODUCTION === "true";
  const envName = isProduction ? "prod" : "dev";

  const deploymentId = process.env.REPLIT_DEPLOYMENT_ID || 
    process.env.REPLIT_DEV_DOMAIN?.split("-")[0] || 
    `local-${process.pid}`;

  const gitSha = process.env.GIT_SHA || 
    process.env.REPLIT_GIT_COMMIT_SHA || 
    "unknown";

  const dbUrl = isProduction ? (envVars.PROD_DATABASE_URL || envVars.DATABASE_URL) : envVars.DATABASE_URL;
  const dbLabel = sanitizeDbUrl(dbUrl);

  const walletLabel = ""; // Will be set after signer is loaded

  cachedContext = {
    envName,
    deploymentId,
    gitSha: gitSha.slice(0, 7),
    dbLabel,
    walletLabel,
    processId: process.pid,
    bootTime: new Date().toISOString(),
  };

  return cachedContext;
}

export function setWalletLabel(pubkey: string): void {
  if (cachedContext) {
    cachedContext.walletLabel = pubkey.slice(-6);
  }
}

function sanitizeDbUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.split(".")[0];
    const db = parsed.pathname.replace("/", "");
    return `${host}/${db}`;
  } catch {
    return "unknown-db";
  }
}

export function computeConfigHash(config: Record<string, any>): string {
  const sortedKeys = Object.keys(config).sort();
  const sorted: Record<string, any> = {};
  for (const key of sortedKeys) {
    sorted[key] = config[key];
  }
  const json = JSON.stringify(sorted);
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 12);
}

export interface ConfigSource {
  value: any;
  source: "default" | "profile" | "env" | "db";
}

export interface EffectiveConfigInfo {
  config: Record<string, any>;
  configHash: string;
  sources: Record<string, "default" | "profile" | "env" | "db">;
  lastLoadedAt: string;
  settingsRowCount: number;
}

let effectiveConfigInfo: EffectiveConfigInfo | null = null;

export function setEffectiveConfigInfo(info: EffectiveConfigInfo): void {
  effectiveConfigInfo = info;
}

export function getEffectiveConfigInfo(): EffectiveConfigInfo | null {
  return effectiveConfigInfo;
}
