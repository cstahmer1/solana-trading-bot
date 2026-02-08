import WebSocket from "ws";
import { fetch } from "undici";
import { logger } from "../utils/logger.js";
import { 
  getHeliusWsUrl, 
  getHeliusRpcUrl,
  TOKEN_PROGRAM_ADDRESS, 
  TOKEN_2022_PROGRAM_ADDRESS,
  RAYDIUM_AMM_V4,
  PUMP_FUN_PROGRAM,
  type DetectedToken 
} from "./config.js";

const INVALID_MINTS = new Set([
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  RAYDIUM_AMM_V4,
  PUMP_FUN_PROGRAM,
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112", // Wrapped SOL
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
  "SysvarRecentB1ockHashes11111111111111111111",
  "SysvarFees111111111111111111111111111111111",
  "SysvarEpochSchewordu1e111111111111111111111",
  "SysvarS1otHistory11111111111111111111111111",
  "SysvarStakeHistory1111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
]);

function isValidMint(mint: string | null | undefined): boolean {
  if (!mint) return false;
  if (mint.length < 32 || mint.length > 44) return false;
  if (INVALID_MINTS.has(mint)) return false;
  if (mint.startsWith("Sysvar")) return false;
  if (mint.startsWith("11111")) return false;
  if (mint === "System") return false;
  return true;
}

type TokenCallback = (token: DetectedToken) => void;
type PoolCallback = (data: { mint: string; poolAddress: string; signature: string }) => void;

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let isConnecting = false;
let tokenCallbacks: TokenCallback[] = [];
let poolCallbacks: PoolCallback[] = [];
let subscriptionIds: number[] = [];
let pingInterval: NodeJS.Timeout | null = null;
let processedSignatures = new Set<string>();

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 30000;
const PROCESSED_CACHE_MAX = 1000;

export function onNewToken(callback: TokenCallback): void {
  tokenCallbacks.push(callback);
}

export function onNewPool(callback: PoolCallback): void {
  poolCallbacks.push(callback);
}

function emitNewToken(token: DetectedToken): void {
  for (const cb of tokenCallbacks) {
    try {
      cb(token);
    } catch (err) {
      logger.error({ err }, "Error in token callback");
    }
  }
}

function emitNewPool(data: { mint: string; poolAddress: string; signature: string }): void {
  for (const cb of poolCallbacks) {
    try {
      cb(data);
    } catch (err) {
      logger.error({ err }, "Error in pool callback");
    }
  }
}

function cleanProcessedCache(): void {
  if (processedSignatures.size > PROCESSED_CACHE_MAX) {
    const entries = Array.from(processedSignatures);
    processedSignatures = new Set(entries.slice(-500));
  }
}

async function fetchTransactionDetails(signature: string): Promise<any> {
  const rpcUrl = getHeliusRpcUrl();
  if (!rpcUrl) return null;

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          signature,
          {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    });

    const data = (await response.json()) as { result?: any };
    return data.result;
  } catch (err) {
    logger.debug({ err, signature }, "Failed to fetch transaction details");
    return null;
  }
}

async function processLogNotification(data: any): Promise<void> {
  try {
    const result = data?.params?.result;
    if (!result) return;

    const signature = result.value?.signature;
    const logs = result.value?.logs || [];
    const slot = result.context?.slot;

    if (!signature || processedSignatures.has(signature)) return;

    const isInitializeMint = logs.some((log: string) => 
      log.includes("InitializeMint") || 
      log.includes("initialize_mint") ||
      log.includes("Instruction: InitializeMint2")
    );

    const isPoolCreation = logs.some((log: string) => 
      log.includes("initialize2") || 
      log.includes("ray_log") ||
      (log.includes("Create") && log.includes("Pool"))
    );

    if (!isInitializeMint && !isPoolCreation) return;

    logger.info({ 
      signature: signature.slice(0, 16), 
      isInitializeMint, 
      isPoolCreation,
      logCount: logs.length,
    }, "SNIPER: Matched filter - fetching transaction details");

    const maxRetries = 15;
    const baseDelayMs = 500;
    let tx = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      tx = await fetchTransactionDetails(signature);
      if (tx) {
        logger.info({ signature: signature.slice(0, 16), attempt, elapsedMs: attempt * baseDelayMs }, "SNIPER: Transaction fetched successfully");
        break;
      }
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(1.5, attempt - 1), 5000);
        if (attempt % 3 === 0) {
          logger.info({ signature: signature.slice(0, 16), attempt, maxRetries, nextDelayMs: delay }, "SNIPER: Transaction not indexed yet, retrying...");
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    if (!tx) {
      logger.warn({ signature: signature.slice(0, 16), attempts: maxRetries }, "SNIPER: Failed to fetch transaction after retries - RPC indexing too slow");
      processedSignatures.add(signature);
      cleanProcessedCache();
      return;
    }

    let extracted = false;

    if (isInitializeMint) {
      const token = extractMintFromTransaction(tx, signature, slot);
      if (token) {
        logger.info({ mint: token.mint.slice(0, 8), signature: signature.slice(0, 16) }, "SNIPER: Token mint extracted, emitting");
        emitNewToken(token);
        extracted = true;
      }
    }

    if (isPoolCreation) {
      const pool = extractPoolFromTransaction(tx, signature);
      if (pool) {
        logger.info({ mint: pool.mint.slice(0, 8), poolAddress: pool.poolAddress?.slice(0, 8), signature: signature.slice(0, 16) }, "SNIPER: Pool extracted, emitting");
        emitNewPool(pool);
        extracted = true;
      }
    }

    if (extracted) {
      processedSignatures.add(signature);
      cleanProcessedCache();
    } else {
      logger.info({ signature: signature.slice(0, 16) }, "SNIPER: Could not extract token/pool from transaction");
    }
  } catch (err) {
    logger.error({ err }, "SNIPER: Failed to process log notification");
  }
}

function extractMintFromTransaction(tx: any, signature: string, slot: number): DetectedToken | null {
  try {
    const meta = tx?.meta;
    const message = tx?.transaction?.message;
    const accountKeys = message?.accountKeys || [];
    
    let mint: string | null = null;
    let creator: string | null = null;

    const instructions = message?.instructions || [];
    for (const ix of instructions) {
      const programId = typeof ix.programId === 'string' ? ix.programId : ix.programId?.toBase58?.();
      
      if (programId === TOKEN_PROGRAM_ADDRESS || programId === TOKEN_2022_PROGRAM_ADDRESS) {
        if (ix.parsed?.type?.includes("initializeMint") || ix.parsed?.type?.includes("InitializeMint")) {
          mint = ix.parsed?.info?.mint;
          creator = ix.parsed?.info?.mintAuthority;
          break;
        }
      }
    }

    if (!mint) {
      const innerInstructions = meta?.innerInstructions || [];
      for (const inner of innerInstructions) {
        for (const ix of inner.instructions || []) {
          if (ix.parsed?.type?.includes("initializeMint") || ix.parsed?.type?.includes("InitializeMint")) {
            mint = ix.parsed?.info?.mint;
            creator = ix.parsed?.info?.mintAuthority;
            break;
          }
        }
        if (mint) break;
      }
    }

    if (!mint) {
      const keys = accountKeys.map((k: any) => typeof k === 'string' ? k : k.pubkey);
      for (let i = 0; i < Math.min(keys.length, 5); i++) {
        const key = keys[i];
        if (isValidMint(key)) {
          mint = key;
          creator = keys[0];
          break;
        }
      }
    }
    
    if (!isValidMint(mint)) {
      logger.debug({ mint, signature }, "SNIPER: Extracted mint is invalid/system address, skipping");
      return null;
    }

    logger.info({ mint, signature, slot }, "SNIPER: Detected InitializeMint via logs");

    return {
      mint: mint as string,
      signature,
      slot,
      timestamp: new Date(),
      creator: creator || undefined,
    };
  } catch (err) {
    logger.debug({ err }, "Failed to extract mint from transaction");
    return null;
  }
}

function extractPoolFromTransaction(tx: any, signature: string): { mint: string; poolAddress: string; signature: string } | null {
  try {
    const meta = tx?.meta;
    const message = tx?.transaction?.message;
    const accountKeys = message?.accountKeys || [];
    
    const innerInstructions = meta?.innerInstructions || [];
    let tokenMint: string | null = null;
    let poolAddress: string | null = null;

    for (const inner of innerInstructions) {
      for (const ix of inner.instructions || []) {
        if (ix.parsed?.type === "initializeAccount" || ix.parsed?.type === "initializeAccount3") {
          tokenMint = ix.parsed?.info?.mint;
        }
      }
    }

    if (!tokenMint) {
      const keys = accountKeys.map((k: any) => typeof k === 'string' ? k : k.pubkey);
      for (let i = 8; i < Math.min(keys.length, 15); i++) {
        if (isValidMint(keys[i])) {
          tokenMint = keys[i];
          poolAddress = keys[4] || "";
          break;
        }
      }
    }

    if (!isValidMint(tokenMint)) {
      logger.debug({ tokenMint, signature }, "SNIPER: Extracted pool mint is invalid/system address, skipping");
      return null;
    }

    logger.info({ tokenMint, poolAddress, signature }, "SNIPER: Detected pool creation via logs");

    return {
      mint: tokenMint as string,
      poolAddress: poolAddress || "",
      signature,
    };
  } catch (err) {
    logger.debug({ err }, "Failed to extract pool from transaction");
    return null;
  }
}

let messageCount = 0;
let lastStatsTime = Date.now();

function handleMessage(data: WebSocket.Data): void {
  try {
    const msg = JSON.parse(data.toString());

    if (msg.id && typeof msg.result === 'number') {
      subscriptionIds.push(msg.result);
      logger.info({ subscriptionId: msg.result, id: msg.id }, "SNIPER: WebSocket subscription confirmed");
      return;
    }

    if (msg.method === "logsNotification") {
      messageCount++;
      
      const now = Date.now();
      if (now - lastStatsTime > 60000) {
        logger.info({ messagesReceived: messageCount, intervalSec: 60 }, "SNIPER: WebSocket stats (last 60s)");
        messageCount = 0;
        lastStatsTime = now;
      }
      
      if (messageCount <= 3) {
        const logs = msg?.params?.result?.value?.logs || [];
        const signature = msg?.params?.result?.value?.signature;
        logger.info({ 
          signature: signature?.slice(0, 16),
          logCount: logs.length,
          firstLogs: logs.slice(0, 5),
        }, "SNIPER: Sample logsNotification received");
      }
      
      processLogNotification(msg);
    }
  } catch (err) {
    logger.debug({ err, data: data.toString().slice(0, 200) }, "Failed to parse WebSocket message");
  }
}

function subscribe(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const subscriptions = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [TOKEN_PROGRAM_ADDRESS] },
        { commitment: "processed" }
      ],
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "logsSubscribe",
      params: [
        { mentions: [TOKEN_2022_PROGRAM_ADDRESS] },
        { commitment: "processed" }
      ],
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "logsSubscribe",
      params: [
        { mentions: [RAYDIUM_AMM_V4] },
        { commitment: "processed" }
      ],
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMP_FUN_PROGRAM] },
        { commitment: "processed" }
      ],
    },
  ];

  for (const sub of subscriptions) {
    ws.send(JSON.stringify(sub));
    logger.info({ mentions: sub.params[0].mentions }, "SNIPER: Sent logsSubscribe request");
  }
}

function startPing(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
  }
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

export async function connect(): Promise<boolean> {
  if (isConnecting) return false;
  if (ws && ws.readyState === WebSocket.OPEN) return true;

  const wsUrl = getHeliusWsUrl();
  if (!wsUrl) {
    logger.error("SNIPER: Helius API key not configured - cannot connect WebSocket");
    return false;
  }

  isConnecting = true;
  logger.info({ wsUrl: wsUrl.replace(/api-key=[^&]+/, "api-key=***") }, "SNIPER: Connecting to WebSocket");

  return new Promise((resolve) => {
    try {
      ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        logger.info("SNIPER: WebSocket connected (standard logsSubscribe mode)");
        reconnectAttempts = 0;
        isConnecting = false;
        startPing();
        subscribe();
        resolve(true);
      });

      ws.on("message", handleMessage);

      ws.on("close", (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, "SNIPER: WebSocket closed");
        isConnecting = false;
        stopPing();
        subscriptionIds = [];
        scheduleReconnect();
      });

      ws.on("error", (err) => {
        logger.error({ err: err.message }, "SNIPER: WebSocket error");
        isConnecting = false;
      });

      ws.on("pong", () => {
        logger.debug("SNIPER: WebSocket pong received");
      });

    } catch (err) {
      logger.error({ err }, "SNIPER: Failed to create WebSocket");
      isConnecting = false;
      resolve(false);
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error("SNIPER: Max reconnect attempts reached, giving up");
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * reconnectAttempts;
  
  logger.info({ attempt: reconnectAttempts, delayMs: delay }, "SNIPER: Scheduling reconnect");
  
  setTimeout(() => {
    connect();
  }, delay);
}

export function disconnect(): void {
  stopPing();
  if (ws) {
    ws.close();
    ws = null;
  }
  subscriptionIds = [];
  tokenCallbacks = [];
  poolCallbacks = [];
  processedSignatures.clear();
  logger.info("SNIPER: WebSocket disconnected");
}

export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

export function getSubscriptionCount(): number {
  return subscriptionIds.length;
}
