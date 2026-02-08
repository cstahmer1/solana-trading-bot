import express from "express";
import session from "express-session";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import { env, MINT_SOL, MINT_USDC } from "../bot/config.js";
import { getUniverse } from "../bot/universe.js";
import { loadRecentTrades, loadLatestEquity, getPerformanceMetrics, loadEquitySeriesWithRange, loadTickTelemetry, loadConfigHistory, loadTradesForExport, loadPricesForExport, loadEquityForExport, getScoutQueueStats, getScoutQueue, countTodayScoutEntries, getSlotCounts, loadEnrichedTradesForExport, loadConfigSnapshotsForExport, loadAnalysisBundleForExport, loadTradesWithPriceContext } from "../bot/persist.js";
import { q } from "../bot/db.js";
import { 
  initRuntimeConfig, 
  getConfig, 
  getConfigForApi, 
  updateConfigBatch,
  isExecutionModeLocked,
  getConfigSources,
  getConfigHash,
  getSettingsRowCount,
  getLastSettingsReloadAt,
  getDbSettings,
  getSettingsDiff,
  getKeyMapping,
  type RuntimeConfig,
  type SettingsDiffRow,
} from "../bot/runtime_config.js";
import { getEnvContext, setWalletLabel, getEffectiveConfigInfo } from "../bot/env_context.js";
import { 
  getLatestTelemetry, 
  getLatestSignals, 
  getLatestPositions,
  getPriceHistory,
  getRecentTrades as getTelemetryTrades,
  getEquityHistory,
  getAllSignalHistory,
  getRecentSignalHistory,
  TelemetrySnapshot,
  SignalData,
  PositionData,
} from "../bot/telemetry.js";
import {
  getTokenMeta,
  getTokenTransfers,
  getTokenHolders,
  getTokenMarkets,
  getCacheStats as getSolscanCacheStats,
} from "../bot/solscan.js";
import {
  getTrendingTokens,
  getNewListings,
  getCacheStats as getDexCacheStats,
  getTokenPairs,
} from "../bot/dexscreener.js";
import { logger } from "../utils/logger.js";
import { SettingsSchema, normalizeSettings, SettingsDefaults, type Settings } from "../bot/settings_schema.js";
import { getAssetsByOwner, isHeliusConfigured } from "../bot/helius.js";
import { getJupiterBatchPrices } from "../bot/jupiter.js";
import { PublicKey } from "@solana/web3.js";
import { initializeDatabase } from "../bot/init_db.js";
import { getRecentScoutEntryEvals } from "../bot/price_metrics.js";
import { createExportLiteZip } from "./export-lite.js";

const symbolCache = new Map<string, string>();
const SYMBOL_CACHE_TTL = 5 * 60 * 1000;
const symbolCacheTimestamps = new Map<string, number>();

async function resolveSymbol(mint: string, universeMap?: Map<string, string>): Promise<string> {
  if (mint === MINT_SOL) return "SOL";
  if (mint === MINT_USDC) return "USDC";
  
  if (universeMap?.has(mint)) {
    return universeMap.get(mint)!;
  }
  
  const now = Date.now();
  const cached = symbolCache.get(mint);
  const cachedTime = symbolCacheTimestamps.get(mint) || 0;
  if (cached && (now - cachedTime) < SYMBOL_CACHE_TTL) {
    return cached;
  }
  
  try {
    const pairs = await getTokenPairs(mint);
    if (pairs && pairs.length > 0) {
      const symbol = pairs[0].baseToken?.symbol || mint.slice(0, 6);
      symbolCache.set(mint, symbol);
      symbolCacheTimestamps.set(mint, now);
      return symbol;
    }
  } catch (err) {
    logger.warn({ mint, err }, "Failed to fetch symbol from DexScreener");
  }
  
  return mint.slice(0, 6);
}

async function buildSymbolMap(mints: string[]): Promise<Map<string, string>> {
  const universe = await getUniverse();
  const universeMap = new Map<string, string>();
  for (const t of universe) {
    universeMap.set(t.mint, t.symbol);
  }
  
  const result = new Map<string, string>();
  const unknownMints: string[] = [];
  
  for (const mint of mints) {
    if (universeMap.has(mint)) {
      result.set(mint, universeMap.get(mint)!);
    } else if (mint === MINT_SOL) {
      result.set(mint, "SOL");
    } else if (mint === MINT_USDC) {
      result.set(mint, "USDC");
    } else {
      const cached = symbolCache.get(mint);
      const cachedTime = symbolCacheTimestamps.get(mint) || 0;
      if (cached && (Date.now() - cachedTime) < SYMBOL_CACHE_TTL) {
        result.set(mint, cached);
      } else {
        unknownMints.push(mint);
      }
    }
  }
  
  for (const mint of unknownMints) {
    const symbol = await resolveSymbol(mint, universeMap);
    result.set(mint, symbol);
  }
  
  return result;
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const isProduction = process.env.NODE_ENV === 'production';

function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function logSecurityEvent(event: string, details: any = {}) {
  logger.info({ securityEvent: event, ...details }, `Security: ${event}`);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    logSecurityEvent('LOGIN_RATE_LIMITED', { ip: req.ip });
    res.status(429).send(options.message);
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const strictApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Rate limit exceeded for this sensitive endpoint.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
}));

app.use(morgan("tiny"));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '100kb' }));

app.use(session({
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: isProduction ? '__Host-sid' : 'sid',
  cookie: { 
    httpOnly: true, 
    sameSite: isProduction ? "strict" : "lax",
    secure: isProduction,
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  },
  proxy: isProduction,
}));

app.use('/api', apiLimiter);

let botState: any = { paused: false, risk: "medium", mode: "paper", circuit: null };

export function initBotStateFromConfig() {
  const config = getConfig();
  botState = {
    ...botState,
    paused: config.manualPause,
    risk: config.riskProfile,
    mode: config.executionMode,
    manualPause: config.manualPause,
  };
}

export function updateBotState(state: any) {
  botState = { ...botState, ...state };
  broadcastState();
}

const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "state", data: botState }));
  ws.on("close", () => clients.delete(ws));
});

function broadcastState() {
  const msg = JSON.stringify({ type: "state", data: botState });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

export function broadcastTelemetry(telemetry: TelemetrySnapshot) {
  const msg = JSON.stringify({ type: "telemetry", data: telemetry });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

export interface RotationEvent {
  action: 'rotation' | 'promotion' | 'trailing_stop' | 'stale_exit' | 'scout_stop_loss' | 'core_loss_exit' | 'scout_underperform';
  soldMint?: string;
  soldSymbol?: string;
  boughtMint?: string;
  boughtSymbol?: string;
  reasonCode: string;
  rankDelta?: number;
  slotType?: string;
  ts: string;
}

export function broadcastRotation(event: RotationEvent) {
  const msg = JSON.stringify({ type: "rotation", data: event });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function requireAuth(req: any, res: any, next: any) {
  if (req.session?.authed) return next();
  return res.redirect("/login");
}

function requireApiAuth(req: any, res: any, next: any) {
  if (req.session?.authed) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

app.get("/login", (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.type("html").send(`
    <!DOCTYPE html>
    <html><head><title>MATRIX :: ACCESS TERMINAL</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
      <style>
        *{box-sizing:border-box}
        body{font-family:'Share Tech Mono',Consolas,'Courier New',monospace;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;position:relative;overflow:hidden}
        #matrix-bg{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;opacity:0.2}
        .login-box{background:rgba(0,20,0,0.9);padding:40px;border-radius:0;border:1px solid #00ff41;max-width:400px;width:90%;box-shadow:0 0 40px rgba(0,255,65,0.3);position:relative;z-index:1}
        h2{color:#00ff41;margin:0 0 24px;font-size:20px;text-align:center;text-shadow:0 0 10px #00ff41;letter-spacing:3px}
        input{padding:14px 16px;width:100%;margin:0 0 16px;background:#000;border:1px solid #003300;border-radius:0;color:#00ff41;font-size:16px;font-family:inherit}
        input:focus{outline:none;border-color:#00ff41;box-shadow:0 0 10px rgba(0,255,65,0.3)}
        input::placeholder{color:#008f11}
        button{padding:14px;width:100%;background:transparent;border:1px solid #00ff41;border-radius:0;color:#00ff41;font-size:16px;font-weight:400;cursor:pointer;font-family:inherit;text-shadow:0 0 5px #00ff41;letter-spacing:2px;transition:all 0.3s}
        button:hover{background:rgba(0,255,65,0.1);box-shadow:0 0 20px rgba(0,255,65,0.4)}
        .subtitle{color:#008f11;text-align:center;margin-bottom:24px;font-size:12px;letter-spacing:1px}
        .terminal-line{color:#008f11;font-size:11px;margin-bottom:4px}
        .cursor{animation:blink 1s infinite}
        @keyframes blink{0%,50%{opacity:1}51%,100%{opacity:0}}
      </style>
    </head>
    <body>
      <canvas id="matrix-bg"></canvas>
      <div class="login-box">
        <h2>[ ACCESS TERMINAL ]</h2>
        <p class="subtitle">ENTER AUTHORIZATION CODE</p>
        <form method="POST" action="/login">
          <input type="hidden" name="_csrf" value="${nonce}" />
          <input type="password" name="password" placeholder="PASSWORD" autocomplete="current-password" required minlength="1" maxlength="256" />
          <button type="submit">[ AUTHENTICATE ]</button>
        </form>
      </div>
      <script>
        const canvas = document.getElementById('matrix-bg');
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%';
        const fontSize = 14;
        const columns = Math.floor(canvas.width / fontSize);
        const drops = [];
        for (let i = 0; i < columns; i++) drops[i] = Math.random() * -100;
        function draw() {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.font = fontSize + 'px Share Tech Mono, monospace';
          for (let i = 0; i < drops.length; i++) {
            const char = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillStyle = 'rgba(0, 255, 65, ' + (0.3 + Math.random() * 0.7) + ')';
            ctx.fillText(char, i * fontSize, drops[i] * fontSize);
            if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
          }
        }
        setInterval(draw, 50);
        window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
      </script>
    </body></html>
  `);
});

app.post("/login", loginLimiter, (req: any, res) => {
  const password = String(req.body?.password ?? "").slice(0, 256);
  const expectedPassword = env.DASHBOARD_PASSWORD || "";
  
  if (safeCompare(password, expectedPassword)) {
    req.session.regenerate((err: any) => {
      if (err) {
        logSecurityEvent('SESSION_REGENERATE_FAILED', { ip: req.ip });
        return res.status(500).send("Session error");
      }
      req.session.authed = true;
      logSecurityEvent('LOGIN_SUCCESS', { ip: req.ip });
      return res.redirect("/");
    });
  } else {
    logSecurityEvent('LOGIN_FAILED', { ip: req.ip });
    return res.status(401).send(`
      <!DOCTYPE html>
      <html><head><title>ACCESS DENIED</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
        <style>
          *{box-sizing:border-box}
          body{font-family:'Share Tech Mono',Consolas,'Courier New',monospace;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;position:relative;overflow:hidden}
          #matrix-bg{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;opacity:0.2}
          .login-box{background:rgba(20,0,0,0.9);padding:40px;border-radius:0;border:1px solid #ff0040;max-width:400px;width:90%;box-shadow:0 0 40px rgba(255,0,64,0.3);position:relative;z-index:1}
          h2{color:#ff0040;margin:0 0 16px;font-size:20px;text-align:center;text-shadow:0 0 10px #ff0040;letter-spacing:2px}
          p{color:#ff6666;text-align:center;margin-bottom:24px}
          .terminal-line{color:#ff0040;font-size:11px;margin-bottom:4px}
          a{display:block;padding:14px;background:transparent;border:1px solid #00ff41;border-radius:0;color:#00ff41;font-size:16px;font-weight:400;text-decoration:none;text-align:center;font-family:inherit;letter-spacing:2px;transition:all 0.3s}
          a:hover{background:rgba(0,255,65,0.1);box-shadow:0 0 20px rgba(0,255,65,0.4)}
        </style>
      </head>
      <body>
        <canvas id="matrix-bg"></canvas>
        <div class="login-box">
          <div class="terminal-line">> ERROR: AUTHENTICATION FAILED</div>
          <div class="terminal-line">> ACCESS DENIED</div>
          <h2>[ INVALID CREDENTIALS ]</h2>
          <p>Authorization code rejected. Retry sequence.</p>
          <a href="/login">[ RETRY ]</a>
        </div>
        <script>
          const canvas = document.getElementById('matrix-bg');
          const ctx = canvas.getContext('2d');
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%';
          const fontSize = 14;
          const columns = Math.floor(canvas.width / fontSize);
          const drops = [];
          for (let i = 0; i < columns; i++) drops[i] = Math.random() * -100;
          function draw() {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.font = fontSize + 'px Share Tech Mono, monospace';
            for (let i = 0; i < drops.length; i++) {
              const char = chars[Math.floor(Math.random() * chars.length)];
              ctx.fillStyle = 'rgba(255, 0, 64, ' + (0.3 + Math.random() * 0.7) + ')';
              ctx.fillText(char, i * fontSize, drops[i] * fontSize);
              if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
              drops[i]++;
            }
          }
          setInterval(draw, 50);
        </script>
      </body></html>
    `);
  }
});

app.get("/logout", (req: any, res) => {
  logSecurityEvent('LOGOUT', { ip: req.ip });
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requireAuth, async (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type("html").send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>MATRIX :: Quant Trading System</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Share Tech Mono',Consolas,'Courier New',monospace;background:#000;color:#00ff41;min-height:100vh;position:relative;overflow-x:hidden}
      
      #matrix-bg{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;opacity:0.15;pointer-events:none}
      .main-content{position:relative;z-index:1}
      
      .header{background:linear-gradient(135deg,rgba(0,20,0,0.95),rgba(0,40,0,0.9));padding:16px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #00ff41;position:sticky;top:0;z-index:100;box-shadow:0 0 20px rgba(0,255,65,0.3)}
      .header h1{font-size:18px;font-weight:400;display:flex;align-items:center;gap:8px;color:#00ff41;text-shadow:0 0 10px #00ff41,0 0 20px #00ff41;letter-spacing:2px}
      .header-right{display:flex;gap:10px;align-items:center}
      
      .badge{padding:5px 10px;border-radius:0;font-size:11px;font-weight:400;text-transform:uppercase;border:1px solid;letter-spacing:1px}
      .badge-paper{background:transparent;color:#ffff00;border-color:#ffff00;text-shadow:0 0 5px #ffff00}
      .badge-live{background:transparent;color:#00ff41;border-color:#00ff41;text-shadow:0 0 5px #00ff41}
      .badge-risk{background:transparent;color:#00ffff;border-color:#00ffff;text-shadow:0 0 5px #00ffff}
      .badge-paused{background:transparent;color:#ff0040;border-color:#ff0040;text-shadow:0 0 5px #ff0040}
      .badge-running{background:transparent;color:#00ff41;border-color:#00ff41;text-shadow:0 0 5px #00ff41}
      
      .nav{background:rgba(0,15,0,0.9);border-bottom:1px solid #003300;padding:0 24px;display:flex;gap:4px}
      .nav-item{padding:12px 16px;color:#008f11;cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:400;transition:all 0.2s;letter-spacing:1px}
      .nav-item:hover{color:#00ff41;text-shadow:0 0 10px #00ff41}
      .nav-item.active{color:#00ff41;border-bottom-color:#00ff41;text-shadow:0 0 10px #00ff41}
      
      .container{padding:20px;max-width:1600px;margin:0 auto}
      .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}
      .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
      .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
      
      .card{background:rgba(0,20,0,0.8);border-radius:0;padding:16px;border:1px solid #003300;box-shadow:0 0 10px rgba(0,255,65,0.1),inset 0 0 30px rgba(0,255,65,0.02)}
      .card:hover{border-color:#00ff41;box-shadow:0 0 20px rgba(0,255,65,0.2)}
      .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
      .card h3{font-size:12px;color:#008f11;font-weight:400;text-transform:uppercase;letter-spacing:2px}
      .card-action{font-size:11px;color:#00ff41;cursor:pointer}
      
      .stat{font-size:28px;font-weight:400;color:#00ff41;text-shadow:0 0 10px #00ff41}
      .stat-small{font-size:13px;color:#008f11;margin-top:2px}
      .stat-change{font-size:12px;margin-left:8px}
      .stat-change.up{color:#00ff41;text-shadow:0 0 5px #00ff41}
      .stat-change.down{color:#ff0040;text-shadow:0 0 5px #ff0040}
      
      .chart-container{height:180px;position:relative}
      .chart-container.tall{height:280px}
      
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{text-align:left;color:#008f11;font-weight:400;padding:10px 8px;border-bottom:1px solid #003300;position:sticky;top:0;background:rgba(0,15,0,0.95);text-transform:uppercase;letter-spacing:1px}
      td{padding:10px 8px;border-bottom:1px solid #001a00;color:#00ff41}
      .table-scroll{max-height:400px;overflow-y:auto}
      
      a{color:#00ffff;text-decoration:none;text-shadow:0 0 5px #00ffff}
      a:hover{text-decoration:underline;text-shadow:0 0 10px #00ffff}
      .token-link{color:#00ff41;text-decoration:none;cursor:pointer}
      .token-link:hover{text-decoration:underline;color:#39ff14}
      
      .status-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:6px;box-shadow:0 0 6px currentColor}
      .status-dot.green{background:#00ff41;box-shadow:0 0 8px #00ff41}
      .status-dot.yellow{background:#ffff00;box-shadow:0 0 8px #ffff00}
      .status-dot.red{background:#ff0040;box-shadow:0 0 8px #ff0040}
      .status-dot.blue{background:#00ffff;box-shadow:0 0 8px #00ffff}
      
      .empty{color:#008f11;text-align:center;padding:32px}
      
      .gauge{position:relative;height:8px;background:#001a00;border-radius:0;overflow:hidden;margin-top:8px;border:1px solid #003300}
      .gauge-fill{height:100%;border-radius:0;transition:width 0.3s}
      .gauge-fill.green{background:linear-gradient(90deg,#00ff41,#39ff14);box-shadow:0 0 10px #00ff41}
      .gauge-fill.yellow{background:linear-gradient(90deg,#ffff00,#ccff00);box-shadow:0 0 10px #ffff00}
      .gauge-fill.red{background:linear-gradient(90deg,#ff0040,#ff4444);box-shadow:0 0 10px #ff0040}
      
      .signal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
      .signal-card{background:rgba(0,15,0,0.9);border-radius:0;padding:12px;border:1px solid #003300}
      .signal-card:hover{border-color:#00ff41;box-shadow:0 0 15px rgba(0,255,65,0.2)}
      .signal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
      .signal-symbol{font-weight:400;color:#00ff41;text-shadow:0 0 5px #00ff41}
      .signal-regime{font-size:10px;padding:3px 6px;border-radius:0;text-transform:uppercase;letter-spacing:1px}
      .signal-regime.trend{background:transparent;color:#00ffff;border:1px solid #00ffff;text-shadow:0 0 5px #00ffff}
      .signal-regime.range{background:transparent;color:#ff00ff;border:1px solid #ff00ff;text-shadow:0 0 5px #ff00ff}
      .signal-score{font-size:20px;font-weight:400;margin:8px 0;color:#00ff41;text-shadow:0 0 10px #00ff41}
      .signal-meta{font-size:11px;color:#008f11}
      
      .position-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #001a00}
      .position-row:last-child{border-bottom:none}
      .flash-close-btn{background:linear-gradient(135deg,#dc2626 0%,#991b1b 100%);color:white;border:none;padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;margin-left:8px;transition:all 0.2s;white-space:nowrap;font-family:inherit}
      .flash-close-btn:hover{background:linear-gradient(135deg,#ef4444 0%,#b91c1c 100%);transform:scale(1.05)}
      .buy-sol-btn{background:linear-gradient(135deg,#16a34a 0%,#15803d 100%);color:white;border:none;padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;margin-left:8px;transition:all 0.2s;white-space:nowrap;font-family:inherit}
      .buy-sol-btn:hover{background:linear-gradient(135deg,#22c55e 0%,#16a34a 100%);transform:scale(1.05)}
      .position-icon{width:32px;height:32px;background:transparent;border:1px solid #00ff41;border-radius:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:400;color:#00ff41;text-shadow:0 0 5px #00ff41}
      .position-info{flex:1}
      .position-name{font-weight:400;color:#00ff41;font-size:13px}
      .position-amount{font-size:11px;color:#008f11}
      .position-value{text-align:right}
      .position-usd{font-weight:400;color:#00ff41;font-size:13px;text-shadow:0 0 5px #00ff41}
      .position-pct{font-size:11px;color:#008f11}
      
      .tab-content{display:none}
      .tab-content.active{display:block}
      
      .live-indicator{width:8px;height:8px;background:#00ff41;border-radius:50%;animation:pulse 2s infinite;box-shadow:0 0 10px #00ff41}
      @keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 10px #00ff41}50%{opacity:0.5;box-shadow:0 0 20px #00ff41}}
      
      .ws-status{font-size:11px;color:#008f11;display:flex;align-items:center;gap:6px}
      
      .trending-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #001a00;cursor:pointer;transition:all 0.2s}
      .trending-row:hover{background:rgba(0,255,65,0.05);box-shadow:inset 0 0 20px rgba(0,255,65,0.1)}
      .trending-rank{width:24px;font-size:12px;color:#008f11;text-align:center}
      .trending-info{flex:1}
      .trending-symbol{font-weight:400;color:#00ff41;font-size:13px}
      .trending-name{font-size:11px;color:#008f11}
      .trending-price{text-align:right}
      .trending-usd{font-weight:400;color:#00ff41;font-size:13px}
      .trending-change{font-size:11px}
      .trending-change.up{color:#00ff41;text-shadow:0 0 5px #00ff41}
      .trending-change.down{color:#ff0040;text-shadow:0 0 5px #ff0040}
      
      .footer{text-align:center;padding:16px;color:#003300;font-size:11px;border-top:1px solid #003300}
      
      .settings-unsaved{position:sticky;top:0;z-index:100;background:rgba(0,0,0,0.95);border:1px solid #ffff00;color:#ffff00;padding:14px 24px;border-radius:0;display:flex;align-items:center;gap:16px;margin-bottom:20px;font-weight:400;font-size:13px;text-shadow:0 0 5px #ffff00;box-shadow:0 4px 20px rgba(255,255,0,0.2)}
      .save-btn{background:transparent;color:#00ff41;border:1px solid #00ff41;padding:10px 20px;border-radius:0;font-weight:400;cursor:pointer;font-size:12px;text-shadow:0 0 5px #00ff41;font-family:inherit;transition:all 0.2s}
      .save-btn:hover:not(:disabled){background:rgba(0,255,65,0.2);box-shadow:0 0 15px rgba(0,255,65,0.4)}
      .save-btn:disabled{opacity:0.5;cursor:not-allowed;text-shadow:none}
      .reset-btn{background:transparent;color:#888;border:1px solid #444;padding:10px 20px;border-radius:0;font-weight:400;cursor:pointer;font-size:12px;font-family:inherit;transition:all 0.2s}
      .reset-btn:hover{background:rgba(255,255,255,0.05);color:#ccc;border-color:#666}
      
      .settings-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
      @media(max-width:1200px){.settings-grid{grid-template-columns:1fr}}
      
      .settings-card{background:rgba(0,20,0,0.8);border-radius:0;border:1px solid #003300;overflow:hidden}
      .settings-card-header{background:linear-gradient(135deg,rgba(0,30,0,0.9),rgba(0,50,0,0.8));padding:20px;display:flex;gap:16px;align-items:flex-start;border-bottom:1px solid #003300}
      .settings-icon{font-size:24px;background:transparent;border:1px solid #00ff41;padding:12px;border-radius:0}
      .settings-card-header h3{color:#00ff41;font-size:16px;font-weight:400;margin:0 0 4px;text-shadow:0 0 5px #00ff41}
      .settings-card-header p{color:#008f11;font-size:12px;margin:0}
      .settings-body{padding:16px}
      
      .setting-row{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid #003300}
      .setting-row:last-child{border-bottom:none}
      .setting-label{flex:1}
      .setting-name{display:block;color:#00ff41;font-size:13px;font-weight:400;margin-bottom:2px}
      .setting-desc{display:block;color:#008f11;font-size:11px}
      
      .setting-select{background:#000;border:1px solid #003300;border-radius:0;color:#00ff41;padding:10px 14px;font-size:13px;min-width:180px;cursor:pointer;font-family:inherit}
      .setting-select:focus{outline:none;border-color:#00ff41;box-shadow:0 0 10px rgba(0,255,65,0.3)}
      
      .setting-input{background:#000;border:1px solid #003300;border-radius:0;color:#00ff41;padding:10px 14px;font-size:13px;width:100px;text-align:right;font-family:inherit}
      .setting-input:focus{outline:none;border-color:#00ff41;box-shadow:0 0 10px rgba(0,255,65,0.3)}
      .setting-input-sm{background:#000;border:1px solid #003300;border-radius:0;color:#00ff41;padding:8px 10px;font-size:13px;width:70px;text-align:right;font-family:inherit}
      .setting-input-sm:focus{outline:none;border-color:#00ff41;box-shadow:0 0 10px rgba(0,255,65,0.3)}
      
      .setting-input-group{display:flex;align-items:center;gap:8px}
      .setting-unit{color:#008f11;font-size:12px;min-width:50px}
      
      .setting-slider-group{display:flex;align-items:center;gap:12px}
      .setting-slider{-webkit-appearance:none;appearance:none;width:150px;height:8px;background:#001a00;border-radius:0;cursor:pointer;border:1px solid #003300;margin:0;padding:0}
      .setting-slider::-webkit-slider-runnable-track{width:100%;height:8px;background:#001a00;border:1px solid #003300;cursor:pointer}
      .setting-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:20px;height:20px;background:#00ff41;border-radius:0;cursor:grab;box-shadow:0 0 10px #00ff41;margin-top:-6px;border:none}
      .setting-slider::-webkit-slider-thumb:active{cursor:grabbing}
      .setting-slider::-moz-range-track{width:100%;height:8px;background:#001a00;border:1px solid #003300;cursor:pointer}
      .setting-slider::-moz-range-thumb{width:20px;height:20px;background:#00ff41;border-radius:0;cursor:grab;border:none;box-shadow:0 0 10px #00ff41}
      .setting-slider::-moz-range-thumb:active{cursor:grabbing}
      .setting-slider:focus{outline:none;border-color:#00ff41}
      
      .toast{position:fixed;bottom:24px;right:24px;padding:14px 24px;border-radius:0;font-size:13px;font-weight:400;z-index:1000;animation:slideIn 0.3s ease;font-family:inherit}
      .toast.success{background:transparent;color:#00ff41;border:1px solid #00ff41;text-shadow:0 0 5px #00ff41;box-shadow:0 0 20px rgba(0,255,65,0.3)}
      .toast.error{background:transparent;color:#ff0040;border:1px solid #ff0040;text-shadow:0 0 5px #ff0040;box-shadow:0 0 20px rgba(255,0,64,0.3)}
      @keyframes slideIn{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
      @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
      
      .equity-range-btn{background:transparent;border:1px solid #003300;border-radius:0;color:#008f11;padding:4px 10px;font-size:11px;cursor:pointer;transition:all 0.2s;font-family:inherit}
      .equity-range-btn:hover{color:#00ff41;border-color:#00ff41}
      .equity-range-btn.active{background:rgba(0,255,65,0.1);color:#00ff41;border-color:#00ff41;text-shadow:0 0 5px #00ff41}
      
      .export-btn{padding:12px 16px;background:transparent;border:1px solid #003300;border-radius:0;color:#00ff41;font-size:12px;font-weight:400;cursor:pointer;transition:all 0.2s;font-family:inherit}
      .export-btn:hover{background:rgba(0,255,65,0.1);border-color:#00ff41;box-shadow:0 0 10px rgba(0,255,65,0.2)}
      .export-btn.secondary{background:transparent;color:#008f11;border-color:#003300}
      .export-btn.secondary:hover{background:rgba(0,255,65,0.05);color:#00ff41}
      
      .perf-tabs{display:flex;gap:4px;margin-bottom:16px}
      .perf-tab{background:transparent;border:1px solid #003300;border-radius:0;color:#008f11;padding:8px 16px;font-size:12px;cursor:pointer;transition:all 0.2s;font-weight:400;font-family:inherit}
      .perf-tab:hover{color:#00ff41;border-color:#00ff41}
      .perf-tab.active{background:rgba(0,255,65,0.1);color:#00ff41;border-color:#00ff41;text-shadow:0 0 5px #00ff41}
      
      .metrics-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
      @media(max-width:1200px){.metrics-grid{grid-template-columns:repeat(2,1fr)}}
      @media(max-width:800px){.metrics-grid{grid-template-columns:1fr}}
      
      .metric-card{background:rgba(0,15,0,0.9);border-radius:0;padding:20px;border:1px solid #003300}
      .metric-card:hover{border-color:#00ff41}
      .metric-label{font-size:12px;color:#008f11;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
      .metric-value{font-size:24px;font-weight:400;color:#00ff41;text-shadow:0 0 10px #00ff41}
      .metric-value.positive{color:#00ff41;text-shadow:0 0 10px #00ff41}
      .metric-value.negative{color:#ff0040;text-shadow:0 0 10px #ff0040}
      .metric-sub{font-size:11px;color:#008f11;margin-top:4px}
      
      ::-webkit-scrollbar{width:8px;height:8px}
      ::-webkit-scrollbar-track{background:#000}
      ::-webkit-scrollbar-thumb{background:#003300;border:1px solid #00ff41}
      ::-webkit-scrollbar-thumb:hover{background:#004400}
      
      ::selection{background:#00ff41;color:#000}
      
      .slot-badge{font-size:10px;padding:3px 6px;border-radius:0;text-transform:uppercase;letter-spacing:1px}
      .slot-badge.core{background:transparent;color:#00ffff;border:1px solid #00ffff;text-shadow:0 0 5px #00ffff}
      .slot-badge.scout{background:transparent;color:#ff00ff;border:1px solid #ff00ff;text-shadow:0 0 5px #ff00ff}
      .reason-badge{font-size:10px;padding:2px 6px;border-radius:0;text-transform:uppercase}
      .reason-badge.trailing{color:#ff0040;border:1px solid #ff0040}
      .reason-badge.stale{color:#ffff00;border:1px solid #ffff00}
      .reason-badge.rotation{color:#00ffff;border:1px solid #00ffff}
      .reason-badge.promotion{color:#00ff41;border:1px solid #00ff41}
      
      .settings-card.advanced{border-color:#444}
      .settings-card.advanced summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px}
      .settings-card.advanced summary::-webkit-details-marker{display:none}
      .settings-card.advanced summary::before{content:'▶';color:#008f11;transition:transform 0.2s}
      .settings-card.advanced[open] summary::before{transform:rotate(90deg)}
      .helper-text{font-size:11px;color:#008f11;margin-bottom:12px;padding:0 20px}
      .setting-checkbox{width:20px;height:20px;accent-color:#00ff41;cursor:pointer;position:relative;z-index:10;flex-shrink:0}
      .stale-warning{color:#ffff00;text-shadow:0 0 5px #ffff00}
      .health-bar{height:4px;background:#001a00;margin-top:4px}
      .health-fill{height:100%;transition:width 0.3s}
      .slot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px}
      .slot-item{background:rgba(0,15,0,0.9);border:1px solid #003300;padding:8px;text-align:center}
      .slot-item.filled{border-color:#00ff41}
      .slot-item.empty{border-color:#003300;opacity:0.5}
      .position-health-row{display:flex;align-items:center;gap:12px;padding:10px;border-bottom:1px solid #003300}
      .position-health-row:last-child{border-bottom:none}
      .pnl-positive{color:#00ff41;text-shadow:0 0 5px #00ff41}
      .pnl-negative{color:#ff0040;text-shadow:0 0 5px #ff0040}
      .whale-indicator{font-size:14px;cursor:help}
      .whale-positive{color:#00ff41;text-shadow:0 0 5px #00ff41}
      .whale-negative{color:#ff0040;text-shadow:0 0 5px #ff0040}
      .whale-neutral{color:#666;opacity:0.6}
      .whale-badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:6px;cursor:help}
      .whale-badge.positive{background:rgba(0,255,65,0.15);color:#00ff41;border:1px solid #00ff41}
      .whale-badge.negative{background:rgba(255,0,64,0.15);color:#ff0040;border:1px solid #ff0040}
      .whale-badge.neutral{background:rgba(100,100,100,0.15);color:#666;border:1px solid #666}
      .whale-promo-ready{display:block;margin-top:4px;background:#00ff41;color:#000;padding:2px 4px;border-radius:2px;font-size:8px;font-weight:bold;text-align:center;animation:pulse 1.5s infinite}
    </style>
  </head>
  <body>
    <canvas id="matrix-bg"></canvas>
    <div class="main-content">
    <div class="header">
      <h1>SOLANA TRADER</h1>
      <div class="header-right">
        <span id="wallet-display" style="font-size:11px;color:#00ffff;margin-right:12px;cursor:pointer;border:1px solid #003333;padding:4px 8px;border-radius:0" title="Click to copy wallet address">
          <span id="wallet-addr">Loading...</span>
        </span>
        <span class="ws-status"><span id="ws-dot" class="status-dot yellow"></span><span id="ws-text">Connecting...</span></span>
        <span id="status-updated" style="font-size:10px;color:#008f11;margin-right:8px" title="Last status update">--</span>
        <span id="day-timer" style="font-size:12px;color:#94a3b8;margin-right:8px" title="Time until CST midnight reset">--:--:--</span>
        <button id="pause-btn" style="padding:6px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:none;margin-right:8px;background:#22c55e;color:#000">RUNNING</button>
        <span class="badge badge-paper" id="mode-badge">PAPER</span>
        <span class="badge badge-risk" id="risk-badge">MEDIUM</span>
        <a href="/logout" style="color:#94a3b8;font-size:12px">Logout</a>
      </div>
    </div>
    
    <div class="nav">
      <div class="nav-item active" data-tab="overview">Overview</div>
      <div class="nav-item" data-tab="signals">Signals</div>
      <div class="nav-item" data-tab="positions">Positions</div>
      <div class="nav-item" data-tab="trades">Trades</div>
      <div class="nav-item" data-tab="performance">Performance</div>
      <div class="nav-item" data-tab="rotation">Rotation</div>
      <div class="nav-item" data-tab="scanner">Market Scanner</div>
      <div class="nav-item" data-tab="settings">Settings</div>
      <div class="nav-item" data-tab="export">Data Export</div>
      <div class="nav-item" data-tab="diagnostics">Diagnostics</div>
    </div>
    
    <div class="container">
      <!-- OVERVIEW TAB -->
      <div id="tab-overview" class="tab-content active">
        <div class="grid">
          <div class="card">
            <h3>Portfolio Value</h3>
            <div class="stat" id="total-usd">$0.00</div>
            <div class="stat-small" id="total-sol">0.0000 SOL equiv</div>
            <div class="stat-small" id="spendable-sol" style="color:#00ffff;margin-top:4px">Spendable: -- SOL</div>
          </div>
          <div class="card">
            <h3>24h P&L</h3>
            <div class="stat" id="pnl-usd">$0.00</div>
            <div class="stat-small" id="pnl-pct">0.00%</div>
          </div>
          <div class="card">
            <h3>Daily Drawdown</h3>
            <div class="stat" id="drawdown">0.00%</div>
            <div class="stat-small">Limit: <span id="drawdown-limit">5.0</span>%</div>
            <div class="gauge"><div class="gauge-fill green" id="drawdown-bar" style="width:0%"></div></div>
          </div>
          <div class="card">
            <h3>Daily Turnover</h3>
            <div class="stat" id="turnover">$0.00</div>
            <div class="stat-small">Limit: <span id="turnover-limit">100</span>%</div>
            <div class="gauge"><div class="gauge-fill green" id="turnover-bar" style="width:0%"></div></div>
          </div>
        </div>
        
        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3>Equity History</h3>
              <div style="display:flex;gap:4px">
                <button class="equity-range-btn active" data-range="24h">24h</button>
                <button class="equity-range-btn" data-range="week">Week</button>
                <button class="equity-range-btn" data-range="month">Month</button>
                <button class="equity-range-btn" data-range="year">Year</button>
                <button class="equity-range-btn" data-range="all">All</button>
              </div>
            </div>
            <div class="chart-container tall">
              <canvas id="equity-chart"></canvas>
            </div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Active Positions</h3>
            </div>
            <div id="positions-mini"></div>
          </div>
        </div>
        
        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3>Signal Overview</h3>
            </div>
            <div id="signals-mini" class="signal-grid"></div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Recent Activity</h3>
            </div>
            <div id="trades-mini" class="table-scroll" style="max-height:250px"></div>
          </div>
        </div>
      </div>
      
      <!-- SIGNALS TAB -->
      <div id="tab-signals" class="tab-content">
        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3>Live Signals</h3>
            </div>
            <div id="signals-full" class="signal-grid"></div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Signal History</h3>
            </div>
            <div class="chart-container tall">
              <canvas id="signal-chart"></canvas>
            </div>
          </div>
        </div>
      </div>
      
      <!-- POSITIONS TAB -->
      <div id="tab-positions" class="tab-content">
        <div class="grid-3">
          <div class="card" style="grid-column: span 2">
            <div class="card-header">
              <h3>Portfolio Breakdown</h3>
            </div>
            <div id="positions-full"></div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Allocation</h3>
            </div>
            <div class="chart-container">
              <canvas id="allocation-chart"></canvas>
            </div>
          </div>
        </div>
      </div>
      
      <!-- TRADES TAB -->
      <div id="tab-trades" class="tab-content">
        <div class="card">
          <div class="card-header">
            <h3>Trade History</h3>
          </div>
          <div id="trades-full" class="table-scroll"></div>
        </div>
      </div>
      
      <!-- PERFORMANCE TAB -->
      <div id="tab-performance" class="tab-content">
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">
            <h3>Performance Analytics</h3>
          </div>
          <div class="perf-tabs">
            <button class="perf-tab active" data-period="daily">Daily</button>
            <button class="perf-tab" data-period="weekly">Weekly</button>
            <button class="perf-tab" data-period="monthly">Monthly</button>
            <button class="perf-tab" data-period="yearly">Yearly</button>
            <button class="perf-tab" data-period="all">All-Time</button>
          </div>
        </div>
        
        <div id="metrics-container">
          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-label">Total P&L</div>
              <div class="metric-value" id="metric-pnl">$0.00</div>
              <div class="metric-sub" id="metric-period-label">All Time</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Percent Return</div>
              <div class="metric-value" id="metric-return">0.00%</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Win Rate</div>
              <div class="metric-value" id="metric-winrate">0.00%</div>
              <div class="metric-sub" id="metric-winloss">0 wins / 0 losses</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Total Trades</div>
              <div class="metric-value" id="metric-trades">0</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Avg Trade Size</div>
              <div class="metric-value" id="metric-avgsize">$0.00</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Turnover</div>
              <div class="metric-value" id="metric-turnover">$0.00</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Best Trade</div>
              <div class="metric-value positive" id="metric-best">$0.00</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Worst Trade</div>
              <div class="metric-value negative" id="metric-worst">$0.00</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Max Drawdown</div>
              <div class="metric-value negative" id="metric-drawdown">0.00%</div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- ROTATION TAB -->
      <div id="tab-rotation" class="tab-content">
        <div class="grid-2" style="margin-bottom:20px">
          <div class="card">
            <div class="card-header">
              <h3>Core Slots</h3>
              <span id="core-slot-count" style="font-size:12px;color:#00ffff">0/5</span>
            </div>
            <div id="core-slots-grid" class="slot-grid">
              <div class="empty">Loading...</div>
            </div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Scout Slots</h3>
              <span id="scout-slot-count" style="font-size:12px;color:#ff00ff">0/10</span>
            </div>
            <div id="scout-slots-grid" class="slot-grid">
              <div class="empty">Loading...</div>
            </div>
          </div>
        </div>
        
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">
            <h3>Position Health</h3>
            <span class="card-action rotation-refresh">Refresh</span>
          </div>
          <div id="position-health-list" class="table-scroll" style="max-height:300px">
            <div class="empty">No positions tracked</div>
          </div>
        </div>
        
        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3>Rotation Activity</h3>
              <span class="card-action rotation-refresh">Refresh</span>
            </div>
            <div id="rotation-log-list" class="table-scroll" style="max-height:350px">
              <div class="empty">No rotation activity yet</div>
            </div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Weekly Report</h3>
              <span class="card-action rotation-refresh">Refresh</span>
            </div>
            <div id="weekly-report-content">
              <div class="empty">Loading report...</div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- SCANNER TAB -->
      <div id="tab-scanner" class="tab-content">
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">
            <h3>Market Scanner Controls</h3>
            <div style="display:flex;gap:12px;align-items:center">
              <span id="scanner-status" style="font-size:12px;color:#64748b">Last scan: Never</span>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer">
                <input type="checkbox" id="scanner-auto-refresh" style="accent-color:#818cf8"> Auto-refresh
              </label>
              <button id="scanner-refresh-btn" class="save-btn" style="padding:8px 16px">Refresh Now</button>
            </div>
          </div>
          <div style="display:flex;gap:24px;padding-top:8px">
            <div><span style="color:#64748b;font-size:12px">Source:</span> <span style="color:#818cf8;font-size:12px">DexScreener</span></div>
            <div id="scanner-stats" style="color:#64748b;font-size:12px"></div>
          </div>
        </div>
        
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">
            <h3>Top Opportunities</h3>
            <span class="card-action scanner-refresh-action">Refresh</span>
          </div>
          <div id="opportunities-list" class="table-scroll" style="max-height:350px"></div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3>Trending Tokens</h3>
              <span class="card-action scanner-data-refresh">Refresh</span>
            </div>
            <div id="trending-list" class="table-scroll" style="max-height:450px"></div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>New Listings</h3>
              <span class="card-action scanner-data-refresh">Refresh</span>
            </div>
            <div id="listings-list" class="table-scroll" style="max-height:450px"></div>
          </div>
        </div>
      </div>
      
      <!-- SETTINGS TAB -->
      <div id="tab-settings" class="tab-content">
        <div id="settings-unsaved" class="settings-unsaved" style="display:none">
          <span>You have unsaved changes</span>
          <button id="settings-save-btn" class="save-btn">Save Changes</button>
          <button id="settings-reset-btn" class="reset-btn">Cancel</button>
        </div>
        
        <div class="settings-grid">
          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Trading Configuration</h3>
                <p>Core trading parameters and mode settings</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="Sets overall trading aggressiveness. Conservative = smaller positions, tighter stops; Aggressive = larger positions, wider stops. Selecting a profile auto-fills recommended values for position sizing, risk limits, and trailing stops.">
                <div class="setting-label">
                  <span class="setting-name">Risk Profile</span>
                  <span class="setting-desc">Trading aggressiveness level - loads preset values</span>
                </div>
                <select id="cfg-riskProfile" class="setting-select" onchange="applyRiskProfilePreset()">
                  <option value="">Loading...</option>
                </select>
              </div>
              <div class="setting-row" title="Paper mode simulates trades without real execution - use for testing strategies. Live mode executes real trades on Solana. Switch to Live only after verifying your settings in Paper mode.">
                <div class="setting-label">
                  <span class="setting-name">Execution Mode</span>
                  <span class="setting-desc">Paper trading or live execution</span>
                </div>
                <select id="cfg-executionMode" class="setting-select" onchange="updateField('executionMode', this.value)">
                  <option value="paper">Paper Trading</option>
                  <option value="live">Live Trading</option>
                </select>
              </div>
              <div class="setting-row" title="How often the bot evaluates positions and executes trades. Lower = more responsive but higher API usage and fees. Higher = less trading activity. 30-60 seconds is typical for active trading.">
                <div class="setting-label">
                  <span class="setting-name">Loop Interval</span>
                  <span class="setting-desc">Seconds between trading cycles (5-3600)</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-loopSeconds" class="setting-input" min="5" max="3600" oninput="updateFieldNum('loopSeconds', this.value, true)">
                  <span class="setting-unit">sec</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Risk Management</h3>
                <p>Portfolio protection and exposure limits</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="Circuit breaker that pauses all trading if daily losses exceed this threshold. Protects against cascading losses during market crashes. Lower values = more conservative, higher = allows more volatility.">
                <div class="setting-label">
                  <span class="setting-name">Max Daily Drawdown</span>
                  <span class="setting-desc">Maximum allowed daily loss before pause</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-maxDailyDrawdownPct-slider" class="setting-slider" min="1" max="50" oninput="syncSlider('maxDailyDrawdownPct')">
                  <input type="number" id="cfg-maxDailyDrawdownPct" class="setting-input-sm" min="1" max="50" step="0.5" onchange="syncInput('maxDailyDrawdownPct'); markUnsaved()" oninput="syncInput('maxDailyDrawdownPct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Limits concentration in any single token. Works with Max Positions and Top-3 Concentration for diversification. 10-20% is typical; lower for more diversification, higher if you want concentrated bets.">
                <div class="setting-label">
                  <span class="setting-name">Max Position Size</span>
                  <span class="setting-desc">Maximum % of portfolio per asset</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-maxPositionPctPerAsset-slider" class="setting-slider" min="1" max="50" oninput="syncSlider('maxPositionPctPerAsset')">
                  <input type="number" id="cfg-maxPositionPctPerAsset" class="setting-input-sm" min="1" max="50" step="0.5" onchange="syncInput('maxPositionPctPerAsset'); markUnsaved()" oninput="syncInput('maxPositionPctPerAsset'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Caps total daily trading volume relative to portfolio size. Prevents excessive churning and fee accumulation. 100% = can trade full portfolio value once per day. Increase if bot needs more trading capacity.">
                <div class="setting-label">
                  <span class="setting-name">Max Daily Turnover</span>
                  <span class="setting-desc">Maximum trading volume as % of portfolio</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-maxTurnoverPctPerDay-slider" class="setting-slider" min="10" max="100000" oninput="syncSlider('maxTurnoverPctPerDay')">
                  <input type="number" id="cfg-maxTurnoverPctPerDay" class="setting-input-sm" min="10" max="100000" step="10" onchange="syncInput('maxTurnoverPctPerDay'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Automatically sells a position when profit reaches this level. Locks in gains before potential reversal. Works alongside trailing stops - whichever triggers first. 20-50% is typical for meme tokens.">
                <div class="setting-label">
                  <span class="setting-name">Take Profit %</span>
                  <span class="setting-desc">Auto-sell when position gains this percentage</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-takeProfitPct-slider" class="setting-slider" min="1" max="100" oninput="syncSlider('takeProfitPct')">
                  <input type="number" id="cfg-takeProfitPct" class="setting-input-sm" min="1" max="100" step="1" onchange="syncInput('takeProfitPct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Portfolio Limits</h3>
                <p>Diversification and concentration rules</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="Total number of tokens the bot can hold simultaneously. Split between core slots (larger positions) and scout slots (smaller test positions). More positions = more diversification but harder to manage.">
                <div class="setting-label">
                  <span class="setting-name">Max Positions</span>
                  <span class="setting-desc">Maximum number of concurrent positions</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-maxPositions" class="setting-input" min="1" max="100" oninput="updateFieldNum('maxPositions', this.value, true)">
                  <span class="setting-unit">positions</span>
                </div>
              </div>
              <div class="setting-row" title="Number of core slots for larger, higher-conviction positions. Core positions get more capital allocation and are targets for scout promotions.">
                <div class="setting-label">
                  <span class="setting-name">Core Slots</span>
                  <span class="setting-desc">Slots for larger core positions</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-coreSlots" class="setting-input" min="0" max="50" oninput="updateFieldNum('coreSlots', this.value, true)">
                  <span class="setting-unit">slots</span>
                </div>
              </div>
              <div class="setting-row" title="Number of scout slots for smaller test positions. Scouts are automatically bought when opportunities are found. Increase this to allow more autonomous buying.">
                <div class="setting-label">
                  <span class="setting-name">Scout Slots</span>
                  <span class="setting-desc">Slots for smaller scout positions</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutSlots" class="setting-input" min="0" max="100" oninput="updateFieldNum('scoutSlots', this.value, true)">
                  <span class="setting-unit">slots</span>
                </div>
              </div>
              <div class="setting-row" title="Target allocation percentage for each core position. A value of 12% means each core position should target ~12% of total portfolio. This controls how much capital is allocated to high-conviction positions.">
                <div class="setting-label">
                  <span class="setting-name">Core Position Target</span>
                  <span class="setting-desc">Target allocation per core position</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-corePositionPctTarget-slider" class="setting-slider" min="5" max="40" oninput="syncSlider('corePositionPctTarget')">
                  <input type="number" id="cfg-corePositionPctTarget" class="setting-input-sm" min="5" max="40" step="1" onchange="syncInput('corePositionPctTarget'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Limits how much of your portfolio can be in your 3 largest positions combined. Prevents over-concentration. 60% means top 3 tokens can't exceed 60% of total value. Lower = more diversified.">
                <div class="setting-label">
                  <span class="setting-name">Top-3 Concentration</span>
                  <span class="setting-desc">Max % in three largest positions</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-maxTop3ConcentrationPct-slider" class="setting-slider" min="30" max="100" oninput="syncSlider('maxTop3ConcentrationPct')">
                  <input type="number" id="cfg-maxTop3ConcentrationPct" class="setting-input-sm" min="30" max="100" step="1" onchange="syncInput('maxTop3ConcentrationPct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Upper limit on portfolio-wide volatility based on weighted position volatilities. When exceeded, the bot reduces exposure to high-volatility tokens. Higher values allow more volatile portfolios.">
                <div class="setting-label">
                  <span class="setting-name">Max Portfolio Volatility</span>
                  <span class="setting-desc">Target portfolio volatility cap</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-maxPortfolioVolatility-slider" class="setting-slider" min="10" max="10000" oninput="syncSlider('maxPortfolioVolatility')">
                  <input type="number" id="cfg-maxPortfolioVolatility" class="setting-input-sm" min="10" max="10000" step="1" onchange="syncInput('maxPortfolioVolatility'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Execution Parameters</h3>
                <p>Trade execution and slippage settings</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="Maximum price deviation accepted during swap execution. 100 bps = 1%. Higher allows trades in volatile/illiquid tokens but risks worse prices. Lower protects execution quality but may fail more often.">
                <div class="setting-label">
                  <span class="setting-name">Max Slippage</span>
                  <span class="setting-desc">Maximum allowed slippage in basis points</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-maxSlippageBps" class="setting-input" min="1" max="2000" oninput="updateFieldNum('maxSlippageBps', this.value, true)">
                  <span class="setting-unit">bps</span>
                </div>
              </div>
              <div class="setting-row" title="Caps the size of any single swap transaction. Larger trades may be split into multiple swaps. Protects against excessive slippage on large orders. Increase for bigger positions, decrease for illiquid tokens.">
                <div class="setting-label">
                  <span class="setting-name">Max Single Swap</span>
                  <span class="setting-desc">Maximum SOL per single swap transaction</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-maxSingleSwapSol" class="setting-input" min="0.01" max="1000" step="0.1" oninput="updateFieldNum('maxSingleSwapSol', this.value, false)">
                  <span class="setting-unit">SOL</span>
                </div>
              </div>
              <div class="setting-row" title="Trades below this USD value are skipped to avoid wasting fees on tiny adjustments. Should be at least 2-3x your average transaction fee. Increase if you're seeing too many small trades.">
                <div class="setting-label">
                  <span class="setting-name">Min Trade Size</span>
                  <span class="setting-desc">Minimum USD value for trade execution</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-minTradeUsd" class="setting-input" min="1" max="1000000" step="1" oninput="updateFieldNum('minTradeUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
            </div>
          </div>
          
          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Scanner Configuration</h3>
                <p>Market scanner filters and thresholds</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="Filters out tokens with insufficient liquidity. Low liquidity = high slippage and difficulty exiting positions. $10,000-$50,000 minimum is typical. Increase for safer trading, decrease to catch early opportunities.">
                <div class="setting-label">
                  <span class="setting-name">Min Liquidity</span>
                  <span class="setting-desc">Minimum liquidity in USD</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scannerMinLiquidity" class="setting-input" min="0" max="10000000" step="1000" oninput="updateFieldNum('scannerMinLiquidity', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Filters out tokens with low trading activity. Higher volume = more reliable price discovery and easier entry/exit. $5,000-$25,000 is typical. Lower for newer tokens, higher for established ones.">
                <div class="setting-label">
                  <span class="setting-name">Min Volume 24h</span>
                  <span class="setting-desc">Minimum 24h trading volume in USD</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scannerMinVolume24h" class="setting-input" min="0" max="10000000" step="1000" oninput="updateFieldNum('scannerMinVolume24h', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Filters out tokens with too few holders. More holders = more distributed ownership, less rug risk. 50-200 is typical minimum. Lower catches newer tokens, higher filters for established projects.">
                <div class="setting-label">
                  <span class="setting-name">Min Holders</span>
                  <span class="setting-desc">Minimum number of token holders</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scannerMinHolders" class="setting-input" min="0" max="100000" step="10" oninput="updateFieldNum('scannerMinHolders', this.value, true)">
                  <span class="setting-unit">holders</span>
                </div>
              </div>
              <div class="setting-row" title="Filters out tokens that have pumped too much in 24h. Helps avoid buying at the top after a major run-up. 100-500% is typical. Lower = more conservative, higher = allows more volatile entries.">
                <div class="setting-label">
                  <span class="setting-name">Max Price Change 24h</span>
                  <span class="setting-desc">Maximum allowed 24h price change</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scannerMaxPriceChange24h" class="setting-input" min="-100" max="10000" step="10" oninput="updateFieldNum('scannerMaxPriceChange24h', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Filters out tokens with negative momentum. Positive value = only buy tokens already trending up. Negative allows buying dips. -20% to +10% is typical. Set higher for momentum strategy, lower for contrarian.">
                <div class="setting-label">
                  <span class="setting-name">Min Price Change 24h</span>
                  <span class="setting-desc">Minimum allowed 24h price change</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scannerMinPriceChange24h" class="setting-input" min="-100" max="10000" step="10" oninput="updateFieldNum('scannerMinPriceChange24h', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Signal & Ranking Weights</h3>
                <p>Weights determine how different factors contribute to position ranking</p>
              </div>
            </div>
            <p class="helper-text">Higher weight = more influence on ranking score</p>
            <div class="settings-body">
              <div class="setting-row" title="How much the strategy signal score affects position ranking. Higher = positions with strong buy signals rank better. Set to 0 to ignore signals in ranking. Works with other weights to create composite score.">
                <div class="setting-label">
                  <span class="setting-name">Signal Weight</span>
                  <span class="setting-desc">Weight for trading signal strength</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingSignalWeight" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('rankingSignalWeight', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="How much recent price momentum affects ranking. Higher = positions with strong upward momentum rank better. Good for trend-following strategies. Lower for mean-reversion approaches.">
                <div class="setting-label">
                  <span class="setting-name">Momentum Weight</span>
                  <span class="setting-desc">Weight for price momentum</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingMomentumWeight" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('rankingMomentumWeight', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Penalizes older positions in ranking. Higher = older positions drop in rank faster, encouraging turnover. Lower = more patient holding. Interacts with Stale Penalty for long-held positions.">
                <div class="setting-label">
                  <span class="setting-name">Time Decay Weight</span>
                  <span class="setting-desc">Weight for position age decay</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingTimeDecayWeight" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('rankingTimeDecayWeight', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="How much trailing stop distance affects ranking. Higher = positions closer to their trailing stop rank lower. Helps prioritize safer positions over those at risk of stop-out.">
                <div class="setting-label">
                  <span class="setting-name">Trailing Weight</span>
                  <span class="setting-desc">Weight for trailing stop proximity</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingTrailingWeight" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('rankingTrailingWeight', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Favors positions with recently updated signals. Higher = stale signals hurt ranking more. Ensures the bot acts on current market data rather than outdated analysis.">
                <div class="setting-label">
                  <span class="setting-name">Freshness Weight</span>
                  <span class="setting-desc">Weight for signal freshness</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingFreshnessWeight" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('rankingFreshnessWeight', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="How much token quality (liquidity, volume, holders) affects ranking. Higher = high-quality tokens rank better. Balances between established tokens and riskier small-caps.">
                <div class="setting-label">
                  <span class="setting-name">Quality Weight</span>
                  <span class="setting-desc">Weight for token quality score</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingQualityWeight" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('rankingQualityWeight', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Negative score applied to positions flagged as stale (flat PnL for too long). More negative = stale positions drop rank faster and get rotated out sooner. Works with Stale Flag Hours setting.">
                <div class="setting-label">
                  <span class="setting-name">Stale Penalty</span>
                  <span class="setting-desc">Negative penalty for stale positions</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingStalePenalty" class="setting-input" max="0" step="0.1" oninput="updateFieldNum('rankingStalePenalty', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Negative score applied when a position is close to hitting its trailing stop. More negative = positions near stop-out rank lower. Helps the bot exit risky positions before forced liquidation.">
                <div class="setting-label">
                  <span class="setting-name">Trailing Stop Penalty</span>
                  <span class="setting-desc">Negative penalty when near trailing stop</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-rankingTrailingStopPenalty" class="setting-input" max="0" step="0.1" oninput="updateFieldNum('rankingTrailingStopPenalty', this.value, false)">
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Scout Promotion Criteria</h3>
                <p>Conditions for promoting scout positions to core slots</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="Scout must achieve this profit percentage before it can be promoted to a core position. Higher = more proof of performance required. 10-25% is typical. Works with Min Hours Held and Min Signal Score.">
                <div class="setting-label">
                  <span class="setting-name">Min PnL % for Promotion</span>
                  <span class="setting-desc">Minimum profit percentage to promote</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-promotionMinPnlPct" class="setting-input" min="0" max="500" step="1" oninput="updateFieldNum('promotionMinPnlPct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Scout must have at least this signal score from the strategy engine to be promoted. Ensures the token still looks good fundamentally. 1-3 for relaxed, 5+ for strict. Set to 0 to promote based on PnL alone.">
                <div class="setting-label">
                  <span class="setting-name">Min Signal Score</span>
                  <span class="setting-desc">Minimum signal score required</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-promotionMinSignalScore" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('promotionMinSignalScore', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Scout must be held for at least this many minutes before promotion. Prevents promoting flash pumps. 15-60 minutes is typical for active trading, 120+ for conservative.">
                <div class="setting-label">
                  <span class="setting-name">Promotion Delay</span>
                  <span class="setting-desc">Minutes before promotion eligible</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-promotionDelayMinutes" class="setting-input" min="0" max="1440" step="1" oninput="updateFieldNum('promotionDelayMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Re-entry Controls</h3>
                <p>Settings for re-entering exited positions</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="When enabled, the bot can re-buy tokens it recently sold if they show renewed strength. Useful for catching second waves after stop-outs. Disable if you prefer clean exits.">
                <div class="setting-label">
                  <span class="setting-name">Re-entry Enabled</span>
                  <span class="setting-desc">Allow re-entry into recently exited positions</span>
                </div>
                <input type="checkbox" id="cfg-reentryEnabled" class="setting-checkbox" onchange="updateFieldBool('reentryEnabled', this.checked)">
              </div>
              <div class="setting-row" title="After exiting a position, wait at least this many minutes before considering re-entry. Prevents whipsawing back in immediately. 5-15 minutes is typical. Must be less than Re-entry Window.">
                <div class="setting-label">
                  <span class="setting-name">Cooldown</span>
                  <span class="setting-desc">Minutes to wait after exit before re-entry</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-reentryCooldownMinutes" class="setting-input" min="0" max="60" step="1" oninput="updateFieldNum('reentryCooldownMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
              <div class="setting-row" title="Re-entry is only allowed within this many minutes after exit. After this window closes, the token goes back to normal cooldown. 30-60 minutes is typical. Longer = more re-entry opportunities.">
                <div class="setting-label">
                  <span class="setting-name">Window</span>
                  <span class="setting-desc">Minutes after exit during which re-entry is allowed</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-reentryWindowMinutes" class="setting-input" min="1" max="120" step="1" oninput="updateFieldNum('reentryWindowMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
              <div class="setting-row" title="Token must have at least this momentum score to trigger re-entry. Ensures you're re-buying into strength, not catching a falling knife. 5-7 is typical. Higher = more selective re-entries.">
                <div class="setting-label">
                  <span class="setting-name">Min Momentum Score</span>
                  <span class="setting-desc">Minimum momentum score for re-entry</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-reentryMinMomentumScore" class="setting-input" min="0" max="10" step="0.1" oninput="updateFieldNum('reentryMinMomentumScore', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Multiplies the original position size on re-entry. 1.0 = same size, 2.0 = double down. Higher = more aggressive averaging. Use with caution as it increases exposure to volatile tokens.">
                <div class="setting-label">
                  <span class="setting-name">Size Multiplier</span>
                  <span class="setting-desc">Multiplier for re-entry position size</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-reentrySizeMultiplier" class="setting-input" min="0.5" max="10" step="0.5" oninput="updateFieldNum('reentrySizeMultiplier', this.value, false)">
                  <span class="setting-unit">x</span>
                </div>
              </div>
              <div class="setting-row" title="Caps re-entry size as a fraction of the normal position limit. 0.5 = re-entry can only be half the normal max position. Prevents over-concentration on re-entries. 0.5-0.8 is typical.">
                <div class="setting-label">
                  <span class="setting-name">Max SOL % of Limit</span>
                  <span class="setting-desc">Max percentage of SOL limit for re-entry</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-reentryMaxSolPct" class="setting-input" min="0.1" max="1" step="0.1" oninput="updateFieldNum('reentryMaxSolPct', this.value, false)">
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Operational Limits</h3>
                <p>Operational thresholds and transfer settings</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="Limits how much portfolio rebalancing can occur in a single tick. Prevents sudden large shifts. 10-25% is typical. Lower = smoother rebalancing over time, higher = faster response to concentration violations.">
                <div class="setting-label">
                  <span class="setting-name">Max Rebalance % per Tick</span>
                  <span class="setting-desc">Maximum concentration rebalance per tick</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-concentrationRebalanceMaxPct" class="setting-input" min="1" max="100" step="1" oninput="updateFieldNum('concentrationRebalanceMaxPct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Minimum USD value for token transfers to be processed. Below this threshold, transfers are skipped to avoid wasting fees on dust amounts. $5-$10 is typical.">
                <div class="setting-label">
                  <span class="setting-name">Transfer Threshold</span>
                  <span class="setting-desc">Minimum USD value for transfers</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-transferThresholdUsd" class="setting-input" min="1" max="100" step="1" oninput="updateFieldNum('transferThresholdUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Autonomous Scouts</h3>
                <p>Configure autonomous token discovery and buying</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="When enabled, the bot automatically discovers and buys promising tokens from the scanner. Tokens passing the scanner filters get queued for purchase. Disable if you prefer manual token selection only.">
                <div class="setting-label">
                  <span class="setting-name">Enable Autonomous Scouts</span>
                  <span class="setting-desc">Automatically discover and buy promising tokens</span>
                </div>
                <input type="checkbox" id="cfg-autonomousScoutsEnabled" class="setting-checkbox" onchange="updateFieldBool('autonomousScoutsEnabled', this.checked)">
              </div>
              <div class="setting-row" title="When enabled, simulates scout buys and logs them without executing real trades. Use this to test your scanner settings and see what the bot would buy before enabling live autonomous trading.">
                <div class="setting-label">
                  <span class="setting-name">Dry Run Mode</span>
                  <span class="setting-desc">Simulate buys without executing trades</span>
                </div>
                <input type="checkbox" id="cfg-autonomousDryRun" class="setting-checkbox" onchange="updateFieldBool('autonomousDryRun', this.checked)">
              </div>
              <div class="setting-row" title="Tokens from the scanner must achieve at least this score to be automatically queued for purchase. Higher = more selective. 15-25 is typical. Works with Scanner Filters to determine eligibility.">
                <div class="setting-label">
                  <span class="setting-name">Auto-Queue Score</span>
                  <span class="setting-desc">Minimum score to auto-queue tokens</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutAutoQueueScore" class="setting-input" min="1" max="50" step="1" oninput="updateFieldNum('scoutAutoQueueScore', this.value, true)">
                </div>
              </div>
              <div class="setting-row" title="SOL amount spent on each autonomous scout purchase. Keep this small since scouts are test positions. 0.02-0.1 SOL is typical. If scout performs well, it gets promoted to a larger core position.">
                <div class="setting-label">
                  <span class="setting-name">Scout Buy Amount</span>
                  <span class="setting-desc">SOL amount per scout buy</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutBuySol" class="setting-input" min="0.01" max="1" step="0.01" oninput="updateFieldNum('scoutBuySol', this.value, false)">
                  <span class="setting-unit">SOL</span>
                </div>
              </div>
              <div class="setting-row" title="Always keep at least this much SOL in wallet for fees and emergencies. Bot won't make scout buys that would drop SOL below this level. 0.1-0.2 SOL is typical. Works with TX Fee Buffer.">
                <div class="setting-label">
                  <span class="setting-name">Min SOL Reserve</span>
                  <span class="setting-desc">Keep at least this much SOL in wallet</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-minSolReserve" class="setting-input" min="0.05" max="1" step="0.01" oninput="updateFieldNum('minSolReserve', this.value, false)">
                  <span class="setting-unit">SOL</span>
                </div>
              </div>
              <div class="setting-row" title="After exiting a token (win or loss), wait this many hours before the scanner can queue it again. Prevents repeatedly buying the same underperformer. 12-48 hours is typical.">
                <div class="setting-label">
                  <span class="setting-name">Token Cooldown</span>
                  <span class="setting-desc">Hours before re-buying same token</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutTokenCooldownHours" class="setting-input" min="1" max="168" step="1" oninput="updateFieldNum('scoutTokenCooldownHours', this.value, true)">
                  <span class="setting-unit">hrs</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum number of autonomous scout purchases per day. Limits exposure and SOL expenditure. 3-5 is typical for conservative trading. Increase for more aggressive token discovery.">
                <div class="setting-label">
                  <span class="setting-name">Daily Buy Limit</span>
                  <span class="setting-desc">Maximum scout buys per day</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutDailyLimit" class="setting-input" min="1" max="1000000" step="1" oninput="updateFieldNum('scoutDailyLimit', this.value, true)">
                  <span class="setting-unit">buys</span>
                </div>
              </div>
              <div class="setting-row" title="How often the scout system checks the queue for tokens ready to buy. Lower = faster execution but more API calls. Higher = less responsive. 60-120 seconds is typical.">
                <div class="setting-label">
                  <span class="setting-name">Queue Poll Interval</span>
                  <span class="setting-desc">Seconds between queue checks</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutQueuePollSeconds" class="setting-input" min="30" max="300" step="10" oninput="updateFieldNum('scoutQueuePollSeconds', this.value, true)">
                  <span class="setting-unit">sec</span>
                </div>
              </div>
              <div class="setting-row" title="How often the market scanner runs to find new opportunities and add them to the scout queue. Lower = faster discovery but more API calls. 5 minutes is recommended for active trading.">
                <div class="setting-label">
                  <span class="setting-name">Scan Interval</span>
                  <span class="setting-desc">Minutes between market scans</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scanIntervalMinutes" class="setting-input" min="1" max="60" step="1" oninput="updateFieldNum('scanIntervalMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-card">
            <div class="settings-card-header">
              <div class="settings-icon"></div>
              <div>
                <h3>Whale Flow Confirmation</h3>
                <p>Gate trading decisions with whale flow signals</p>
              </div>
            </div>
            <div class="settings-body">
              <div class="setting-row" title="When enabled, scout promotions and new entries require positive whale flow confirmation. Whales (large traders) often have better information. Disable if you want faster execution without this gate.">
                <div class="setting-label">
                  <span class="setting-name">Enable Whale Confirmation</span>
                  <span class="setting-desc">Gate promotions and entries with whale flow signals</span>
                </div>
                <input type="checkbox" id="cfg-whaleConfirmEnabled" class="setting-checkbox" onchange="updateFieldBool('whaleConfirmEnabled', this.checked)">
              </div>
              <div class="setting-row" title="When enabled, logs whale signals and what decisions would have been blocked, but doesn't actually block anything. Use to evaluate whale confirmation before enabling it for real.">
                <div class="setting-label">
                  <span class="setting-name">Dry Run Mode</span>
                  <span class="setting-desc">Log signals without blocking trades</span>
                </div>
                <input type="checkbox" id="cfg-whaleConfirmDryRun" class="setting-checkbox" onchange="updateFieldBool('whaleConfirmDryRun', this.checked)">
              </div>
              <div class="setting-row" title="How often to check whale transaction data. Lower = more responsive to whale activity but more API calls. Higher = less responsive. 30-60 seconds is typical.">
                <div class="setting-label">
                  <span class="setting-name">Poll Interval</span>
                  <span class="setting-desc">Seconds between whale flow checks</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-whaleConfirmPollSeconds" class="setting-input" min="10" max="300" step="10" oninput="updateFieldNum('whaleConfirmPollSeconds', this.value, true)">
                  <span class="setting-unit">sec</span>
                </div>
              </div>
              <div class="setting-row" title="Look back this many minutes when calculating whale netflow. Shorter = more recent activity matters; longer = smooths out noise. 5-15 minutes is typical. Works with Netflow Trigger.">
                <div class="setting-label">
                  <span class="setting-name">Time Window</span>
                  <span class="setting-desc">Minutes of whale activity to analyze</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-whaleWindowMinutes" class="setting-input" min="1" max="60" step="1" oninput="updateFieldNum('whaleWindowMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
              <div class="setting-row" title="Transactions must be at least this USD value to count as 'whale' activity. Filters out retail noise. $1,000-$10,000 is typical depending on token market cap.">
                <div class="setting-label">
                  <span class="setting-name">Min Whale TX Size</span>
                  <span class="setting-desc">Minimum USD value to count as whale</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-whaleMinUsd" class="setting-input" min="100" max="100000" step="100" oninput="updateFieldNum('whaleMinUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Net whale buying must exceed this USD amount (buys minus sells) for positive confirmation. Higher = more conviction required. $5,000-$25,000 is typical. Works with Time Window.">
                <div class="setting-label">
                  <span class="setting-name">Netflow Trigger</span>
                  <span class="setting-desc">USD netflow needed for confirmation</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-whaleNetflowTriggerUsd" class="setting-input" min="100" max="1000000" step="100" oninput="updateFieldNum('whaleNetflowTriggerUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Price must have moved up at least this percentage to confirm market agrees with whale signal. Prevents acting on whale buys that didn't move price. 1-5% is typical.">
                <div class="setting-label">
                  <span class="setting-name">Market Confirm %</span>
                  <span class="setting-desc">Min price change % for market confirmation</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-marketConfirmPct" class="setting-input" min="0" max="50" step="0.1" oninput="updateFieldNum('marketConfirmPct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Skip trades where the expected price impact exceeds this threshold. 100 bps = 1%. Protects against excessive slippage on illiquid tokens. 200-500 bps is typical for meme tokens.">
                <div class="setting-label">
                  <span class="setting-name">Max Price Impact</span>
                  <span class="setting-desc">Maximum acceptable price impact</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-maxPriceImpactBps" class="setting-input" min="10" max="1000" step="10" oninput="updateFieldNum('maxPriceImpactBps', this.value, true)">
                  <span class="setting-unit">bps</span>
                </div>
              </div>
              <div class="setting-row" title="If whale netflow goes this negative (whales selling), trigger an exit signal. More negative = requires more whale selling to trigger. -$10,000 to -$50,000 is typical.">
                <div class="setting-label">
                  <span class="setting-name">Exit Netflow Threshold</span>
                  <span class="setting-desc">Negative USD netflow to trigger exit signal</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-exitNetflowUsd" class="setting-input" min="-1000000" max="0" step="100" oninput="updateFieldNum('exitNetflowUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Trailing stop drawdown percentage for whale-confirmed positions. When price drops this much from its peak, exit. Works as an additional layer on top of regular trailing stops. 10-20% is typical.">
                <div class="setting-label">
                  <span class="setting-name">Exit Trail Drawdown</span>
                  <span class="setting-desc">Trailing stop drawdown percentage</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-exitTrailDrawdownPct" class="setting-input" min="1" max="50" step="1" oninput="updateFieldNum('exitTrailDrawdownPct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="If a scout position doesn't achieve positive PnL within this time, it's marked as underperforming. Underperformers get lower ranking and may be rotated out. 30-120 minutes is typical.">
                <div class="setting-label">
                  <span class="setting-name">Scout Underperform Time</span>
                  <span class="setting-desc">Minutes before marking scout as underperforming</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutUnderperformMinutes" class="setting-input" min="10" max="1440" step="10" oninput="updateFieldNum('scoutUnderperformMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
              <div class="setting-row" title="Minimum minutes between whale-gated actions on the same token. Prevents rapid-fire promotions or entries based on the same whale signal. 5-30 minutes is typical.">
                <div class="setting-label">
                  <span class="setting-name">Whale Cooldown</span>
                  <span class="setting-desc">Minutes between whale-gated actions</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-whaleCooldownMinutes" class="setting-input" min="1" max="1440" step="1" oninput="updateFieldNum('whaleCooldownMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
            </div>
          </div>

          <details class="settings-card advanced">
            <summary>
              <div class="settings-card-header" style="border-bottom:none">
                <div class="settings-icon"></div>
                <div>
                  <h3>Advanced Flow Controls</h3>
                  <p>Tune promotion speed, exit thresholds, and deployment timing</p>
                </div>
              </div>
            </summary>
            <p class="helper-text">Adjust these to speed up SOL deployment or make the bot more cautious</p>
            <div class="settings-body">
              <div class="setting-row" title="When you manually add a token to the universe, immediately purchase a scout-sized position (uses scoutBuySol amount). Respects slot limits, SOL reserves, and whale confirmation if enabled.">
                <div class="setting-label">
                  <span class="setting-name">Manual Scout Buy</span>
                  <span class="setting-desc">Auto-buy scout position when manually adding tokens</span>
                </div>
                <input type="checkbox" id="cfg-manualScoutBuyEnabled" class="setting-checkbox" onchange="updateFieldBool('manualScoutBuyEnabled', this.checked)">
              </div>
              <div class="setting-row" title="Minimum time a scout must be held before it can be promoted to a core position. Works alongside Min Hours Held (promotion eligibility). Lower = faster deployment.">
                <div class="setting-label">
                  <span class="setting-name">Promotion Delay</span>
                  <span class="setting-desc">Minimum minutes before scout can promote to core</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-promotionDelayMinutes" class="setting-input" min="1" max="1440" step="1" oninput="updateFieldNum('promotionDelayMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
              <div class="setting-row" title="After a scout hits its stop-loss or is flagged for rotation, wait this many minutes before selling. Gives temporary dips a chance to recover.">
                <div class="setting-label">
                  <span class="setting-name">Scout Grace Period</span>
                  <span class="setting-desc">Minutes before underperforming scout gets dropped</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutGraceMinutes" class="setting-input" min="1" max="120" step="1" oninput="updateFieldNum('scoutGraceMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
              <div class="setting-row" title="If a scout position drops by this percentage from entry, exit immediately. Expressed as a decimal (0.18 = 18% loss). Scouts have tighter stops than core positions.">
                <div class="setting-label">
                  <span class="setting-name">Scout Stop Loss</span>
                  <span class="setting-desc">Max loss before exiting scout position</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutStopLossPct" class="setting-input" min="0.01" max="0.50" step="0.01" oninput="updateFieldNum('scoutStopLossPct', this.value, false)">
                  <span class="setting-unit">fraction</span>
                </div>
              </div>
              <div class="setting-row" title="If a scout reaches this profit %, attempt promotion (if eligible) or take-profit exit. Expressed as decimal (0.08 = 8%). Prevents round-trip losses on volatile scouts.">
                <div class="setting-label">
                  <span class="setting-name">Scout Take Profit</span>
                  <span class="setting-desc">Profit threshold for scout TP or promotion</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutTakeProfitPct" class="setting-input" min="0.01" max="0.50" step="0.01" oninput="updateFieldNum('scoutTakeProfitPct', this.value, false)">
                  <span class="setting-unit">fraction</span>
                </div>
              </div>
              <div class="setting-row" title="Minimum minutes a scout must be held before the take-profit rule can trigger. Prevents instant exits on price noise.">
                <div class="setting-label">
                  <span class="setting-name">Scout TP Min Hold</span>
                  <span class="setting-desc">Minimum hold time before scout TP triggers</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-scoutTpMinHoldMinutes" class="setting-input" min="0" max="60" step="1" oninput="updateFieldNum('scoutTpMinHoldMinutes', this.value, true)">
                  <span class="setting-unit">min</span>
                </div>
              </div>
              <div class="setting-row" title="If any core position drops by this percentage from entry, exit immediately. Expressed as a decimal (0.15 = 15% loss). This is a hard circuit breaker for core positions.">
                <div class="setting-label">
                  <span class="setting-name">Loss Exit Threshold</span>
                  <span class="setting-desc">Max loss before forced exit on core positions</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-lossExitPct" class="setting-input" min="0.01" max="0.50" step="0.01" oninput="updateFieldNum('lossExitPct', this.value, false)">
                  <span class="setting-unit">fraction</span>
                </div>
              </div>
              <div class="setting-row" title="If a position's PnL stays within this band (e.g. -5% to +5%) for too long, it's flagged as stale. Works with Stale Flag Hours and Stale Exit Hours below.">
                <div class="setting-label">
                  <span class="setting-name">Stale PnL Band</span>
                  <span class="setting-desc">Exit if PnL stuck in this band for too long</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-stalePnlBandPct" class="setting-input" min="0.01" max="0.20" step="0.01" oninput="updateFieldNum('stalePnlBandPct', this.value, false)">
                  <span class="setting-unit">fraction</span>
                </div>
              </div>
              <div class="setting-row" title="After this many hours, positions with PnL inside the Stale PnL Band get flagged as stale and receive a ranking penalty.">
                <div class="setting-label">
                  <span class="setting-name">Stale Flag Hours</span>
                  <span class="setting-desc">Hours before position is flagged stale</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-stalePositionHours" class="setting-input" min="1" max="720" step="1" oninput="updateFieldNum('stalePositionHours', this.value, true)">
                  <span class="setting-unit">hrs</span>
                </div>
              </div>
              <div class="setting-row" title="After this many hours with stale status (PnL flat within band), the position is force-exited regardless of other factors.">
                <div class="setting-label">
                  <span class="setting-name">Stale Exit Hours</span>
                  <span class="setting-desc">Hours before stale position is force-exited</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-staleExitHours" class="setting-input" min="1" max="720" step="1" oninput="updateFieldNum('staleExitHours', this.value, true)">
                  <span class="setting-unit">hrs</span>
                </div>
              </div>
              
              <h4 style="color: var(--matrix-green); margin: 1.5rem 0 0.5rem 0; font-size: 0.9rem; border-bottom: 1px solid rgba(0,255,65,0.2); padding-bottom: 0.3rem;">Trailing Stop Configuration</h4>
              
              <div class="setting-row" title="Standard trailing stop distance from peak. If position drops this percentage from its highest price, trailing stop triggers. 20-40% is typical for volatile tokens.">
                <div class="setting-label">
                  <span class="setting-name">Trailing Stop Base</span>
                  <span class="setting-desc">Drop from peak to trigger exit</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-trailingStopBasePct" class="setting-input" min="5" max="80" step="1" oninput="updateFieldNum('trailingStopBasePct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Tightened trailing stop for winning positions. Once profit exceeds the Profit Threshold below, trailing stop switches from Base to this tighter value.">
                <div class="setting-label">
                  <span class="setting-name">Trailing Stop Tight</span>
                  <span class="setting-desc">Tighter stop for profitable positions</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-trailingStopTightPct" class="setting-input" min="3" max="50" step="1" oninput="updateFieldNum('trailingStopTightPct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Profit level at which trailing stop tightens. When position profit exceeds this threshold, stop changes from Base to Tight percentage.">
                <div class="setting-label">
                  <span class="setting-name">Trailing Profit Threshold</span>
                  <span class="setting-desc">Profit % to trigger tighter stop</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-trailingStopProfitThreshold" class="setting-input" min="10" max="200" step="5" oninput="updateFieldNum('trailingStopProfitThreshold', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              
              <div class="setting-row" title="Positions worth less than this amount are hidden from display and skipped during rotation evaluation.">
                <div class="setting-label">
                  <span class="setting-name">Dust Threshold</span>
                  <span class="setting-desc">Skip positions below this USD value</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-dustThresholdUsd" class="setting-input" min="0.01" max="10" step="0.10" oninput="updateFieldNum('dustThresholdUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="The minimum USD value a position must have to be considered valid. Positions below this are ignored in rotation and ranking calculations.">
                <div class="setting-label">
                  <span class="setting-name">Min Position Size</span>
                  <span class="setting-desc">Minimum position value in USD</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-minPositionUsd" class="setting-input" min="0.10" max="100" step="0.10" oninput="updateFieldNum('minPositionUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Extra SOL held back beyond minSolReserve to cover transaction fees. Total reserve = minSolReserve + txFeeBufferSol. Increase if seeing 'insufficient balance for rent' errors.">
                <div class="setting-label">
                  <span class="setting-name">TX Fee Buffer</span>
                  <span class="setting-desc">SOL reserved for transaction fees</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-txFeeBufferSol" class="setting-input" min="0.001" max="0.1" step="0.001" oninput="updateFieldNum('txFeeBufferSol', this.value, false)">
                  <span class="setting-unit">SOL</span>
                </div>
              </div>
            </div>
          </details>

          <details class="settings-card advanced">
            <summary>
              <div class="settings-card-header" style="border-bottom:none">
                <div class="settings-icon"></div>
                <div>
                  <h3>Strategy Engine (Advanced)</h3>
                  <p>Core strategy parameters - modify with caution</p>
                </div>
              </div>
            </summary>
            <p class="helper-text">These parameters affect the core trading strategy behavior</p>
            <div class="settings-body">
              <div class="setting-row" title="Threshold for classifying market regime as trending vs ranging. Higher = requires stronger trends to trigger trend-following behavior. 0.3-0.6 is typical. Affects signal generation and position sizing.">
                <div class="setting-label">
                  <span class="setting-name">Trend Threshold</span>
                  <span class="setting-desc">Threshold for trend regime classification</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-strategyTrendThreshold" class="setting-input" min="0" max="1" step="0.05" oninput="updateFieldNum('strategyTrendThreshold', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Scales how much recent price momentum affects signal strength. Higher = momentum has more influence on buy/sell signals. Lower = signals rely more on other factors. 0.3-0.7 is typical.">
                <div class="setting-label">
                  <span class="setting-name">Momentum Factor</span>
                  <span class="setting-desc">Factor for momentum signal scaling</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-strategyMomentumFactor" class="setting-input" min="0" max="1" step="0.05" oninput="updateFieldNum('strategyMomentumFactor', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Width of the neutral zone around signal thresholds. Prevents excessive trading on marginal signals. Wider band = fewer trades, narrower = more responsive but more noise. 0.05-0.15 is typical.">
                <div class="setting-label">
                  <span class="setting-name">Band</span>
                  <span class="setting-desc">Strategy band width</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-strategyBand" class="setting-input" min="0" max="0.5" step="0.01" oninput="updateFieldNum('strategyBand', this.value, false)">
                </div>
              </div>
              <div class="setting-row" title="Minimum number of price ticks (data points) required before computing signal scores and allocation. Lower = faster allocations on new tokens but noisier signals. Higher = more stable signals but slower initial allocations. Default 60.">
                <div class="setting-label">
                  <span class="setting-name">Min Ticks for Signals</span>
                  <span class="setting-desc">Lower = faster allocations, but noisier signals</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-minTicksForSignals" class="setting-input" min="5" max="500" step="1" oninput="updateFieldNum('minTicksForSignals', this.value, true)">
                  <span class="setting-unit">ticks</span>
                </div>
              </div>
              <div class="setting-row" title="Number of price ticks required before a token can receive its full target allocation percentage. Tokens with fewer ticks get ramped allocations (scaled by sqrt of ticks/threshold). Prevents over-allocation to tokens with limited price history.">
                <div class="setting-label">
                  <span class="setting-name">Min Ticks for Full Allocation</span>
                  <span class="setting-desc">Ticks needed before full allocation allowed</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-minTicksForFullAlloc" class="setting-input" min="0" max="500" step="1" oninput="updateFieldNum('minTicksForFullAlloc', this.value, true)">
                  <span class="setting-unit">ticks</span>
                </div>
              </div>
              <div class="setting-row" title="Hard cap on allocation percentage before a token reaches minTicksForFullAlloc. Even if signals suggest higher allocation, tokens with insufficient tick history are limited to this maximum. Prevents large allocations to unproven tokens.">
                <div class="setting-label">
                  <span class="setting-name">Pre-Full Alloc Max</span>
                  <span class="setting-desc">Max allocation before tick threshold reached</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-preFullAllocMaxPct-slider" class="setting-slider" min="1" max="25" oninput="syncSlider('preFullAllocMaxPct')">
                  <input type="number" id="cfg-preFullAllocMaxPct" class="setting-input-sm" min="1" max="25" step="1" onchange="syncInput('preFullAllocMaxPct'); markUnsaved()" oninput="syncInput('preFullAllocMaxPct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
            </div>
          </details>

          <details class="settings-card advanced">
            <summary>
              <div class="settings-card-header" style="border-bottom:none">
                <div class="settings-icon"></div>
                <div>
                  <h3>Exit Invariant</h3>
                  <p>Ensure positions close completely - retry logic for failed exits</p>
                </div>
              </div>
            </summary>
            <p class="helper-text">Controls how the bot handles partial fills and retries when closing positions</p>
            <div class="settings-body">
              <div class="setting-row" title="Enable the exit invariant system. When enabled, the bot will verify positions are fully closed and retry if needed.">
                <div class="setting-label">
                  <span class="setting-name">Exit Invariant Enabled</span>
                  <span class="setting-desc">Enable position close verification and retry</span>
                </div>
                <input type="checkbox" id="cfg-exitInvariantEnabled" class="setting-checkbox" onchange="updateFieldBool('exitInvariantEnabled', this.checked)">
              </div>
              <div class="setting-row" title="Maximum number of retry attempts if a position doesn't fully close. Each retry uses increased slippage.">
                <div class="setting-label">
                  <span class="setting-name">Max Retries</span>
                  <span class="setting-desc">Number of retry attempts for incomplete closes</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-exitInvariantMaxRetries" class="setting-input" min="1" max="5" step="1" oninput="updateFieldNum('exitInvariantMaxRetries', this.value, true)">
                </div>
              </div>
              <div class="setting-row" title="Delay in milliseconds between retry attempts. Allows time for blockchain state to settle.">
                <div class="setting-label">
                  <span class="setting-name">Retry Delay</span>
                  <span class="setting-desc">Delay between retry attempts</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-exitInvariantRetryDelayMs" class="setting-input" min="500" max="5000" step="100" oninput="updateFieldNum('exitInvariantRetryDelayMs', this.value, true)">
                  <span class="setting-unit">ms</span>
                </div>
              </div>
              <div class="setting-row" title="Minimum remaining token quantity that triggers a retry. Set to 0 to always retry any remaining balance.">
                <div class="setting-label">
                  <span class="setting-name">Min Remaining Qty</span>
                  <span class="setting-desc">Token quantity threshold for retry trigger</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-exitInvariantMinRemainingQty" class="setting-input" min="0" max="1000000" step="1" oninput="updateFieldNum('exitInvariantMinRemainingQty', this.value, false)">
                  <span class="setting-unit">tokens</span>
                </div>
              </div>
              <div class="setting-row" title="Minimum remaining USD value that triggers a retry. Positions below this are considered fully closed.">
                <div class="setting-label">
                  <span class="setting-name">Min Remaining USD</span>
                  <span class="setting-desc">USD value threshold for retry trigger</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-exitInvariantMinRemainingUsd" class="setting-input" min="0.10" max="100" step="0.10" oninput="updateFieldNum('exitInvariantMinRemainingUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Slippage tolerance in basis points for exit invariant retries. Higher values increase chance of fill but may result in worse prices.">
                <div class="setting-label">
                  <span class="setting-name">Slippage (bps)</span>
                  <span class="setting-desc">Slippage tolerance for retry swaps</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-exitInvariantSlippageBps" class="setting-input" min="50" max="1000" step="10" oninput="updateFieldNum('exitInvariantSlippageBps', this.value, true)">
                  <span class="setting-unit">bps</span>
                </div>
              </div>
              <div class="setting-row" title="Force exact close by selling entire balance regardless of initial sell amount. More aggressive but ensures complete exit.">
                <div class="setting-label">
                  <span class="setting-name">Force Exact Close</span>
                  <span class="setting-desc">Sell entire remaining balance on retry</span>
                </div>
                <input type="checkbox" id="cfg-exitInvariantForceExactClose" class="setting-checkbox" onchange="updateFieldBool('exitInvariantForceExactClose', this.checked)">
              </div>
            </div>
          </details>

          <details class="settings-card advanced">
            <summary>
              <div class="settings-card-header" style="border-bottom:none">
                <div class="settings-icon">💰</div>
                <div>
                  <h3>Capital Management</h3>
                  <p>Capacity-aware position sizing and liquidity constraints</p>
                </div>
              </div>
            </summary>
            <p class="helper-text">Controls how positions are sized based on portfolio equity, liquidity, and risk budgets</p>
            <div class="settings-body">
              <div class="setting-row" title="Enable capacity-aware position sizing. When enabled, position sizes are dynamically calculated based on equity, liquidity, and risk constraints.">
                <div class="setting-label">
                  <span class="setting-name">Enable Capital Management</span>
                  <span class="setting-desc">Enable capacity-aware sizing</span>
                </div>
                <input type="checkbox" id="cfg-capitalMgmtEnabled" class="setting-checkbox" onchange="updateFieldBool('capitalMgmtEnabled', this.checked)">
              </div>
              
              <div style="margin-top:12px;padding:8px 0;border-bottom:1px solid #003300">
                <span style="color:#00ff41;font-size:13px;font-weight:bold">Portfolio Risk Budgets</span>
              </div>
              <div class="setting-row" title="Maximum total portfolio exposure as a percentage of equity. Limits how much of portfolio can be in risky positions.">
                <div class="setting-label">
                  <span class="setting-name">Max Total Exposure</span>
                  <span class="setting-desc">Maximum total exposure %</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-capMaxTotalExposurePct-slider" class="setting-slider" min="0" max="100" oninput="syncSlider('capMaxTotalExposurePct')">
                  <input type="number" id="cfg-capMaxTotalExposurePct" class="setting-input-sm" min="0" max="100" step="1" onchange="syncInput('capMaxTotalExposurePct'); markUnsaved()" oninput="syncInput('capMaxTotalExposurePct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum exposure allocated to core positions as a percentage of equity.">
                <div class="setting-label">
                  <span class="setting-name">Max Core Exposure</span>
                  <span class="setting-desc">Maximum core exposure %</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-capMaxCoreExposurePct-slider" class="setting-slider" min="0" max="100" oninput="syncSlider('capMaxCoreExposurePct')">
                  <input type="number" id="cfg-capMaxCoreExposurePct" class="setting-input-sm" min="0" max="100" step="1" onchange="syncInput('capMaxCoreExposurePct'); markUnsaved()" oninput="syncInput('capMaxCoreExposurePct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum exposure allocated to scout positions as a percentage of equity.">
                <div class="setting-label">
                  <span class="setting-name">Max Scout Exposure</span>
                  <span class="setting-desc">Maximum scout exposure %</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-capMaxScoutExposurePct-slider" class="setting-slider" min="0" max="100" oninput="syncSlider('capMaxScoutExposurePct')">
                  <input type="number" id="cfg-capMaxScoutExposurePct" class="setting-input-sm" min="0" max="100" step="1" onchange="syncInput('capMaxScoutExposurePct'); markUnsaved()" oninput="syncInput('capMaxScoutExposurePct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum exposure to any single token as a percentage of equity.">
                <div class="setting-label">
                  <span class="setting-name">Max Per-Token Exposure</span>
                  <span class="setting-desc">Maximum per-token exposure %</span>
                </div>
                <div class="setting-slider-group">
                  <input type="range" id="cfg-capMaxMintExposurePct-slider" class="setting-slider" min="0" max="25" oninput="syncSlider('capMaxMintExposurePct')">
                  <input type="number" id="cfg-capMaxMintExposurePct" class="setting-input-sm" min="0" max="25" step="1" onchange="syncInput('capMaxMintExposurePct'); markUnsaved()" oninput="syncInput('capMaxMintExposurePct'); markUnsaved()">
                  <span class="setting-unit">%</span>
                </div>
              </div>

              <div style="margin-top:12px;padding:8px 0;border-bottom:1px solid #003300">
                <span style="color:#00ff41;font-size:13px;font-weight:bold">Trade Risk</span>
              </div>
              <div class="setting-row" title="Maximum risk per scout trade as a percentage of equity. Controls position sizing for scout entries.">
                <div class="setting-label">
                  <span class="setting-name">Risk Per Scout Trade</span>
                  <span class="setting-desc">Risk per scout trade %</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capRiskPerTradeScoutPct" class="setting-input" min="0" max="5" step="0.05" oninput="updateFieldNum('capRiskPerTradeScoutPct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum risk per core trade as a percentage of equity. Controls position sizing for core entries.">
                <div class="setting-label">
                  <span class="setting-name">Risk Per Core Trade</span>
                  <span class="setting-desc">Risk per core trade %</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capRiskPerTradeCorePct" class="setting-input" min="0" max="5" step="0.05" oninput="updateFieldNum('capRiskPerTradeCorePct', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>

              <div style="margin-top:12px;padding:8px 0;border-bottom:1px solid #003300">
                <span style="color:#00ff41;font-size:13px;font-weight:bold">Impact Limits</span>
              </div>
              <div class="setting-row" title="Maximum price impact allowed when entering scout positions. Trades exceeding this are rejected.">
                <div class="setting-label">
                  <span class="setting-name">Max Entry Impact (Scout)</span>
                  <span class="setting-desc">Max entry impact for scouts</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capEntryMaxImpactPctScout" class="setting-input" min="0" max="5" step="0.1" oninput="updateFieldNum('capEntryMaxImpactPctScout', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum price impact allowed when exiting scout positions.">
                <div class="setting-label">
                  <span class="setting-name">Max Exit Impact (Scout)</span>
                  <span class="setting-desc">Max exit impact for scouts</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capExitMaxImpactPctScout" class="setting-input" min="0" max="5" step="0.1" oninput="updateFieldNum('capExitMaxImpactPctScout', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum price impact allowed when entering core positions.">
                <div class="setting-label">
                  <span class="setting-name">Max Entry Impact (Core)</span>
                  <span class="setting-desc">Max entry impact for core</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capEntryMaxImpactPctCore" class="setting-input" min="0" max="5" step="0.1" oninput="updateFieldNum('capEntryMaxImpactPctCore', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum price impact allowed when exiting core positions.">
                <div class="setting-label">
                  <span class="setting-name">Max Exit Impact (Core)</span>
                  <span class="setting-desc">Max exit impact for core</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capExitMaxImpactPctCore" class="setting-input" min="0" max="5" step="0.1" oninput="updateFieldNum('capExitMaxImpactPctCore', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>

              <div style="margin-top:12px;padding:8px 0;border-bottom:1px solid #003300">
                <span style="color:#00ff41;font-size:13px;font-weight:bold">Roundtrip Constraints</span>
              </div>
              <div class="setting-row" title="Minimum ratio of sell quote to buy cost for scout positions. Ensures sufficient liquidity for exits. 0.94 means must be able to sell for at least 94% of buy cost.">
                <div class="setting-label">
                  <span class="setting-name">Min Roundtrip Ratio (Scout)</span>
                  <span class="setting-desc">Min roundtrip ratio for scouts</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capRoundtripMinRatioScout" class="setting-input" min="80" max="100" step="1" oninput="updateFieldNum('capRoundtripMinRatioScout', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Minimum ratio of sell quote to buy cost for core positions. Core positions require higher liquidity standards.">
                <div class="setting-label">
                  <span class="setting-name">Min Roundtrip Ratio (Core)</span>
                  <span class="setting-desc">Min roundtrip ratio for core</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capRoundtripMinRatioCore" class="setting-input" min="80" max="100" step="1" oninput="updateFieldNum('capRoundtripMinRatioCore', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>
              <div class="setting-row" title="Safety haircut applied to liquidity estimates. 0.80 means we only count 80% of reported liquidity as usable.">
                <div class="setting-label">
                  <span class="setting-name">Liquidity Safety Haircut</span>
                  <span class="setting-desc">Safety factor for liquidity</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capLiquiditySafetyHaircut" class="setting-input" min="50" max="100" step="5" oninput="updateFieldNum('capLiquiditySafetyHaircut', this.value, false)">
                  <span class="setting-unit">%</span>
                </div>
              </div>

              <div style="margin-top:12px;padding:8px 0;border-bottom:1px solid #003300">
                <span style="color:#00ff41;font-size:13px;font-weight:bold">Liquidity Tiers</span>
              </div>
              <div class="setting-row" title="Minimum pool TVL (total value locked) required for scout entries. Ensures sufficient liquidity.">
                <div class="setting-label">
                  <span class="setting-name">Min Pool TVL (Scout)</span>
                  <span class="setting-desc">Min pool TVL for scout ($)</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capMinPoolTvlUsdScout" class="setting-input" min="0" max="1000000" step="1000" oninput="updateFieldNum('capMinPoolTvlUsdScout', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Minimum pool TVL (total value locked) required for core entries. Core positions require higher liquidity.">
                <div class="setting-label">
                  <span class="setting-name">Min Pool TVL (Core)</span>
                  <span class="setting-desc">Min pool TVL for core ($)</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capMinPoolTvlUsdCore" class="setting-input" min="0" max="1000000" step="5000" oninput="updateFieldNum('capMinPoolTvlUsdCore', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>

              <div style="margin-top:12px;padding:8px 0;border-bottom:1px solid #003300">
                <span style="color:#00ff41;font-size:13px;font-weight:bold">Scout Sizing</span>
              </div>
              <div class="setting-row" title="Minimum USD size for scout positions. Positions below this are not opened.">
                <div class="setting-label">
                  <span class="setting-name">Min Scout Size</span>
                  <span class="setting-desc">Min scout size ($)</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capScoutSizeMinUsd" class="setting-input" min="1" max="500" step="1" oninput="updateFieldNum('capScoutSizeMinUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Maximum USD size for scout positions. Caps how large any scout position can be.">
                <div class="setting-label">
                  <span class="setting-name">Max Scout Size</span>
                  <span class="setting-desc">Max scout size ($)</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capScoutSizeMaxUsd" class="setting-input" min="1" max="1000" step="5" oninput="updateFieldNum('capScoutSizeMaxUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Base USD size for scout positions when equity equals the base equity level.">
                <div class="setting-label">
                  <span class="setting-name">Base Scout Size</span>
                  <span class="setting-desc">Base scout size ($)</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capScoutSizeBaseUsd" class="setting-input" min="1" max="500" step="1" oninput="updateFieldNum('capScoutSizeBaseUsd', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
              <div class="setting-row" title="Base equity level for scout size scaling. Scout sizes scale with sqrt(equity / baseEquity).">
                <div class="setting-label">
                  <span class="setting-name">Base Equity for Scaling</span>
                  <span class="setting-desc">Base equity for scaling ($)</span>
                </div>
                <div class="setting-input-group">
                  <input type="number" id="cfg-capScoutSizeBaseEquity" class="setting-input" min="100" max="10000" step="50" oninput="updateFieldNum('capScoutSizeBaseEquity', this.value, false)">
                  <span class="setting-unit">USD</span>
                </div>
              </div>
            </div>
          </details>

          <!-- DANGER ZONE -->
          <details class="settings-card danger-zone" style="border:1px solid #ef4444;background:linear-gradient(135deg,#1a0a0a,#2d1515)">
            <summary>
              <div class="settings-card-header" style="border-bottom:none;color:#ef4444">
                <span class="settings-icon">⚠️</span>
                <span>Danger Zone</span>
              </div>
            </summary>
            <div class="settings-content" style="padding:16px">
              <div style="background:#1f0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:16px;margin-bottom:16px">
                <h4 style="color:#fca5a5;margin-bottom:8px">Reset Portfolio</h4>
                <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">
                  This will <strong style="color:#ef4444">flash sell ALL tokens</strong> (except SOL), clear the trading universe, 
                  empty the scout queue, and reset entry prices. Use this to start fresh with a clean baseline.
                </p>
                <div id="reset-preview" style="display:none;background:#0f172a;border-radius:6px;padding:12px;margin-bottom:12px;max-height:150px;overflow-y:auto">
                  <div style="color:#64748b;font-size:12px;margin-bottom:8px">Tokens to be sold:</div>
                  <div id="reset-preview-list" style="font-size:12px;color:#94a3b8"></div>
                </div>
                <div style="display:flex;gap:12px;flex-wrap:wrap">
                  <button id="btn-preview-reset" class="btn" style="background:#7f1d1d;border:1px solid #ef4444;padding:8px 16px;border-radius:6px;color:#fca5a5;cursor:pointer">
                    Preview Reset
                  </button>
                  <button id="btn-reset-portfolio" class="btn" style="background:#dc2626;border:none;padding:8px 16px;border-radius:6px;color:#fff;cursor:pointer;display:none">
                    Execute Reset
                  </button>
                  <button id="btn-cleanup-only" class="btn" style="background:#b45309;border:none;padding:8px 16px;border-radius:6px;color:#fff;cursor:pointer;display:none">
                    Clean Data Only
                  </button>
                </div>
              </div>
              
              <div style="background:#1a1a0a;border:1px solid #7f6d1d;border-radius:8px;padding:16px;margin-bottom:16px">
                <h4 style="color:#fcd34d;margin-bottom:8px">Prune Historical Data</h4>
                <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">
                  Delete old telemetry, prices, features, and equity snapshots to reduce database size.
                  Keeps recent data for analysis.
                </p>
                <div id="prune-preview" style="display:none;background:#0f172a;border-radius:6px;padding:12px;margin-bottom:12px">
                  <div id="prune-preview-content" style="font-size:12px;color:#94a3b8"></div>
                </div>
                <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
                  <label style="color:#94a3b8;font-size:12px">Keep last:</label>
                  <select id="prune-days" style="background:#0f172a;border:1px solid #334155;border-radius:6px;color:#fff;padding:6px 12px">
                    <option value="3">3 days</option>
                    <option value="7" selected>7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                  </select>
                  <button id="btn-preview-prune" class="btn" style="background:#7f6d1d;border:1px solid #fcd34d;padding:8px 16px;border-radius:6px;color:#fcd34d;cursor:pointer">
                    Preview Prune
                  </button>
                  <button id="btn-execute-prune" class="btn" style="background:#ca8a04;border:none;padding:8px 16px;border-radius:6px;color:#fff;cursor:pointer;display:none">
                    Execute Prune
                  </button>
                </div>
              </div>
              
              <div style="font-size:11px;color:#64748b;padding:8px;background:#1e1b4b;border-radius:6px">
                <strong>Note:</strong> Trade history is preserved for analysis. These actions cannot be undone.
              </div>
            </div>
          </details>
        </div>

        <div class="grid-2" style="margin-top:20px">
          <div class="card">
            <div class="card-header">
              <h3>Bot Status</h3>
              <span class="card-action health-refresh">Refresh</span>
            </div>
            <div id="health-info">Loading...</div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>Current Portfolio Risk</h3>
              <span class="card-action portfolio-risk-refresh">Refresh</span>
            </div>
            <div id="portfolio-risk-info">Loading...</div>
          </div>
        </div>
        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3>Trading Universe</h3>
              <span class="card-action universe-refresh">Refresh</span>
            </div>
            <div id="universe-info" class="table-scroll" style="max-height:300px">Loading...</div>
          </div>
          <div class="card">
            <div class="card-header">
              <h3>API Cache</h3>
              <span class="card-action cache-refresh">Refresh</span>
            </div>
            <div id="cache-info">Loading...</div>
          </div>
        </div>
      </div>

      <!-- EXPORT TAB -->
      <div id="tab-export" class="tab-content">
        <div class="grid-2">
          <div class="card">
            <h3 style="margin-bottom:16px">Export Data for Analysis</h3>
            <p style="color:#94a3b8;font-size:13px;margin-bottom:20px">
              Download your trading data for statistical analysis. Data is exported as CSV or JSON.
            </p>
            
            <div style="margin-bottom:20px">
              <label style="display:block;color:#94a3b8;font-size:12px;margin-bottom:6px">Date Range</label>
              <div style="display:flex;gap:10px;align-items:center">
                <input type="date" id="export-start" class="form-input" style="padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#fff">
                <span style="color:#64748b">to</span>
                <input type="date" id="export-end" class="form-input" style="padding:8px 12px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#fff">
              </div>
            </div>
            
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
              <button class="export-btn" data-export-type="trades" data-export-format="csv">Trades (CSV)</button>
              <button class="export-btn secondary" data-export-type="trades" data-export-format="json">Trades (JSON)</button>
              <button class="export-btn" data-export-type="telemetry" data-export-format="csv">Tick Telemetry (CSV)</button>
              <button class="export-btn secondary" data-export-type="telemetry" data-export-format="json">Tick Telemetry (JSON)</button>
              <button class="export-btn" data-export-type="prices" data-export-format="csv">Price History (CSV)</button>
              <button class="export-btn secondary" data-export-type="prices" data-export-format="json">Price History (JSON)</button>
              <button class="export-btn" data-export-type="equity" data-export-format="csv">Equity Snapshots (CSV)</button>
              <button class="export-btn secondary" data-export-type="equity" data-export-format="json">Equity (JSON)</button>
              <button class="export-btn" data-export-type="config-history" data-export-format="csv">Config History (CSV)</button>
              <button class="export-btn secondary" data-export-type="config-history" data-export-format="json">Config History (JSON)</button>
            </div>
            
            <h4 style="margin:20px 0 12px 0;color:#00ff41">Event Logs (Journey-Linked)</h4>
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              <button class="export-btn" data-export-type="events" data-export-format="csv">Events (CSV)</button>
              <button class="export-btn secondary" data-export-type="events" data-export-format="json">Events (JSON)</button>
              <button class="export-btn secondary" data-export-type="journeys" data-export-format="json">Journeys Summary (JSON)</button>
            </div>
            
            <div style="margin-top:20px;padding-top:16px;border-top:1px solid #334155">
              <button class="export-btn" data-export-type="all" data-export-format="json" style="width:100%;background:linear-gradient(135deg,#6366f1,#8b5cf6)">
                Export All Data (JSON Bundle)
              </button>
            </div>
            
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid #00ff41">
              <h4 style="margin-bottom:12px;color:#00ff41">Analysis-Ready Export</h4>
              <button id="export-lite-btn" class="export-btn" style="width:100%;background:linear-gradient(135deg,#00ff41,#10b981);color:#000;font-weight:600;padding:16px;font-size:14px">
                <span id="export-lite-text">Export Lite (ZIP)</span>
                <span id="export-lite-spinner" style="display:none;margin-left:8px">&#x21bb;</span>
              </button>
              <p style="color:#94a3b8;font-size:11px;margin-top:8px">
                Compact ZIP with NDJSON files: equity, trades, P&L, lots, positions, and pre-computed aggregates. Fast and analysis-ready.
              </p>
            </div>
          </div>
          
          <div class="card">
            <h3 style="margin-bottom:16px">Data Description</h3>
            <div style="font-size:13px;color:#94a3b8;line-height:1.7">
              <p style="margin-bottom:12px"><strong style="color:#fff">Trades:</strong> All executed trades with P&L, slippage, price impact, and execution details.</p>
              <p style="margin-bottom:12px"><strong style="color:#fff">Tick Telemetry:</strong> Per-tick decision data including regime classification, target weights, signals, and portfolio snapshots.</p>
              <p style="margin-bottom:12px"><strong style="color:#fff">Price History:</strong> Minute-level price data for all tracked tokens.</p>
              <p style="margin-bottom:12px"><strong style="color:#fff">Equity Snapshots:</strong> Portfolio value over time with breakdown by asset.</p>
              <p style="margin-bottom:12px"><strong style="color:#fff">Config History:</strong> All settings changes with timestamps for correlation analysis.</p>
              <p style="margin-bottom:12px"><strong style="color:#fff">Events:</strong> Structured event logs with journey IDs linking scan->queue->entry->exit for each token.</p>
              <p style="margin-bottom:12px"><strong style="color:#fff">Journeys:</strong> Summary of token journeys showing event flow and duration.</p>
              <p style="margin-bottom:12px"><strong style="color:#fff">All Data Bundle:</strong> Complete JSON export with all datasets for comprehensive analysis.</p>
              <p style="margin-bottom:12px"><strong style="color:#00ff41">Export Lite (ZIP):</strong> Analysis-ready ZIP with streaming NDJSON files for equity, trades, P&L events, open lots, and pre-computed aggregates including drawdown, win rates by reason code, and fee summaries.</p>
            </div>
            
            <div style="margin-top:20px;padding:12px;background:#1e1b4b;border-radius:8px;font-size:12px;color:#a5b4fc">
              <strong>Tip:</strong> Use Python (pandas) or Excel to analyze the exported data. The tick telemetry is especially useful for understanding trading decisions. For quick analysis, use Export Lite (ZIP) which includes pre-computed aggregates.
            </div>
          </div>
        </div>
        
        <div class="card" style="margin-top:16px">
          <h3 style="margin-bottom:16px">Quick Stats</h3>
          <div id="export-stats" style="color:#94a3b8">Loading data counts...</div>
        </div>
      </div>

      <!-- DIAGNOSTICS TAB -->
      <div id="tab-diagnostics" class="tab-content">
        <div style="padding:8px 12px;background:rgba(0,40,0,0.9);border:1px solid #003300;margin-bottom:16px;display:flex;gap:24px;flex-wrap:wrap;align-items:center;font-size:12px">
          <span><strong style="color:#00ff41">ENV:</strong> <span id="diag-env">-</span></span>
          <span><strong style="color:#00ff41">MODE:</strong> <span id="diag-mode">-</span></span>
          <span><strong style="color:#00ff41">HASH:</strong> <span id="diag-hash" style="font-family:monospace">-</span></span>
          <span><strong style="color:#00ff41">GIT:</strong> <span id="diag-git" style="font-family:monospace">-</span></span>
          <span><strong style="color:#00ff41">PID:</strong> <span id="diag-pid">-</span></span>
          <span><strong style="color:#00ff41">RELOAD:</strong> <span id="diag-reload">-</span></span>
        </div>
        
        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3>Risk State</h3>
              <span class="card-action" id="diag-risk-refresh">Refresh</span>
            </div>
            <div id="diag-risk-state">
              <table style="width:100%">
                <tr><td style="color:#008f11">Paused</td><td id="diag-risk-paused">-</td></tr>
                <tr><td style="color:#008f11">Reason</td><td id="diag-risk-reason">-</td></tr>
                <tr><td style="color:#008f11">Baseline Type</td><td id="diag-risk-baseline-type">-</td></tr>
                <tr><td style="color:#008f11">Baseline Equity</td><td id="diag-risk-baseline">-</td></tr>
                <tr><td style="color:#008f11">Current Equity</td><td id="diag-risk-current">-</td></tr>
                <tr><td style="color:#008f11">P&L</td><td id="diag-risk-pnl">-</td></tr>
                <tr><td style="color:#008f11">P&L %</td><td id="diag-risk-pnl-pct">-</td></tr>
                <tr><td style="color:#008f11">Threshold %</td><td id="diag-risk-threshold">-</td></tr>
                <tr><td style="color:#008f11">Turnover</td><td id="diag-risk-turnover">-</td></tr>
              </table>
            </div>
          </div>
          
          <div class="card">
            <div class="card-header">
              <h3>Settings Diff</h3>
              <span class="card-action" id="diag-diff-refresh">Refresh</span>
            </div>
            <div id="diag-diff-container" class="table-scroll" style="max-height:300px">
              <table style="width:100%">
                <thead>
                  <tr><th>Key</th><th>DB Value</th><th>Effective</th><th>Source</th></tr>
                </thead>
                <tbody id="diag-diff-body"></tbody>
              </table>
            </div>
            <div style="margin-top:8px;font-size:11px;color:#008f11">
              <span id="diag-diff-count">0</span> differences found
            </div>
          </div>
        </div>
        
        <div class="grid-2" style="margin-top:16px">
          <div class="card">
            <div class="card-header">
              <h3>Stored Settings (DB)</h3>
              <div style="display:flex;gap:8px">
                <span class="card-action" id="diag-db-copy">Copy JSON</span>
                <span class="card-action" id="diag-db-refresh">Refresh</span>
              </div>
            </div>
            <div id="diag-db-settings" class="table-scroll" style="max-height:400px;overflow:auto">
              <pre style="font-size:11px;color:#00ff41;white-space:pre-wrap;word-break:break-all">Loading...</pre>
            </div>
          </div>
          
          <div class="card">
            <div class="card-header">
              <h3>Effective Settings (Runtime)</h3>
              <div style="display:flex;gap:8px">
                <span class="card-action" id="diag-effective-copy">Copy JSON</span>
                <span class="card-action" id="diag-effective-refresh">Refresh</span>
              </div>
            </div>
            <div id="diag-effective-settings" class="table-scroll" style="max-height:400px;overflow:auto">
              <pre style="font-size:11px;color:#00ff41;white-space:pre-wrap;word-break:break-all">Loading...</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="footer">
      WebSocket connected | Risk Profile: <span id="footer-risk">-</span> | Mode: <span id="footer-mode">-</span> | Cache: <span id="cache-stats">-</span>
    </div>

    <script>
      let equityChart = null;
      let signalChart = null;
      let allocationChart = null;
      let whaleStatusMap = new Map();
      let ws = null;
      
      // Tab navigation
      document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
          document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
          item.classList.add('active');
          document.getElementById('tab-' + item.dataset.tab).classList.add('active');
          
          if (item.dataset.tab === 'performance') {
            loadPerformanceTab();
          }
          if (item.dataset.tab === 'rotation') {
            loadRotationData();
          }
          if (item.dataset.tab === 'scanner') {
            loadScannerData();
          }
          if (item.dataset.tab === 'settings') {
            loadSettings();
          }
          if (item.dataset.tab === 'export') {
            initExportDates();
            loadExportStats();
          }
          if (item.dataset.tab === 'diagnostics') {
            loadDiagnostics();
          }
        });
      });
      
      let diagDbSettings = null;
      let diagEffectiveSettings = null;
      
      async function loadDiagnostics() {
        try {
          const [effective, dbData, diffData, riskData] = await Promise.all([
            fetch('/api/settings/effective').then(r => r.json()),
            fetch('/api/settings/db').then(r => r.json()),
            fetch('/api/settings/diff').then(r => r.json()),
            fetch('/api/risk-state').then(r => r.json()),
          ]);
          
          diagDbSettings = dbData.settings;
          diagEffectiveSettings = effective.effectiveSettings;
          
          document.getElementById('diag-env').textContent = effective.envName || '-';
          document.getElementById('diag-mode').textContent = effective.execMode || '-';
          document.getElementById('diag-hash').textContent = effective.settingsHash || '-';
          document.getElementById('diag-git').textContent = effective.gitSha || '-';
          document.getElementById('diag-pid').textContent = effective.pid || '-';
          document.getElementById('diag-reload').textContent = effective.lastSettingsReloadAt ? new Date(effective.lastSettingsReloadAt).toLocaleTimeString() : '-';
          
          const pausedEl = document.getElementById('diag-risk-paused');
          if (riskData.paused) {
            pausedEl.innerHTML = '<span style="color:#ff0040">YES</span>';
          } else {
            pausedEl.innerHTML = '<span style="color:#00ff41">NO</span>';
          }
          document.getElementById('diag-risk-reason').textContent = riskData.reason || '-';
          document.getElementById('diag-risk-baseline-type').textContent = riskData.baselineType || '-';
          document.getElementById('diag-risk-baseline').textContent = riskData.baselineEquityUsd ? '$' + riskData.baselineEquityUsd.toFixed(2) : '-';
          document.getElementById('diag-risk-current').textContent = riskData.currentEquityUsd ? '$' + riskData.currentEquityUsd.toFixed(2) : '-';
          const pnlColor = riskData.pnlUsd >= 0 ? '#00ff41' : '#ff0040';
          document.getElementById('diag-risk-pnl').innerHTML = riskData.pnlUsd !== undefined ? '<span style="color:' + pnlColor + '">$' + riskData.pnlUsd.toFixed(2) + '</span>' : '-';
          document.getElementById('diag-risk-pnl-pct').innerHTML = riskData.pnlPct !== undefined ? '<span style="color:' + pnlColor + '">' + riskData.pnlPct.toFixed(2) + '%</span>' : '-';
          document.getElementById('diag-risk-threshold').textContent = riskData.thresholdPct ? riskData.thresholdPct.toFixed(2) + '%' : '-';
          document.getElementById('diag-risk-turnover').textContent = riskData.turnoverUsd !== undefined ? '$' + riskData.turnoverUsd.toFixed(0) + ' / $' + (riskData.turnoverCapUsd || 0).toFixed(0) : '-';
          
          const diffBody = document.getElementById('diag-diff-body');
          diffBody.innerHTML = '';
          for (const d of diffData.diffs || []) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td>' + d.key + '</td><td style="color:#ffff00">' + (d.dbValue ?? 'null') + '</td><td style="color:#00ffff">' + String(d.effectiveValue) + '</td><td>' + d.source + '</td>';
            diffBody.appendChild(tr);
          }
          document.getElementById('diag-diff-count').textContent = (diffData.diffs || []).length;
          
          document.getElementById('diag-db-settings').querySelector('pre').textContent = JSON.stringify(dbData.settings || {}, null, 2);
          document.getElementById('diag-effective-settings').querySelector('pre').textContent = JSON.stringify(effective.effectiveSettings || {}, null, 2);
          
        } catch (err) {
          console.error('Failed to load diagnostics:', err);
        }
      }
      
      document.getElementById('diag-risk-refresh')?.addEventListener('click', async () => {
        const riskData = await fetch('/api/risk-state').then(r => r.json());
        const pausedEl = document.getElementById('diag-risk-paused');
        if (riskData.paused) {
          pausedEl.innerHTML = '<span style="color:#ff0040">YES</span>';
        } else {
          pausedEl.innerHTML = '<span style="color:#00ff41">NO</span>';
        }
        document.getElementById('diag-risk-reason').textContent = riskData.reason || '-';
      });
      
      document.getElementById('diag-diff-refresh')?.addEventListener('click', async () => {
        const diffData = await fetch('/api/settings/diff').then(r => r.json());
        const diffBody = document.getElementById('diag-diff-body');
        diffBody.innerHTML = '';
        for (const d of diffData.diffs || []) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td>' + d.key + '</td><td style="color:#ffff00">' + (d.dbValue ?? 'null') + '</td><td style="color:#00ffff">' + String(d.effectiveValue) + '</td><td>' + d.source + '</td>';
          diffBody.appendChild(tr);
        }
        document.getElementById('diag-diff-count').textContent = (diffData.diffs || []).length;
      });
      
      document.getElementById('diag-db-refresh')?.addEventListener('click', async () => {
        const dbData = await fetch('/api/settings/db').then(r => r.json());
        diagDbSettings = dbData.settings;
        document.getElementById('diag-db-settings').querySelector('pre').textContent = JSON.stringify(dbData.settings || {}, null, 2);
      });
      
      document.getElementById('diag-effective-refresh')?.addEventListener('click', async () => {
        const effective = await fetch('/api/settings/effective').then(r => r.json());
        diagEffectiveSettings = effective.effectiveSettings;
        document.getElementById('diag-effective-settings').querySelector('pre').textContent = JSON.stringify(effective.effectiveSettings || {}, null, 2);
      });
      
      document.getElementById('diag-db-copy')?.addEventListener('click', () => {
        if (diagDbSettings) {
          navigator.clipboard.writeText(JSON.stringify(diagDbSettings, null, 2));
          alert('DB settings copied to clipboard');
        }
      });
      
      document.getElementById('diag-effective-copy')?.addEventListener('click', () => {
        if (diagEffectiveSettings) {
          navigator.clipboard.writeText(JSON.stringify(diagEffectiveSettings, null, 2));
          alert('Effective settings copied to clipboard');
        }
      });
      
      // WebSocket connection
      function connectWS() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(protocol + '//' + location.host + '/ws');
        
        ws.onopen = () => {
          document.getElementById('ws-dot').className = 'status-dot green';
          document.getElementById('ws-text').textContent = 'Live';
          fetchRuntimeStatus();
        };
        
        ws.onclose = () => {
          document.getElementById('ws-dot').className = 'status-dot yellow';
          document.getElementById('ws-text').textContent = 'Reconnecting...';
          setTimeout(connectWS, 3000);
          fetchRuntimeStatus();
        };
        
        ws.onerror = () => {
          document.getElementById('ws-dot').className = 'status-dot yellow';
          document.getElementById('ws-text').textContent = 'Reconnecting...';
        };
        
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'state') {
            updateState(msg.data);
            if (msg.data.whaleStatus) {
              updateWhaleStatusMap(msg.data.whaleStatus);
            }
          }
          if (msg.type === 'telemetry') updateTelemetry(msg.data);
          if (msg.type === 'rotation') handleRotationEvent(msg.data);
        };
      }
      
      let lastStatusFetchTime = null;
      
      async function fetchRuntimeStatus() {
        try {
          const resp = await fetch('/api/runtime-status');
          if (!resp.ok) throw new Error('API error');
          const status = await resp.json();
          lastStatusFetchTime = Date.now();
          updateStatusUpdatedDisplay();
          
          if (status.state === 'paused') {
            manualPauseState = true;
            updatePauseButton(true);
          } else if (status.state === 'running') {
            manualPauseState = false;
            updatePauseButton(false);
          } else if (status.state === 'stale') {
            document.getElementById('ws-dot').className = 'status-dot yellow';
            document.getElementById('ws-text').textContent = 'Bot Stale';
          }
        } catch (e) {
          console.error('Failed to fetch runtime status:', e);
        }
      }
      
      function updateStatusUpdatedDisplay() {
        if (!lastStatusFetchTime) {
          document.getElementById('status-updated').textContent = '--';
          return;
        }
        const ageMs = Date.now() - lastStatusFetchTime;
        const ageSec = Math.floor(ageMs / 1000);
        if (ageSec < 60) {
          document.getElementById('status-updated').textContent = ageSec + 's ago';
        } else {
          const ageMin = Math.floor(ageSec / 60);
          document.getElementById('status-updated').textContent = ageMin + 'm ago';
        }
      }
      
      setInterval(updateStatusUpdatedDisplay, 1000);
      setInterval(fetchRuntimeStatus, 30000);
      
      function handleRotationEvent(event) {
        console.log('Rotation event:', event);
        const activeTab = document.querySelector('.tab-content.active')?.id;
        if (activeTab === 'tab-rotation') {
          loadRotationData();
        }
        const action = event.action || 'rotation';
        const symbol = event.soldSymbol || event.boughtSymbol || 'Unknown';
        const reason = event.reasonCode || 'unknown';
        showToast(action.toUpperCase() + ': ' + symbol + ' (' + reason + ')', 
          action === 'promotion' ? 'success' : 'info');
      }
      
      let currentConfig = null;
      
      async function loadCurrentConfig() {
        try {
          const config = await fetch('/api/config').then(r => r.json());
          currentConfig = config;
          
          const ddLimit = (config.limits?.maxDailyDrawdownPct * 100) || 5;
          document.getElementById('drawdown-limit').textContent = ddLimit.toFixed(1);
          
          const turnoverLimit = (config.limits?.maxTurnoverPctPerDay * 100) || 100;
          document.getElementById('turnover-limit').textContent = turnoverLimit.toFixed(0);
        } catch (e) {
          console.error('Failed to load config:', e);
        }
      }
      
      let manualPauseState = false;
      
      async function togglePause() {
        try {
          const response = await fetch('/api/pause', { method: 'POST' });
          const result = await response.json();
          if (result.success) {
            manualPauseState = result.manualPause;
            updatePauseButton(result.manualPause);
            showToast(result.manualPause ? 'Trading PAUSED manually' : 'Trading RESUMED', result.manualPause ? 'error' : 'success');
          } else {
            showToast('Failed to toggle pause', 'error');
          }
        } catch (e) {
          showToast('Failed to toggle pause', 'error');
        }
      }
      
      function updatePauseButton(isPaused) {
        const btn = document.getElementById('pause-btn');
        if (isPaused) {
          btn.style.background = '#ef4444';
          btn.style.color = '#fff';
          btn.textContent = 'PAUSED';
        } else {
          btn.style.background = '#22c55e';
          btn.style.color = '#000';
          btn.textContent = 'RUNNING';
        }
      }
      
      async function loadDayTimer() {
        try {
          const resp = await fetch('/api/day-timer');
          if (!resp.ok) throw new Error('API error');
          const timer = await resp.json();
          const secs = timer.secondsRemaining;
          if (typeof secs === 'number' && secs >= 0 && secs <= 86400) {
            dayTimerSeconds = Math.floor(secs);
            updateDayTimerDisplay(dayTimerSeconds);
          } else {
            dayTimerSeconds = 86400;
            updateDayTimerDisplay(86400);
          }
        } catch (e) {
          dayTimerSeconds = 86400;
          updateDayTimerDisplay(86400);
        }
      }
      
      function updateDayTimerDisplay(seconds) {
        const safeSeconds = Math.max(0, Math.floor(seconds));
        const hours = Math.floor(safeSeconds / 3600);
        const mins = Math.floor((safeSeconds % 3600) / 60);
        const secs = safeSeconds % 60;
        const display = String(hours).padStart(2, '0') + ':' + String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
        document.getElementById('day-timer').textContent = display + ' CST';
      }
      
      let walletAddress = '';
      
      async function loadWallet() {
        try {
          const resp = await fetch('/api/wallet-address');
          if (!resp.ok) throw new Error('API error');
          const data = await resp.json();
          walletAddress = data.address;
          const short = walletAddress.slice(0, 4) + '...' + walletAddress.slice(-4);
          document.getElementById('wallet-addr').textContent = short;
          document.getElementById('wallet-display').title = 'Click to copy: ' + walletAddress;
          loadSpendableSol(walletAddress);
        } catch (e) {
          document.getElementById('wallet-addr').textContent = 'Error';
        }
      }
      
      function copyWallet() {
        if (!walletAddress) return;
        navigator.clipboard.writeText(walletAddress).then(() => {
          showToast('Wallet address copied!', 'success');
        }).catch(() => {
          const el = document.getElementById('wallet-addr');
          el.textContent = walletAddress;
          setTimeout(() => {
            const short = walletAddress.slice(0, 4) + '...' + walletAddress.slice(-4);
            el.textContent = short;
          }, 3000);
        });
      }
      
      let dayTimerSeconds = -1;
      let timerRefreshPending = false;
      let lastRefreshTime = 0;
      
      async function refreshDayTimer() {
        const now = Date.now();
        if (timerRefreshPending) return;
        if (dayTimerSeconds >= 0 && (now - lastRefreshTime < 5000)) return;
        timerRefreshPending = true;
        lastRefreshTime = now;
        try {
          const resp = await fetch('/api/day-timer');
          if (!resp.ok) throw new Error('API error');
          const timer = await resp.json();
          const secs = timer.secondsRemaining;
          if (typeof secs === 'number' && secs >= 0 && secs <= 86400) {
            dayTimerSeconds = Math.floor(secs);
            updateDayTimerDisplay(dayTimerSeconds);
          } else {
            dayTimerSeconds = 86400;
            updateDayTimerDisplay(86400);
          }
        } catch (e) {
          if (dayTimerSeconds < 0) {
            dayTimerSeconds = 86400;
            updateDayTimerDisplay(86400);
          }
        } finally {
          timerRefreshPending = false;
        }
      }
      
      setInterval(() => {
        if (dayTimerSeconds > 0) {
          dayTimerSeconds--;
          updateDayTimerDisplay(dayTimerSeconds);
        } else if (dayTimerSeconds === 0) {
          updateDayTimerDisplay(0);
          refreshDayTimer();
        } else if (dayTimerSeconds < 0) {
          refreshDayTimer();
        }
      }, 1000);
      
      setInterval(refreshDayTimer, 60000);
      
      async function loadPauseState() {
        try {
          const config = await fetch('/api/config').then(r => r.json());
          manualPauseState = config.manualPause || false;
          updatePauseButton(manualPauseState);
        } catch (e) {}
      }
      
      function updateState(state) {
        const circuitPaused = state.paused;
        const manualPaused = state.manualPause || manualPauseState;
        
        updatePauseButton(manualPaused || circuitPaused);
        
        const modeBadge = document.getElementById('mode-badge');
        const riskBadge = document.getElementById('risk-badge');
        const footerMode = document.getElementById('footer-mode');
        const footerRisk = document.getElementById('footer-risk');
        
        const mode = state.mode || 'paper';
        const risk = state.riskProfile || state.risk || 'medium';
        
        modeBadge.className = 'badge badge-' + mode;
        modeBadge.textContent = mode.toUpperCase();
        riskBadge.textContent = risk.toUpperCase();
        footerMode.textContent = mode.toUpperCase();
        footerRisk.textContent = risk.toUpperCase();
        
        const drawdownPct = state.circuit?.drawdownPct || 0;
        const ddLimit = currentConfig?.limits?.maxDailyDrawdownPct || 0.05;
        document.getElementById('drawdown').textContent = (drawdownPct * 100).toFixed(2) + '%';
        const ddBar = document.getElementById('drawdown-bar');
        ddBar.style.width = Math.min(100, drawdownPct / ddLimit * 100) + '%';
        ddBar.className = 'gauge-fill ' + (drawdownPct > ddLimit * 0.8 ? 'red' : drawdownPct > ddLimit * 0.5 ? 'yellow' : 'green');
        
        const turnover = state.circuit?.turnoverUsd || 0;
        document.getElementById('turnover').textContent = '$' + turnover.toFixed(2);
      }
      
      function updateTelemetry(t) {
        // Update from WebSocket telemetry
      }
      
      function updateWhaleStatusMap(entries) {
        if (!entries || !Array.isArray(entries)) return;
        for (const entry of entries) {
          whaleStatusMap.set(entry.mint, entry);
        }
      }
      
      function getWhaleIndicator(mint) {
        const status = whaleStatusMap.get(mint);
        if (!status) {
          return '<span class="whale-indicator whale-neutral" title="No whale data">🐋</span>';
        }
        const netflow = status.netflowUsd || 0;
        const netflowStr = netflow >= 0 ? '+$' + netflow.toFixed(0) : '-$' + Math.abs(netflow).toFixed(0);
        if (status.isPositive) {
          return '<span class="whale-indicator whale-positive" title="Netflow: ' + netflowStr + '">🐋↑</span>';
        } else if (status.isNegative) {
          return '<span class="whale-indicator whale-negative" title="Netflow: ' + netflowStr + '">🐋↓</span>';
        }
        return '<span class="whale-indicator whale-neutral" title="Netflow: ' + netflowStr + '">🐋</span>';
      }
      
      function getWhaleBadge(mint) {
        const status = whaleStatusMap.get(mint);
        if (!status) return '';
        const netflow = status.netflowUsd || 0;
        const netflowStr = netflow >= 0 ? '+$' + netflow.toFixed(0) : '-$' + Math.abs(netflow).toFixed(0);
        if (status.isPositive) {
          return '<span class="whale-badge positive" title="Netflow: ' + netflowStr + '">🐋 ' + netflowStr + '</span>';
        } else if (status.isNegative) {
          return '<span class="whale-badge negative" title="Netflow: ' + netflowStr + '">🐋 ' + netflowStr + '</span>';
        }
        return '<span class="whale-badge neutral" title="Netflow: ' + netflowStr + '">🐋</span>';
      }
      
      async function loadWhaleStatus() {
        try {
          const data = await fetch('/api/whale-status').then(r => r.json());
          if (data.entries) {
            updateWhaleStatusMap(data.entries);
          }
        } catch (e) {
          console.warn('Failed to load whale status:', e);
        }
      }
      
      async function loadAll() {
        try {
          const [eq, tr, series, status, signals, positions, signalHistory, dailyMetrics, whaleData] = await Promise.all([
            fetch('/api/equity').then(r=>r.json()),
            fetch('/api/trades').then(r=>r.json()),
            fetch('/api/equity-series').then(r=>r.json()),
            fetch('/api/status').then(r=>r.json()),
            fetch('/api/signals').then(r=>r.json()),
            fetch('/api/wallet-positions').then(r=>r.json()).catch(() => []),
            fetch('/api/signals/history').then(r=>r.json()).catch(() => ({ byToken: [], recent: [] })),
            fetch('/api/performance-metrics?period=daily').then(r=>r.json()).catch(() => ({ totalPnL: 0, percentReturn: 0 })),
            fetch('/api/whale-status').then(r=>r.json()).catch(() => ({ entries: [] }))
          ]);
          
          if (whaleData.entries) {
            updateWhaleStatusMap(whaleData.entries);
          }

          document.getElementById('total-usd').textContent = '$' + Number(eq.total_usd || 0).toFixed(2);
          document.getElementById('total-sol').textContent = Number(eq.total_sol_equiv || 0).toFixed(4) + ' SOL equiv';
          
          const dailyPnl = Number(dailyMetrics.totalPnL) || 0;
          const dailyPct = Number(dailyMetrics.percentReturn) || 0;
          const pnlUsdEl = document.getElementById('pnl-usd');
          const pnlPctEl = document.getElementById('pnl-pct');
          pnlUsdEl.textContent = (dailyPnl >= 0 ? '+$' : '-$') + Math.abs(dailyPnl).toFixed(2);
          pnlUsdEl.style.color = dailyPnl >= 0 ? '#00ff41' : '#ff4136';
          pnlPctEl.textContent = (dailyPct >= 0 ? '+' : '') + dailyPct.toFixed(2) + '%';
          pnlPctEl.style.color = dailyPct >= 0 ? '#00ff41' : '#ff4136';
          
          updateState(status);
          renderSignals(signals);
          renderPositions(positions);
          renderTrades(tr);
          renderEquityChart(series);
          renderSignalChart(signalHistory);
          
        } catch(e) {
          console.error('Load error:', e);
        }
      }
      
      async function loadSpendableSol(addr) {
        try {
          if (!addr) return;
          const holdings = await fetch('/api/wallet/' + addr + '/holdings').then(r => r.json());
          if (holdings && holdings.spendableSol !== undefined) {
            document.getElementById('spendable-sol').textContent = 'Spendable: ' + holdings.spendableSol.toFixed(4) + ' SOL';
          }
        } catch(e) {
          console.error('Failed to load spendable SOL:', e);
        }
      }
      
      function renderSignals(signals) {
        const container = document.getElementById('signals-mini');
        const fullContainer = document.getElementById('signals-full');
        
        if (!signals || signals.length === 0) {
          container.innerHTML = '<div class="empty">No active signals</div>';
          fullContainer.innerHTML = '<div class="empty">No active signals</div>';
          return;
        }
        
        const html = signals.map(s => {
          const whaleBadge = getWhaleBadge(s.mint);
          return \`
          <div class="signal-card">
            <div class="signal-header">
              <a href="https://solscan.io/token/\${s.mint}" target="_blank" class="token-link signal-symbol">\${s.symbol || s.mint?.slice(0,6) || 'Unknown'}</a>
              <span class="signal-regime \${s.regime}">\${s.regime}</span>
            </div>
            <div class="signal-score" style="color:\${s.score > 0 ? '#22c55e' : s.score < 0 ? '#ef4444' : '#fff'}">
              \${(s.score || 0).toFixed(3)}
              \${whaleBadge}
            </div>
            <div class="signal-meta">Target: \${((s.targetPct || 0) * 100).toFixed(1)}% | Current: \${((s.currentPct || 0) * 100).toFixed(1)}%</div>
          </div>
        \`}).join('');
        
        container.innerHTML = html;
        fullContainer.innerHTML = html;
      }
      
      function renderSignalChart(historyData) {
        const ctx = document.getElementById('signal-chart');
        if (!ctx) return;
        
        if (signalChart) {
          signalChart.destroy();
        }
        
        const recent = historyData?.recent || [];
        if (recent.length === 0) {
          ctx.parentElement.innerHTML = '<div class="empty" style="height:200px;display:flex;align-items:center;justify-content:center">No signal history yet. Data will appear after the bot runs for a while.</div>';
          return;
        }
        
        const matrixColors = ['#00ff41', '#00cc33', '#ff6b6b', '#ffd93d', '#4dabf7', '#cc33ff'];
        const byToken = historyData?.byToken || [];
        
        const datasets = byToken.slice(0, 6).map((token, idx) => {
          const history = token.history || [];
          return {
            label: token.symbol || token.mint?.slice(0, 6) || 'Unknown',
            data: history.map(h => ({
              x: new Date(h.lastUpdate),
              y: h.score
            })),
            borderColor: matrixColors[idx % matrixColors.length],
            backgroundColor: matrixColors[idx % matrixColors.length] + '20',
            fill: false,
            tension: 0.1,
            pointRadius: 2,
            pointHoverRadius: 5,
          };
        });
        
        if (datasets.length === 0 || datasets.every(d => d.data.length === 0)) {
          ctx.parentElement.innerHTML = '<div class="empty" style="height:200px;display:flex;align-items:center;justify-content:center">No signal history yet. Data will appear after the bot runs for a while.</div>';
          return;
        }
        
        signalChart = new Chart(ctx, {
          type: 'line',
          data: { datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { 
                display: true, 
                position: 'top', 
                labels: { 
                  color: '#00ff41', 
                  font: { family: 'Share Tech Mono, monospace', size: 10 } 
                } 
              },
              tooltip: {
                backgroundColor: 'rgba(0, 20, 0, 0.9)',
                borderColor: '#00ff41',
                borderWidth: 1,
                titleColor: '#00ff41',
                bodyColor: '#00ff41',
                callbacks: {
                  label: (ctx) => {
                    const point = ctx.raw;
                    return ctx.dataset.label + ': ' + (point.y || 0).toFixed(3);
                  }
                }
              }
            },
            scales: {
              x: { 
                type: 'time',
                time: { 
                  unit: 'minute',
                  displayFormats: { minute: 'HH:mm' }
                },
                ticks: { color: '#00ff41', font: { family: 'Share Tech Mono, monospace', size: 10 } }, 
                grid: { color: 'rgba(0, 255, 65, 0.1)' } 
              },
              y: { 
                title: { display: true, text: 'Score', color: '#00ff41' },
                ticks: { color: '#00ff41', font: { family: 'Share Tech Mono, monospace', size: 10 } }, 
                grid: { color: 'rgba(0, 255, 65, 0.1)' } 
              }
            }
          }
        });
      }
      
      function renderPositions(positions) {
        const container = document.getElementById('positions-mini');
        const fullContainer = document.getElementById('positions-full');
        
        if (!positions || positions.length === 0) {
          container.innerHTML = '<div class="empty">No positions</div>';
          fullContainer.innerHTML = '<div class="empty">No positions</div>';
          return;
        }
        
        const html = positions.map(p => {
          const hasPnl = p.unrealizedPnl !== undefined && p.unrealizedPnl !== null;
          const pnlPct = hasPnl ? p.unrealizedPnl : 0;
          const pnlUsd = p.unrealizedPnlUsd || 0;
          const pnlClass = pnlPct >= 0 ? 'pnl-positive' : 'pnl-negative';
          const pnlSign = pnlPct >= 0 ? '+' : '';
          const safeSymbol = (p.symbol || 'Unknown').replace(/"/g, '&quot;');
          const whaleIndicator = getWhaleIndicator(p.mint);
          const sniperIndicator = p.source === 'sniper' ? '<span title="Sniper position">🎯</span>' : '';
          return \`
          <div class="position-row">
            <div class="position-icon">\${p.symbol?.slice(0,2) || '?'}</div>
            <div class="position-info">
              <div class="position-name"><a href="https://solscan.io/token/\${p.mint}" target="_blank" class="token-link">\${sniperIndicator}\${p.symbol || p.mint?.slice(0,8) || 'Unknown'}</a></div>
              <div class="position-amount">\${Number(p.amount || 0).toLocaleString()} tokens</div>
            </div>
            <div style="min-width:32px;text-align:center">\${whaleIndicator}</div>
            <div class="position-value">
              <div class="position-usd">$\${Number(p.valueUsd || 0).toFixed(2)}</div>
              <div class="position-pct">\${((p.pctOfPortfolio || 0) * 100).toFixed(1)}%</div>
            </div>
            \${hasPnl ? \`<div class="position-pnl \${pnlClass}" style="min-width:80px;text-align:right">
              <div>\${pnlSign}\${pnlPct.toFixed(2)}%</div>
              <div style="font-size:10px;opacity:0.8">\${pnlSign}$\${Math.abs(pnlUsd).toFixed(2)}</div>
            </div>\` : ''}
            \${p.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' 
              ? \`<button class="buy-sol-btn" data-mint="\${p.mint}" data-amount="\${p.amount}" data-decimals="\${p.decimals || 6}" title="Convert USDC to SOL">💰 Buy SOL</button>\`
              : \`<button class="flash-close-btn" data-mint="\${p.mint}" data-amount="\${p.amount}" data-decimals="\${p.decimals || 9}" data-symbol="\${safeSymbol}" title="Market sell entire position">⚡ Close</button>\`}
          </div>
        \`}).join('');
        
        container.innerHTML = html;
        fullContainer.innerHTML = html;
        
        renderAllocationChart(positions);
      }
      
      function renderAllocationChart(positions) {
        const ctx = document.getElementById('allocation-chart');
        if (!ctx) return;
        
        if (allocationChart) {
          allocationChart.destroy();
        }
        
        if (!positions || positions.length === 0) {
          ctx.parentElement.innerHTML = '<div class="empty" style="height:200px;display:flex;align-items:center;justify-content:center">No positions</div>';
          return;
        }
        
        const matrixGreens = [
          '#00ff41',
          '#00cc33',
          '#009926',
          '#00661a',
          '#004d13',
          '#00ff41cc',
          '#00cc33cc',
          '#009926cc',
        ];
        
        const labels = positions.map(p => p.symbol || p.mint?.slice(0,6) || 'Unknown');
        const data = positions.map(p => Number(p.valueUsd || 0));
        const colors = positions.map((_, i) => matrixGreens[i % matrixGreens.length]);
        
        allocationChart = new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels,
            datasets: [{
              data,
              backgroundColor: colors,
              borderColor: '#000',
              borderWidth: 2,
              hoverBorderColor: '#00ff41',
              hoverBorderWidth: 3,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '60%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  color: '#00ff41',
                  font: { family: 'Share Tech Mono', size: 11 },
                  padding: 12,
                  usePointStyle: true,
                  pointStyle: 'rect',
                }
              },
              tooltip: {
                backgroundColor: 'rgba(0,15,0,0.95)',
                titleColor: '#00ff41',
                bodyColor: '#00ff41',
                borderColor: '#00ff41',
                borderWidth: 1,
                titleFont: { family: 'Share Tech Mono' },
                bodyFont: { family: 'Share Tech Mono' },
                callbacks: {
                  label: function(context) {
                    const value = context.raw;
                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                    const pct = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                    return context.label + ': $' + value.toFixed(2) + ' (' + pct + '%)';
                  }
                }
              }
            },
            animation: {
              animateRotate: true,
              duration: 800,
            }
          }
        });
      }
      
      function renderTrades(trades) {
        const container = document.getElementById('trades-mini');
        const fullContainer = document.getElementById('trades-full');
        
        if (!trades || trades.length === 0) {
          const empty = '<div class="empty">No trades yet</div>';
          container.innerHTML = empty;
          fullContainer.innerHTML = empty;
          return;
        }
        
        const rows = trades.slice(0, 10).map(t => {
          const solscan = t.tx_sig ? 'https://solscan.io/tx/' + t.tx_sig : null;
          const link = solscan ? '<a target="_blank" href="' + solscan + '">View</a>' : '<span style="color:#64748b">Paper</span>';
          const statusClass = t.status === 'sent' ? 'green' : t.status === 'paper' ? 'yellow' : 'red';
          const sideColor = t.side === 'BUY' ? '#00ff41' : t.side === 'SELL' ? '#ff4136' : '#ffd93d';
          const sideLabel = t.side || 'SWAP';
          const assetLabel = t.assetSymbol || '?';
          const assetLink = t.assetMint ? '<a href="https://solscan.io/token/' + t.assetMint + '" target="_blank" class="token-link">' + assetLabel + '</a>' : assetLabel;
          return '<tr>' +
            '<td>' + new Date(t.ts).toLocaleString() + '</td>' +
            '<td><span class="status-dot ' + statusClass + '"></span>' + t.status + '</td>' +
            '<td><span style="color:' + sideColor + ';font-weight:700">' + sideLabel + '</span> ' + assetLink + '</td>' +
            '<td>' + link + '</td>' +
          '</tr>';
        }).join('');

        const table = '<table><thead><tr><th>Time</th><th>Status</th><th>Trade</th><th>Tx</th></tr></thead><tbody>' + rows + '</tbody></table>';
        container.innerHTML = table;
        
        // Full trades table with more columns
        const fullRows = trades.slice(0, 50).map(t => {
          const solscan = t.tx_sig ? 'https://solscan.io/tx/' + t.tx_sig : null;
          const link = solscan ? '<a target="_blank" href="' + solscan + '">View</a>' : '-';
          const statusClass = t.status === 'sent' ? 'green' : t.status === 'paper' ? 'yellow' : 'red';
          const sideColor = t.side === 'BUY' ? '#00ff41' : t.side === 'SELL' ? '#ff4136' : '#ffd93d';
          const sideLabel = t.side || 'SWAP';
          const pnlValue = parseFloat(t.pnl_usd) || 0;
          const pnlColor = pnlValue >= 0 ? '#00ff41' : '#ff4136';
          const pnlDisplay = pnlValue >= 0 ? '+$' + pnlValue.toFixed(2) : '-$' + Math.abs(pnlValue).toFixed(2);
          const assetLink = t.assetMint ? '<a href="https://solscan.io/token/' + t.assetMint + '" target="_blank" class="token-link">' + (t.assetSymbol || '?') + '</a>' : (t.assetSymbol || '?');
          return '<tr>' +
            '<td>' + new Date(t.ts).toLocaleString() + '</td>' +
            '<td><span style="color:' + sideColor + ';font-weight:700">' + sideLabel + '</span></td>' +
            '<td style="font-weight:600">' + assetLink + '</td>' +
            '<td>' + (t.inputSymbol || '?') + ' \u2192 ' + (t.outputSymbol || '?') + '</td>' +
            '<td>' + (t.mode || '-') + '</td>' +
            '<td><span class="status-dot ' + statusClass + '"></span>' + t.status + '</td>' +
            '<td style="color:' + pnlColor + '">' + pnlDisplay + '</td>' +
            '<td>' + (t.slippage_bps || 0) + ' bps</td>' +
            '<td>' + link + '</td>' +
          '</tr>';
        }).join('');
        
        fullContainer.innerHTML = '<table><thead><tr><th>Time</th><th>Side</th><th>Asset</th><th>Route</th><th>Mode</th><th>Status</th><th>P&L</th><th>Slippage</th><th>Tx</th></tr></thead><tbody>' + fullRows + '</tbody></table>';
      }
      
      function renderEquityChart(series) {
        const labels = series.map(x => new Date(x.ts).toLocaleTimeString());
        const data = series.map(x => Number(x.total_usd));

        if (!equityChart) {
          const ctx = document.getElementById('equity-chart').getContext('2d');
          equityChart = new Chart(ctx, {
            type: 'line',
            data: { 
              labels, 
              datasets: [{ 
                label: 'Portfolio USD', 
                data,
                borderColor: '#818cf8',
                backgroundColor: 'rgba(129,140,248,0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 0
              }] 
            },
            options: { 
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { display: false },
                y: { 
                  grid: { color: 'rgba(255,255,255,0.05)' },
                  ticks: { color: '#64748b' }
                }
              }
            }
          });
        } else {
          equityChart.data.labels = labels;
          equityChart.data.datasets[0].data = data;
          equityChart.update();
        }
      }
      
      let currentEquityRange = '24h';
      let currentMetricsPeriod = 'daily';
      
      async function changeEquityRange(range) {
        currentEquityRange = range;
        document.querySelectorAll('.equity-range-btn').forEach(btn => {
          btn.classList.remove('active');
          if (btn.dataset.range === range) btn.classList.add('active');
        });
        
        try {
          const series = await fetch('/api/equity-series?range=' + range).then(r => r.json());
          renderEquityChart(series);
        } catch (e) {
          console.error('Failed to load equity series:', e);
        }
      }
      
      async function loadMetrics(period) {
        currentMetricsPeriod = period;
        document.querySelectorAll('.perf-tab').forEach(btn => {
          btn.classList.remove('active');
          if (btn.dataset.period === period) btn.classList.add('active');
        });
        
        try {
          const metrics = await fetch('/api/metrics?period=' + period).then(r => r.json());
          renderMetrics(metrics);
        } catch (e) {
          console.error('Failed to load metrics:', e);
        }
      }
      
      function renderMetrics(m) {
        if (!m || m.error) {
          console.error('Invalid metrics response:', m);
          return;
        }
        
        const formatMoney = (n) => {
          const num = Number(n) || 0;
          const sign = num >= 0 ? '' : '-';
          return sign + '$' + Math.abs(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };
        
        const safeNum = (v) => Number(v) || 0;
        
        const periodLabels = {
          daily: 'Today (CST)',
          weekly: 'Last 7 Days',
          monthly: 'Last 30 Days',
          yearly: 'Last 365 Days',
          all: 'All Time'
        };
        
        const totalPnL = safeNum(m.totalPnL);
        const percentReturn = safeNum(m.percentReturn);
        const winRate = safeNum(m.winRate);
        const winCount = safeNum(m.winCount);
        const lossCount = safeNum(m.lossCount);
        const totalTrades = safeNum(m.totalTrades);
        const avgTradeSize = safeNum(m.avgTradeSize);
        const turnover = safeNum(m.turnover);
        const bestTrade = safeNum(m.bestTrade);
        const worstTrade = safeNum(m.worstTrade);
        const maxDrawdown = safeNum(m.maxDrawdown);
        
        const pnlEl = document.getElementById('metric-pnl');
        pnlEl.textContent = formatMoney(totalPnL);
        pnlEl.className = 'metric-value ' + (totalPnL >= 0 ? 'positive' : 'negative');
        
        const returnEl = document.getElementById('metric-return');
        returnEl.textContent = percentReturn.toFixed(2) + '%';
        returnEl.className = 'metric-value ' + (percentReturn >= 0 ? 'positive' : 'negative');
        
        document.getElementById('metric-winrate').textContent = winRate.toFixed(2) + '%';
        document.getElementById('metric-winloss').textContent = winCount + ' wins / ' + lossCount + ' losses';
        document.getElementById('metric-trades').textContent = totalTrades.toLocaleString();
        document.getElementById('metric-avgsize').textContent = formatMoney(avgTradeSize);
        document.getElementById('metric-turnover').textContent = formatMoney(turnover);
        document.getElementById('metric-best').textContent = formatMoney(bestTrade);
        document.getElementById('metric-worst').textContent = formatMoney(worstTrade);
        document.getElementById('metric-drawdown').textContent = maxDrawdown.toFixed(2) + '%';
        document.getElementById('metric-period-label').textContent = periodLabels[m.period] || m.period;
      }
      
      let scannerAutoRefresh = null;
      let lastScanTimestamp = null;
      
      function renderTokenCard(t, showScore = true, showAddButton = false) {
        const priceChange = t.priceChange24h || t.price_change_24h || 0;
        const changeClass = priceChange >= 0 ? 'up' : 'down';
        const changeSign = priceChange >= 0 ? '+' : '';
        const reasons = t.reasons || [];
        const score = t.score || 0;
        const whaleIndicator = getWhaleIndicator(t.mint);
        
        return \`
          <div style="background:#0f172a;border-radius:12px;padding:14px;border:1px solid #334155;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:36px;height:36px;background:#334155;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">\${(t.symbol || '?').slice(0,2)}</div>
                <div>
                  <div style="font-weight:600;color:#fff;font-size:14px"><a href="https://solscan.io/token/\${t.mint}" target="_blank" class="token-link" style="color:#fff">\${t.symbol || 'Unknown'}</a> \${whaleIndicator}</div>
                  <div style="font-size:11px;color:#64748b">\${t.name?.slice(0, 25) || (t.mint)?.slice(0, 12)}...</div>
                </div>
              </div>
              \${showScore && score > 0 ? '<div style="background:#818cf8;color:#fff;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600">Score: ' + score + '</div>' : ''}
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
              <div><span style="color:#64748b;font-size:10px">Price</span><br/><span style="color:#fff;font-size:12px">$\${Number(t.price || 0).toPrecision(4)}</span></div>
              <div><span style="color:#64748b;font-size:10px">24h Change</span><br/><span class="trending-change \${changeClass}" style="font-size:12px">\${changeSign}\${priceChange.toFixed(2)}%</span></div>
              <div><span style="color:#64748b;font-size:10px">Volume</span><br/><span style="color:#fff;font-size:12px">$\${formatNumber(t.volume24h || t.volume_24h || 0)}</span></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
              <div><span style="color:#64748b;font-size:10px">Liquidity</span><br/><span style="color:#fff;font-size:12px">$\${formatNumber(t.liquidity || 0)}</span></div>
              <div><span style="color:#64748b;font-size:10px">Market Cap</span><br/><span style="color:#fff;font-size:12px">$\${formatNumber(t.marketCap || t.market_cap || 0)}</span></div>
              <div><span style="color:#64748b;font-size:10px">Holders</span><br/><span style="color:#fff;font-size:12px">\${formatNumber(t.holders || 0)}</span></div>
            </div>
            \${reasons.length > 0 ? '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">' + reasons.map(r => '<span style="background:#1e1b4b;color:#a5b4fc;padding:3px 8px;border-radius:4px;font-size:10px">' + r + '</span>').join('') + '</div>' : ''}
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:10px;color:#64748b">Source: \${t.source || 'DexScreener'}</span>
              <div style="display:flex;gap:8px">
                <a href="#" data-action="viewToken" data-mint="\${t.mint}" style="font-size:11px;color:#818cf8">View on Solscan</a>
                \${showAddButton ? '<button data-action="addToUniverse" data-mint="'+t.mint+'" data-symbol="'+t.symbol+'" data-name="'+((t.name || t.symbol || '').replace(/'/g, ''))+'" style="background:#22c55e;color:#000;border:none;padding:4px 10px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer">Add to Universe</button>' : ''}
              </div>
            </div>
          </div>
        \`;
      }
      
      function formatNumber(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(2) + 'K';
        return Number(n).toFixed(2);
      }
      
      async function refreshScanner() {
        document.getElementById('scanner-status').textContent = 'Scanning...';
        try {
          const result = await fetch('/api/scanner/refresh', { method: 'POST', credentials: 'include' }).then(r => r.json());
          lastScanTimestamp = result.timestamp;
          updateScannerStatus();
          renderScannerData(result);
          showToast('Scanner refreshed successfully', 'success');
        } catch (e) {
          showToast('Failed to refresh scanner', 'error');
          document.getElementById('scanner-status').textContent = 'Scan failed';
        }
      }
      
      function updateScannerStatus() {
        if (lastScanTimestamp) {
          const ago = Math.floor((Date.now() - lastScanTimestamp) / 1000);
          if (ago < 60) {
            document.getElementById('scanner-status').textContent = 'Last scan: ' + ago + 's ago';
          } else {
            document.getElementById('scanner-status').textContent = 'Last scan: ' + Math.floor(ago / 60) + 'm ago';
          }
        }
      }
      
      async function loadScannerData() {
        try {
          const result = await fetch('/api/scan', { credentials: 'include' }).then(r => r.json());
          if (result.timestamp) lastScanTimestamp = result.timestamp;
          updateScannerStatus();
          renderScannerData(result);
        } catch (e) {
          console.error('Failed to load scanner data', e);
        }
      }
      
      function renderScannerData(result) {
        const trendingList = document.getElementById('trending-list');
        const listingsList = document.getElementById('listings-list');
        const opportunitiesList = document.getElementById('opportunities-list');
        
        const trending = result.trending || [];
        const listings = result.newListings || [];
        const opportunities = result.topOpportunities || [];
        
        document.getElementById('scanner-stats').textContent = 
          trending.length + ' trending | ' + listings.length + ' listings | ' + opportunities.length + ' opportunities';
        
        if (trending.length === 0) {
          trendingList.innerHTML = '<div class="empty">No trending tokens found</div>';
        } else {
          trendingList.innerHTML = trending.slice(0, 15).map(t => renderTokenCard(t, true, false)).join('');
        }
        
        if (listings.length === 0) {
          listingsList.innerHTML = '<div class="empty">No new listings found</div>';
        } else {
          listingsList.innerHTML = listings.slice(0, 15).map(t => renderTokenCard(t, true, false)).join('');
        }
        
        if (opportunities.length === 0) {
          opportunitiesList.innerHTML = '<div class="empty">No top opportunities found</div>';
        } else {
          opportunitiesList.innerHTML = opportunities.map(t => renderTokenCard(t, true, true)).join('');
        }
      }
      
      async function addToUniverse(mint, symbol, name) {
        try {
          const response = await fetch('/api/universe/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mint, symbol, name: name || symbol, source: 'scanner' })
          });
          const result = await response.json();
          if (result.success) {
            showToast('Added ' + symbol + ' to trading universe', 'success');
            const btn = document.querySelector('button[data-mint="' + mint + '"]');
            if (btn) {
              btn.textContent = 'In Universe';
              btn.disabled = true;
              btn.style.background = '#334155';
              btn.style.cursor = 'default';
            }
            loadUniverse();
          } else {
            showToast(result.error || 'Failed to add ' + symbol, 'error');
          }
        } catch (e) {
          showToast('Failed to add ' + symbol + ' to universe', 'error');
        }
      }
      
      const scannerAutoRefreshEl = document.getElementById('scanner-auto-refresh');
      if (scannerAutoRefreshEl) {
        scannerAutoRefreshEl.addEventListener('change', function() {
          if (this.checked) {
            scannerAutoRefresh = setInterval(refreshScanner, 5 * 60 * 1000);
            showToast('Auto-refresh enabled (5 min)', 'success');
          } else {
            clearInterval(scannerAutoRefresh);
            scannerAutoRefresh = null;
            showToast('Auto-refresh disabled', 'success');
          }
        });
      }
      
      setInterval(updateScannerStatus, 10000);
      
      async function loadTrending() {
        loadScannerData();
      }
      
      async function loadNewListings() {
        loadScannerData();
      }
      
      function viewToken(mint) {
        window.open('https://solscan.io/token/' + mint, '_blank');
      }
      
      async function loadCacheStats() {
        try {
          const stats = await fetch('/api/cache-stats').then(r => r.json());
          const dex = stats.dexscreener || {};
          const sol = stats.solscan || {};
          const totalValid = (dex.valid || 0) + (sol.valid || 0);
          const totalAll = (dex.total || 0) + (sol.total || 0);
          document.getElementById('cache-stats').textContent = totalValid + ' cached / ' + totalAll + ' total';
          document.getElementById('cache-info').innerHTML = \`
            <div style="display:grid;gap:8px">
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">DexScreener</span><span>\${dex.valid || 0}/\${dex.total || 0}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Solscan</span><span>\${sol.valid || 0}/\${sol.total || 0}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Total Valid</span><span>\${totalValid}</span></div>
            </div>
          \`;
        } catch (e) {
          document.getElementById('cache-info').innerHTML = '<div class="empty">Failed to load</div>';
        }
      }
      
      async function loadHealth() {
        try {
          const h = await fetch('/api/health').then(r => r.json());
          document.getElementById('health-info').innerHTML = \`
            <div style="display:grid;gap:8px">
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Status</span><span class="\${h.status === 'running' ? 'green' : 'yellow'}">\${h.status?.toUpperCase()}</span></div>
              \${h.pauseReason ? '<div style="display:flex;justify-content:space-between"><span style="color:#64748b">Pause Reason</span><span style="color:#ef4444">' + h.pauseReason + '</span></div>' : ''}
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Uptime</span><span>\${h.uptimeHours}h</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Last Tick</span><span>\${h.lastTickAt ? new Date(h.lastTickAt).toLocaleTimeString() : 'Never'}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Risk Profile</span><span>\${h.riskProfile}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Mode</span><span>\${h.executionMode}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Wallet</span><span style="font-size:11px">\${h.walletAddress?.slice(0,8) || '-'}...</span></div>
            </div>
          \`;
        } catch (e) {
          document.getElementById('health-info').innerHTML = '<div class="empty">Failed to load</div>';
        }
      }
      
      // Rotation Tab Functions
      async function loadRotationData() {
        await Promise.all([loadSlotStatus(), loadRotationLog(), loadWeeklyReport()]);
      }
      
      async function loadSlotStatus() {
        try {
          const data = await fetch('/api/slot-status').then(r => r.json());
          const config = data.slotConfig || {};
          const corePositions = data.corePositions || [];
          const scoutPositions = data.scoutPositions || [];
          const staleThresholdHours = data.staleThresholdHours || 48;
          const staleExitHours = data.staleExitHours || 72;
          
          document.getElementById('core-slot-count').textContent = corePositions.length + '/' + (config.coreSlots || 5);
          document.getElementById('scout-slot-count').textContent = scoutPositions.length + '/' + (config.scoutSlots || 10);
          
          const coreGrid = document.getElementById('core-slots-grid');
          const scoutGrid = document.getElementById('scout-slots-grid');
          
          if (corePositions.length === 0) {
            coreGrid.innerHTML = '<div class="empty">No core positions</div>';
          } else {
            coreGrid.innerHTML = corePositions.map(p => \`
              <div class="slot-item filled">
                <span class="slot-badge core">CORE</span>
                <div style="font-size:11px;margin-top:4px;color:#00ff41"><a href="https://solscan.io/token/\${p.mint}" target="_blank" class="token-link">\${p.symbol || p.mint?.slice(0,6) || '?'}</a></div>
                <div style="font-size:10px;color:#008f11">\${p.hoursHeld?.toFixed(1) || 0}h</div>
              </div>
            \`).join('');
          }
          
          if (scoutPositions.length === 0) {
            scoutGrid.innerHTML = '<div class="empty">No scout positions</div>';
          } else {
            scoutGrid.innerHTML = scoutPositions.map(p => {
              const whaleInd = getWhaleIndicator(p.mint);
              const whaleStatus = whaleStatusMap.get(p.mint);
              const readyForPromotion = whaleStatus?.isPositive ? '<span class="whale-promo-ready" title="Positive whale flow - ready for promotion">PROMO READY</span>' : '';
              return \`
              <div class="slot-item filled">
                <span class="slot-badge scout">SCOUT</span>
                <div style="font-size:11px;margin-top:4px;color:#ff00ff"><a href="https://solscan.io/token/\${p.mint}" target="_blank" class="token-link" style="color:#ff00ff">\${p.symbol || p.mint?.slice(0,6) || '?'}</a></div>
                <div style="font-size:10px;color:#008f11">\${p.hoursHeld?.toFixed(1) || 0}h \${whaleInd}</div>
                \${readyForPromotion}
              </div>
            \`}).join('');
          }
          
          // Render position health
          const allPositions = [...corePositions.map(p => ({...p, slotType: 'core'})), ...scoutPositions.map(p => ({...p, slotType: 'scout'}))];
          const healthList = document.getElementById('position-health-list');
          
          if (allPositions.length === 0) {
            healthList.innerHTML = '<div class="empty">No positions tracked</div>';
          } else {
            healthList.innerHTML = '<table><thead><tr><th>Position</th><th>Slot</th><th>Held</th><th>P&L</th><th>P&L USD</th><th>Peak</th><th>Status</th></tr></thead><tbody>' +
              allPositions.map(p => {
                const pnlClass = p.pnlPct >= 0 ? 'pnl-positive' : 'pnl-negative';
                const pnlSign = p.pnlPct >= 0 ? '+' : '';
                const hoursHeld = p.hoursHeld || 0;
                const isStale = hoursHeld >= staleThresholdHours;
                const isExitStale = hoursHeld >= staleExitHours;
                const staleClass = isExitStale ? 'stale-warning' : (isStale ? 'stale-warning' : '');
                const peakDrop = p.peakPrice > 0 && p.currentPrice > 0 ? ((p.peakPrice - p.currentPrice) / p.peakPrice * 100) : 0;
                const pnlUsd = p.pnlUsd || 0;
                const pnlUsdSign = pnlUsd >= 0 ? '+' : '';
                
                const symbolLink = p.mint ? '<a href="https://solscan.io/token/' + p.mint + '" target="_blank" class="token-link">' + (p.symbol || p.mint?.slice(0,8) || '?') + '</a>' : (p.symbol || '?');
                return '<tr>' +
                  '<td>' + symbolLink + '</td>' +
                  '<td><span class="slot-badge ' + p.slotType + '">' + p.slotType.toUpperCase() + '</span></td>' +
                  '<td class="' + staleClass + '">' + (hoursHeld < 24 ? hoursHeld.toFixed(1) + 'h' : (hoursHeld / 24).toFixed(1) + 'd') + '</td>' +
                  '<td class="' + pnlClass + '">' + pnlSign + p.pnlPct.toFixed(2) + '%</td>' +
                  '<td class="' + pnlClass + '">' + pnlUsdSign + '$' + Math.abs(pnlUsd).toFixed(2) + '</td>' +
                  '<td>' + peakDrop.toFixed(1) + '% from peak</td>' +
                  '<td>' + (isExitStale ? '<span class="stale-warning">EXIT SOON</span>' : (isStale ? '<span style="color:#ffff00">STALE</span>' : '<span style="color:#00ff41">OK</span>')) + '</td>' +
                '</tr>';
              }).join('') +
            '</tbody></table>';
          }
        } catch (e) {
          console.error('Failed to load slot status:', e);
          document.getElementById('core-slots-grid').innerHTML = '<div class="empty">Failed to load</div>';
          document.getElementById('scout-slots-grid').innerHTML = '<div class="empty">Failed to load</div>';
        }
      }
      
      function getReasonBadgeClass(code) {
        if (code?.includes('trailing')) return 'trailing';
        if (code?.includes('stale')) return 'stale';
        if (code?.includes('promotion')) return 'promotion';
        if (code?.includes('rotation') || code?.includes('opportunity')) return 'rotation';
        return '';
      }
      
      async function loadRotationLog() {
        try {
          const logs = await fetch('/api/rotation-log?limit=50').then(r => r.json());
          const container = document.getElementById('rotation-log-list');
          
          if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="empty">No rotation activity yet</div>';
            return;
          }
          
          container.innerHTML = '<table><thead><tr><th>Time</th><th>Action</th><th>Trade</th><th>Reason</th><th>Rank \u0394</th></tr></thead><tbody>' +
            logs.map(log => {
              const badgeClass = getReasonBadgeClass(log.reason_code);
              const soldSymbol = log.sold_symbol || log.sold_mint?.slice(0,6) || '-';
              const soldLink = log.sold_mint ? '<a href="https://solscan.io/token/' + log.sold_mint + '" target="_blank" class="token-link">' + soldSymbol + '</a>' : soldSymbol;
              const boughtSymbol = log.bought_symbol || log.bought_mint?.slice(0,6) || 'exit';
              const boughtLink = log.bought_mint ? '<a href="https://solscan.io/token/' + log.bought_mint + '" target="_blank" class="token-link">' + boughtSymbol + '</a>' : boughtSymbol;
              const tradeStr = log.action === 'promotion' 
                ? boughtLink + ' promoted'
                : soldLink + ' \u2192 ' + boughtLink;
              return '<tr>' +
                '<td>' + new Date(log.ts).toLocaleString() + '</td>' +
                '<td>' + (log.action || '-') + '</td>' +
                '<td>' + tradeStr + '</td>' +
                '<td><span class="reason-badge ' + badgeClass + '">' + (log.reason_code || '-') + '</span></td>' +
                '<td>' + (log.rank_delta != null ? Number(log.rank_delta).toFixed(2) : '-') + '</td>' +
              '</tr>';
            }).join('') +
          '</tbody></table>';
        } catch (e) {
          console.error('Failed to load rotation log:', e);
          document.getElementById('rotation-log-list').innerHTML = '<div class="empty">Failed to load</div>';
        }
      }
      
      async function loadWeeklyReport() {
        try {
          const data = await fetch('/api/weekly-report').then(r => r.json());
          const report = data.report;
          const container = document.getElementById('weekly-report-content');
          
          if (!report) {
            container.innerHTML = '<div class="empty">No report data</div>';
            return;
          }
          
          const summary = report.summary || {};
          const perf = report.performance || {};
          const breakdown = report.rotationBreakdown || [];
          const winners = report.topWinners || [];
          const losers = report.topLosers || [];
          
          let html = '<div style="display:grid;gap:12px">';
          
          html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">';
          html += '<div><span style="color:#008f11;font-size:10px">Period</span><br/><span style="color:#00ff41;font-size:12px">' + new Date(report.periodStart).toLocaleDateString() + ' - ' + new Date(report.periodEnd).toLocaleDateString() + '</span></div>';
          html += '<div><span style="color:#008f11;font-size:10px">Total Trades</span><br/><span style="color:#00ff41;font-size:12px">' + (summary.totalTrades || 0) + '</span></div>';
          html += '<div><span style="color:#008f11;font-size:10px">Win Rate</span><br/><span style="color:#00ff41;font-size:12px">' + ((perf.winRate || 0) * 100).toFixed(1) + '%</span></div>';
          html += '</div>';
          
          html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">';
          const pnlClass = (perf.realizedPnlUsd || 0) >= 0 ? 'pnl-positive' : 'pnl-negative';
          html += '<div><span style="color:#008f11;font-size:10px">Realized P&L</span><br/><span class="' + pnlClass + '" style="font-size:12px">$' + (perf.realizedPnlUsd || 0).toFixed(2) + '</span></div>';
          html += '<div><span style="color:#008f11;font-size:10px">Rotations</span><br/><span style="color:#00ffff;font-size:12px">' + (summary.rotations || 0) + '</span></div>';
          html += '<div><span style="color:#008f11;font-size:10px">Promotions</span><br/><span style="color:#00ff41;font-size:12px">' + (summary.promotions || 0) + '</span></div>';
          html += '</div>';
          
          if (breakdown.length > 0) {
            html += '<div style="margin-top:8px"><span style="color:#008f11;font-size:11px">ROTATION BREAKDOWN</span>';
            html += '<div style="display:grid;gap:4px;margin-top:4px">';
            breakdown.forEach(b => {
              const badgeClass = getReasonBadgeClass(b.reasonCode);
              html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #003300">';
              html += '<span class="reason-badge ' + badgeClass + '">' + b.reasonCode + '</span>';
              html += '<span style="font-size:11px">' + b.count + ' trades | $' + (b.totalPnlUsd || 0).toFixed(2) + '</span>';
              html += '</div>';
            });
            html += '</div></div>';
          }
          
          if (winners.length > 0) {
            html += '<div style="margin-top:8px"><span style="color:#00ff41;font-size:11px">TOP WINNERS</span>';
            html += '<div style="display:grid;gap:2px;margin-top:4px">';
            winners.slice(0,3).forEach(w => {
              const winnerLink = w.mint ? '<a href="https://solscan.io/token/' + w.mint + '" target="_blank" class="token-link">' + (w.symbol || w.mint?.slice(0,6)) + '</a>' : (w.symbol || '?');
              html += '<div style="display:flex;justify-content:space-between;font-size:11px"><span>' + winnerLink + '</span><span class="pnl-positive">+$' + w.pnlUsd.toFixed(2) + '</span></div>';
            });
            html += '</div></div>';
          }
          
          if (losers.length > 0) {
            html += '<div style="margin-top:8px"><span style="color:#ff0040;font-size:11px">TOP LOSERS</span>';
            html += '<div style="display:grid;gap:2px;margin-top:4px">';
            losers.slice(0,3).forEach(l => {
              const loserLink = l.mint ? '<a href="https://solscan.io/token/' + l.mint + '" target="_blank" class="token-link">' + (l.symbol || l.mint?.slice(0,6)) + '</a>' : (l.symbol || '?');
              html += '<div style="display:flex;justify-content:space-between;font-size:11px"><span>' + loserLink + '</span><span class="pnl-negative">$' + l.pnlUsd.toFixed(2) + '</span></div>';
            });
            html += '</div></div>';
          }
          
          html += '</div>';
          container.innerHTML = html;
        } catch (e) {
          console.error('Failed to load weekly report:', e);
          document.getElementById('weekly-report-content').innerHTML = '<div class="empty">Failed to load report</div>';
        }
      }
      
      // Rotation refresh click handler
      document.querySelectorAll('.rotation-refresh').forEach(el => {
        el.addEventListener('click', loadRotationData);
      });
      
      // Settings State Management
      let savedSettings = {};
      let draftSettings = {};
      let settingsLoading = false;
      let settingsSaving = false;
      
      const settingsDefaults = {
        riskProfile: 'medium',
        executionMode: 'paper',
        loopSeconds: 30,
        maxDailyDrawdownPct: 5,
        maxPositionPctPerAsset: 25,
        autonomousScoutsEnabled: false,
        autonomousDryRun: true,
        scoutAutoQueueScore: 10,
        scoutBuySol: 0.02,
        minSolReserve: 0.1,
        scoutTokenCooldownHours: 24,
        scoutDailyLimit: 5,
        scoutQueuePollSeconds: 60,
        scanIntervalMinutes: 5,
        maxTurnoverPctPerDay: 100,
        takeProfitPct: 5,
        maxSlippageBps: 80,
        maxSingleSwapSol: 1.5,
        minTradeUsd: 25,
        maxPositions: 10,
        coreSlots: 5,
        scoutSlots: 10,
        corePositionPctTarget: 12,
        maxTop3ConcentrationPct: 70,
        maxPortfolioVolatility: 50,
        scannerMinLiquidity: 10000,
        scannerMinVolume24h: 5000,
        scannerMinHolders: 100,
        scannerMaxPriceChange24h: 500,
        scannerMinPriceChange24h: -50,
        rankingSignalWeight: 3.0,
        rankingMomentumWeight: 2.0,
        rankingTimeDecayWeight: 1.0,
        rankingTrailingWeight: 2.5,
        rankingFreshnessWeight: 1.5,
        rankingQualityWeight: 1.0,
        rankingStalePenalty: -2.0,
        rankingTrailingStopPenalty: -10.0,
        promotionMinPnlPct: 20,
        promotionMinSignalScore: 1.0,
        reentryEnabled: true,
        reentryCooldownMinutes: 3,
        reentryWindowMinutes: 30,
        reentryMinMomentumScore: 1.0,
        reentrySizeMultiplier: 3.0,
        reentryMaxSolPct: 0.5,
        strategyTrendThreshold: 0.75,
        strategyMomentumFactor: 0.25,
        strategyBand: 0.05,
        minTicksForSignals: 60,
        minTicksForFullAlloc: 30,
        exitInvariantEnabled: true,
        exitInvariantMaxRetries: 2,
        exitInvariantRetryDelayMs: 1200,
        exitInvariantMinRemainingQty: 0,
        exitInvariantMinRemainingUsd: 0.50,
        exitInvariantSlippageBps: 300,
        exitInvariantForceExactClose: false,
        preFullAllocMaxPct: 8,
        concentrationRebalanceMaxPct: 25,
        transferThresholdUsd: 5,
        whaleConfirmEnabled: false,
        whaleConfirmDryRun: true,
        whaleConfirmPollSeconds: 30,
        whaleWindowMinutes: 10,
        whaleMinUsd: 5000,
        whaleNetflowTriggerUsd: 8000,
        marketConfirmPct: 1.5,
        maxPriceImpactBps: 150,
        exitNetflowUsd: -7000,
        exitTrailDrawdownPct: 8,
        scoutUnderperformMinutes: 180,
        whaleCooldownMinutes: 60,
        stalePnlBandPct: 0.05,
        dustThresholdUsd: 0.50,
        minPositionUsd: 1.0,
        txFeeBufferSol: 0.01,
        scoutStopLossPct: 0.18,
        scoutTakeProfitPct: 0.08,
        scoutTpMinHoldMinutes: 5,
        lossExitPct: 0.15,
        promotionDelayMinutes: 15,
        scoutGraceMinutes: 10,
        manualScoutBuyEnabled: true,
        stalePositionHours: 48,
        staleExitHours: 72,
        trailingStopBasePct: 30,
        trailingStopTightPct: 12,
        trailingStopProfitThreshold: 50,
        capitalMgmtEnabled: true,
        capMaxTotalExposurePct: 55,
        capMaxCoreExposurePct: 40,
        capMaxScoutExposurePct: 20,
        capMaxMintExposurePct: 8,
        capRiskPerTradeScoutPct: 0.35,
        capRiskPerTradeCorePct: 0.60,
        capEntryMaxImpactPctScout: 0.8,
        capExitMaxImpactPctScout: 1.0,
        capEntryMaxImpactPctCore: 0.5,
        capExitMaxImpactPctCore: 0.7,
        capRoundtripMinRatioScout: 94,
        capRoundtripMinRatioCore: 96,
        capLiquiditySafetyHaircut: 80,
        capMinPoolTvlUsdScout: 25000,
        capMinPoolTvlUsdCore: 150000,
        capScoutSizeMinUsd: 15,
        capScoutSizeMaxUsd: 60,
        capScoutSizeBaseUsd: 20,
        capScoutSizeBaseEquity: 400
      };
      
      const sliderFields = ['maxDailyDrawdownPct', 'maxPositionPctPerAsset', 'maxTurnoverPctPerDay', 'takeProfitPct', 'maxTop3ConcentrationPct', 'maxPortfolioVolatility', 'preFullAllocMaxPct', 'capMaxTotalExposurePct', 'capMaxCoreExposurePct', 'capMaxScoutExposurePct', 'capMaxMintExposurePct'];
      
      function deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (typeof a !== 'object' || a === null || b === null) return false;
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
          if (!deepEqual(a[key], b[key])) return false;
        }
        return true;
      }
      
      function isDirty() {
        return !deepEqual(savedSettings, draftSettings);
      }
      
      function updateDirtyState() {
        const dirty = isDirty();
        const saveBar = document.getElementById('settings-unsaved');
        const saveBtn = document.getElementById('settings-save-btn');
        if (saveBar) saveBar.style.display = dirty ? 'flex' : 'none';
        if (saveBtn) saveBtn.disabled = !dirty || settingsSaving;
      }
      
      function setDraft(key, value) {
        draftSettings[key] = value;
        updateDirtyState();
      }
      
      function parseNumber(value, fallback, isInt = false) {
        if (value === '' || value === null || value === undefined) return fallback;
        const num = isInt ? parseInt(value, 10) : parseFloat(value);
        if (isNaN(num)) return fallback;
        return num;
      }
      
      function bindControl(key, isSlider = false, isInt = false, min = null, max = null) {
        const input = document.getElementById('cfg-' + key);
        const slider = isSlider ? document.getElementById('cfg-' + key + '-slider') : null;
        
        if (!input) return;
        
        function handleInputChange(e) {
          let val = parseNumber(e.target.value, settingsDefaults[key], isInt);
          if (min !== null && val < min) val = min;
          if (max !== null && val > max) val = max;
          setDraft(key, val);
          if (slider && slider !== e.target) slider.value = val;
          if (input !== e.target) input.value = val;
        }
        
        input.addEventListener('input', handleInputChange);
        input.addEventListener('change', handleInputChange);
        
        if (slider) {
          slider.addEventListener('input', (e) => {
            const val = parseNumber(e.target.value, settingsDefaults[key], isInt);
            setDraft(key, val);
            input.value = val;
          });
          slider.addEventListener('change', (e) => {
            const val = parseNumber(e.target.value, settingsDefaults[key], isInt);
            setDraft(key, val);
            input.value = val;
          });
        }
      }
      
      function bindSelectControl(key) {
        const select = document.getElementById('cfg-' + key);
        if (!select) return;
        select.addEventListener('change', (e) => {
          setDraft(key, e.target.value);
        });
      }
      
      function bindCheckbox(key) {
        const checkbox = document.getElementById('cfg-' + key);
        if (!checkbox) {
          console.warn('[Settings] Checkbox not found: cfg-' + key);
          return;
        }
        // Set initial checked state from draftSettings
        const val = draftSettings[key];
        checkbox.checked = (val === true || val === 'true');
        
        checkbox.addEventListener('change', (e) => {
          const checked = e.target.checked;
          console.log('[Settings] bindCheckbox change:', key, '=', checked);
          draftSettings[key] = checked;
          updateDirtyState();
        });
      }
      
      function populateUI() {
        for (const key of Object.keys(draftSettings)) {
          const input = document.getElementById('cfg-' + key);
          const slider = document.getElementById('cfg-' + key + '-slider');
          if (input) {
            if (input.type === 'checkbox') {
              // CRITICAL: Use strict equality to handle both boolean and string values
              const val = draftSettings[key];
              input.checked = (val === true || val === 'true');
            } else {
              input.value = draftSettings[key];
            }
          }
          if (slider) slider.value = draftSettings[key];
        }
      }
      
      async function loadConfig() {
        if (settingsLoading) return;
        settingsLoading = true;
        
        try {
          // Use the new unified /api/settings endpoint that returns flat structure
          const c = await fetch('/api/settings', { cache: 'no-store' }).then(r => r.json());
          console.log('[Settings] Loaded from /api/settings:', Object.keys(c).length, 'keys');
          
          // Helper to convert decimal to percentage for display
          const decimalToPct = (v, d) => {
            const n = parseFloat(v);
            return isNaN(n) ? d : n * 100;
          };
          
          savedSettings = {
            riskProfile: c.riskProfile || settingsDefaults.riskProfile,
            executionMode: c.executionMode || settingsDefaults.executionMode,
            loopSeconds: c.loopSeconds || settingsDefaults.loopSeconds,
            maxDailyDrawdownPct: decimalToPct(c.maxDailyDrawdownPct, settingsDefaults.maxDailyDrawdownPct),
            maxPositionPctPerAsset: decimalToPct(c.maxPositionPctPerAsset, settingsDefaults.maxPositionPctPerAsset),
            maxTurnoverPctPerDay: decimalToPct(c.maxTurnoverPctPerDay, settingsDefaults.maxTurnoverPctPerDay),
            takeProfitPct: decimalToPct(c.takeProfitPct, settingsDefaults.takeProfitPct),
            maxSlippageBps: c.maxSlippageBps || settingsDefaults.maxSlippageBps,
            maxSingleSwapSol: c.maxSingleSwapSol || settingsDefaults.maxSingleSwapSol,
            minTradeUsd: c.minTradeUsd || settingsDefaults.minTradeUsd,
            maxPositions: c.maxPositions || settingsDefaults.maxPositions,
            coreSlots: c.coreSlots || settingsDefaults.coreSlots,
            scoutSlots: c.scoutSlots || settingsDefaults.scoutSlots,
            corePositionPctTarget: decimalToPct(c.corePositionPctTarget, settingsDefaults.corePositionPctTarget),
            maxTop3ConcentrationPct: decimalToPct(c.maxTop3ConcentrationPct, settingsDefaults.maxTop3ConcentrationPct),
            maxPortfolioVolatility: decimalToPct(c.maxPortfolioVolatility, settingsDefaults.maxPortfolioVolatility),
            scannerMinLiquidity: c.scannerMinLiquidity || settingsDefaults.scannerMinLiquidity,
            scannerMinVolume24h: c.scannerMinVolume24h || settingsDefaults.scannerMinVolume24h,
            scannerMinHolders: c.scannerMinHolders || settingsDefaults.scannerMinHolders,
            scannerMaxPriceChange24h: c.scannerMaxPriceChange24h ?? settingsDefaults.scannerMaxPriceChange24h,
            scannerMinPriceChange24h: c.scannerMinPriceChange24h ?? settingsDefaults.scannerMinPriceChange24h,
            rankingSignalWeight: c.rankingSignalWeight ?? settingsDefaults.rankingSignalWeight,
            rankingMomentumWeight: c.rankingMomentumWeight ?? settingsDefaults.rankingMomentumWeight,
            rankingTimeDecayWeight: c.rankingTimeDecayWeight ?? settingsDefaults.rankingTimeDecayWeight,
            rankingTrailingWeight: c.rankingTrailingWeight ?? settingsDefaults.rankingTrailingWeight,
            rankingFreshnessWeight: c.rankingFreshnessWeight ?? settingsDefaults.rankingFreshnessWeight,
            rankingQualityWeight: c.rankingQualityWeight ?? settingsDefaults.rankingQualityWeight,
            rankingStalePenalty: c.rankingStalePenalty ?? settingsDefaults.rankingStalePenalty,
            rankingTrailingStopPenalty: c.rankingTrailingStopPenalty ?? settingsDefaults.rankingTrailingStopPenalty,
            promotionMinPnlPct: decimalToPct(c.promotionMinPnlPct, settingsDefaults.promotionMinPnlPct),
            promotionMinSignalScore: c.promotionMinSignalScore ?? settingsDefaults.promotionMinSignalScore,
            reentryEnabled: (function() { const v = c.reentryEnabled ?? settingsDefaults.reentryEnabled; return v === true || v === 'true'; })(),
            reentryCooldownMinutes: c.reentryCooldownMinutes ?? settingsDefaults.reentryCooldownMinutes,
            reentryWindowMinutes: c.reentryWindowMinutes ?? settingsDefaults.reentryWindowMinutes,
            reentryMinMomentumScore: c.reentryMinMomentumScore ?? settingsDefaults.reentryMinMomentumScore,
            reentrySizeMultiplier: c.reentrySizeMultiplier ?? settingsDefaults.reentrySizeMultiplier,
            reentryMaxSolPct: c.reentryMaxSolPct ?? settingsDefaults.reentryMaxSolPct,
            strategyTrendThreshold: c.strategyTrendThreshold ?? settingsDefaults.strategyTrendThreshold,
            strategyMomentumFactor: c.strategyMomentumFactor ?? settingsDefaults.strategyMomentumFactor,
            strategyBand: c.strategyBand ?? settingsDefaults.strategyBand,
            minTicksForSignals: c.minTicksForSignals ?? settingsDefaults.minTicksForSignals,
            minTicksForFullAlloc: c.minTicksForFullAlloc ?? settingsDefaults.minTicksForFullAlloc,
            preFullAllocMaxPct: decimalToPct(c.preFullAllocMaxPct, settingsDefaults.preFullAllocMaxPct),
            concentrationRebalanceMaxPct: decimalToPct(c.concentrationRebalanceMaxPct, settingsDefaults.concentrationRebalanceMaxPct),
            transferThresholdUsd: c.transferThresholdUsd ?? settingsDefaults.transferThresholdUsd,
            autonomousScoutsEnabled: (function() { const v = c.autonomousScoutsEnabled ?? settingsDefaults.autonomousScoutsEnabled; return v === true || v === 'true'; })(),
            autonomousDryRun: (function() { const v = c.autonomousDryRun ?? settingsDefaults.autonomousDryRun; return v === true || v === 'true'; })(),
            scoutAutoQueueScore: c.scoutAutoQueueScore ?? settingsDefaults.scoutAutoQueueScore,
            scoutBuySol: c.scoutBuySol ?? settingsDefaults.scoutBuySol,
            minSolReserve: c.minSolReserve ?? settingsDefaults.minSolReserve,
            scoutTokenCooldownHours: c.scoutTokenCooldownHours ?? settingsDefaults.scoutTokenCooldownHours,
            scoutDailyLimit: c.scoutDailyLimit ?? settingsDefaults.scoutDailyLimit,
            scoutQueuePollSeconds: c.scoutQueuePollSeconds ?? settingsDefaults.scoutQueuePollSeconds,
            scanIntervalMinutes: c.scanIntervalMinutes ?? settingsDefaults.scanIntervalMinutes,
            whaleConfirmEnabled: (function() { const v = c.whaleConfirmEnabled ?? settingsDefaults.whaleConfirmEnabled; return v === true || v === 'true'; })(),
            whaleConfirmDryRun: (function() { const v = c.whaleConfirmDryRun ?? settingsDefaults.whaleConfirmDryRun; return v === true || v === 'true'; })(),
            whaleConfirmPollSeconds: c.whaleConfirmPollSeconds ?? settingsDefaults.whaleConfirmPollSeconds,
            whaleWindowMinutes: c.whaleWindowMinutes ?? settingsDefaults.whaleWindowMinutes,
            whaleMinUsd: c.whaleMinUsd ?? settingsDefaults.whaleMinUsd,
            whaleNetflowTriggerUsd: c.whaleNetflowTriggerUsd ?? settingsDefaults.whaleNetflowTriggerUsd,
            marketConfirmPct: c.marketConfirmPct ?? settingsDefaults.marketConfirmPct,
            maxPriceImpactBps: c.maxPriceImpactBps ?? settingsDefaults.maxPriceImpactBps,
            exitNetflowUsd: c.exitNetflowUsd ?? settingsDefaults.exitNetflowUsd,
            exitTrailDrawdownPct: c.exitTrailDrawdownPct ?? settingsDefaults.exitTrailDrawdownPct,
            scoutUnderperformMinutes: c.scoutUnderperformMinutes ?? settingsDefaults.scoutUnderperformMinutes,
            whaleCooldownMinutes: c.whaleCooldownMinutes ?? settingsDefaults.whaleCooldownMinutes,
            stalePnlBandPct: c.stalePnlBandPct ?? settingsDefaults.stalePnlBandPct,
            dustThresholdUsd: c.dustThresholdUsd ?? settingsDefaults.dustThresholdUsd,
            minPositionUsd: c.minPositionUsd ?? settingsDefaults.minPositionUsd,
            txFeeBufferSol: c.txFeeBufferSol ?? settingsDefaults.txFeeBufferSol,
            scoutStopLossPct: c.scoutStopLossPct ?? settingsDefaults.scoutStopLossPct,
            scoutTakeProfitPct: c.scoutTakeProfitPct ?? settingsDefaults.scoutTakeProfitPct,
            scoutTpMinHoldMinutes: c.scoutTpMinHoldMinutes ?? settingsDefaults.scoutTpMinHoldMinutes,
            lossExitPct: c.lossExitPct ?? settingsDefaults.lossExitPct,
            promotionDelayMinutes: c.promotionDelayMinutes ?? settingsDefaults.promotionDelayMinutes,
            scoutGraceMinutes: c.scoutGraceMinutes ?? settingsDefaults.scoutGraceMinutes,
            manualScoutBuyEnabled: (function() { const v = c.manualScoutBuyEnabled ?? settingsDefaults.manualScoutBuyEnabled; return v === true || v === 'true'; })(),
            stalePositionHours: c.stalePositionHours ?? settingsDefaults.stalePositionHours,
            staleExitHours: c.staleExitHours ?? settingsDefaults.staleExitHours,
            trailingStopBasePct: decimalToPct(c.trailingStopBasePct, settingsDefaults.trailingStopBasePct),
            trailingStopTightPct: decimalToPct(c.trailingStopTightPct, settingsDefaults.trailingStopTightPct),
            trailingStopProfitThreshold: decimalToPct(c.trailingStopProfitThreshold, settingsDefaults.trailingStopProfitThreshold),
            exitInvariantEnabled: (function() { const v = c.exitInvariantEnabled ?? settingsDefaults.exitInvariantEnabled; return v === true || v === 'true'; })(),
            exitInvariantMaxRetries: c.exitInvariantMaxRetries ?? settingsDefaults.exitInvariantMaxRetries,
            exitInvariantRetryDelayMs: c.exitInvariantRetryDelayMs ?? settingsDefaults.exitInvariantRetryDelayMs,
            exitInvariantMinRemainingQty: c.exitInvariantMinRemainingQty ?? settingsDefaults.exitInvariantMinRemainingQty,
            exitInvariantMinRemainingUsd: c.exitInvariantMinRemainingUsd ?? settingsDefaults.exitInvariantMinRemainingUsd,
            exitInvariantSlippageBps: c.exitInvariantSlippageBps ?? settingsDefaults.exitInvariantSlippageBps,
            exitInvariantForceExactClose: (function() { const v = c.exitInvariantForceExactClose ?? settingsDefaults.exitInvariantForceExactClose; return v === true || v === 'true'; })(),
            capitalMgmtEnabled: (function() { const v = c.capitalMgmtEnabled ?? settingsDefaults.capitalMgmtEnabled; return v === true || v === 'true'; })(),
            capMaxTotalExposurePct: decimalToPct(c.capMaxTotalExposurePct, settingsDefaults.capMaxTotalExposurePct),
            capMaxCoreExposurePct: decimalToPct(c.capMaxCoreExposurePct, settingsDefaults.capMaxCoreExposurePct),
            capMaxScoutExposurePct: decimalToPct(c.capMaxScoutExposurePct, settingsDefaults.capMaxScoutExposurePct),
            capMaxMintExposurePct: decimalToPct(c.capMaxMintExposurePct, settingsDefaults.capMaxMintExposurePct),
            capRiskPerTradeScoutPct: decimalToPct(c.capRiskPerTradeScoutPct, settingsDefaults.capRiskPerTradeScoutPct),
            capRiskPerTradeCorePct: decimalToPct(c.capRiskPerTradeCorePct, settingsDefaults.capRiskPerTradeCorePct),
            capEntryMaxImpactPctScout: decimalToPct(c.capEntryMaxImpactPctScout, settingsDefaults.capEntryMaxImpactPctScout),
            capExitMaxImpactPctScout: decimalToPct(c.capExitMaxImpactPctScout, settingsDefaults.capExitMaxImpactPctScout),
            capEntryMaxImpactPctCore: decimalToPct(c.capEntryMaxImpactPctCore, settingsDefaults.capEntryMaxImpactPctCore),
            capExitMaxImpactPctCore: decimalToPct(c.capExitMaxImpactPctCore, settingsDefaults.capExitMaxImpactPctCore),
            capRoundtripMinRatioScout: decimalToPct(c.capRoundtripMinRatioScout, settingsDefaults.capRoundtripMinRatioScout),
            capRoundtripMinRatioCore: decimalToPct(c.capRoundtripMinRatioCore, settingsDefaults.capRoundtripMinRatioCore),
            capLiquiditySafetyHaircut: decimalToPct(c.capLiquiditySafetyHaircut, settingsDefaults.capLiquiditySafetyHaircut),
            capMinPoolTvlUsdScout: c.capMinPoolTvlUsdScout ?? settingsDefaults.capMinPoolTvlUsdScout,
            capMinPoolTvlUsdCore: c.capMinPoolTvlUsdCore ?? settingsDefaults.capMinPoolTvlUsdCore,
            capScoutSizeMinUsd: c.capScoutSizeMinUsd ?? settingsDefaults.capScoutSizeMinUsd,
            capScoutSizeMaxUsd: c.capScoutSizeMaxUsd ?? settingsDefaults.capScoutSizeMaxUsd,
            capScoutSizeBaseUsd: c.capScoutSizeBaseUsd ?? settingsDefaults.capScoutSizeBaseUsd,
            capScoutSizeBaseEquity: c.capScoutSizeBaseEquity ?? settingsDefaults.capScoutSizeBaseEquity
          };
          
          console.log('[Settings] Loaded autonomousScoutsEnabled:', c.autonomousScoutsEnabled, '-> savedSettings:', savedSettings.autonomousScoutsEnabled);
          
          draftSettings = JSON.parse(JSON.stringify(savedSettings));
          populateUI();
          updateDirtyState();
        } catch (e) {
          console.error('Failed to load config:', e);
          showToast('Failed to load configuration', 'error');
        } finally {
          settingsLoading = false;
        }
      }
      
      function initSettingsBindings() {
        bindSelectControl('riskProfile');
        bindSelectControl('executionMode');
        bindControl('loopSeconds', false, true, 5, 300);
        
        bindControl('maxDailyDrawdownPct', true, false, 1, 50);
        bindControl('maxPositionPctPerAsset', true, false, 1, 50);
        bindControl('maxTurnoverPctPerDay', true, false, 10, 500);
        bindControl('takeProfitPct', true, false, 1, 100);
        
        bindControl('maxSlippageBps', false, true, 1, 2000);
        bindControl('maxSingleSwapSol', false, false, 0.01, 1000);
        bindControl('minTradeUsd', false, false, 1, 1000000);
        
        bindControl('maxPositions', false, true, 1, 100);
        bindControl('coreSlots', false, true, 0, 50);
        bindControl('scoutSlots', false, true, 0, 100);
        bindControl('corePositionPctTarget', true, false, 5, 40);
        bindControl('maxTop3ConcentrationPct', true, false, 30, 100);
        bindControl('maxPortfolioVolatility', true, false, 10, 10000);
        
        bindControl('scannerMinLiquidity', false, false, 0, 10000000);
        bindControl('scannerMinVolume24h', false, false, 0, 10000000);
        bindControl('scannerMinHolders', false, true, 0, 100000);
        bindControl('scannerMaxPriceChange24h', false, false, -100, 10000);
        bindControl('scannerMinPriceChange24h', false, false, -100, 10000);
        
        bindControl('rankingSignalWeight', false, false, 0, 10);
        bindControl('rankingMomentumWeight', false, false, 0, 10);
        bindControl('rankingTimeDecayWeight', false, false, 0, 10);
        bindControl('rankingTrailingWeight', false, false, 0, 10);
        bindControl('rankingFreshnessWeight', false, false, 0, 10);
        bindControl('rankingQualityWeight', false, false, 0, 10);
        bindControl('rankingStalePenalty', false, false, -100, 0);
        bindControl('rankingTrailingStopPenalty', false, false, -100, 0);
        
        bindControl('promotionMinPnlPct', false, false, 0, 500);
        bindControl('promotionMinSignalScore', false, false, 0, 10);
        bindControl('promotionDelayMinutes', false, true, 0, 1440);
        
        bindControl('reentryCooldownMinutes', false, true, 0, 60);
        bindControl('reentryWindowMinutes', false, true, 1, 120);
        bindControl('reentryMinMomentumScore', false, false, 0, 10);
        bindControl('reentrySizeMultiplier', false, false, 0.5, 10);
        bindControl('reentryMaxSolPct', false, false, 0.1, 1);
        
        bindControl('strategyTrendThreshold', false, false, 0, 1);
        bindControl('strategyMomentumFactor', false, false, 0, 1);
        bindControl('strategyBand', false, false, 0, 0.5);
        bindControl('minTicksForSignals', false, true, 5, 500);
        bindControl('minTicksForFullAlloc', false, true, 0, 500);
        bindControl('preFullAllocMaxPct', true, false, 1, 25);
        
        bindControl('concentrationRebalanceMaxPct', false, false, 1, 100);
        bindControl('transferThresholdUsd', false, false, 1, 100);
        
        bindControl('scoutAutoQueueScore', false, true, 1, 50);
        bindControl('scoutBuySol', false, false, 0.01, 1);
        bindControl('minSolReserve', false, false, 0.05, 1);
        bindControl('scoutTokenCooldownHours', false, true, 1, 168);
        bindControl('scoutDailyLimit', false, true, 1, 1000000);
        bindControl('scoutQueuePollSeconds', false, true, 30, 300);
        bindControl('scanIntervalMinutes', false, true, 1, 60);
        
        bindCheckbox('reentryEnabled');
        bindCheckbox('autonomousScoutsEnabled');
        bindCheckbox('autonomousDryRun');
        bindCheckbox('whaleConfirmEnabled');
        bindCheckbox('whaleConfirmDryRun');
        bindCheckbox('manualScoutBuyEnabled');
        
        // Whale flow numeric settings
        bindControl('whaleConfirmPollSeconds', false, true, 10, 300);
        bindControl('whaleWindowMinutes', false, true, 1, 60);
        bindControl('whaleMinUsd', false, false, 100, 1000000);
        bindControl('whaleNetflowTriggerUsd', false, false, 100, 1000000);
        bindControl('marketConfirmPct', false, false, 0, 50);
        bindControl('maxPriceImpactBps', false, true, 10, 1000);
        bindControl('exitNetflowUsd', false, false, -1000000, 0);
        bindControl('exitTrailDrawdownPct', false, false, 1, 50);
        bindControl('scoutUnderperformMinutes', false, true, 10, 1440);
        bindControl('whaleCooldownMinutes', false, true, 1, 1440);
        
        bindControl('promotionDelayMinutes', false, true, 1, 1440);
        bindControl('scoutGraceMinutes', false, true, 1, 120);
        bindControl('scoutStopLossPct', false, false, 0.01, 0.50);
        bindControl('scoutTakeProfitPct', false, false, 0.01, 0.50);
        bindControl('scoutTpMinHoldMinutes', false, true, 0, 60);
        bindControl('lossExitPct', false, false, 0.01, 0.50);
        bindControl('stalePnlBandPct', false, false, 0.01, 0.20);
        bindControl('dustThresholdUsd', false, false, 0.01, 10);
        bindControl('minPositionUsd', false, false, 0.10, 100);
        bindControl('txFeeBufferSol', false, false, 0.001, 0.1);
        bindControl('stalePositionHours', false, true, 1, 720);
        bindControl('staleExitHours', false, true, 1, 720);
        bindControl('trailingStopBasePct', false, false, 5, 80);
        bindControl('trailingStopTightPct', false, false, 3, 50);
        bindControl('trailingStopProfitThreshold', false, false, 10, 200);
        
        bindCheckbox('exitInvariantEnabled');
        bindControl('exitInvariantMaxRetries', false, true, 1, 5);
        bindControl('exitInvariantRetryDelayMs', false, true, 500, 5000);
        bindControl('exitInvariantMinRemainingQty', false, false, 0, 1000000);
        bindControl('exitInvariantMinRemainingUsd', false, false, 0.10, 100);
        bindControl('exitInvariantSlippageBps', false, true, 50, 1000);
        bindCheckbox('exitInvariantForceExactClose');
        
        // Capital Management settings
        bindCheckbox('capitalMgmtEnabled');
        bindControl('capMaxTotalExposurePct', true, false, 0, 100);
        bindControl('capMaxCoreExposurePct', true, false, 0, 100);
        bindControl('capMaxScoutExposurePct', true, false, 0, 100);
        bindControl('capMaxMintExposurePct', true, false, 0, 25);
        bindControl('capRiskPerTradeScoutPct', false, false, 0, 5);
        bindControl('capRiskPerTradeCorePct', false, false, 0, 5);
        bindControl('capEntryMaxImpactPctScout', false, false, 0, 5);
        bindControl('capExitMaxImpactPctScout', false, false, 0, 5);
        bindControl('capEntryMaxImpactPctCore', false, false, 0, 5);
        bindControl('capExitMaxImpactPctCore', false, false, 0, 5);
        bindControl('capRoundtripMinRatioScout', false, false, 80, 100);
        bindControl('capRoundtripMinRatioCore', false, false, 80, 100);
        bindControl('capLiquiditySafetyHaircut', false, false, 50, 100);
        bindControl('capMinPoolTvlUsdScout', false, false, 0, 1000000);
        bindControl('capMinPoolTvlUsdCore', false, false, 0, 1000000);
        bindControl('capScoutSizeMinUsd', false, false, 1, 500);
        bindControl('capScoutSizeMaxUsd', false, false, 1, 1000);
        bindControl('capScoutSizeBaseUsd', false, false, 1, 500);
        bindControl('capScoutSizeBaseEquity', false, false, 100, 10000);
      }
      
      function syncSlider(key) {
        const slider = document.getElementById('cfg-' + key + '-slider');
        const input = document.getElementById('cfg-' + key);
        if (slider && input) {
          input.value = slider.value;
          const val = parseNumber(slider.value, settingsDefaults[key], false);
          setDraft(key, val);
        }
      }
      window.syncSlider = syncSlider;
      
      function syncInput(key) {
        const slider = document.getElementById('cfg-' + key + '-slider');
        const input = document.getElementById('cfg-' + key);
        if (slider && input) {
          slider.value = input.value;
          const val = parseNumber(input.value, settingsDefaults[key], false);
          setDraft(key, val);
        }
      }
      window.syncInput = syncInput;
      
      function updateField(key, value) {
        draftSettings[key] = value;
        updateDirtyState();
      }
      window.updateField = updateField;
      
      function updateFieldNum(key, value, isInt) {
        const num = isInt ? parseInt(value, 10) : parseFloat(value);
        if (!isNaN(num)) {
          draftSettings[key] = num;
        }
        updateDirtyState();
      }
      window.updateFieldNum = updateFieldNum;
      
      function updateFieldBool(key, value) {
        const boolValue = Boolean(value);
        console.log('[Settings] updateFieldBool:', key, '=', boolValue, '(was:', draftSettings[key], ')');
        draftSettings[key] = boolValue;
        updateDirtyState();
      }
      window.updateFieldBool = updateFieldBool;
      
      function markUnsaved() {
        updateDirtyState();
      }
      window.markUnsaved = markUnsaved;
      
      function resetSettings() {
        draftSettings = JSON.parse(JSON.stringify(savedSettings));
        populateUI();
        updateDirtyState();
        showToast('Settings reset to saved values', 'success');
      }
      window.resetSettings = resetSettings;
      
      async function saveAllSettings() {
        if (settingsSaving) return;
        settingsSaving = true;
        
        const saveBtn = document.getElementById('settings-save-btn');
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
        }
        
        // Build the patch from draftSettings - convert display values to API values
        // Percentages in UI are stored as whole numbers (e.g., 5 for 5%), API expects decimals (0.05)
        const d = draftSettings;
        const def = settingsDefaults;
        
        // Helper functions
        const pctToDecimal = (v, d) => {
          const n = parseFloat(v);
          return isNaN(n) ? d : n / 100;
        };
        const toInt = (v, d) => {
          const n = parseInt(v, 10);
          return isNaN(n) ? d : n;
        };
        const toFloat = (v, d) => {
          const n = parseFloat(v);
          return isNaN(n) ? d : n;
        };
        const toBool = (v) => !!v;
        
        // Generate request ID for tracing
        const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        
        // CRITICAL: Explicitly handle booleans - use strict equality, not truthiness
        const autonomousScoutsEnabledValue = d.autonomousScoutsEnabled === true;
        const autonomousDryRunValue = d.autonomousDryRun === true;
        const reentryEnabledValue = d.reentryEnabled === true;
        
        console.log('[Settings][' + requestId + '] Boolean values from draftSettings:');
        console.log('  autonomousScoutsEnabled:', d.autonomousScoutsEnabled, '->', autonomousScoutsEnabledValue);
        console.log('  autonomousDryRun:', d.autonomousDryRun, '->', autonomousDryRunValue);
        console.log('  reentryEnabled:', d.reentryEnabled, '->', reentryEnabledValue);
        
        const patch = {
          riskProfile: d.riskProfile || def.riskProfile,
          executionMode: d.executionMode || def.executionMode,
          loopSeconds: toInt(d.loopSeconds, def.loopSeconds),
          maxDailyDrawdownPct: pctToDecimal(d.maxDailyDrawdownPct, def.maxDailyDrawdownPct),
          maxPositionPctPerAsset: pctToDecimal(d.maxPositionPctPerAsset, def.maxPositionPctPerAsset),
          maxTurnoverPctPerDay: pctToDecimal(d.maxTurnoverPctPerDay, def.maxTurnoverPctPerDay),
          takeProfitPct: pctToDecimal(d.takeProfitPct, def.takeProfitPct),
          maxSlippageBps: toInt(d.maxSlippageBps, def.maxSlippageBps),
          maxSingleSwapSol: toFloat(d.maxSingleSwapSol, def.maxSingleSwapSol),
          minTradeUsd: toFloat(d.minTradeUsd, def.minTradeUsd),
          maxPositions: toInt(d.maxPositions, def.maxPositions),
          coreSlots: toInt(d.coreSlots, def.coreSlots),
          scoutSlots: toInt(d.scoutSlots, def.scoutSlots),
          corePositionPctTarget: pctToDecimal(d.corePositionPctTarget, def.corePositionPctTarget),
          maxTop3ConcentrationPct: pctToDecimal(d.maxTop3ConcentrationPct, def.maxTop3ConcentrationPct),
          maxPortfolioVolatility: pctToDecimal(d.maxPortfolioVolatility, def.maxPortfolioVolatility),
          scannerMinLiquidity: toFloat(d.scannerMinLiquidity, def.scannerMinLiquidity),
          scannerMinVolume24h: toFloat(d.scannerMinVolume24h, def.scannerMinVolume24h),
          scannerMinHolders: toInt(d.scannerMinHolders, def.scannerMinHolders),
          scannerMaxPriceChange24h: toFloat(d.scannerMaxPriceChange24h, def.scannerMaxPriceChange24h),
          scannerMinPriceChange24h: toFloat(d.scannerMinPriceChange24h, def.scannerMinPriceChange24h),
          rankingSignalWeight: toFloat(d.rankingSignalWeight, def.rankingSignalWeight),
          rankingMomentumWeight: toFloat(d.rankingMomentumWeight, def.rankingMomentumWeight),
          rankingTimeDecayWeight: toFloat(d.rankingTimeDecayWeight, def.rankingTimeDecayWeight),
          rankingTrailingWeight: toFloat(d.rankingTrailingWeight, def.rankingTrailingWeight),
          rankingFreshnessWeight: toFloat(d.rankingFreshnessWeight, def.rankingFreshnessWeight),
          rankingQualityWeight: toFloat(d.rankingQualityWeight, def.rankingQualityWeight),
          rankingStalePenalty: toFloat(d.rankingStalePenalty, def.rankingStalePenalty),
          rankingTrailingStopPenalty: toFloat(d.rankingTrailingStopPenalty, def.rankingTrailingStopPenalty),
          promotionMinPnlPct: pctToDecimal(d.promotionMinPnlPct, def.promotionMinPnlPct),
          promotionMinSignalScore: toFloat(d.promotionMinSignalScore, def.promotionMinSignalScore),
          reentryEnabled: reentryEnabledValue,
          reentryCooldownMinutes: toInt(d.reentryCooldownMinutes, def.reentryCooldownMinutes),
          reentryWindowMinutes: toInt(d.reentryWindowMinutes, def.reentryWindowMinutes),
          reentryMinMomentumScore: toFloat(d.reentryMinMomentumScore, def.reentryMinMomentumScore),
          reentrySizeMultiplier: toFloat(d.reentrySizeMultiplier, def.reentrySizeMultiplier),
          reentryMaxSolPct: toFloat(d.reentryMaxSolPct, def.reentryMaxSolPct),
          strategyTrendThreshold: toFloat(d.strategyTrendThreshold, def.strategyTrendThreshold),
          strategyMomentumFactor: toFloat(d.strategyMomentumFactor, def.strategyMomentumFactor),
          strategyBand: toFloat(d.strategyBand, def.strategyBand),
          minTicksForSignals: toInt(d.minTicksForSignals, def.minTicksForSignals),
          minTicksForFullAlloc: toInt(d.minTicksForFullAlloc, def.minTicksForFullAlloc),
          preFullAllocMaxPct: pctToDecimal(d.preFullAllocMaxPct, def.preFullAllocMaxPct),
          concentrationRebalanceMaxPct: pctToDecimal(d.concentrationRebalanceMaxPct, def.concentrationRebalanceMaxPct),
          transferThresholdUsd: toFloat(d.transferThresholdUsd, def.transferThresholdUsd),
          autonomousScoutsEnabled: autonomousScoutsEnabledValue,
          autonomousDryRun: autonomousDryRunValue,
          scoutAutoQueueScore: toInt(d.scoutAutoQueueScore, def.scoutAutoQueueScore),
          scoutBuySol: toFloat(d.scoutBuySol, def.scoutBuySol),
          minSolReserve: toFloat(d.minSolReserve, def.minSolReserve),
          scoutTokenCooldownHours: toInt(d.scoutTokenCooldownHours, def.scoutTokenCooldownHours),
          scoutDailyLimit: toInt(d.scoutDailyLimit, def.scoutDailyLimit),
          scoutQueuePollSeconds: toInt(d.scoutQueuePollSeconds, def.scoutQueuePollSeconds),
          scanIntervalMinutes: toInt(d.scanIntervalMinutes, def.scanIntervalMinutes),
          // Whale confirmation settings
          whaleConfirmEnabled: d.whaleConfirmEnabled === true,
          whaleConfirmDryRun: d.whaleConfirmDryRun === true,
          whaleConfirmPollSeconds: toInt(d.whaleConfirmPollSeconds, def.whaleConfirmPollSeconds),
          whaleWindowMinutes: toInt(d.whaleWindowMinutes, def.whaleWindowMinutes),
          whaleMinUsd: toFloat(d.whaleMinUsd, def.whaleMinUsd),
          whaleNetflowTriggerUsd: toFloat(d.whaleNetflowTriggerUsd, def.whaleNetflowTriggerUsd),
          marketConfirmPct: toFloat(d.marketConfirmPct, def.marketConfirmPct),
          maxPriceImpactBps: toInt(d.maxPriceImpactBps, def.maxPriceImpactBps),
          exitNetflowUsd: toFloat(d.exitNetflowUsd, def.exitNetflowUsd),
          exitTrailDrawdownPct: toFloat(d.exitTrailDrawdownPct, def.exitTrailDrawdownPct),
          scoutUnderperformMinutes: toInt(d.scoutUnderperformMinutes, def.scoutUnderperformMinutes),
          whaleCooldownMinutes: toInt(d.whaleCooldownMinutes, def.whaleCooldownMinutes),
          // Advanced flow controls
          stalePnlBandPct: toFloat(d.stalePnlBandPct, def.stalePnlBandPct),
          dustThresholdUsd: toFloat(d.dustThresholdUsd, def.dustThresholdUsd),
          minPositionUsd: toFloat(d.minPositionUsd, def.minPositionUsd),
          txFeeBufferSol: toFloat(d.txFeeBufferSol, def.txFeeBufferSol),
          scoutStopLossPct: toFloat(d.scoutStopLossPct, def.scoutStopLossPct),
          scoutTakeProfitPct: toFloat(d.scoutTakeProfitPct, def.scoutTakeProfitPct),
          scoutTpMinHoldMinutes: toInt(d.scoutTpMinHoldMinutes, def.scoutTpMinHoldMinutes),
          lossExitPct: toFloat(d.lossExitPct, def.lossExitPct),
          promotionDelayMinutes: toInt(d.promotionDelayMinutes, def.promotionDelayMinutes),
          scoutGraceMinutes: toInt(d.scoutGraceMinutes, def.scoutGraceMinutes),
          manualScoutBuyEnabled: d.manualScoutBuyEnabled === true,
          stalePositionHours: toInt(d.stalePositionHours, def.stalePositionHours),
          staleExitHours: toInt(d.staleExitHours, def.staleExitHours),
          trailingStopBasePct: pctToDecimal(d.trailingStopBasePct, def.trailingStopBasePct),
          trailingStopTightPct: pctToDecimal(d.trailingStopTightPct, def.trailingStopTightPct),
          trailingStopProfitThreshold: pctToDecimal(d.trailingStopProfitThreshold, def.trailingStopProfitThreshold),
          exitInvariantEnabled: d.exitInvariantEnabled === true,
          exitInvariantMaxRetries: toInt(d.exitInvariantMaxRetries, def.exitInvariantMaxRetries),
          exitInvariantRetryDelayMs: toInt(d.exitInvariantRetryDelayMs, def.exitInvariantRetryDelayMs),
          exitInvariantMinRemainingQty: toFloat(d.exitInvariantMinRemainingQty, def.exitInvariantMinRemainingQty),
          exitInvariantMinRemainingUsd: toFloat(d.exitInvariantMinRemainingUsd, def.exitInvariantMinRemainingUsd),
          exitInvariantSlippageBps: toInt(d.exitInvariantSlippageBps, def.exitInvariantSlippageBps),
          exitInvariantForceExactClose: d.exitInvariantForceExactClose === true,
          // Capital Management settings
          capitalMgmtEnabled: d.capitalMgmtEnabled === true,
          capMaxTotalExposurePct: pctToDecimal(d.capMaxTotalExposurePct, def.capMaxTotalExposurePct),
          capMaxCoreExposurePct: pctToDecimal(d.capMaxCoreExposurePct, def.capMaxCoreExposurePct),
          capMaxScoutExposurePct: pctToDecimal(d.capMaxScoutExposurePct, def.capMaxScoutExposurePct),
          capMaxMintExposurePct: pctToDecimal(d.capMaxMintExposurePct, def.capMaxMintExposurePct),
          capRiskPerTradeScoutPct: pctToDecimal(d.capRiskPerTradeScoutPct, def.capRiskPerTradeScoutPct),
          capRiskPerTradeCorePct: pctToDecimal(d.capRiskPerTradeCorePct, def.capRiskPerTradeCorePct),
          capEntryMaxImpactPctScout: pctToDecimal(d.capEntryMaxImpactPctScout, def.capEntryMaxImpactPctScout),
          capExitMaxImpactPctScout: pctToDecimal(d.capExitMaxImpactPctScout, def.capExitMaxImpactPctScout),
          capEntryMaxImpactPctCore: pctToDecimal(d.capEntryMaxImpactPctCore, def.capEntryMaxImpactPctCore),
          capExitMaxImpactPctCore: pctToDecimal(d.capExitMaxImpactPctCore, def.capExitMaxImpactPctCore),
          capRoundtripMinRatioScout: pctToDecimal(d.capRoundtripMinRatioScout, def.capRoundtripMinRatioScout),
          capRoundtripMinRatioCore: pctToDecimal(d.capRoundtripMinRatioCore, def.capRoundtripMinRatioCore),
          capLiquiditySafetyHaircut: pctToDecimal(d.capLiquiditySafetyHaircut, def.capLiquiditySafetyHaircut),
          capMinPoolTvlUsdScout: toFloat(d.capMinPoolTvlUsdScout, def.capMinPoolTvlUsdScout),
          capMinPoolTvlUsdCore: toFloat(d.capMinPoolTvlUsdCore, def.capMinPoolTvlUsdCore),
          capScoutSizeMinUsd: toFloat(d.capScoutSizeMinUsd, def.capScoutSizeMinUsd),
          capScoutSizeMaxUsd: toFloat(d.capScoutSizeMaxUsd, def.capScoutSizeMaxUsd),
          capScoutSizeBaseUsd: toFloat(d.capScoutSizeBaseUsd, def.capScoutSizeBaseUsd),
          capScoutSizeBaseEquity: toFloat(d.capScoutSizeBaseEquity, def.capScoutSizeBaseEquity)
        };
        
        console.log('[Settings][' + requestId + '] Patch object booleans:', {
          autonomousScoutsEnabled: patch.autonomousScoutsEnabled,
          autonomousDryRun: patch.autonomousDryRun,
          reentryEnabled: patch.reentryEnabled,
          whaleConfirmEnabled: patch.whaleConfirmEnabled,
          whaleConfirmDryRun: patch.whaleConfirmDryRun,
          manualScoutBuyEnabled: patch.manualScoutBuyEnabled,
          exitInvariantEnabled: patch.exitInvariantEnabled,
          exitInvariantForceExactClose: patch.exitInvariantForceExactClose
        });
        console.log('[Settings][' + requestId + '] Total keys in patch:', Object.keys(patch).length);
        
        try {
          const response = await fetch('/api/settings', {
            method: 'PATCH',
            headers: { 
              'Content-Type': 'application/json',
              'X-Settings-Request-Id': requestId
            },
            body: JSON.stringify(patch)
          });
          console.log('[Settings][' + requestId + '] Response status:', response.status);
          
          const result = await response.json();
          
          if (result.success) {
            savedSettings = JSON.parse(JSON.stringify(draftSettings));
            updateDirtyState();
            showToast('Settings saved successfully!', 'success');
            
            const riskBadge = document.querySelector('.badge-risk');
            if (riskBadge) riskBadge.textContent = draftSettings.riskProfile.toUpperCase();
            
            const modeBadge = document.querySelector('.badge-paper, .badge-live');
            if (modeBadge) {
              modeBadge.className = 'badge badge-' + draftSettings.executionMode;
              modeBadge.textContent = draftSettings.executionMode.toUpperCase();
            }
            
            console.log('[Settings] Saved successfully, server returned:', result.settings ? Object.keys(result.settings).length + ' keys' : 'no settings');
          } else {
            showToast(result.error || 'Failed to save settings', 'error');
            console.error('[Settings] Save failed:', result.error);
          }
        } catch (e) {
          console.error('[Settings] Save error:', e);
          showToast('Failed to save settings: ' + e.message, 'error');
        } finally {
          settingsSaving = false;
          if (saveBtn) {
            saveBtn.textContent = 'Save Changes';
            saveBtn.disabled = !isDirty();
          }
        }
      }
      window.saveAllSettings = saveAllSettings;
      
      function showToast(message, type) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.remove(), 3000);
      }
      
      async function flashClose(mint, amount, decimals, symbol) {
        if (!confirm('⚠️ FLASH CLOSE WARNING ⚠️\\n\\nYou are about to market sell your ENTIRE ' + symbol + ' position:\\n• Amount: ' + Number(amount).toLocaleString() + ' tokens\\n• Action: Immediate market sell\\n\\nThis action cannot be undone. Continue?')) {
          return;
        }
        
        try {
          showToast('Executing flash close...', 'info');
          
          const response = await fetch('/api/flash-close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ mint, amount, decimals, confirmToken: 'CONFIRM_FLASH_CLOSE' }),
          });
          
          const result = await response.json();
          
          if (result.success) {
            showToast(symbol + ' position closed! TX: ' + (result.txSig?.slice(0, 8) || 'paper') + '...', 'success');
            setTimeout(() => {
              loadAll();
            }, 2000);
          } else {
            showToast('Flash close failed: ' + result.error, 'error');
          }
        } catch (e) {
          showToast('Flash close error: ' + e.message, 'error');
        }
      }
      window.flashClose = flashClose;
      
      async function buySOLWithUSDC(amount, decimals) {
        const usdcAmount = Number(amount) / Math.pow(10, decimals || 6);
        if (!confirm('💰 BUY SOL WITH USDC 💰\\n\\nYou are about to convert your USDC to SOL:\\n• Amount: $' + usdcAmount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' USDC\\n• Action: Immediate market buy SOL\\n\\nThis will use 95% of your USDC balance, keeping 5% as reserve.\\n\\nContinue?')) {
          return;
        }
        
        try {
          showToast('Converting USDC to SOL...', 'info');
          
          const response = await fetch('/api/usdc-to-sol', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ amount, decimals, confirmToken: 'CONFIRM_USDC_TO_SOL' }),
          });
          
          const result = await response.json();
          
          if (result.success) {
            showToast('Bought ' + result.solReceived?.toFixed(4) + ' SOL! TX: ' + (result.txSig?.slice(0, 8) || 'paper') + '...', 'success');
            setTimeout(() => {
              loadAll();
            }, 2000);
          } else {
            showToast('USDC to SOL failed: ' + result.error, 'error');
          }
        } catch (e) {
          showToast('USDC to SOL error: ' + e.message, 'error');
        }
      }
      window.buySOLWithUSDC = buySOLWithUSDC;
      
      async function loadPortfolioRisk() {
        try {
          const r = await fetch('/api/portfolio-risk').then(r => r.json());
          document.getElementById('portfolio-risk-info').innerHTML = \`
            <div style="display:grid;gap:8px">
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Active Positions</span><span>\${r.activePositions}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Largest Position</span><span>\${(r.largestPositionPct*100).toFixed(1)}%</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Top-3 Concentration</span><span>\${(r.top3ConcentrationPct*100).toFixed(1)}%</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">HHI Index</span><span>\${r.hhi?.toFixed(4) || 0}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Est. Volatility</span><span>\${(r.estimatedVolatility*100).toFixed(1)}%</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#64748b">Total Equity</span><span>$\${r.totalEquityUsd?.toFixed(2) || 0}</span></div>
            </div>
          \`;
        } catch (e) {
          document.getElementById('portfolio-risk-info').innerHTML = '<div class="empty">Failed to load</div>';
        }
      }
      
      async function loadUniverse() {
        try {
          const u = await fetch('/api/universe').then(r => r.json());
          if (!u || u.length === 0) {
            document.getElementById('universe-info').innerHTML = '<div class="empty">No tokens configured</div>';
            return;
          }
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          document.getElementById('universe-info').innerHTML = u.map(t => {
            const isCore = t.mint === SOL || t.mint === USDC;
            return \`
              <div class="trending-row" style="display:flex;justify-content:space-between;align-items:center">
                <div class="trending-info" data-action="viewToken" data-mint="\${t.mint}" style="cursor:pointer;flex:1">
                  <div class="trending-symbol"><a href="https://solscan.io/token/\${t.mint}" target="_blank" class="token-link">\${t.symbol}</a></div>
                  <div class="trending-name" style="font-size:10px">\${t.mint.slice(0,16)}...</div>
                </div>
                \${isCore ? '<span style="color:#64748b;font-size:11px">Core</span>' : \`<button data-action="removeFromUniverse" data-mint="\${t.mint}" data-symbol="\${t.symbol}" style="padding:4px 10px;font-size:11px;background:#ef4444;border:none;border-radius:4px;color:#fff;cursor:pointer">Remove</button>\`}
              </div>
            \`;
          }).join('');
        } catch (e) {
          document.getElementById('universe-info').innerHTML = '<div class="empty">Failed to load</div>';
        }
      }
      
      async function removeFromUniverse(mint, symbol) {
        if (!confirm(\`Remove \${symbol} from trading universe?\`)) return;
        try {
          const res = await fetch(\`/api/universe/\${mint}\`, { method: 'DELETE' });
          if (res.ok) {
            showToast(\`\${symbol} removed from universe\`, 'success');
            loadUniverse();
          } else {
            showToast('Failed to remove token', 'error');
          }
        } catch (e) {
          showToast('Failed to remove token', 'error');
        }
      }
      
      async function loadSettings() {
        await Promise.all([loadHealth(), loadConfig(), loadPortfolioRisk(), loadUniverse(), loadCacheStats(), loadRiskProfiles()]);
      }
      
      let riskProfiles = [];
      
      async function loadRiskProfiles() {
        try {
          riskProfiles = await fetch('/api/risk-profiles').then(r => r.json());
          const cfgSelect = document.getElementById('cfg-riskProfile');
          const currentRisk = cfgSelect?.value || 'medium';
          
          if (cfgSelect) {
            cfgSelect.innerHTML = riskProfiles.map(p => \`<option value="\${p.name}" \${p.name === currentRisk ? 'selected' : ''}>\${p.name.charAt(0).toUpperCase() + p.name.slice(1)}\${p.isDefault ? '' : ' (Custom)'}</option>\`).join('');
          }
        } catch (e) {
          console.error('Failed to load risk profiles:', e);
        }
      }
      
      function applyRiskProfilePreset() {
        const cfgSelect = document.getElementById('cfg-riskProfile');
        const selectedName = cfgSelect?.value;
        if (!selectedName) return;
        
        const profile = riskProfiles.find(p => p.name === selectedName);
        if (!profile) {
          showToast('Profile not found - try refreshing the page', 'error');
          return;
        }
        
        // Create new draft settings object (atomic update)
        const newDraft = JSON.parse(JSON.stringify(draftSettings));
        newDraft.riskProfile = selectedName;
        newDraft.maxDailyDrawdownPct = profile.maxDailyDrawdownPct * 100;
        newDraft.maxPositionPctPerAsset = profile.maxPositionPctPerAsset * 100;
        newDraft.maxTurnoverPctPerDay = profile.maxTurnoverPctPerDay * 100;
        newDraft.takeProfitPct = profile.takeProfitPct * 100;
        newDraft.maxSlippageBps = profile.slippageBps;
        newDraft.maxSingleSwapSol = profile.maxSingleSwapSol;
        newDraft.minTradeUsd = profile.minTradeUsd;
        
        draftSettings = newDraft;
        populateUI();
        updateDirtyState();
        showToast('Loaded ' + selectedName.toUpperCase() + ' profile - save to apply', 'success');
      }
      window.applyRiskProfilePreset = applyRiskProfilePreset;
      
      async function loadPerformanceTab() {
        await loadMetrics(currentMetricsPeriod);
      }
      
      function initExportDates() {
        const today = new Date();
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        document.getElementById('export-end').value = today.toISOString().split('T')[0];
        document.getElementById('export-start').value = weekAgo.toISOString().split('T')[0];
      }
      
      async function exportData(type, format) {
        const start = document.getElementById('export-start').value;
        const end = document.getElementById('export-end').value;
        
        if (!start || !end) {
          showToast('Please select date range', 'error');
          return;
        }
        
        showToast('Preparing export...', 'success');
        
        try {
          const formatParam = format === 'csv' ? '&format=csv' : '';
          let url;
          if (type === 'journeys') {
            url = '/api/export/events/journeys?start=' + start + '&end=' + end;
          } else {
            url = '/api/export/' + type + '?start=' + start + '&end=' + end + formatParam;
          }
          
          if (format === 'csv') {
            window.location.href = url;
          } else {
            const res = await fetch(url);
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Export failed');
            }
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = type + '_' + start + '_' + end + '.json';
            a.click();
          }
          showToast('Export downloaded!', 'success');
        } catch (e) {
          showToast('Export failed: ' + (e.message || 'Unknown error'), 'error');
        }
      }
      
      async function loadExportStats() {
        try {
          const start = document.getElementById('export-start')?.value || new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
          const end = document.getElementById('export-end')?.value || new Date().toISOString().split('T')[0];
          
          const [allRes, eventsRes] = await Promise.all([
            fetch('/api/export/all?start=' + start + '&end=' + end),
            fetch('/api/export/events/stats')
          ]);
          const data = await allRes.json();
          const eventStats = await eventsRes.json();
          
          document.getElementById('export-stats').innerHTML = 
            '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;text-align:center;margin-bottom:16px">' +
            '<div><div style="font-size:24px;font-weight:700;color:#fff">' + data.summary.tradesCount + '</div><div style="font-size:12px">Trades</div></div>' +
            '<div><div style="font-size:24px;font-weight:700;color:#fff">' + data.summary.telemetryCount + '</div><div style="font-size:12px">Tick Records</div></div>' +
            '<div><div style="font-size:24px;font-weight:700;color:#fff">' + data.summary.pricesCount + '</div><div style="font-size:12px">Price Records</div></div>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;text-align:center">' +
            '<div><div style="font-size:24px;font-weight:700;color:#fff">' + data.summary.equitySnapshotsCount + '</div><div style="font-size:12px">Equity Snapshots</div></div>' +
            '<div><div style="font-size:24px;font-weight:700;color:#fff">' + data.summary.configChangesCount + '</div><div style="font-size:12px">Config Changes</div></div>' +
            '<div><div style="font-size:24px;font-weight:700;color:#00ff41">' + (eventStats.totalEvents || 0) + '</div><div style="font-size:12px">Event Logs</div></div>' +
            '</div>';
        } catch (e) {
          document.getElementById('export-stats').innerHTML = '<span style="color:#ef4444">Failed to load stats</span>';
        }
      }
      
      // Matrix Rain Animation
      function initMatrixRain() {
        const canvas = document.getElementById('matrix-bg');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()_+-=[]{}|;:,./<>?~';
        const fontSize = 14;
        const columns = Math.floor(canvas.width / fontSize);
        const drops = [];
        
        for (let i = 0; i < columns; i++) {
          drops[i] = Math.random() * -100;
        }
        
        function draw() {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          
          ctx.fillStyle = '#00ff41';
          ctx.font = fontSize + 'px Share Tech Mono, monospace';
          
          for (let i = 0; i < drops.length; i++) {
            const char = chars[Math.floor(Math.random() * chars.length)];
            const x = i * fontSize;
            const y = drops[i] * fontSize;
            
            ctx.fillStyle = 'rgba(0, 255, 65, ' + (0.3 + Math.random() * 0.7) + ')';
            ctx.fillText(char, x, y);
            
            if (y > canvas.height && Math.random() > 0.975) {
              drops[i] = 0;
            }
            drops[i]++;
          }
        }
        
        setInterval(draw, 50);
        
        window.addEventListener('resize', () => {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
        });
      }
      
      // Global error handler for debugging
      window.onerror = function(message, source, lineno, colno, error) {
        console.error('JS Error:', message, 'at line', lineno);
        return false;
      };
      
      // Bind settings controls using addEventListener (required due to CSP/Helmet security)
      function bindSettingsButtons() {
        const saveBtn = document.getElementById('settings-save-btn');
        if (saveBtn) {
          saveBtn.addEventListener('click', function(e) {
            e.preventDefault();
            saveAllSettings();
          });
        }
        
        const resetBtn = document.getElementById('settings-reset-btn');
        if (resetBtn) {
          resetBtn.addEventListener('click', function() {
            resetSettings();
          });
        }
        
        const riskProfileSelect = document.getElementById('cfg-riskProfile');
        if (riskProfileSelect) {
          riskProfileSelect.addEventListener('change', function() {
            applyRiskProfilePreset();
          });
        }
      }
      
      // Bind all interactive controls using addEventListener (CSP-safe)
      function bindAllControls() {
        // Header controls
        const pauseBtn = document.getElementById('pause-btn');
        if (pauseBtn) {
          pauseBtn.addEventListener('click', function(e) {
            e.preventDefault();
            togglePause();
          });
        }
        
        const walletDisplay = document.getElementById('wallet-display');
        if (walletDisplay) walletDisplay.addEventListener('click', copyWallet);
        
        // Equity range buttons
        document.querySelectorAll('.equity-range-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            changeEquityRange(this.dataset.range);
          });
        });
        
        // Performance tabs
        document.querySelectorAll('.perf-tab').forEach(btn => {
          btn.addEventListener('click', function() {
            loadMetrics(this.dataset.period);
          });
        });
        
        // Scanner controls
        const scannerRefreshBtn = document.getElementById('scanner-refresh-btn');
        if (scannerRefreshBtn) scannerRefreshBtn.addEventListener('click', refreshScanner);
        
        document.querySelectorAll('.scanner-refresh-action').forEach(el => {
          el.addEventListener('click', refreshScanner);
        });
        
        document.querySelectorAll('.scanner-data-refresh').forEach(el => {
          el.addEventListener('click', loadScannerData);
        });
        
        // Settings tab refresh buttons
        document.querySelectorAll('.health-refresh').forEach(el => {
          el.addEventListener('click', loadHealth);
        });
        
        document.querySelectorAll('.portfolio-risk-refresh').forEach(el => {
          el.addEventListener('click', loadPortfolioRisk);
        });
        
        document.querySelectorAll('.universe-refresh').forEach(el => {
          el.addEventListener('click', loadUniverse);
        });
        
        document.querySelectorAll('.cache-refresh').forEach(el => {
          el.addEventListener('click', loadCacheStats);
        });
        
        // Export buttons
        document.querySelectorAll('[data-export-type]').forEach(btn => {
          btn.addEventListener('click', function() {
            exportData(this.dataset.exportType, this.dataset.exportFormat);
          });
        });
        
        // Export Lite button
        const exportLiteBtn = document.getElementById('export-lite-btn');
        if (exportLiteBtn) {
          exportLiteBtn.addEventListener('click', async function() {
            const start = document.getElementById('export-start').value;
            const end = document.getElementById('export-end').value;
            const textEl = document.getElementById('export-lite-text');
            const spinnerEl = document.getElementById('export-lite-spinner');
            
            exportLiteBtn.disabled = true;
            textEl.textContent = 'Preparing ZIP...';
            spinnerEl.style.display = 'inline';
            spinnerEl.style.animation = 'spin 1s linear infinite';
            
            try {
              const params = new URLSearchParams();
              if (start) params.append('start', start);
              if (end) params.append('end', end);
              
              const response = await fetch('/api/export/lite?' + params.toString(), { credentials: 'include' });
              if (!response.ok) throw new Error('Export failed');
              
              const blob = await response.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'export_lite_' + (start || 'default') + '_' + (end || 'now') + '.zip';
              document.body.appendChild(a);
              a.click();
              window.URL.revokeObjectURL(url);
              a.remove();
              
              textEl.textContent = 'Export Lite (ZIP)';
              spinnerEl.style.display = 'none';
              exportLiteBtn.disabled = false;
            } catch (err) {
              console.error('Export Lite failed:', err);
              textEl.textContent = 'Export Failed - Retry';
              spinnerEl.style.display = 'none';
              exportLiteBtn.disabled = false;
            }
          });
        }
        
        // Event delegation for dynamically generated content
        document.body.addEventListener('click', function(e) {
          // Handle flash close button clicks
          const flashBtn = e.target.closest('.flash-close-btn');
          if (flashBtn) {
            e.preventDefault();
            const mint = flashBtn.dataset.mint;
            const amount = parseFloat(flashBtn.dataset.amount);
            const decimals = parseInt(flashBtn.dataset.decimals) || 9;
            const symbol = flashBtn.dataset.symbol || 'Unknown';
            flashClose(mint, amount, decimals, symbol);
            return;
          }
          
          // Handle buy SOL with USDC button clicks
          const buySolBtn = e.target.closest('.buy-sol-btn');
          if (buySolBtn) {
            e.preventDefault();
            const amount = parseFloat(buySolBtn.dataset.amount);
            const decimals = parseInt(buySolBtn.dataset.decimals) || 6;
            buySOLWithUSDC(amount, decimals);
            return;
          }
          
          const target = e.target.closest('[data-action]');
          if (!target) return;
          
          const action = target.dataset.action;
          const mint = target.dataset.mint;
          const symbol = target.dataset.symbol;
          const name = target.dataset.name;
          
          e.preventDefault();
          
          switch(action) {
            case 'viewToken':
              viewToken(mint);
              break;
            case 'addToUniverse':
              addToUniverse(mint, symbol, name);
              break;
            case 'removeFromUniverse':
              removeFromUniverse(mint, symbol);
              break;
          }
        });
      }
      
      // Reset Portfolio handlers
      const previewResetBtn = document.getElementById('btn-preview-reset');
      const executeResetBtn = document.getElementById('btn-reset-portfolio');
      const cleanupOnlyBtn = document.getElementById('btn-cleanup-only');
      const resetPreview = document.getElementById('reset-preview');
      const resetPreviewList = document.getElementById('reset-preview-list');
      
      if (previewResetBtn) {
        previewResetBtn.addEventListener('click', async function() {
          previewResetBtn.disabled = true;
          previewResetBtn.textContent = 'Loading...';
          try {
            const res = await fetch('/api/reset-preview');
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            
            let html = '';
            if (data.tokensToSell.length === 0) {
              html = '<div style="color:#64748b">No tokens to sell</div>';
              html += '<div style="margin-top:8px;color:#f59e0b;font-size:11px">' +
                'Use "Clean Data Only" to clear remaining database data (universe: ' + 
                data.universeCount + ', queue: ' + data.queueCount + ')</div>';
              executeResetBtn.style.display = 'none';
              cleanupOnlyBtn.style.display = 'inline-block';
            } else {
              html = data.tokensToSell.map(t => 
                '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e293b">' +
                  '<span style="color:#fff">' + t.symbol + '</span>' +
                  '<span style="color:#94a3b8">$' + (t.valueUsd || 0).toFixed(2) + '</span>' +
                '</div>'
              ).join('');
              html += '<div style="margin-top:8px;color:#64748b;font-size:11px">' +
                'Will also clear: ' + data.universeCount + ' tokens from universe, ' + 
                data.queueCount + ' from scout queue</div>';
              executeResetBtn.style.display = 'inline-block';
              cleanupOnlyBtn.style.display = 'none';
            }
            resetPreviewList.innerHTML = html;
            resetPreview.style.display = 'block';
          } catch (err) {
            resetPreviewList.innerHTML = '<div style="color:#ef4444">Error: ' + err.message + '</div>';
            resetPreview.style.display = 'block';
          }
          previewResetBtn.disabled = false;
          previewResetBtn.textContent = 'Preview Reset';
        });
      }
      
      if (executeResetBtn) {
        executeResetBtn.addEventListener('click', async function() {
          const confirmText = prompt('This will sell ALL tokens and clear your portfolio. Type RESET to confirm:');
          if (confirmText !== 'RESET') {
            alert('Reset cancelled - confirmation text did not match');
            return;
          }
          
          executeResetBtn.disabled = true;
          executeResetBtn.textContent = 'Executing...';
          
          try {
            const res = await fetch('/api/reset-portfolio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ confirmation: 'RESET' })
            });
            const data = await res.json();
            
            if (data.success) {
              const successCount = data.results.filter(r => r.status === 'sent' || r.status === 'paper').length;
              const errorCount = data.results.filter(r => r.status === 'error').length;
              
              let msg = 'Portfolio Reset Complete!\\n\\n';
              msg += 'Sold: ' + successCount + ' tokens\\n';
              if (errorCount > 0) msg += 'Errors: ' + errorCount + ' tokens\\n';
              msg += '\\nCleared:\\n';
              msg += '- Trading universe\\n';
              msg += '- Scout queue\\n';
              msg += '- Entry prices\\n';
              msg += '- Trailing stops';
              
              alert(msg);
              resetPreview.style.display = 'none';
              executeResetBtn.style.display = 'none';
              loadAll(); // Refresh dashboard
            } else {
              alert('Reset failed: ' + (data.error || 'Unknown error'));
            }
          } catch (err) {
            alert('Reset failed: ' + err.message);
          }
          
          executeResetBtn.disabled = false;
          executeResetBtn.textContent = 'Execute Reset';
        });
      }
      
      // Clean Data Only button handler
      if (cleanupOnlyBtn) {
        cleanupOnlyBtn.addEventListener('click', async function() {
          const confirmText = prompt('This will clear ALL database data (positions, queue, universe) without selling. Type CLEANUP to confirm:');
          if (confirmText !== 'CLEANUP') {
            alert('Cleanup cancelled - confirmation text did not match');
            return;
          }
          
          cleanupOnlyBtn.disabled = true;
          cleanupOnlyBtn.textContent = 'Cleaning...';
          
          try {
            const res = await fetch('/api/reset-portfolio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ confirmation: 'RESET', forceCleanup: true })
            });
            const data = await res.json();
            
            if (data.success) {
              let msg = 'Data Cleanup Complete!\\n\\n';
              msg += 'Cleared tables:\\n';
              for (const [table, result] of Object.entries(data.cleared || {})) {
                msg += '- ' + table + ': ' + (result.success ? 'OK' : 'FAILED: ' + result.error) + '\\n';
              }
              if (data.failedCleanups && data.failedCleanups.length > 0) {
                msg += '\\nWarning: Some cleanups failed. You may need to retry.';
              }
              
              alert(msg);
              resetPreview.style.display = 'none';
              cleanupOnlyBtn.style.display = 'none';
              loadAll();
            } else {
              alert('Cleanup failed: ' + (data.error || 'Unknown error'));
            }
          } catch (err) {
            alert('Cleanup failed: ' + err.message);
          }
          
          cleanupOnlyBtn.disabled = false;
          cleanupOnlyBtn.textContent = 'Clean Data Only';
        });
      }
      
      // Prune Historical Data handlers
      const previewPruneBtn = document.getElementById('btn-preview-prune');
      const executePruneBtn = document.getElementById('btn-execute-prune');
      const prunePreview = document.getElementById('prune-preview');
      const prunePreviewContent = document.getElementById('prune-preview-content');
      const pruneDaysSelect = document.getElementById('prune-days');
      
      if (previewPruneBtn) {
        previewPruneBtn.addEventListener('click', async function() {
          const days = pruneDaysSelect ? pruneDaysSelect.value : 7;
          previewPruneBtn.disabled = true;
          previewPruneBtn.textContent = 'Loading...';
          try {
            const res = await fetch('/api/prune-preview?days=' + days);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            
            let html = '<div style="margin-bottom:8px"><strong>Data older than ' + days + ' days to delete:</strong></div>';
            html += '<table style="width:100%;font-size:12px">';
            html += '<tr><td>Telemetry</td><td style="text-align:right">' + data.telemetry.count.toLocaleString() + ' rows (' + data.telemetry.size + ')</td></tr>';
            html += '<tr><td>Equity Snapshots</td><td style="text-align:right">' + data.equity.count.toLocaleString() + ' rows (' + data.equity.size + ')</td></tr>';
            html += '<tr><td>Prices</td><td style="text-align:right">' + data.prices.count.toLocaleString() + ' rows (' + data.prices.size + ')</td></tr>';
            html += '<tr><td>Features</td><td style="text-align:right">' + data.features.count.toLocaleString() + ' rows (' + data.features.size + ')</td></tr>';
            html += '<tr style="border-top:1px solid #334155"><td><strong>Total estimated</strong></td><td style="text-align:right"><strong>' + data.totalSize + '</strong></td></tr>';
            html += '</table>';
            
            prunePreviewContent.innerHTML = html;
            prunePreview.style.display = 'block';
            executePruneBtn.style.display = 'inline-block';
            executePruneBtn.dataset.days = days;
          } catch (err) {
            prunePreviewContent.innerHTML = '<div style="color:#ef4444">Error: ' + err.message + '</div>';
            prunePreview.style.display = 'block';
          }
          previewPruneBtn.disabled = false;
          previewPruneBtn.textContent = 'Preview Prune';
        });
      }
      
      if (executePruneBtn) {
        executePruneBtn.addEventListener('click', async function() {
          const days = executePruneBtn.dataset.days || 7;
          const confirmText = prompt('This will DELETE historical data older than ' + days + ' days. Type PRUNE to confirm:');
          if (confirmText !== 'PRUNE') {
            alert('Prune cancelled - confirmation text did not match');
            return;
          }
          
          executePruneBtn.disabled = true;
          executePruneBtn.textContent = 'Pruning...';
          
          try {
            const res = await fetch('/api/prune-history', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ days: parseInt(days), confirmation: 'PRUNE' })
            });
            const data = await res.json();
            
            if (data.success) {
              let msg = 'Historical Data Pruned!\\n\\n';
              msg += 'Deleted:\\n';
              msg += '- Telemetry: ' + (data.deleted.telemetry || 0).toLocaleString() + ' rows\\n';
              msg += '- Equity: ' + (data.deleted.equity || 0).toLocaleString() + ' rows\\n';
              msg += '- Prices: ' + (data.deleted.prices || 0).toLocaleString() + ' rows\\n';
              msg += '- Features: ' + (data.deleted.features || 0).toLocaleString() + ' rows\\n';
              msg += '\\nNote: Run VACUUM in database console to reclaim disk space.';
              
              alert(msg);
              prunePreview.style.display = 'none';
              executePruneBtn.style.display = 'none';
            } else {
              alert('Prune failed: ' + (data.error || 'Unknown error'));
            }
          } catch (err) {
            alert('Prune failed: ' + err.message);
          }
          
          executePruneBtn.disabled = false;
          executePruneBtn.textContent = 'Execute Prune';
        });
      }
      
      // Initialize
      initMatrixRain();
      connectWS();
      loadCurrentConfig();
      loadPauseState();
      loadDayTimer();
      loadWallet();
      loadAll();
      initSettingsBindings();
      bindSettingsButtons();
      bindAllControls();
      loadSettings();
      setInterval(loadAll, 30000);
      setInterval(loadCacheStats, 60000);
      setInterval(loadSettings, 60000);
      setInterval(loadCurrentConfig, 30000);
    </script>
  </div>
  </body>
  </html>
  `);
});

// API Endpoints
app.get("/api/wallet-address", requireApiAuth, async (_req, res) => {
  try {
    const { loadKeypair } = await import("../bot/solana.js");
    const signer = loadKeypair();
    res.json({ address: signer.publicKey.toBase58() });
  } catch (e) {
    res.status(500).json({ error: "Failed to load wallet" });
  }
});

app.get("/api/trades", requireApiAuth, async (_req, res) => {
  const rows = await loadRecentTrades(50);
  
  const allMints = new Set<string>();
  for (const trade of rows as any[]) {
    if (trade.input_mint) allMints.add(trade.input_mint);
    if (trade.output_mint) allMints.add(trade.output_mint);
  }
  const symbolMap = await buildSymbolMap([...allMints]);
  
  const { getAllPositionTracking } = await import("../bot/persist.js");
  const positionTrackingRows = await getAllPositionTracking();
  const entryPriceMap = new Map<string, number>();
  for (const pt of positionTrackingRows) {
    if (pt.entry_price > 0) {
      entryPriceMap.set(pt.mint, pt.entry_price);
    }
  }
  
  const historicalEntryPrices = new Map<string, number>();
  try {
    const histResult = await q<{mint: string, entry_price_usd: number}>(`
      SELECT DISTINCT ON (mint) mint, entry_price_usd 
      FROM reconciled_trades 
      WHERE side = 'buy' AND entry_price_usd > 0
      ORDER BY mint, timestamp DESC
    `);
    for (const row of histResult) {
      if (!entryPriceMap.has(row.mint) && row.entry_price_usd > 0) {
        historicalEntryPrices.set(row.mint, Number(row.entry_price_usd));
      }
    }
  } catch (e) {}
  
  const enrichedRows = (rows as any[]).map((trade: any) => {
    const inputMint = trade.input_mint || "";
    const outputMint = trade.output_mint || "";
    
    let side: "BUY" | "SELL" | "SWAP" = "SWAP";
    let assetMint = "";
    let assetSymbol = "";
    
    if (inputMint === MINT_SOL || inputMint === MINT_USDC) {
      side = "BUY";
      assetMint = outputMint;
    } else if (outputMint === MINT_SOL || outputMint === MINT_USDC) {
      side = "SELL";
      assetMint = inputMint;
    } else {
      assetMint = outputMint;
    }
    
    assetSymbol = symbolMap.get(assetMint) || assetMint.slice(0, 6);
    
    let computedPnl = Number(trade.pnl_usd) || 0;
    if (side === "SELL" && computedPnl === 0 && trade.meta) {
      const meta = typeof trade.meta === 'string' ? JSON.parse(trade.meta) : trade.meta;
      
      if (meta.realizedPnl && meta.realizedPnl !== 0) {
        computedPnl = Number(meta.realizedPnl);
      } else if (meta.proceedsUsd && meta.costBasis && meta.costBasis !== 0) {
        computedPnl = Number(meta.proceedsUsd) - Number(meta.costBasis);
      } else if (meta.tradeValueUsd) {
        const storedEntryPrice = entryPriceMap.get(assetMint) || historicalEntryPrices.get(assetMint) || meta.entryPrice;
        if (storedEntryPrice && storedEntryPrice > 0) {
          const inAmount = Number(trade.in_amount) || 0;
          const decimals = meta.inDecimals ?? 9;
          const tokenAmount = inAmount / Math.pow(10, decimals);
          const costBasis = tokenAmount * storedEntryPrice;
          computedPnl = Number(meta.tradeValueUsd) - costBasis;
        }
      }
    }
    
    return {
      ...trade,
      side,
      assetMint,
      assetSymbol,
      inputSymbol: symbolMap.get(inputMint) || inputMint.slice(0, 6),
      outputSymbol: symbolMap.get(outputMint) || outputMint.slice(0, 6),
      pnl_usd: computedPnl,
    };
  });
  
  res.json(enrichedRows);
});

app.get("/api/equity", requireApiAuth, async (_req, res) => {
  const row = await loadLatestEquity();
  res.json(row ?? { total_usd: 0, total_sol_equiv: 0, breakdown: {} });
});

app.get("/api/equity-series", requireApiAuth, async (req, res) => {
  const range = (req.query.range as string) || '24h';
  const validRanges = ['24h', 'week', 'month', 'year', 'all'];
  const selectedRange = validRanges.includes(range) ? range : '24h';
  const rows = await loadEquitySeriesWithRange(selectedRange);
  res.json(rows);
});

app.get("/api/metrics", requireApiAuth, async (req, res) => {
  try {
    const period = (req.query.period as string) || 'all';
    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
    const selectedPeriod = validPeriods.includes(period) ? period : 'all';
    const metrics = await getPerformanceMetrics(selectedPeriod);
    res.json(metrics);
  } catch (err) {
    console.error("Failed to get metrics:", err);
    res.status(500).json({ error: "Failed to compute metrics" });
  }
});

app.get("/api/performance-metrics", requireApiAuth, async (req, res) => {
  try {
    const period = (req.query.period as string) || 'all';
    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
    const selectedPeriod = validPeriods.includes(period) ? period : 'all';
    const metrics = await getPerformanceMetrics(selectedPeriod);
    res.json(metrics);
  } catch (err) {
    console.error("Failed to get performance metrics:", err);
    res.status(500).json({ error: "Failed to compute metrics" });
  }
});

app.get("/api/status", requireApiAuth, async (_req, res) => {
  const envContext = getEnvContext();
  const config = getConfig();
  const configHash = getConfigHash();
  
  res.json({
    ...botState,
    envName: envContext.envName,
    execMode: config.executionMode,
    settingsHash: configHash,
    gitSha: envContext.gitSha,
    pid: envContext.processId,
    dbLabel: envContext.dbLabel,
    lastSettingsReloadAt: getLastSettingsReloadAt(),
  });
});

const SENSITIVE_KEY_EXACT = new Set([
  'databaseurl', 'proddatabaseurl', 'botwalletprivatekey',
  'sessionsecret', 'dashboardpassword', 'jupapikey',
  'solanarpcurl', 'solanawssurl', 'heliusapikey',
]);

const SENSITIVE_KEY_SUFFIXES = ['privatekey', 'secretkey', 'authtoken', 'accesstoken', 'bearertoken'];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/_/g, '');
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  for (const suffix of SENSITIVE_KEY_SUFFIXES) {
    if (normalized.endsWith(suffix)) return true;
  }
  return false;
}

function sanitizeSettingsKey(key: string): boolean {
  return !isSensitiveKey(key);
}

app.get("/api/settings/db", requireApiAuth, async (_req, res) => {
  try {
    const dbSettings = await getDbSettings();
    const keyMapping = getKeyMapping();
    
    const sanitized: Record<string, { key: string; value: string; updated_at: Date }> = {};
    for (const [dbKey, entry] of Object.entries(dbSettings)) {
      if (!sanitizeSettingsKey(dbKey)) continue;
      
      const configKey = keyMapping[dbKey];
      if (configKey) {
        sanitized[configKey] = {
          key: dbKey,
          value: entry.value,
          updated_at: entry.updated_at,
        };
      }
    }
    
    res.json({
      settings: sanitized,
      rowCount: Object.keys(sanitized).length,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get DB settings");
    res.status(500).json({ error: "Failed to get DB settings" });
  }
});

function sanitizeConfig(config: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!isSensitiveKey(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

app.get("/api/settings/effective", requireApiAuth, async (_req, res) => {
  try {
    const envContext = getEnvContext();
    const config = getConfig();
    const sources = getConfigSources();
    const configHash = getConfigHash();
    const effectiveConfigInfo = getEffectiveConfigInfo();
    
    const sanitizedConfig = sanitizeConfig(config as Record<string, any>);
    const sanitizedSources = sanitizeConfig(sources as Record<string, any>);
    
    res.json({
      effectiveSettings: sanitizedConfig,
      settingsSources: sanitizedSources,
      settingsHash: configHash,
      execMode: config.executionMode,
      envName: envContext.envName,
      pid: envContext.processId,
      gitSha: envContext.gitSha,
      dbLabel: envContext.dbLabel,
      lastSettingsReloadAt: getLastSettingsReloadAt(),
      settingsRowCount: effectiveConfigInfo?.settingsRowCount ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get effective settings");
    res.status(500).json({ error: "Failed to get effective settings" });
  }
});

app.get("/api/settings/diff", requireApiAuth, async (_req, res) => {
  try {
    const diffs = await getSettingsDiff();
    const sanitizedDiffs = diffs.filter(d => !isSensitiveKey(d.key) && !isSensitiveKey(d.dbKey ?? ''));
    res.json({
      diffs: sanitizedDiffs,
      diffCount: sanitizedDiffs.length,
    });
  } catch (err) {
    logger.error({ err }, "Failed to compute settings diff");
    res.status(500).json({ error: "Failed to compute settings diff" });
  }
});

app.get("/api/env-status", requireApiAuth, async (_req, res) => {
  try {
    const envContext = getEnvContext();
    const config = getConfig();
    const configHash = getConfigHash();
    const sources = getConfigSources();
    const settingsRowCount = getSettingsRowCount();
    const effectiveConfigInfo = getEffectiveConfigInfo();

    const isModeMismatch = (envContext.envName === "prod" && config.executionMode === "paper") ||
                            (envContext.envName === "dev" && config.executionMode === "live");

    res.json({
      environment: {
        envName: envContext.envName,
        deploymentId: envContext.deploymentId,
        gitSha: envContext.gitSha,
        dbLabel: envContext.dbLabel,
        walletLabel: envContext.walletLabel,
        processId: envContext.processId,
        bootTime: envContext.bootTime,
      },
      config: {
        configHash,
        executionMode: config.executionMode,
        executionModeLocked: isExecutionModeLocked(),
        riskProfile: config.riskProfile,
        scannerMinLiquidity: config.scannerMinLiquidity,
        autonomousScoutsEnabled: config.autonomousScoutsEnabled,
        loopSeconds: config.loopSeconds,
      },
      configSources: sources,
      meta: {
        settingsRowCount,
        lastLoadedAt: effectiveConfigInfo?.lastLoadedAt ?? null,
        modeMismatch: isModeMismatch,
        modeMismatchWarning: isModeMismatch 
          ? `WARNING: ${envContext.envName.toUpperCase()} environment running in ${config.executionMode} mode!`
          : null,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to get env status");
    res.status(500).json({ error: "Failed to get environment status" });
  }
});

app.get("/api/runtime-status", requireApiAuth, async (_req, res) => {
  try {
    const { getRuntimeStatus } = await import("../bot/persist.js");
    const { getScanStatus } = await import("../bot/index.js");
    const status = await getRuntimeStatus();
    const scanStatus = getScanStatus();
    const queueStats = await getScoutQueueStats();
    
    if (!status) {
      return res.json({ 
        state: "unknown", 
        lastHeartbeat: null,
        message: "No status record found",
        scan: scanStatus,
        queue: queueStats
      });
    }
    
    const now = Date.now();
    const lastHeartbeat = new Date(status.last_heartbeat).getTime();
    const heartbeatAge = now - lastHeartbeat;
    const isStale = heartbeatAge > 120000; // 2 minutes = stale
    
    let state = status.manual_pause ? "paused" : "running";
    if (!status.manual_pause && isStale) {
      state = "stale"; // Bot hasn't checked in
    }
    
    res.json({
      state,
      manualPause: status.manual_pause,
      executionMode: status.execution_mode,
      lastHeartbeat: status.last_heartbeat,
      lastTransitionAt: status.last_transition_at,
      heartbeatAgeMs: heartbeatAge,
      instanceId: status.instance_id,
      isStale,
      scan: scanStatus,
      queue: queueStats
    });
  } catch (err) {
    res.status(500).json({ state: "error", error: "Failed to get status" });
  }
});

app.get("/api/signals", requireApiAuth, async (_req, res) => {
  const signals = getLatestSignals();
  res.json(signals);
});

app.get("/api/signals/history", requireApiAuth, async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const mint = req.query.mint as string | undefined;
  
  if (mint) {
    const { getSignalHistory } = await import("../bot/telemetry.js");
    const history = getSignalHistory(mint, limit);
    res.json(history);
  } else {
    const allHistory = getAllSignalHistory(limit);
    const recentSignals = getRecentSignalHistory(limit);
    res.json({
      byToken: allHistory,
      recent: recentSignals,
    });
  }
});

app.get("/api/positions", requireApiAuth, async (_req, res) => {
  try {
    const { getBatchPositionCostBasis } = await import("../bot/pnl_engine.js");
    const { getAllPositionTracking } = await import("../bot/persist.js");
    const positions = getLatestPositions();
    
    if (!positions || positions.length === 0) {
      res.json(positions);
      return;
    }
    
    // Get cost basis for all positions to calculate PnL
    const mints = positions.map(p => p.mint).filter(m => m !== "So11111111111111111111111111111111111111112");
    const costBasisMap = mints.length > 0 ? await getBatchPositionCostBasis(mints) : new Map();
    
    // CRITICAL FIX: Get position_tracking data for fallback when FIFO is missing
    // This ensures Overview shows same P&L as Rotation tab
    const trackingRows = await getAllPositionTracking();
    const trackingMap = new Map<string, { entry_price: number; total_tokens: number; entry_time: string }>();
    for (const t of trackingRows) {
      trackingMap.set(t.mint, { 
        entry_price: Number(t.entry_price) || 0, 
        total_tokens: Number(t.total_tokens) || 0,
        entry_time: String(t.entry_time),
      });
    }
    
    // Enrich positions with PnL data
    const enrichedPositions = positions.map(p => {
      if (p.mint === "So11111111111111111111111111111111111111112") {
        return p; // No PnL tracking for SOL
      }
      
      const fifoCostBasis = costBasisMap.get(p.mint);
      const hasFifoData = fifoCostBasis && fifoCostBasis.totalCostBasis > 0 && fifoCostBasis.totalQuantity > 0;
      
      if (hasFifoData) {
        // Use FIFO cost basis (preferred)
        const unrealizedPnlUsd = p.valueUsd - fifoCostBasis.totalCostBasis;
        const unrealizedPnl = (unrealizedPnlUsd / fifoCostBasis.totalCostBasis) * 100;
        return {
          ...p,
          costBasis: fifoCostBasis.totalCostBasis,
          unrealizedPnl,
          unrealizedPnlUsd,
          fifoDataMissing: false,
        };
      }
      
      // FALLBACK: Use position_tracking entry_price when FIFO is missing
      // But only if entry_time is recent (<24h), otherwise data is stale
      const tracking = trackingMap.get(p.mint);
      if (tracking && tracking.entry_price > 0) {
        const entryTimeMs = new Date(tracking.entry_time).getTime();
        const ageHours = (Date.now() - entryTimeMs) / (1000 * 60 * 60);
        const isStaleEntry = ageHours > 24;
        
        if (!isStaleEntry) {
          const fallbackCostBasis = p.amount * tracking.entry_price;
          const unrealizedPnlUsd = p.valueUsd - fallbackCostBasis;
          const unrealizedPnl = fallbackCostBasis > 0 ? (unrealizedPnlUsd / fallbackCostBasis) * 100 : 0;
          return {
            ...p,
            costBasis: fallbackCostBasis,
            unrealizedPnl,
            unrealizedPnlUsd,
            fifoDataMissing: true,
          };
        }
      }
      
      // No reliable cost basis - show 0% PnL
      return { ...p, fifoDataMissing: true, unrealizedPnl: 0, unrealizedPnlUsd: 0 };
    });
    
    res.json(enrichedPositions);
  } catch (err) {
    logger.error({ error: String(err) }, "Failed to get positions with PnL");
    const positions = getLatestPositions();
    res.json(positions); // Fallback to basic positions
  }
});

app.get("/api/whale-status", requireApiAuth, async (_req, res) => {
  try {
    const { getWhaleStatusCache } = await import("../bot/whaleSignal.js");
    const config = getConfig();
    const cache = getWhaleStatusCache();
    const entries = Array.from(cache.values());
    res.json({ 
      enabled: config.whaleConfirmEnabled,
      dryRun: config.whaleConfirmDryRun,
      entries 
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get whale status" });
  }
});

// Get ALL wallet token positions (not just universe)
app.get("/api/wallet-positions", requireApiAuth, async (_req, res) => {
  try {
    const { getAllTokenAccounts } = await import("../bot/wallet.js");
    const { loadKeypair } = await import("../bot/solana.js");
    const { getBatchTokens, getTokenPairs } = await import("../bot/dexscreener.js");
    const { getBatchPositionCostBasis } = await import("../bot/pnl_engine.js");
    const { getAllPositionTracking } = await import("../bot/persist.js");
    
    const signer = loadKeypair();
    const balances = await getAllTokenAccounts(signer.publicKey);
    
    // Get SOL price first
    const solMint = "So11111111111111111111111111111111111111112";
    let solPrice = 180; // fallback
    try {
      const solPairs = await getTokenPairs(solMint);
      if (solPairs && solPairs.length > 0) {
        solPrice = parseFloat(solPairs[0].priceUsd || "180");
      }
    } catch {}
    
    // Get prices for all tokens
    const mints = Object.keys(balances.tokens);
    const tokenDataMap = mints.length > 0 ? await getBatchTokens(mints) : new Map();
    
    // Build price map from token data
    const priceMap: Record<string, { price: number; symbol: string }> = {};
    for (const [mint, pairs] of tokenDataMap) {
      if (pairs && pairs.length > 0) {
        priceMap[mint] = { 
          price: parseFloat(pairs[0].priceUsd || "0"), 
          symbol: pairs[0].baseToken.symbol 
        };
      }
    }
    
    // Get cost basis for all positions in a single batch query
    const costBasisMap = await getBatchPositionCostBasis(mints);
    
    // Get position tracking for fallback entry prices and source
    const trackingRows = await getAllPositionTracking();
    const trackingMap = new Map<string, { entry_price: number; source: string }>();
    for (const t of trackingRows) {
      trackingMap.set(t.mint, { entry_price: Number(t.entry_price), source: (t as any).source || 'bot' });
    }
    
    // Build positions array with values and PnL
    interface PositionWithPnL {
      mint: string;
      symbol: string;
      amount: number;
      valueUsd: number;
      priceUsd: number;
      pctOfPortfolio: number;
      decimals: number;
      costBasis?: number;
      unrealizedPnl?: number;
      unrealizedPnlUsd?: number;
      source?: string;
    }
    const positions: PositionWithPnL[] = [];
    
    // Add SOL (no PnL tracking for SOL)
    const solValue = balances.sol * solPrice;
    positions.push({
      mint: solMint,
      symbol: "SOL",
      amount: balances.sol,
      valueUsd: solValue,
      priceUsd: solPrice,
      pctOfPortfolio: 0,
      decimals: 9,
    });
    
    // Add all tokens with PnL data
    for (const [mint, data] of Object.entries(balances.tokens)) {
      const tokenInfo = priceMap[mint];
      const price = tokenInfo?.price || 0;
      const valueUsd = data.amount * price;
      const fifoData = costBasisMap.get(mint);
      const tracking = trackingMap.get(mint);
      
      let unrealizedPnlUsd: number | undefined;
      let unrealizedPnl: number | undefined;
      let effectiveCostBasis: number | undefined;
      
      if (fifoData && fifoData.totalQuantity > 0 && fifoData.avgCostUsd > 0) {
        const walletQty = data.amount;
        const fifoCoverageRatio = walletQty > 0 ? fifoData.totalQuantity / walletQty : 1;
        const coverageIsReliable = fifoCoverageRatio >= 0.5 && fifoCoverageRatio <= 1.5;
        
        if (coverageIsReliable) {
          effectiveCostBasis = fifoData.totalCostBasis;
        } else if (tracking && tracking.entry_price > 0) {
          effectiveCostBasis = walletQty * tracking.entry_price;
        } else {
          effectiveCostBasis = walletQty * fifoData.avgCostUsd;
        }
        
        if (effectiveCostBasis > 0) {
          unrealizedPnlUsd = valueUsd - effectiveCostBasis;
          unrealizedPnl = (unrealizedPnlUsd / effectiveCostBasis) * 100;
        }
      } else if (tracking && tracking.entry_price > 0) {
        effectiveCostBasis = data.amount * tracking.entry_price;
        if (effectiveCostBasis > 0) {
          unrealizedPnlUsd = valueUsd - effectiveCostBasis;
          unrealizedPnl = (unrealizedPnlUsd / effectiveCostBasis) * 100;
        }
      }
      
      positions.push({
        mint,
        symbol: tokenInfo?.symbol || mint.slice(0, 6),
        amount: data.amount,
        valueUsd,
        priceUsd: price,
        pctOfPortfolio: 0,
        decimals: data.decimals || 9,
        costBasis: effectiveCostBasis,
        unrealizedPnl,
        unrealizedPnlUsd,
        source: tracking?.source || 'bot',
      });
    }
    
    // Calculate total and percentages
    const totalValue = positions.reduce((sum, p) => sum + p.valueUsd, 0);
    for (const p of positions) {
      p.pctOfPortfolio = totalValue > 0 ? p.valueUsd / totalValue : 0;
    }
    
    // Sort by value
    positions.sort((a, b) => b.valueUsd - a.valueUsd);
    
    // Filter out dust (positions worth less than $0.50)
    const DUST_THRESHOLD_USD = 0.50;
    const filteredPositions = positions.filter(p => p.valueUsd >= DUST_THRESHOLD_USD);
    
    res.json(filteredPositions);
  } catch (err) {
    console.error("Failed to get wallet positions:", err);
    res.status(500).json({ error: "Failed to get wallet positions" });
  }
});

export interface HoldingItem {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: number;
  rawBalance: string;
  priceUsd: number | null;
  holdingUsd: number | null;
  isNativeSol: boolean;
  hasPrice: boolean;
  programId?: string;
}

export interface HoldingsResponse {
  address: string;
  nativeSol: number;
  spendableSol: number;
  totalValueUsd: number;
  holdings: HoldingItem[];
  unknownMintCount: number;
  source: "helius_das" | "rpc_fallback";
}

app.get("/api/wallet/:address/holdings", requireApiAuth, async (req, res) => {
  const { address } = req.params;
  const showDust = req.query.showDust === "true";
  const dustThreshold = parseFloat(req.query.dustThreshold as string) || 0.50;

  try {
    new PublicKey(address);
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  try {
    let holdings: HoldingItem[] = [];
    let nativeSol = 0;
    let unknownMintCount = 0;
    let source: "helius_das" | "rpc_fallback" = "helius_das";

    if (isHeliusConfigured()) {
      const heliusHoldings = await getAssetsByOwner(address);
      
      if (heliusHoldings) {
        nativeSol = heliusHoldings.nativeSol;
        unknownMintCount = heliusHoldings.unknownMintCount;

        const mintsNeedingPrices = heliusHoldings.tokens
          .filter(t => t.priceUsd === null)
          .map(t => t.mint);

        let jupiterPrices: Record<string, number | null> = {};
        if (mintsNeedingPrices.length > 0) {
          jupiterPrices = await getJupiterBatchPrices(mintsNeedingPrices);
        }

        for (const token of heliusHoldings.tokens) {
          const priceUsd = token.priceUsd ?? jupiterPrices[token.mint] ?? null;
          const holdingUsd = priceUsd !== null ? token.balance * priceUsd : null;

          holdings.push({
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            balance: token.balance,
            rawBalance: token.rawBalance,
            priceUsd,
            holdingUsd,
            isNativeSol: false,
            hasPrice: priceUsd !== null,
          });
        }
      } else {
        source = "rpc_fallback";
      }
    } else {
      source = "rpc_fallback";
    }

    if (source === "rpc_fallback") {
      const { getAllTokenAccounts } = await import("../bot/wallet.js");
      const pk = new PublicKey(address);
      const balances = await getAllTokenAccounts(pk);
      nativeSol = balances.sol;

      const mints = Object.keys(balances.tokens);
      const jupiterPrices = mints.length > 0 ? await getJupiterBatchPrices(mints) : {};

      for (const [mint, data] of Object.entries(balances.tokens)) {
        const priceUsd = jupiterPrices[mint] ?? null;
        const holdingUsd = priceUsd !== null ? data.amount * priceUsd : null;

        let symbol = mint.slice(0, 6);
        try {
          const pairs = await getTokenPairs(mint);
          if (pairs && pairs.length > 0) {
            symbol = pairs[0].baseToken?.symbol || mint.slice(0, 6);
          }
        } catch {}

        if (!priceUsd) unknownMintCount++;

        holdings.push({
          mint,
          symbol,
          name: symbol,
          decimals: data.decimals,
          balance: data.amount,
          rawBalance: String(Math.floor(data.amount * Math.pow(10, data.decimals))),
          priceUsd,
          holdingUsd,
          isNativeSol: false,
          hasPrice: priceUsd !== null,
          programId: data.programId,
        });
      }
    }

    const solPrice = await getJupiterBatchPrices([MINT_SOL]);
    const solPriceUsd = solPrice[MINT_SOL] ?? 180;
    const solHoldingUsd = nativeSol * solPriceUsd;

    holdings.unshift({
      mint: MINT_SOL,
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      balance: nativeSol,
      rawBalance: String(Math.floor(nativeSol * 1e9)),
      priceUsd: solPriceUsd,
      holdingUsd: solHoldingUsd,
      isNativeSol: true,
      hasPrice: true,
    });

    if (!showDust) {
      holdings = holdings.filter(h => h.isNativeSol || (h.holdingUsd !== null && h.holdingUsd >= dustThreshold));
    }

    holdings.sort((a, b) => {
      if (a.isNativeSol) return -1;
      if (b.isNativeSol) return 1;
      const aVal = a.holdingUsd ?? 0;
      const bVal = b.holdingUsd ?? 0;
      if (bVal !== aVal) return bVal - aVal;
      return b.balance - a.balance;
    });

    const totalValueUsd = holdings.reduce((sum, h) => sum + (h.holdingUsd ?? 0), 0);
    const minSolReserve = 0.01;
    const spendableSol = Math.max(0, nativeSol - minSolReserve);

    const response: HoldingsResponse = {
      address,
      nativeSol,
      spendableSol,
      totalValueUsd,
      holdings,
      unknownMintCount,
      source,
    };

    logger.info({
      address: address.slice(0, 8),
      tokenCount: holdings.length - 1,
      nativeSol: nativeSol.toFixed(4),
      totalValueUsd: totalValueUsd.toFixed(2),
      unknownMintCount,
      source,
    }, "Holdings fetched");

    res.json(response);
  } catch (err) {
    logger.error({ err: String(err), address }, "Failed to get holdings");
    res.status(500).json({ error: "Failed to get holdings" });
  }
});

app.get("/api/debug/holdings", requireApiAuth, async (_req, res) => {
  try {
    const { loadKeypair } = await import("../bot/solana.js");
    const signer = loadKeypair();
    const address = signer.publicKey.toBase58();

    const { getAllTokenAccounts } = await import("../bot/wallet.js");
    const rpcBalances = await getAllTokenAccounts(signer.publicKey);

    let heliusHoldings = null;
    if (isHeliusConfigured()) {
      heliusHoldings = await getAssetsByOwner(address);
    }

    res.json({
      address,
      rpc: {
        sol: rpcBalances.sol,
        tokenCount: Object.keys(rpcBalances.tokens).length,
        tokens: rpcBalances.tokens,
      },
      helius: heliusHoldings ? {
        sol: heliusHoldings.nativeSol,
        tokenCount: heliusHoldings.tokens.length,
        tokens: heliusHoldings.tokens,
        unknownMintCount: heliusHoldings.unknownMintCount,
      } : null,
      heliusConfigured: isHeliusConfigured(),
    });
  } catch (err) {
    logger.error({ err: String(err) }, "Debug holdings failed");
    res.status(500).json({ error: "Debug failed" });
  }
});

app.get("/api/debug/position_health", requireApiAuth, async (_req, res) => {
  try {
    const openLotsRows = await q<{ mint: string }>(
      `SELECT DISTINCT mint FROM position_lots WHERE is_closed = false`
    );
    const openLotsMints = new Set(openLotsRows.map(r => r.mint));

    const trackingRows = await q<{ mint: string }>(
      `SELECT mint FROM position_tracking`
    );
    const trackingMints = new Set(trackingRows.map(r => r.mint));

    const missingTrackingMints: string[] = [];
    for (const mint of openLotsMints) {
      if (!trackingMints.has(mint)) {
        missingTrackingMints.push(mint);
        if (missingTrackingMints.length >= 20) break;
      }
    }

    const config = getConfig();

    res.json({
      openLotsMintsCount: openLotsMints.size,
      trackingRowsCount: trackingRows.length,
      missingTrackingMints,
      paused: {
        manual: config.manualPause,
        risk: botState.circuit === 'breaker',
      },
      config: {
        scoutStopLossPct: config.scoutStopLossPct,
        scoutTakeProfitPct: config.scoutTakeProfitPct,
        scoutTpMinHoldMinutes: config.scoutTpMinHoldMinutes,
        lossExitPct: config.lossExitPct,
      },
    });
  } catch (err) {
    logger.error({ err: String(err) }, "Position health check failed");
    res.status(500).json({ error: "Position health check failed" });
  }
});

app.get("/api/debug/pnl_compare", requireApiAuth, async (_req, res) => {
  try {
    const { getPositionCostBasis } = await import("../bot/pnl_engine.js");
    const { loadKeypair } = await import("../bot/solana.js");
    const { getAllTokenAccounts } = await import("../bot/wallet.js");
    const { getBatchTokens } = await import("../bot/dexscreener.js");
    
    const signer = loadKeypair();
    const balances = await getAllTokenAccounts(signer.publicKey);
    
    const tokenMints = Object.keys(balances.tokens).filter(m => 
      m !== MINT_SOL && m !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );
    
    if (tokenMints.length === 0) {
      res.json({ positions: [], message: "No token positions found" });
      return;
    }
    
    const batchTokens = await getBatchTokens(tokenMints);
    const prices: Record<string, number> = {};
    for (const [mint, pairs] of batchTokens) {
      if (pairs.length > 0) {
        const priceVal = pairs[0].priceUsd;
        prices[mint] = typeof priceVal === 'string' ? parseFloat(priceVal) || 0 : (priceVal || 0);
      }
    }
    
    const trackingRows = await q<{ 
      mint: string; 
      slot_type: string;
      entry_price: string;
      entry_time: Date;
    }>(
      `SELECT mint, slot_type, entry_price, entry_time FROM position_tracking WHERE slot_type = 'scout'`
    );
    const trackingMap = new Map<string, { entryPrice: number; entryTime: Date }>();
    for (const row of trackingRows) {
      trackingMap.set(row.mint, { 
        entryPrice: Number(row.entry_price) || 0,
        entryTime: row.entry_time
      });
    }
    
    const positions: Array<{
      mint: string;
      symbol: string;
      uiPnlPct: number;
      evaluatorPnlPct: number;
      discrepancy: number;
      uiEntryPrice: number;
      evaluatorEntryPrice: number;
      currentPrice: number;
      costBasisUsd: number;
      positionUsd: number;
      holdMinutes: number;
      scoutTpThreshold: number;
      meetsThreshold: boolean;
      reason?: string;
    }> = [];
    
    const config = getConfig();
    const scoutTpPct = config.scoutTakeProfitPct || 0.08;
    const scoutTpMinHoldMinutes = config.scoutTpMinHoldMinutes || 5;
    
    for (const mint of tokenMints) {
      const tokenData = balances.tokens[mint];
      if (!tokenData || tokenData.amount <= 0) continue;
      
      const currentPrice = prices[mint] || 0;
      if (currentPrice === 0) continue;
      
      const positionUsd = tokenData.amount * currentPrice;
      if (positionUsd < 1) continue;
      
      const cb = await getPositionCostBasis(mint);
      const tracking = trackingMap.get(mint);
      
      const uiEntryPrice = cb && cb.avgCostUsd > 0 ? cb.avgCostUsd : (tracking?.entryPrice || currentPrice);
      const evaluatorEntryPrice = cb && cb.avgCostUsd > 0 ? cb.avgCostUsd : 0;
      
      const costBasisUsd = cb ? cb.totalCostBasis : 0;
      
      const uiPnlPct = uiEntryPrice > 0 
        ? ((currentPrice - uiEntryPrice) / uiEntryPrice) * 100
        : 0;
      
      const evaluatorPnlPct = evaluatorEntryPrice > 0
        ? (currentPrice - evaluatorEntryPrice) / evaluatorEntryPrice
        : 0;
      
      const holdMinutes = tracking 
        ? (Date.now() - new Date(tracking.entryTime).getTime()) / (1000 * 60)
        : 0;
      
      const meetsThreshold = evaluatorPnlPct >= scoutTpPct && holdMinutes >= scoutTpMinHoldMinutes;
      
      let reason: string | undefined;
      if (evaluatorEntryPrice === 0) {
        reason = "No entry price in position_lots (evaluatorEntryPrice=0)";
      } else if (evaluatorPnlPct < scoutTpPct) {
        reason = `PnL ${(evaluatorPnlPct * 100).toFixed(2)}% < threshold ${(scoutTpPct * 100).toFixed(1)}%`;
      } else if (holdMinutes < scoutTpMinHoldMinutes) {
        reason = `Hold time ${holdMinutes.toFixed(1)}min < ${scoutTpMinHoldMinutes}min required`;
      }
      
      positions.push({
        mint,
        symbol: mint.slice(0, 6),
        uiPnlPct,
        evaluatorPnlPct: evaluatorPnlPct * 100,
        discrepancy: Math.abs(uiPnlPct - (evaluatorPnlPct * 100)),
        uiEntryPrice,
        evaluatorEntryPrice,
        currentPrice,
        costBasisUsd,
        positionUsd,
        holdMinutes,
        scoutTpThreshold: scoutTpPct * 100,
        meetsThreshold,
        reason,
      });
    }
    
    positions.sort((a, b) => b.uiPnlPct - a.uiPnlPct);
    
    res.json({
      scoutTpPct: scoutTpPct * 100,
      scoutTpMinHoldMinutes,
      positionsCount: positions.length,
      top10ByUiPnl: positions.slice(0, 10),
      top10ByEvaluatorPnl: [...positions].sort((a, b) => b.evaluatorPnlPct - a.evaluatorPnlPct).slice(0, 10),
      positionsAboveUiTp: positions.filter(p => p.uiPnlPct >= scoutTpPct * 100).length,
      positionsAboveEvaluatorTp: positions.filter(p => p.evaluatorPnlPct >= scoutTpPct * 100).length,
      positionsMeetingAllCriteria: positions.filter(p => p.meetsThreshold).length,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "PnL compare check failed");
    res.status(500).json({ error: "PnL compare check failed" });
  }
});

app.get("/api/debug/scout-entry-gate", requireApiAuth, async (_req, res) => {
  try {
    const config = getConfig();
    const recentEvals = getRecentScoutEntryEvals(20);
    const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
    
    const reasonCounts: Record<string, number> = {};
    for (const e of getRecentScoutEntryEvals(100)) {
      if (e.timestamp >= thirtyMinsAgo) {
        const reason = e.failReason || 'PASS';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }
    }
    
    res.json({
      recentEvals,
      reasonCounts,
      thresholds: {
        scoutChaseRet15Max: config.scoutChaseRet15Max,
        scoutImpulseRet15Min: config.scoutImpulseRet15Min,
        scoutPullbackFromHigh15Min: config.scoutPullbackFromHigh15Min,
        scoutEntrySmaMinutes: config.scoutEntrySmaMinutes,
        scoutEntryRequireAboveSma: config.scoutEntryRequireAboveSma,
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/debug/scout-queue", requireApiAuth, async (_req, res) => {
  try {
    const { getQueueHealth } = await import("../bot/persist.js");
    const { q } = await import("../bot/db.js");
    
    const health = await getQueueHealth();
    
    interface QueueItem {
      mint: string;
      symbol: string | null;
      status: string;
      score: number;
      buy_attempts: number;
      created_at: Date;
      queued_at: Date | null;
      in_progress_at: Date | null;
      next_attempt_at: Date | null;
      last_error: string | null;
    }
    
    const items = await q<QueueItem>(
      `SELECT mint, symbol, status, score, buy_attempts, created_at, queued_at, 
              in_progress_at, next_attempt_at, last_error
       FROM scout_queue
       ORDER BY 
         CASE status 
           WHEN 'IN_PROGRESS' THEN 1 
           WHEN 'QUEUED' THEN 2 
           ELSE 3 
         END,
         score DESC
       LIMIT 50`
    );
    
    const itemsWithAge = items.map((item: QueueItem) => {
      const createdAgeMin = (Date.now() - new Date(item.created_at).getTime()) / 60000;
      const queuedAgeMin = item.queued_at 
        ? (Date.now() - new Date(item.queued_at).getTime()) / 60000 
        : null;
      const inProgressAgeMin = item.in_progress_at 
        ? (Date.now() - new Date(item.in_progress_at).getTime()) / 60000 
        : null;
      
      return {
        ...item,
        createdAgeMin: Math.round(createdAgeMin * 10) / 10,
        queuedAgeMin: queuedAgeMin !== null ? Math.round(queuedAgeMin * 10) / 10 : null,
        inProgressAgeMin: inProgressAgeMin !== null ? Math.round(inProgressAgeMin * 10) / 10 : null,
      };
    });
    
    res.json({
      health,
      itemCount: items.length,
      items: itemsWithAge,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "Scout queue debug failed");
    res.status(500).json({ error: "Scout queue debug failed" });
  }
});

app.get("/api/debug/bars", requireApiAuth, async (req, res) => {
  try {
    const { q } = await import("../bot/db.js");
    const mint = req.query.mint as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 120, 500);
    
    if (!mint) {
      return res.status(400).json({ error: "mint query param required" });
    }
    
    interface PriceRow { ts: Date; usd_price: number; }
    
    const rows = await q<PriceRow>(
      `SELECT ts, usd_price FROM prices 
       WHERE mint = $1 
       ORDER BY ts DESC 
       LIMIT $2`,
      [mint, limit]
    );
    
    const count = rows.length;
    const oldestTs = count > 0 ? rows[count - 1].ts : null;
    const newestTs = count > 0 ? rows[0].ts : null;
    
    const first3 = rows.slice(-3).reverse().map(r => ({ ts: r.ts, usd_price: Number(r.usd_price) }));
    const last3 = rows.slice(0, 3).map(r => ({ ts: r.ts, usd_price: Number(r.usd_price) }));
    
    res.json({
      mint,
      count,
      oldestTs,
      newestTs,
      sample: { first3, last3 },
      queryLimit: limit,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "Bars debug failed");
    res.status(500).json({ error: "Bars debug failed" });
  }
});

app.get("/api/wallet/:address/pnl", requireApiAuth, async (req, res) => {
  const { address } = req.params;

  try {
    new PublicKey(address);
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  try {
    const { getPnlSummary } = await import("../bot/reconcile.js");
    const { getAllTokenAccounts } = await import("../bot/wallet.js");
    const { isHeliusConfigured } = await import("../bot/helius.js");

    if (!isHeliusConfigured()) {
      res.status(503).json({ error: "Helius API not configured - reconciliation unavailable" });
      return;
    }

    const pk = new PublicKey(address);
    const balances = await getAllTokenAccounts(pk);

    const holdingsMap = new Map<string, { balance: number; symbol: string }>();
    for (const [mint, data] of Object.entries(balances.tokens)) {
      holdingsMap.set(mint, { balance: data.amount, symbol: mint.slice(0, 6) });
    }

    const pnl = await getPnlSummary(address, holdingsMap);

    res.json({
      address,
      positions: pnl.positions,
      totals: pnl.totals,
      positionCount: pnl.positions.length,
    });
  } catch (err) {
    logger.error({ err: String(err), address }, "PnL calculation failed");
    res.status(500).json({ error: "PnL calculation failed" });
  }
});

app.get("/api/pnl", requireApiAuth, async (_req, res) => {
  try {
    const { getPnLSummary, getRecentPnLEvents, getPositionCostBasis } = await import("../bot/pnl_engine.js");
    const { loadKeypair } = await import("../bot/solana.js");
    const { getAllTokenAccounts } = await import("../bot/wallet.js");
    const { getBatchTokens } = await import("../bot/dexscreener.js");
    
    const signer = loadKeypair();
    const balances = await getAllTokenAccounts(signer.publicKey);
    
    const summary = await getPnLSummary();
    const recentEvents = await getRecentPnLEvents(20);
    
    const tokenMints = Object.keys(balances.tokens).filter(m => 
      m !== MINT_SOL && m !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );
    
    const batchTokens = await getBatchTokens(tokenMints);
    const prices: Record<string, number> = {};
    for (const [mint, pairs] of batchTokens) {
      if (pairs.length > 0) {
        const priceVal = pairs[0].priceUsd;
        prices[mint] = typeof priceVal === 'string' ? parseFloat(priceVal) || 0 : (priceVal || 0);
      }
    }
    
    const positions: Array<{
      mint: string;
      symbol: string;
      quantity: number;
      currentPrice: number;
      marketValue: number;
      costBasis: number;
      unrealizedPnl: number;
      realizedPnl: number;
    }> = [];
    
    let totalUnrealizedPnl = 0;
    
    for (const [mint, data] of Object.entries(balances.tokens)) {
      if (mint === MINT_SOL || mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") continue;
      if (data.amount < 0.000001) continue;
      
      const currentPrice = prices[mint] ?? 0;
      const marketValue = data.amount * currentPrice;
      
      const costBasisData = await getPositionCostBasis(mint);
      const unrealizedPnl = marketValue - costBasisData.totalCostBasis;
      totalUnrealizedPnl += unrealizedPnl;
      
      const tokenData = summary.byToken.get(mint);
      
      positions.push({
        mint,
        symbol: mint.slice(0, 6),
        quantity: data.amount,
        currentPrice,
        marketValue,
        costBasis: costBasisData.totalCostBasis,
        unrealizedPnl,
        realizedPnl: tokenData?.realizedPnl ?? 0,
      });
    }
    
    positions.sort((a, b) => b.marketValue - a.marketValue);
    
    res.json({
      summary: {
        totalRealizedPnl: summary.totalRealizedPnl,
        totalUnrealizedPnl,
        todayRealizedPnl: summary.todayRealizedPnl,
        totalPnl: summary.totalRealizedPnl + totalUnrealizedPnl,
      },
      positions,
      recentEvents: recentEvents.map(e => ({
        timestamp: e.timestamp,
        mint: e.mint,
        symbol: e.symbol,
        type: e.event_type,
        quantity: e.quantity,
        proceeds: e.proceeds_usd,
        costBasis: e.cost_basis_usd,
        realizedPnl: e.realized_pnl_usd,
      })),
    });
  } catch (err) {
    logger.error({ err: String(err) }, "PnL V2 calculation failed");
    res.status(500).json({ error: "PnL calculation failed" });
  }
});

app.post("/api/pnl/sync", strictApiLimiter, requireApiAuth, async (_req, res) => {
  try {
    const { backfillTradesFromReconciled } = await import("../bot/reconcile.js");
    const { loadKeypair } = await import("../bot/solana.js");
    const { isHeliusConfigured } = await import("../bot/helius.js");
    
    if (!isHeliusConfigured()) {
      res.status(503).json({ error: "Helius API not configured" });
      return;
    }
    
    const signer = loadKeypair();
    const address = signer.publicKey.toBase58();
    
    const universe = await q<{ mint: string; symbol: string }>(`SELECT mint, symbol FROM trading_universe`);
    const symbolMap = new Map<string, string>();
    for (const row of universe) {
      symbolMap.set(row.mint, row.symbol);
    }
    
    const result = await backfillTradesFromReconciled(address, symbolMap);
    
    res.json({
      success: true,
      synced: result.synced,
      processed: result.processed,
      message: `Synced ${result.synced} new trades, processed ${result.processed} into lots`,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "PnL sync failed");
    res.status(500).json({ error: "Sync failed" });
  }
});

app.post("/api/wallet/:address/reconcile", strictApiLimiter, requireApiAuth, async (req, res) => {
  const { address } = req.params;
  const limit = parseInt(req.query.limit as string) || 200;

  try {
    new PublicKey(address);
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  try {
    const { fetchAndReconcileTrades } = await import("../bot/reconcile.js");
    const { isHeliusConfigured } = await import("../bot/helius.js");

    if (!isHeliusConfigured()) {
      res.status(503).json({ error: "Helius API not configured" });
      return;
    }

    const result = await fetchAndReconcileTrades(address, { limit });
    
    res.json({
      address,
      newTrades: result.newTrades,
      totalTrades: result.totalTrades,
      message: `Reconciled ${result.newTrades} new trades (${result.totalTrades} total)`,
    });
  } catch (err) {
    logger.error({ err: String(err), address }, "Reconciliation failed");
    res.status(500).json({ error: "Reconciliation failed" });
  }
});

app.get("/api/reconciled-trades", requireApiAuth, async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;

  try {
    const { getReconciledTrades } = await import("../bot/reconcile.js");
    const trades = await getReconciledTrades(limit);
    res.json({ trades, count: trades.length });
  } catch (err) {
    logger.error({ err: String(err) }, "Failed to get reconciled trades");
    res.status(500).json({ error: "Failed to get trades" });
  }
});

app.post("/api/flash-close", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { mint, amount, decimals, confirmToken } = req.body;
    
    if (!mint || !amount) {
      return res.status(400).json({ error: "Missing mint or amount" });
    }
    
    if (!/^[A-Za-z0-9]{32,64}$/.test(mint)) {
      return res.status(400).json({ error: "Invalid mint address" });
    }
    
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1e15) {
      return res.status(400).json({ error: "Invalid amount - must be a positive finite number" });
    }
    
    if (confirmToken !== "CONFIRM_FLASH_CLOSE") {
      return res.status(400).json({ error: "Missing confirmation token" });
    }
    
    const config = getConfig();
    
    if (config.manualPause) {
      return res.status(400).json({ error: "Bot is paused - flash close disabled" });
    }
    
    if (config.executionMode === "paper") {
      logger.info({ mint, amount: parsedAmount }, "Flash close in paper mode - simulating");
    }
    
    const { loadKeypair } = await import("../bot/solana.js");
    const { closePositionForFlashClose } = await import("../bot/close_position.js");
    const { getTokenPairs } = await import("../bot/dexscreener.js");
    
    const signer = loadKeypair();
    const execMode = config.executionMode;

    let solPrice = 200;
    try {
      const solPairs = await getTokenPairs(MINT_SOL);
      if (solPairs && solPairs.length > 0) {
        solPrice = parseFloat(solPairs[0].priceUsd || "200");
      }
    } catch {}

    const symbol = await resolveSymbol(mint);
    
    logger.info({ mint, symbol, amount: parsedAmount, mode: execMode }, "FLASH_CLOSE: Starting via closePositionForFlashClose");
    
    const result = await closePositionForFlashClose(
      mint,
      {
        symbol,
        solPriceUsd: solPrice,
        amount: parsedAmount,
        decimals: decimals || 9,
        manual: true,
      },
      signer,
      execMode
    );
    
    if (result.success) {
      logger.info({
        mint,
        symbol,
        txSig: result.txSig,
        soldAmount: result.soldAmount,
        proceedsUsd: result.proceedsUsd,
        realizedPnlUsd: result.realizedPnlUsd,
        fullyClosed: result.fullyClosed,
        remainingAmount: result.remainingAmount,
        coreSlotFreed: result.coreSlotFreed,
      }, "FLASH_CLOSE: Successfully executed via closePositionForFlashClose");
      
      res.json({ 
        success: true, 
        txSig: result.txSig,
        status: result.status,
        soldAmount: result.soldAmount,
        proceedsUsd: result.proceedsUsd,
        realizedPnlUsd: result.realizedPnlUsd,
        fullyClosed: result.fullyClosed,
        remainingAmount: result.remainingAmount,
        coreSlotFreed: result.coreSlotFreed,
      });
    } else {
      logger.error({ mint, symbol, error: result.error }, "FLASH_CLOSE: Failed");
      res.status(400).json({ 
        success: false, 
        error: result.error || "Flash close failed",
        status: result.status,
      });
    }
  } catch (e: any) {
    console.error("Flash close error:", e);
    res.status(500).json({ error: e.message || "Flash close failed" });
  }
});

app.post("/api/usdc-to-sol", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { amount, decimals, confirmToken } = req.body;
    
    if (!amount) {
      return res.status(400).json({ error: "Missing amount" });
    }
    
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1e15) {
      return res.status(400).json({ error: "Invalid amount - must be a positive finite number" });
    }
    
    if (confirmToken !== "CONFIRM_USDC_TO_SOL") {
      return res.status(400).json({ error: "Missing confirmation token" });
    }
    
    const config = getConfig();
    
    if (config.manualPause) {
      return res.status(400).json({ error: "Bot is paused - USDC to SOL disabled" });
    }
    
    const { loadKeypair } = await import("../bot/solana.js");
    const { executeSwap } = await import("../bot/execution.js");
    const { insertTrade } = await import("../bot/persist.js");
    
    const signer = loadKeypair();
    const execMode = config.executionMode;
    
    const usdcDecimals = Number(decimals) || 6;
    const baseUnits = parsedAmount * Math.pow(10, usdcDecimals);
    
    const USDC_TO_SOL_MAX_PCT = 0.95;
    const maxSellAmount = BigInt(Math.floor(baseUnits * USDC_TO_SOL_MAX_PCT));
    
    if (maxSellAmount <= 0n) {
      return res.status(400).json({ error: "USDC balance too low for conversion" });
    }
    
    logger.info({ 
      usdcAmountHuman: parsedAmount,
      usdcDecimals,
      baseUnits,
      sellAmount: maxSellAmount.toString(),
      maxPct: USDC_TO_SOL_MAX_PCT,
      mode: execMode 
    }, "USDC_TO_SOL: Starting USDC to SOL conversion");
    
    const sellRes = await executeSwap({
      strategy: "usdc_to_sol",
      inputMint: MINT_USDC,
      outputMint: MINT_SOL,
      inAmountBaseUnits: maxSellAmount.toString(),
      slippageBps: config.maxSlippageBps,
      meta: {
        manual: true,
        isUSDCToSOL: true,
      },
    }, signer, execMode);
    
    if (sellRes.status === "insufficient_funds" || sellRes.status === "simulation_failed" || sellRes.status === "error") {
      logger.error({
        status: sellRes.status,
        error: sellRes.error,
      }, "USDC_TO_SOL: Swap failed");
      
      return res.status(400).json({ 
        success: false, 
        error: sellRes.error || "USDC to SOL swap failed",
        status: sellRes.status,
      });
    }
    
    const solReceivedLamports = BigInt(sellRes.quote?.outAmount ?? "0");
    const solReceived = Number(solReceivedLamports) / 1e9;
    const usdcSpent = Number(maxSellAmount) / 1e6;
    
    await insertTrade({
      strategy: "usdc_to_sol",
      risk_profile: config.riskProfile,
      mode: execMode,
      input_mint: MINT_USDC,
      output_mint: MINT_SOL,
      in_amount: maxSellAmount.toString(),
      out_amount: sellRes.quote?.outAmount ?? null,
      est_out_amount: sellRes.quote?.outAmount ?? null,
      price_impact_pct: sellRes.quote?.priceImpactPct ?? null,
      slippage_bps: sellRes.quote?.slippageBps ?? null,
      tx_sig: sellRes.txSig,
      status: sellRes.status,
      meta: { 
        manual: true,
        isUSDCToSOL: true,
      },
      pnl_usd: 0,
      reason_code: "manual_usdc_to_sol",
    }).catch(e => logger.error({ error: String(e) }, "USDC_TO_SOL: Failed to insert trade"));
    
    logger.info({
      txSig: sellRes.txSig,
      usdcSpent,
      solReceived,
      reservedUsdc: (baseUnits - Number(maxSellAmount)) / Math.pow(10, usdcDecimals),
    }, "USDC_TO_SOL: Successfully converted USDC to SOL");
    
    res.json({ 
      success: true, 
      txSig: sellRes.txSig,
      status: sellRes.status,
      usdcSpent,
      solReceived,
    });
  } catch (e: any) {
    console.error("USDC to SOL error:", e);
    res.status(500).json({ error: e.message || "USDC to SOL failed" });
  }
});

app.get("/api/telemetry", requireApiAuth, async (_req, res) => {
  const telemetry = getLatestTelemetry();
  res.json(telemetry);
});

app.get("/api/price-history/:mint", requireApiAuth, async (req, res) => {
  const history = getPriceHistory(req.params.mint, 500);
  res.json(history);
});

// Solscan endpoints
app.get("/api/token/:mint", requireApiAuth, async (req, res) => {
  const meta = await getTokenMeta(req.params.mint);
  res.json(meta);
});

app.get("/api/token/:mint/transfers", requireApiAuth, async (req, res) => {
  const transfers = await getTokenTransfers(req.params.mint, 20);
  res.json(transfers);
});

app.get("/api/token/:mint/holders", requireApiAuth, async (req, res) => {
  const holders = await getTokenHolders(req.params.mint, 20);
  res.json(holders);
});

app.get("/api/token/:mint/markets", requireApiAuth, async (req, res) => {
  const markets = await getTokenMarkets(req.params.mint);
  res.json(markets);
});

app.get("/api/trending", requireApiAuth, async (_req, res) => {
  const trending = await getTrendingTokens();
  res.json({ data: trending, source: "dexscreener" });
});

app.get("/api/listings", requireApiAuth, async (_req, res) => {
  const listings = await getNewListings();
  res.json({ data: listings, source: "dexscreener" });
});

app.get("/api/cache-stats", requireApiAuth, async (_req, res) => {
  const solscan = getSolscanCacheStats();
  const dex = getDexCacheStats();
  res.json({ solscan, dexscreener: dex });
});

app.get("/api/scan", requireApiAuth, async (_req, res) => {
  try {
    const { runMarketScan } = await import("../bot/scanner.js");
    const result = await runMarketScan();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Scan failed" });
  }
});

app.post("/api/scanner/refresh", strictApiLimiter, requireApiAuth, async (_req, res) => {
  try {
    const { clearCache } = await import("../bot/dexscreener.js");
    const { runMarketScan } = await import("../bot/scanner.js");
    clearCache();  // Clear DexScreener cache to force fresh data
    const result = await runMarketScan(true);
    res.json(result);
  } catch (err) {
    console.error("Scanner refresh failed:", err);
    res.status(500).json({ error: "Scan failed" });
  }
});

app.get("/api/opportunities", requireApiAuth, async (_req, res) => {
  try {
    const { getLastScan } = await import("../bot/scanner.js");
    const scan = getLastScan();
    res.json(scan?.topOpportunities ?? []);
  } catch (err) {
    res.json([]);
  }
});

app.get("/api/sniper/status", requireApiAuth, async (_req, res) => {
  try {
    const { getSniperStatus } = await import("../sniper/index.js");
    res.json(getSniperStatus());
  } catch (err) {
    res.json({ 
      running: false, 
      connected: false, 
      subscriptions: 0,
      activePositions: 0,
      closedPositions: 0,
      pendingTokens: 0,
      config: null,
      stats: { activeCount: 0, closedCount: 0, totalPnlUsd: 0, winCount: 0, lossCount: 0 },
      error: "Sniper module not loaded"
    });
  }
});

app.get("/api/sniper/positions", requireApiAuth, async (_req, res) => {
  try {
    const { getSniperPositions } = await import("../sniper/index.js");
    res.json(getSniperPositions());
  } catch (err) {
    res.json({ active: [], closed: [] });
  }
});

app.post("/api/sniper/start", strictApiLimiter, requireApiAuth, async (_req, res) => {
  try {
    const config = getConfig();
    if (!config.sniperEnabled) {
      return res.status(403).json({ 
        success: false, 
        error: "Sniper disabled via sniperEnabled flag. Set sniper_enabled=true in bot_settings to enable." 
      });
    }
    const { startSniper, getSniperStatus } = await import("../sniper/index.js");
    const started = await startSniper();
    res.json({ success: started, status: getSniperStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post("/api/sniper/stop", strictApiLimiter, requireApiAuth, async (_req, res) => {
  try {
    const { stopSniper, getSniperStatus } = await import("../sniper/index.js");
    stopSniper();
    res.json({ success: true, status: getSniperStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post("/api/sniper/reset", strictApiLimiter, requireApiAuth, async (_req, res) => {
  try {
    const { resetSniper, getSniperStatus } = await import("../sniper/index.js");
    resetSniper();
    res.json({ success: true, status: getSniperStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.get("/api/config", requireApiAuth, async (_req, res) => {
  res.json(getConfigForApi());
});

app.get("/api/universe/active", requireApiAuth, async (_req, res) => {
  try {
    const { loadTradingUniverse, getSlotCounts, getAllPositionTracking } = await import("../bot/persist.js");
    const universe = await loadTradingUniverse();
    const slotCounts = await getSlotCounts();
    const tracking = await getAllPositionTracking();
    
    const trackingMap = new Map(tracking.map(t => [t.mint, t]));
    
    const tokens = universe.map(u => ({
      mint: u.mint,
      symbol: u.symbol,
      name: u.name,
      addedAt: u.added_at,
      source: u.source,
      slotType: trackingMap.get(u.mint)?.slot_type ?? null,
    }));
    
    res.json({
      count: tokens.length,
      slotCounts,
      tokens,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/universe/cache", requireApiAuth, async (_req, res) => {
  try {
    const { getRecentExitedTokens } = await import("../bot/persist.js");
    const cached = await getRecentExitedTokens(50);
    
    res.json({
      count: cached.length,
      tokens: cached.map(c => ({
        mint: c.mint,
        symbol: c.symbol,
        lastExitTime: c.last_exit_time,
        lastExitReason: c.last_exit_reason,
        lastExitPnlUsd: c.last_exit_pnl_usd,
        lastExitPnlPct: c.last_exit_pnl_pct,
        cooldownUntil: c.cooldown_until,
        timesReentered: c.times_reentered,
        lastKnownPrice: c.last_known_price,
        lastKnownSignal: c.last_known_signal,
        telemetryUntil: c.telemetry_until,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/telemetry/status", requireApiAuth, async (_req, res) => {
  try {
    const { getTelemetryLoggerStatus } = await import("../bot/telemetry_logger.js");
    const status = getTelemetryLoggerStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/telemetry/:mint", requireApiAuth, async (req, res) => {
  try {
    const { getTokenTelemetry } = await import("../bot/persist.js");
    const mint = req.params.mint;
    const limit = parseInt(req.query.limit as string) || 100;
    const telemetry = await getTokenTelemetry(mint, limit);
    res.json({
      mint,
      count: telemetry.length,
      records: telemetry.map(t => ({
        ts: t.ts,
        price: t.price,
        liquidityUsd: t.liquidity_usd,
        volume24h: t.volume_24h,
        holders: t.holders,
        signal: t.signal,
        features: t.features,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/pause", strictApiLimiter, requireApiAuth, async (_req, res) => {
  try {
    const currentConfig = getConfig();
    const newPauseState = !currentConfig.manualPause;
    const success = await updateConfigBatch({ manualPause: newPauseState });
    if (success) {
      updateBotState({ paused: newPauseState, manualPause: newPauseState });
      res.json({ success: true, manualPause: newPauseState });
    } else {
      res.status(500).json({ error: "Failed to update pause state" });
    }
  } catch (e) {
    res.status(500).json({ error: "Failed to toggle pause state" });
  }
});

app.get("/api/day-timer", requireApiAuth, async (_req, res) => {
  try {
    const { getNextCSTMidnightInfo } = await import("../bot/index.js");
    const timerInfo = getNextCSTMidnightInfo();
    res.json(timerInfo);
  } catch (e) {
    res.status(500).json({ error: "Failed to get timer info" });
  }
});

app.post("/api/config", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const body = req.body as Partial<RuntimeConfig>;
    const updates: Partial<RuntimeConfig> = {};

    if (body.riskProfile && ["low", "medium", "high", "degen"].includes(body.riskProfile)) {
      updates.riskProfile = body.riskProfile;
    }
    if (body.executionMode && ["paper", "live"].includes(body.executionMode)) {
      if (isExecutionModeLocked() && body.executionMode !== getConfig().executionMode) {
        return res.status(403).json({ 
          error: "Execution mode is locked in development environment. Deploy to production to enable live trading." 
        });
      }
      updates.executionMode = body.executionMode;
    }
    if (typeof body.loopSeconds === "number" && body.loopSeconds >= 5 && body.loopSeconds <= 3600) {
      updates.loopSeconds = Math.floor(body.loopSeconds);
    }
    if (typeof body.maxDailyDrawdownPct === "number" && body.maxDailyDrawdownPct >= 0.01 && body.maxDailyDrawdownPct <= 0.99) {
      updates.maxDailyDrawdownPct = body.maxDailyDrawdownPct;
    }
    if (typeof body.maxPositionPctPerAsset === "number" && body.maxPositionPctPerAsset >= 0.01 && body.maxPositionPctPerAsset <= 0.99) {
      updates.maxPositionPctPerAsset = body.maxPositionPctPerAsset;
    }
    if (typeof body.maxTurnoverPctPerDay === "number" && body.maxTurnoverPctPerDay >= 0.1 && body.maxTurnoverPctPerDay <= 10) {
      updates.maxTurnoverPctPerDay = body.maxTurnoverPctPerDay;
    }
    if (typeof body.takeProfitPct === "number" && body.takeProfitPct >= 0.01 && body.takeProfitPct <= 1) {
      updates.takeProfitPct = body.takeProfitPct;
    }
    if (typeof body.maxSlippageBps === "number" && body.maxSlippageBps >= 1 && body.maxSlippageBps <= 2000) {
      updates.maxSlippageBps = Math.floor(body.maxSlippageBps);
    }
    if (typeof body.maxSingleSwapSol === "number" && body.maxSingleSwapSol >= 0.01 && body.maxSingleSwapSol <= 1000) {
      updates.maxSingleSwapSol = body.maxSingleSwapSol;
    }
    if (typeof body.minTradeUsd === "number" && body.minTradeUsd >= 1 && body.minTradeUsd <= 1000000) {
      updates.minTradeUsd = body.minTradeUsd;
    }
    if (typeof body.maxPositions === "number" && body.maxPositions >= 1 && body.maxPositions <= 100) {
      updates.maxPositions = Math.floor(body.maxPositions);
    }
    if (typeof body.maxTop3ConcentrationPct === "number" && body.maxTop3ConcentrationPct >= 0.1 && body.maxTop3ConcentrationPct <= 1) {
      updates.maxTop3ConcentrationPct = body.maxTop3ConcentrationPct;
    }
    if (typeof body.maxPortfolioVolatility === "number" && body.maxPortfolioVolatility >= 0.1 && body.maxPortfolioVolatility <= 100) {
      updates.maxPortfolioVolatility = body.maxPortfolioVolatility;
    }

    if (typeof body.scannerMinLiquidity === "number" && body.scannerMinLiquidity >= 0 && body.scannerMinLiquidity <= 10000000) {
      updates.scannerMinLiquidity = body.scannerMinLiquidity;
    }
    if (typeof body.scannerMinVolume24h === "number" && body.scannerMinVolume24h >= 0 && body.scannerMinVolume24h <= 10000000) {
      updates.scannerMinVolume24h = body.scannerMinVolume24h;
    }
    if (typeof body.scannerMinHolders === "number" && body.scannerMinHolders >= 0 && body.scannerMinHolders <= 100000) {
      updates.scannerMinHolders = Math.floor(body.scannerMinHolders);
    }
    if (typeof body.scannerMaxPriceChange24h === "number" && body.scannerMaxPriceChange24h >= -100 && body.scannerMaxPriceChange24h <= 10000) {
      updates.scannerMaxPriceChange24h = body.scannerMaxPriceChange24h;
    }
    if (typeof body.scannerMinPriceChange24h === "number" && body.scannerMinPriceChange24h >= -100 && body.scannerMinPriceChange24h <= 10000) {
      updates.scannerMinPriceChange24h = body.scannerMinPriceChange24h;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid settings to update" });
    }

    logSecurityEvent('CONFIG_UPDATE', { fields: Object.keys(updates), ip: req.ip });
    
    const success = await updateConfigBatch(updates);
    if (success) {
      updateBotState({ 
        risk: getConfig().riskProfile, 
        mode: getConfig().executionMode 
      });
      res.json({ success: true, config: getConfigForApi() });
    } else {
      res.status(500).json({ error: "Failed to update some settings" });
    }
  } catch (e) {
    res.status(500).json({ error: "Failed to update config" });
  }
});

app.get("/api/settings", requireApiAuth, async (req, res) => {
  const requestId = req.headers['x-settings-request-id'] || 'no-id';
  
  try {
    // CRITICAL: Disable ALL caching to prevent stale reads in production
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    
    const config = getConfig();
    const normalized = normalizeSettings(config as Partial<Settings>);
    
    // TRACE: Log boolean values being returned
    const envContext = getEnvContext();
    logger.info({ 
      requestId,
      keys: Object.keys(normalized).length,
      booleanValues: {
        autonomousScoutsEnabled: normalized.autonomousScoutsEnabled,
        autonomousDryRun: normalized.autonomousDryRun,
        reentryEnabled: normalized.reentryEnabled
      },
      env: envContext.envName,
      dbLabel: envContext.dbLabel
    }, "GET /api/settings - returning normalized settings (cache disabled)");
    
    res.json(normalized);
  } catch (e: any) {
    logger.error({ error: e.message, requestId }, "GET /api/settings failed");
    res.status(500).json({ error: "Failed to load settings" });
  }
});

app.patch("/api/settings", strictApiLimiter, requireApiAuth, async (req, res) => {
  const requestId = req.headers['x-settings-request-id'] || 'no-id';
  
  try {
    const patch = req.body as Partial<Settings>;
    
    // TRACE: Log raw body received
    logger.info({ 
      requestId,
      patchKeys: Object.keys(patch),
      booleans: {
        autonomousScoutsEnabled: patch.autonomousScoutsEnabled,
        autonomousDryRun: patch.autonomousDryRun,
        reentryEnabled: patch.reentryEnabled
      }
    }, "PATCH /api/settings - raw body received");
    
    const current = getConfig();
    const merged = { ...current, ...patch };
    
    // TRACE: Log merged values before validation
    logger.info({
      requestId,
      mergedBooleans: {
        autonomousScoutsEnabled: merged.autonomousScoutsEnabled,
        autonomousDryRun: merged.autonomousDryRun,
        reentryEnabled: merged.reentryEnabled
      }
    }, "PATCH /api/settings - merged with current config");
    
    let validated: Settings;
    try {
      validated = normalizeSettings(merged);
    } catch (validationError: any) {
      logger.warn({ requestId, error: validationError.message, patch }, "PATCH /api/settings - validation failed");
      return res.status(400).json({ error: "Validation failed", details: validationError.message });
    }
    
    // TRACE: Log validated values
    logger.info({
      requestId,
      validatedBooleans: {
        autonomousScoutsEnabled: validated.autonomousScoutsEnabled,
        autonomousDryRun: validated.autonomousDryRun,
        reentryEnabled: validated.reentryEnabled
      }
    }, "PATCH /api/settings - after normalization");
    
    if (isExecutionModeLocked() && patch.executionMode && patch.executionMode !== current.executionMode) {
      return res.status(403).json({ 
        error: "Execution mode is locked in development environment. Deploy to production to enable live trading." 
      });
    }
    
    // CRITICAL FIX: Include ALL keys from patch, using explicit undefined check
    const updatePayload: Partial<RuntimeConfig> = {};
    for (const key of Object.keys(validated) as (keyof Settings)[]) {
      const val = validated[key];
      // Use strict undefined check - false/0/"" are valid values
      if (val !== undefined) {
        (updatePayload as any)[key] = val;
      }
    }
    
    // TRACE: Log what's being written to DB
    logger.info({
      requestId,
      payloadKeys: Object.keys(updatePayload).length,
      payloadBooleans: {
        autonomousScoutsEnabled: (updatePayload as any).autonomousScoutsEnabled,
        autonomousDryRun: (updatePayload as any).autonomousDryRun,
        reentryEnabled: (updatePayload as any).reentryEnabled
      }
    }, "PATCH /api/settings - update payload for DB");
    
    logSecurityEvent('SETTINGS_UPDATE', { fields: Object.keys(patch), ip: req.ip });
    
    const success = await updateConfigBatch(updatePayload);
    
    if (success) {
      const finalConfig = getConfig();
      const finalNormalized = normalizeSettings(finalConfig as Partial<Settings>);
      
      // TRACE: Log final values after save
      logger.info({
        requestId,
        finalBooleans: {
          autonomousScoutsEnabled: finalNormalized.autonomousScoutsEnabled,
          autonomousDryRun: finalNormalized.autonomousDryRun,
          reentryEnabled: finalNormalized.reentryEnabled
        }
      }, "PATCH /api/settings - saved successfully, final values");
      
      updateBotState({ 
        risk: finalConfig.riskProfile, 
        mode: finalConfig.executionMode 
      });
      
      res.json({ success: true, settings: finalNormalized });
    } else {
      logger.error({ requestId }, "PATCH /api/settings - updateConfigBatch returned false");
      res.status(500).json({ error: "Failed to persist settings" });
    }
  } catch (e: any) {
    logger.error({ requestId, error: e.message }, "PATCH /api/settings failed");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

app.get("/api/risk-state", requireApiAuth, async (_req, res) => {
  try {
    const { getRiskPauseState } = await import("../bot/risk.js");
    const riskState = getRiskPauseState();
    
    if (!riskState) {
      res.json({
        paused: false,
        reason: null,
        baselineType: "sod",
        baselineEquityUsd: 0,
        currentEquityUsd: 0,
        pnlUsd: 0,
        pnlPct: 0,
        thresholdPct: 5,
        turnoverUsd: 0,
        turnoverCapUsd: 0,
        day: "",
        available: false,
      });
    } else {
      res.json({
        ...riskState,
        available: true,
      });
    }
  } catch (err) {
    logger.error({ err }, "Failed to get risk state");
    res.status(500).json({ error: "Failed to get risk state" });
  }
});

app.get("/api/portfolio-risk", requireApiAuth, async (_req, res) => {
  try {
    const { getPortfolioRiskSummary, newPortfolioRisk } = await import("../bot/portfolio_risk.js");
    const positions = getLatestPositions();
    if (!positions || positions.length === 0) {
      res.json(getPortfolioRiskSummary(newPortfolioRisk()));
    } else {
      const { updatePortfolioRisk } = await import("../bot/portfolio_risk.js");
      const state = newPortfolioRisk();
      const posInfo = positions.map(p => ({
        mint: p.mint,
        amount: p.amount,
        usdValue: p.valueUsd,
      }));
      const prices: Record<string, number> = {};
      positions.forEach(p => { prices[p.mint] = p.priceUsd; });
      const updated = updatePortfolioRisk(state, posInfo, prices);
      res.json(getPortfolioRiskSummary(updated));
    }
  } catch (err) {
    res.json({ activePositions: 0, largestPositionPct: 0, top3ConcentrationPct: 0, hhi: 0, estimatedVolatility: 0, totalEquityUsd: 0 });
  }
});

app.get("/api/slot-status", requireApiAuth, async (_req, res) => {
  try {
    const { getSlotCounts, getAllPositionTracking } = await import("../bot/persist.js");
    const { getBatchPositionCostBasis } = await import("../bot/pnl_engine.js");
    const config = getConfig();
    const slotCounts = await getSlotCounts();
    const tracking = await getAllPositionTracking();
    
    const allMints = tracking.map(t => t.mint);
    const mintToSymbol = await buildSymbolMap(allMints);
    
    const costBasisMap = await getBatchPositionCostBasis(allMints);
    
    // CRITICAL FIX: Use real-time prices from telemetry instead of stale last_price from tracking
    // This ensures Rotation tab shows same prices as Overview tab
    const realTimePositions = getLatestPositions();
    const realTimePriceMap = new Map<string, { priceUsd: number; amount: number; valueUsd: number }>();
    for (const pos of realTimePositions) {
      realTimePriceMap.set(pos.mint, { 
        priceUsd: pos.priceUsd, 
        amount: pos.amount,
        valueUsd: pos.valueUsd 
      });
    }
    
    const mapPosition = (t: any) => {
      const cb = costBasisMap.get(t.mint);
      const realTime = realTimePriceMap.get(t.mint);
      
      // Use real-time price from telemetry, fallback to tracking's last_price only if unavailable
      const currentPrice = realTime?.priceUsd ?? (Number(t.last_price) || 0);
      
      // Use FIFO data when available, fallback to position_tracking data when missing
      const hasFifoData = cb && cb.totalQuantity > 0 && cb.avgCostUsd > 0;
      
      // For quantity: prefer real-time wallet balance, then FIFO, then tracking
      const quantity = realTime?.amount ?? (hasFifoData ? cb.totalQuantity : (Number(t.total_tokens) || 0));
      
      // CRITICAL FIX: When FIFO data is missing, check if tracking entry_price is stale
      // If position was entered >24h ago but FIFO is missing, the entry_price is unreliable
      // Use current price as fallback to show 0% PnL rather than misleading huge PnL
      const entryTimeMs = new Date(t.entry_time).getTime();
      const ageHours = (Date.now() - entryTimeMs) / (1000 * 60 * 60);
      const isStaleEntry = ageHours > 24 && !hasFifoData;
      
      // For entry price: prefer FIFO avgCostUsd, then fresh tracking entry_price, then current price
      let entryPrice: number;
      if (hasFifoData) {
        entryPrice = cb.avgCostUsd;
      } else if (!isStaleEntry && Number(t.entry_price) > 0) {
        entryPrice = Number(t.entry_price);
      } else {
        // Use current price when data is stale or missing - shows 0% PnL
        entryPrice = currentPrice;
      }
      
      // Calculate cost basis: prefer FIFO totalCostBasis, fallback to quantity * entryPrice
      const costBasis = hasFifoData 
        ? cb.totalCostBasis 
        : (quantity * entryPrice);
      
      // Use real-time value if available, otherwise calculate from quantity * price
      const currentValue = realTime?.valueUsd ?? (quantity * currentPrice);
      const pnlUsd = currentValue - costBasis;
      
      // Calculate PnL% - use cost basis when available, otherwise use entry price
      const pnlPct = costBasis > 0 
        ? (pnlUsd / costBasis) * 100 
        : (entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0);
      
      return {
        mint: t.mint,
        symbol: mintToSymbol.get(t.mint) || t.mint.slice(0, 6),
        entryTime: t.entry_time,
        entryPrice,
        currentPrice,
        peakPrice: Number(t.peak_price),
        pnlPct,
        pnlUsd,
        costBasis,
        currentValue,
        quantity,
        hoursHeld: (Date.now() - new Date(t.entry_time).getTime()) / (1000 * 60 * 60),
        fifoDataMissing: !hasFifoData,
        staleEntryData: isStaleEntry,
      };
    };
    
    const corePositions = tracking.filter(t => t.slot_type === 'core' && (t as any).source !== 'sniper').map(mapPosition);
    const scoutPositions = tracking.filter(t => t.slot_type === 'scout' && (t as any).source !== 'sniper').map(mapPosition);
    
    res.json({
      slotConfig: {
        coreSlots: config.coreSlots,
        scoutSlots: config.scoutSlots,
        corePositionPctTarget: config.corePositionPctTarget,
        scoutPositionPct: config.scoutPositionPct,
      },
      slotCounts,
      corePositions,
      scoutPositions,
      staleThresholdHours: config.stalePositionHours,
      staleExitHours: config.staleExitHours,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get slot status" });
  }
});

app.get("/api/position-data-integrity", requireApiAuth, async (_req, res) => {
  try {
    const { checkPositionDataIntegrity } = await import("../bot/pnl_engine.js");
    const result = await checkPositionDataIntegrity();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to check position data integrity" });
  }
});

app.get("/api/rotation-log", requireApiAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const rows = await q<{
      id: number;
      ts: Date;
      action: string;
      sold_mint: string | null;
      sold_symbol: string | null;
      bought_mint: string | null;
      bought_symbol: string | null;
      reason_code: string;
      sold_rank: number | null;
      bought_rank: number | null;
      rank_delta: number | null;
      meta: any;
    }>(
      `SELECT * FROM rotation_log ORDER BY ts DESC LIMIT $1`,
      [limit]
    );
    
    const allMints: string[] = [];
    for (const row of rows) {
      if (row.sold_mint) allMints.push(row.sold_mint);
      if (row.bought_mint) allMints.push(row.bought_mint);
    }
    const mintToSymbol = await buildSymbolMap(allMints);
    
    const enrichedRows = rows.map(row => ({
      ...row,
      sold_symbol: row.sold_symbol || (row.sold_mint ? mintToSymbol.get(row.sold_mint) || row.sold_mint.slice(0, 6) : null),
      bought_symbol: row.bought_symbol || (row.bought_mint ? mintToSymbol.get(row.bought_mint) || row.bought_mint.slice(0, 6) : null),
    }));
    
    res.json(enrichedRows);
  } catch (err) {
    res.status(500).json({ error: "Failed to get rotation log" });
  }
});

app.get("/api/weekly-report", requireApiAuth, async (req, res) => {
  try {
    const { generateWeeklyReport, formatWeeklyReport } = await import("../bot/reports.js");
    const startStr = req.query.start as string;
    const endStr = req.query.end as string;
    
    const startDate = startStr ? new Date(startStr) : undefined;
    const endDate = endStr ? new Date(endStr) : undefined;
    
    const report = await generateWeeklyReport(startDate, endDate);
    const formatted = formatWeeklyReport(report);
    
    res.json({ report, formatted });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate weekly report" });
  }
});

const botStartTime = Date.now();
let lastTickTime = 0;

export function recordTickTime() {
  lastTickTime = Date.now();
}

app.get("/api/health", requireApiAuth, async (_req, res) => {
  const uptime = Date.now() - botStartTime;
  const uptimeHours = (uptime / 3600000).toFixed(2);
  const lastTickAgo = lastTickTime > 0 ? Date.now() - lastTickTime : null;
  
  res.json({
    status: botState.paused ? "paused" : "running",
    pauseReason: botState.pauseReason,
    startedAt: new Date(botStartTime).toISOString(),
    uptimeHours: parseFloat(uptimeHours),
    lastTickAt: lastTickTime > 0 ? new Date(lastTickTime).toISOString() : null,
    lastTickAgoMs: lastTickAgo,
    walletAddress: botState.wallet ?? null,
    riskProfile: botState.risk,
    executionMode: botState.mode,
  });
});

app.get("/api/admin/scout-queue", requireApiAuth, async (_req, res) => {
  try {
    const [stats, queue] = await Promise.all([
      getScoutQueueStats(),
      getScoutQueue(),
    ]);
    
    const formattedQueue = queue.map(item => ({
      mint: item.mint,
      symbol: item.symbol ?? item.mint.slice(0, 6),
      score: item.score,
      status: item.status ?? 'QUEUED',
      discovered_at: item.discovered_at ? new Date(item.discovered_at).toISOString() : null,
      queued_at: item.queued_at ? new Date(item.queued_at).toISOString() : null,
      last_error: item.last_error ?? undefined,
      buy_attempts: item.buy_attempts ?? 0,
    }));
    
    res.json({
      stats: {
        queued: stats['QUEUED'] ?? 0,
        buying: stats['BUYING'] ?? 0,
        bought: stats['BOUGHT'] ?? 0,
        skipped: stats['SKIPPED'] ?? 0,
        failed: stats['FAILED'] ?? 0,
      },
      queue: formattedQueue,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get scout queue");
    res.status(500).json({ error: "Failed to get scout queue" });
  }
});

app.get("/api/admin/autonomous-status", requireApiAuth, async (_req, res) => {
  try {
    const config = getConfig();
    const [todayBought, slotCounts] = await Promise.all([
      countTodayScoutEntries(),
      getSlotCounts(),
    ]);
    
    res.json({
      config: {
        enabled: config.autonomousScoutsEnabled,
        dryRun: config.autonomousDryRun,
        autoQueueScore: config.scoutAutoQueueScore,
        buySol: config.scoutBuySol,
        minSolReserve: config.minSolReserve,
        tokenCooldownHours: config.scoutTokenCooldownHours,
        dailyLimit: config.scoutDailyLimit,
        queuePollSeconds: config.scoutQueuePollSeconds,
      },
      today: {
        bought: todayBought,
        limit: config.scoutDailyLimit,
      },
      slots: {
        scout: slotCounts.scout,
        core: slotCounts.core,
        maxScout: config.scoutSlots,
        maxCore: config.coreSlots,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to get autonomous status");
    res.status(500).json({ error: "Failed to get autonomous status" });
  }
});

function jsonToCsv(data: any[]): string {
  if (!data || data.length === 0) return '';
  const headers = Object.keys(data[0]);
  const rows = data.map(row => 
    headers.map(h => {
      const val = row[h];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val).replace(/"/g, '""');
      return String(val).replace(/"/g, '""');
    }).map(v => `"${v}"`).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

app.get("/api/export/trades", requireApiAuth, async (req, res) => {
  try {
    const { start, end, format, enriched } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    
    const trades = enriched === 'true' 
      ? await loadEnrichedTradesForExport(startDate, endDate)
      : await loadTradesForExport(startDate, endDate);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="trades_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
      res.send(jsonToCsv(trades));
    } else {
      res.json({ count: trades.length, startDate, endDate, enriched: enriched === 'true', trades });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to export trades" });
  }
});

app.get("/api/export/telemetry", requireApiAuth, async (req, res) => {
  try {
    const { start, end, format, limit } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    const maxRows = Math.min(parseInt(limit as string) || 10000, 50000);
    
    const telemetry = await loadTickTelemetry(startDate, endDate, maxRows);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="telemetry_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
      res.send(jsonToCsv(telemetry));
    } else {
      res.json({ count: telemetry.length, startDate, endDate, telemetry });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to export telemetry" });
  }
});

app.get("/api/export/config-history", requireApiAuth, async (req, res) => {
  try {
    const { start, end, format, snapshots } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    
    const history = snapshots === 'true'
      ? await loadConfigSnapshotsForExport(startDate, endDate)
      : await loadConfigHistory(startDate, endDate);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="config_history_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
      res.send(jsonToCsv(history));
    } else {
      res.json({ count: history.length, startDate, endDate, snapshots: snapshots === 'true', history });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to export config history" });
  }
});

app.get("/api/export/prices", requireApiAuth, async (req, res) => {
  try {
    const { start, end, format, mints } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    const mintList = mints ? (mints as string).split(',') : undefined;
    
    const prices = await loadPricesForExport(startDate, endDate, mintList);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="prices_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
      res.send(jsonToCsv(prices));
    } else {
      res.json({ count: prices.length, startDate, endDate, prices });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to export prices" });
  }
});

app.get("/api/export/equity", requireApiAuth, async (req, res) => {
  try {
    const { start, end, format } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    
    const equity = await loadEquityForExport(startDate, endDate);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="equity_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
      res.send(jsonToCsv(equity));
    } else {
      res.json({ count: equity.length, startDate, endDate, equity });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to export equity" });
  }
});

app.get("/api/export/all", requireApiAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    
    const [trades, telemetry, configHistory, prices, equity] = await Promise.all([
      loadTradesForExport(startDate, endDate),
      loadTickTelemetry(startDate, endDate, 10000),
      loadConfigHistory(startDate, endDate),
      loadPricesForExport(startDate, endDate),
      loadEquityForExport(startDate, endDate),
    ]);
    
    res.json({
      exportDate: new Date().toISOString(),
      dateRange: { start: startDate, end: endDate },
      summary: {
        tradesCount: trades.length,
        telemetryCount: telemetry.length,
        configChangesCount: configHistory.length,
        pricesCount: prices.length,
        equitySnapshotsCount: equity.length,
      },
      trades,
      telemetry,
      configHistory,
      prices,
      equity,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to export data" });
  }
});

app.get("/api/export/analysis-bundle", requireApiAuth, async (req, res) => {
  try {
    const { start, end, priceWindow } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    const priceWindowMinutes = parseInt(priceWindow as string) || 30;
    
    const bundle = await loadAnalysisBundleForExport(startDate, endDate, priceWindowMinutes);
    
    res.json(bundle);
  } catch (err: any) {
    logger.error({ err: err?.message }, "Failed to export analysis bundle");
    res.status(500).json({ error: "Failed to export analysis bundle" });
  }
});

app.get("/api/export/lite", requireApiAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    
    const filename = `export_lite_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.zip`;
    
    logger.info({ startDate, endDate }, "Starting export lite request");
    
    const { buffer, fileCount, totalRows } = await createExportLiteZip(startDate, endDate);
    
    logger.info({ fileCount, totalRows, bufferSize: buffer.length, startDate, endDate }, "Export lite completed successfully");
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err: any) {
    logger.error({ err: err?.message, stack: err?.stack }, "Failed to create export lite zip");
    res.status(500).json({ error: `Failed to export lite data: ${err?.message || 'Unknown error'}` });
  }
});

app.get("/api/export/trades-with-context", requireApiAuth, async (req, res) => {
  try {
    const { start, end, priceWindow, format } = req.query;
    const startDate = start ? new Date(start as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();
    const priceWindowMinutes = parseInt(priceWindow as string) || 60;
    
    const trades = await loadTradesWithPriceContext(startDate, endDate, priceWindowMinutes);
    
    if (format === 'csv') {
      const flatTrades = trades.map(t => ({
        ...t.trade,
        mint: t.mint,
        symbol: t.symbol,
        side: t.side,
        priceAtTrade: t.priceAtTrade,
        priceHistoryCount: t.priceHistory.length,
        priceWindowMinutes: t.priceWindowMinutes,
      }));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="trades_with_context_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv"`);
      res.send(jsonToCsv(flatTrades));
    } else {
      res.json({ 
        count: trades.length, 
        startDate, 
        endDate, 
        priceWindowMinutes,
        trades 
      });
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "Failed to export trades with context");
    res.status(500).json({ error: "Failed to export trades with context" });
  }
});

app.get("/api/universe", requireApiAuth, async (_req, res) => {
  try {
    const { getUniverse } = await import("../bot/universe.js");
    const universe = await getUniverse();
    res.json(universe);
  } catch (err) {
    res.json([]);
  }
});

app.post("/api/universe/add", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { mint, symbol, name, source } = req.body;
    
    if (!mint || typeof mint !== 'string' || mint.length < 32 || mint.length > 64) {
      return res.status(400).json({ success: false, error: "Invalid mint address" });
    }
    if (!/^[A-Za-z0-9]+$/.test(mint)) {
      return res.status(400).json({ success: false, error: "Invalid mint address format" });
    }
    if (!symbol || typeof symbol !== 'string' || symbol.length < 1 || symbol.length > 20) {
      return res.status(400).json({ success: false, error: "Invalid symbol" });
    }
    const sanitizedSymbol = symbol.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    const sanitizedName = name ? String(name).slice(0, 100) : sanitizedSymbol;
    const sanitizedSource = ['scanner', 'manual', 'default'].includes(source) ? source : 'manual';
    
    logSecurityEvent('UNIVERSE_ADD', { mint, symbol: sanitizedSymbol });
    
    const { addToUniverse } = await import("../bot/universe.js");
    const success = await addToUniverse(mint, sanitizedSymbol, sanitizedName, sanitizedSource);
    
    // If manualScoutBuyEnabled, trigger immediate scout buy
    const config = getConfig();
    let scoutBuyResult = null;
    if (success && config.manualScoutBuyEnabled) {
      try {
        const { executeManualScoutBuy } = await import("../bot/scout_auto.js");
        scoutBuyResult = await executeManualScoutBuy(mint, sanitizedSymbol, sanitizedName);
        logger.info({ mint, symbol: sanitizedSymbol, result: scoutBuyResult }, "Manual scout buy triggered");
      } catch (buyErr) {
        logger.warn({ mint, symbol: sanitizedSymbol, error: String(buyErr) }, "Manual scout buy failed");
        scoutBuyResult = { status: 'error', error: String(buyErr) };
      }
    }
    
    res.json({ success, mint, symbol: sanitizedSymbol, scoutBuy: scoutBuyResult });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to add to universe" });
  }
});

app.delete("/api/universe/:mint", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { mint } = req.params;
    
    if (!mint || typeof mint !== 'string' || mint.length < 32 || mint.length > 64) {
      return res.status(400).json({ success: false, error: "Invalid mint address" });
    }
    if (!/^[A-Za-z0-9]+$/.test(mint)) {
      return res.status(400).json({ success: false, error: "Invalid mint address format" });
    }
    
    logSecurityEvent('UNIVERSE_REMOVE', { mint });
    
    const { removeFromUniverse } = await import("../bot/universe.js");
    const success = await removeFromUniverse(mint);
    if (!success) {
      return res.status(400).json({ success: false, error: "Cannot remove default tokens (SOL/USDC)" });
    }
    res.json({ success: true, mint });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to remove from universe" });
  }
});

app.get("/api/opportunities-history", requireApiAuth, async (_req, res) => {
  try {
    const { loadRecentOpportunities } = await import("../bot/persist.js");
    const opportunities = await loadRecentOpportunities(100);
    res.json(opportunities);
  } catch (err) {
    res.json([]);
  }
});

app.get("/api/trending-history", requireApiAuth, async (_req, res) => {
  try {
    const { loadRecentTrending } = await import("../bot/persist.js");
    const trending = await loadRecentTrending(100);
    res.json(trending);
  } catch (err) {
    res.json([]);
  }
});

app.get("/api/token-metrics/:mint", requireApiAuth, async (req, res) => {
  try {
    const { loadTokenMetricsHistory } = await import("../bot/persist.js");
    const metrics = await loadTokenMetricsHistory(req.params.mint, 100);
    res.json(metrics);
  } catch (err) {
    res.json([]);
  }
});

app.get("/api/db-stats", requireApiAuth, async (_req, res) => {
  try {
    const counts = await q(`
      SELECT 
        (SELECT COUNT(*) FROM prices) as prices,
        (SELECT COUNT(*) FROM bot_trades) as trades,
        (SELECT COUNT(*) FROM equity_snapshots) as equity_snapshots,
        (SELECT COUNT(*) FROM scanner_opportunities) as opportunities,
        (SELECT COUNT(*) FROM token_metrics) as token_metrics,
        (SELECT COUNT(*) FROM trending_tokens) as trending
    `);
    res.json(counts[0] ?? {});
  } catch (err) {
    res.json({ error: "Failed to get stats" });
  }
});

app.get("/api/risk-profiles", requireApiAuth, async (_req, res) => {
  try {
    const { getAllRiskProfiles, loadRiskProfiles } = await import("../bot/risk_profiles.js");
    await loadRiskProfiles();
    const profiles = getAllRiskProfiles();
    res.json(profiles);
  } catch (err) {
    console.error("Failed to get risk profiles:", err);
    res.status(500).json({ error: "Failed to get risk profiles" });
  }
});

app.get("/api/risk-profiles/:name", requireApiAuth, async (req, res) => {
  try {
    const { getRiskProfile, loadRiskProfiles } = await import("../bot/risk_profiles.js");
    await loadRiskProfiles();
    const profile = getRiskProfile(req.params.name);
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }
    res.json(profile);
  } catch (err) {
    console.error("Failed to get risk profile:", err);
    res.status(500).json({ error: "Failed to get risk profile" });
  }
});

app.put("/api/risk-profiles/:name", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { upsertRiskProfile, loadRiskProfileByName } = await import("../bot/persist.js");
    const { reloadRiskProfiles } = await import("../bot/risk_profiles.js");
    const name = req.params.name;
    const body = req.body;
    
    const existing = await loadRiskProfileByName(name);
    if (!existing) {
      return res.status(404).json({ error: "Profile not found" });
    }
    
    const profile = {
      name,
      maxPositionPctPerAsset: body.maxPositionPctPerAsset ?? Number(existing.max_pos_pct),
      maxDailyDrawdownPct: body.maxDailyDrawdownPct ?? Number(existing.max_drawdown),
      entryZ: body.entryZ ?? Number(existing.entry_z),
      takeProfitPct: body.takeProfitPct ?? Number(existing.take_profit_pct),
      stopLossPct: body.stopLossPct ?? Number(existing.stop_loss_pct),
      maxTurnoverPctPerDay: body.maxTurnoverPctPerDay ?? Number(existing.max_turnover),
      slippageBps: body.slippageBps ?? Number(existing.slippage_bps),
      maxSingleSwapSol: body.maxSingleSwapSol ?? Number(existing.max_single_swap_sol),
      minTradeUsd: body.minTradeUsd ?? Number(existing.min_trade_usd),
      cooldownSeconds: body.cooldownSeconds ?? Number(existing.cooldown_seconds),
      isDefault: existing.is_default,
    };
    
    const success = await upsertRiskProfile(profile);
    if (success) {
      await reloadRiskProfiles();
      res.json({ success: true, profile });
    } else {
      res.status(500).json({ error: "Failed to update profile" });
    }
  } catch (err) {
    console.error("Failed to update risk profile:", err);
    res.status(500).json({ error: "Failed to update risk profile" });
  }
});

app.post("/api/risk-profiles", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { upsertRiskProfile, loadRiskProfileByName } = await import("../bot/persist.js");
    const { reloadRiskProfiles } = await import("../bot/risk_profiles.js");
    const body = req.body;
    
    if (!body.name || body.name.trim() === "") {
      return res.status(400).json({ error: "Profile name is required" });
    }
    
    const existing = await loadRiskProfileByName(body.name);
    if (existing) {
      return res.status(400).json({ error: "Profile with this name already exists" });
    }
    
    const profile = {
      name: body.name.trim().toLowerCase(),
      maxPositionPctPerAsset: body.maxPositionPctPerAsset ?? 0.25,
      maxDailyDrawdownPct: body.maxDailyDrawdownPct ?? 0.03,
      entryZ: body.entryZ ?? 1.0,
      takeProfitPct: body.takeProfitPct ?? 0.05,
      stopLossPct: body.stopLossPct ?? 0.03,
      maxTurnoverPctPerDay: body.maxTurnoverPctPerDay ?? 1.0,
      slippageBps: body.slippageBps ?? 80,
      maxSingleSwapSol: body.maxSingleSwapSol ?? 1.5,
      minTradeUsd: body.minTradeUsd ?? 25,
      cooldownSeconds: body.cooldownSeconds ?? 600,
      isDefault: false,
    };
    
    const success = await upsertRiskProfile(profile);
    if (success) {
      await reloadRiskProfiles();
      res.json({ success: true, profile });
    } else {
      res.status(500).json({ error: "Failed to create profile" });
    }
  } catch (err) {
    console.error("Failed to create risk profile:", err);
    res.status(500).json({ error: "Failed to create risk profile" });
  }
});

app.delete("/api/risk-profiles/:name", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { deleteRiskProfile } = await import("../bot/persist.js");
    const { reloadRiskProfiles } = await import("../bot/risk_profiles.js");
    const name = req.params.name;
    
    const result = await deleteRiskProfile(name);
    if (result.success) {
      await reloadRiskProfiles();
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error("Failed to delete risk profile:", err);
    res.status(500).json({ error: "Failed to delete risk profile" });
  }
});

// Reset Portfolio - Preview what will be sold
app.get("/api/reset-preview", requireApiAuth, async (_req, res) => {
  try {
    // Use positions from the dashboard state
    const positions = getLatestPositions();
    const config = getConfig();
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const PRESERVED_MINTS = [SOL_MINT, USDC_MINT];
    const DUST_THRESHOLD_USD = config.dustThresholdUsd || 0.50;
    
    // Filter to meaningful positions: non-SOL/USDC with value above dust threshold
    const tokensToSell = positions
      .filter((p: any) => !PRESERVED_MINTS.includes(p.mint) && p.amount > 0 && (p.valueUsd ?? 0) >= DUST_THRESHOLD_USD)
      .map((p: any) => ({
        mint: p.mint,
        symbol: p.symbol || p.mint.slice(0, 8),
        slotType: p.slotType || 'unknown',
        amount: p.amount,
        valueUsd: p.valueUsd || 0
      }));
    
    // Count queue items
    const queueCount = await q(`SELECT COUNT(*) as cnt FROM scout_queue WHERE status = 'pending'`);
    const universeCount = await q(`SELECT COUNT(*) as cnt FROM trading_universe WHERE active = true AND mint NOT IN ($1, $2)`, [SOL_MINT, USDC_MINT]);
    
    res.json({
      tokensToSell,
      queueCount: Number(queueCount[0]?.cnt || 0),
      universeCount: Number(universeCount[0]?.cnt || 0)
    });
  } catch (err) {
    console.error("Failed to generate reset preview:", err);
    res.status(500).json({ error: "Failed to generate preview" });
  }
});

// Reset Portfolio - Execute the reset
app.post("/api/reset-portfolio", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { confirmation, forceCleanup } = req.body;
    if (confirmation !== "RESET") {
      return res.status(400).json({ success: false, error: "Invalid confirmation" });
    }
    
    const cleanupOnly = forceCleanup === true;
    logSecurityEvent('RESET_PORTFOLIO', { timestamp: new Date().toISOString(), cleanupOnly });
    logger.warn({ action: 'reset_portfolio', cleanupOnly }, cleanupOnly ? "Executing cleanup-only reset" : "Executing portfolio reset");
    
    const config = getConfig();
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const PRESERVED_MINTS = [SOL_MINT, USDC_MINT];
    
    const results: any[] = [];
    
    // Only run sell loop if not cleanup-only mode
    if (!cleanupOnly) {
      const { loadKeypair } = await import("../bot/solana.js");
      const { executeSwap, uiToBaseUnits } = await import("../bot/execution.js");
      const { getRiskProfile } = await import("../bot/risk_profiles.js");
      const { insertTrade } = await import("../bot/persist.js");
      
      const signer = loadKeypair();
      const rp = getRiskProfile(config.riskProfile);
      const execMode = config.executionMode;
      
      if (!rp) {
        return res.status(500).json({ success: false, error: "Risk profile not found" });
      }
      
      // Use tracked positions (same as preview) - NOT getAllTokenAccounts which includes 100s of dust tokens
      // This ensures preview and execute match, and we don't waste API calls on worthless dust
      const positions = getLatestPositions();
      const DUST_THRESHOLD_USD = config.dustThresholdUsd || 0.50; // Skip tokens worth less than this
      
      // Filter to meaningful positions: non-SOL/USDC with value above dust threshold
      const tokensToSell = positions.filter((p: any) => 
        !PRESERVED_MINTS.includes(p.mint) && 
        p.amount > 0 && 
        (p.valueUsd ?? 0) >= DUST_THRESHOLD_USD
      );
      
      logger.info({ 
        totalPositions: positions.length, 
        toSell: tokensToSell.length,
        dustThreshold: DUST_THRESHOLD_USD 
      }, "Reset: filtered positions for selling");
      
      // Sell tracked positions only
      for (const pos of tokensToSell) {
        const mint = pos.mint;
        const symbol = pos.symbol || mint.slice(0, 8);
      
      try {
        // Get decimals from chain for accurate conversion
        const { getAuthoritativeDecimals } = await import("../bot/execution.js");
        const tokenDecimals = await getAuthoritativeDecimals(mint);
        const baseUnits = uiToBaseUnits(pos.amount, tokenDecimals);
        
        logger.info({ mint, symbol, amount: pos.amount, valueUsd: pos.valueUsd, decimals: tokenDecimals }, "Reset: selling token");
        
        const result = await executeSwap({
          strategy: "reset_portfolio",
          inputMint: mint,
          outputMint: SOL_MINT,
          inAmountBaseUnits: baseUnits,
          slippageBps: Math.min(config.maxSlippageBps, rp.slippageBps),
          meta: { reset_portfolio: true },
        }, signer, execMode);
        
        if (result.status === "sent" || result.status === "paper") {
          const { buildTradeAnalytics } = await import("../bot/trade_analytics.js");
          const { TRADE_REASONS } = await import("../bot/trade_reasons.js");
          const resetAnalytics = buildTradeAnalytics({
            reason: TRADE_REASONS.SELL_EXIT_OTHER,
            quote: result.quote,
            riskProfile: rp.name,
          });

          await insertTrade({
            strategy: "reset_portfolio",
            risk_profile: rp.name,
            mode: execMode,
            input_mint: mint,
            output_mint: SOL_MINT,
            in_amount: baseUnits,
            out_amount: result.quote?.outAmount || "0",
            est_out_amount: result.quote?.outAmount || "0",
            price_impact_pct: result.quote?.priceImpactPct || "0",
            slippage_bps: result.quote?.slippageBps || 0,
            tx_sig: result.txSig,
            status: result.status,
            meta: { reset_portfolio: true },
            pnl_usd: 0,
            reason_code: resetAnalytics.reason_code,
            fees_lamports: resetAnalytics.fees_lamports,
            priority_fee_lamports: resetAnalytics.priority_fee_lamports,
            route: resetAnalytics.route,
            settings_snapshot: resetAnalytics.settings_snapshot,
          });
          results.push({ mint, symbol, status: result.status, txSig: result.txSig });
        } else {
          results.push({ mint, symbol, status: 'error', error: result.error });
        }
        } catch (sellErr) {
          results.push({ mint, symbol, status: 'error', error: String(sellErr) });
          logger.error({ mint, symbol, error: String(sellErr) }, "Failed to sell token during reset");
        }
      }
    } // End of if (!cleanupOnly) block
    
    // Cleanup with individual error handling - each table gets its own try/catch
    // so one failure doesn't prevent the others from running
    const cleanupResults: Record<string, { success: boolean; rowCount?: number; error?: string }> = {};
    
    // Helper to run cleanup with error handling
    async function cleanupTable(name: string, query: string, params: any[] = []): Promise<void> {
      try {
        const result = await q(query, params);
        const rowCount = Array.isArray(result) ? result.length : 0;
        cleanupResults[name] = { success: true, rowCount };
        logger.info({ table: name, rowCount }, `Reset: cleared ${name}`);
      } catch (err) {
        cleanupResults[name] = { success: false, error: String(err) };
        logger.error({ table: name, error: String(err) }, `Reset: failed to clear ${name}`);
      }
    }
    
    // Run all cleanups - each one runs even if previous ones fail
    // This is a COMPLETE clean slate - clears all non-essential data while preserving:
    // - bot_settings (runtime configuration)
    // - risk_profiles (risk management configurations)
    // - bot_runtime_status (pause state, execution mode - only reset heartbeat)
    // - trading_universe SOL/USDC defaults
    
    // === TRADING UNIVERSE ===
    await cleanupTable('trading_universe', 
      `UPDATE trading_universe SET active = false WHERE mint NOT IN ($1, $2)`, 
      [SOL_MINT, USDC_MINT]);
    
    // === SCOUT & QUEUE DATA ===
    await cleanupTable('scout_queue', `DELETE FROM scout_queue`);
    
    // === PNL & POSITION TRACKING ===
    await cleanupTable('pnl_events', `DELETE FROM pnl_events`);
    await cleanupTable('position_tracking', `DELETE FROM position_tracking`);
    await cleanupTable('position_lots', `DELETE FROM position_lots`);
    await cleanupTable('trade_lots', `DELETE FROM trade_lots`);
    await cleanupTable('daily_position_snapshots', `DELETE FROM daily_position_snapshots`);
    
    // === TRADE HISTORY ===
    await cleanupTable('trades', `DELETE FROM trades`);
    await cleanupTable('bot_trades', `DELETE FROM bot_trades`);
    await cleanupTable('reconciled_trades', `DELETE FROM reconciled_trades`);
    
    // === PORTFOLIO SNAPSHOTS ===
    await cleanupTable('equity_snapshots', `DELETE FROM equity_snapshots`);
    
    // === PRICE & MARKET DATA (can get very large) ===
    await cleanupTable('prices', `DELETE FROM prices`);
    await cleanupTable('features', `DELETE FROM features`);
    await cleanupTable('token_metrics', `DELETE FROM token_metrics`);
    await cleanupTable('trending_tokens', `DELETE FROM trending_tokens`);
    await cleanupTable('scanner_opportunities', `DELETE FROM scanner_opportunities`);
    
    // === TELEMETRY & LOGS ===
    await cleanupTable('bot_tick_telemetry', `DELETE FROM bot_tick_telemetry`);
    await cleanupTable('rotation_log', `DELETE FROM rotation_log`);
    await cleanupTable('weekly_reports', `DELETE FROM weekly_reports`);
    await cleanupTable('wallet_transfers', `DELETE FROM wallet_transfers`);
    await cleanupTable('bot_config_history', `DELETE FROM bot_config_history`);
    
    // Reset bot circuit state (turnover, pause triggers)
    try {
      const { resetBotCircuit } = await import("../bot/index.js");
      const circuitResult = resetBotCircuit();
      cleanupResults['bot_circuit'] = { success: circuitResult.success, rowCount: 0 };
      logger.info({ circuitReset: circuitResult.message }, "Reset: bot circuit state cleared");
    } catch (circuitErr) {
      cleanupResults['bot_circuit'] = { success: false, error: String(circuitErr) };
      logger.warn({ error: String(circuitErr) }, "Reset: failed to reset bot circuit");
    }
    
    // Check if any cleanup failed
    const failedCleanups = Object.entries(cleanupResults)
      .filter(([_, r]) => !r.success)
      .map(([name, r]) => `${name}: ${r.error}`);
    
    const allCleanupsSucceeded = failedCleanups.length === 0;
    
    logger.info({ 
      tokensSold: results.length, 
      successCount: results.filter(r => r.status === 'sent' || r.status === 'paper').length,
      cleanupResults,
      allCleanupsSucceeded
    }, "Portfolio reset complete");
    
    res.json({ 
      success: true, 
      cleanupOnly,
      results,
      cleared: cleanupResults,
      allCleanupsSucceeded,
      failedCleanups: failedCleanups.length > 0 ? failedCleanups : undefined
    });
  } catch (err) {
    console.error("Failed to execute reset:", err);
    logger.error({ error: String(err) }, "Portfolio reset failed");
    res.status(500).json({ success: false, error: "Reset failed: " + String(err) });
  }
});

// Prune Historical Data - Preview what will be deleted
app.get("/api/prune-preview", requireApiAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 7));
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const [telemetry, equity, prices, features] = await Promise.all([
      q<{ cnt: string }>(`SELECT COUNT(*) as cnt FROM bot_tick_telemetry WHERE ts < $1`, [cutoffDate.toISOString()]),
      q<{ cnt: string }>(`SELECT COUNT(*) as cnt FROM equity_snapshots WHERE ts < $1`, [cutoffDate.toISOString()]),
      q<{ cnt: string }>(`SELECT COUNT(*) as cnt FROM prices WHERE ts < $1`, [cutoffDate.toISOString()]),
      q<{ cnt: string }>(`SELECT COUNT(*) as cnt FROM features WHERE ts < $1`, [cutoffDate.toISOString()]),
    ]);
    
    const telemetryCount = Number(telemetry[0]?.cnt || 0);
    const equityCount = Number(equity[0]?.cnt || 0);
    const pricesCount = Number(prices[0]?.cnt || 0);
    const featuresCount = Number(features[0]?.cnt || 0);
    
    const telemetrySizeEst = telemetryCount * 24; // ~24KB per row
    const equitySizeEst = equityCount * 20; // ~20KB per row
    const pricesSizeEst = pricesCount * 0.25; // ~250 bytes per row
    const featuresSizeEst = featuresCount * 0.5; // ~500 bytes per row
    
    const formatSize = (kb: number) => kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
    const totalKb = telemetrySizeEst + equitySizeEst + pricesSizeEst + featuresSizeEst;
    
    res.json({
      days,
      cutoffDate,
      telemetry: { count: telemetryCount, size: formatSize(telemetrySizeEst) },
      equity: { count: equityCount, size: formatSize(equitySizeEst) },
      prices: { count: pricesCount, size: formatSize(pricesSizeEst) },
      features: { count: featuresCount, size: formatSize(featuresSizeEst) },
      totalSize: formatSize(totalKb)
    });
  } catch (err) {
    console.error("Failed to generate prune preview:", err);
    res.status(500).json({ error: "Failed to generate preview" });
  }
});

// Prune Historical Data - Execute the prune
app.post("/api/prune-history", strictApiLimiter, requireApiAuth, async (req, res) => {
  try {
    const { days, confirmation } = req.body;
    if (confirmation !== "PRUNE") {
      return res.status(400).json({ success: false, error: "Invalid confirmation" });
    }
    
    const retainDays = Math.max(1, Math.min(365, parseInt(days) || 7));
    const cutoffDate = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
    
    logSecurityEvent('PRUNE_HISTORY', { days: retainDays, cutoffDate: cutoffDate.toISOString() });
    logger.warn({ action: 'prune_history', days: retainDays, cutoff: cutoffDate.toISOString() }, "Executing historical data prune");
    
    const deleted: Record<string, number> = {};
    
    // Delete old telemetry
    const telResult = await q(`DELETE FROM bot_tick_telemetry WHERE ts < $1`, [cutoffDate.toISOString()]);
    deleted.telemetry = Array.isArray(telResult) ? telResult.length : 0;
    
    // Delete old equity snapshots
    const eqResult = await q(`DELETE FROM equity_snapshots WHERE ts < $1`, [cutoffDate.toISOString()]);
    deleted.equity = Array.isArray(eqResult) ? eqResult.length : 0;
    
    // Delete old prices
    const prResult = await q(`DELETE FROM prices WHERE ts < $1`, [cutoffDate.toISOString()]);
    deleted.prices = Array.isArray(prResult) ? prResult.length : 0;
    
    // Delete old features
    const feResult = await q(`DELETE FROM features WHERE ts < $1`, [cutoffDate.toISOString()]);
    deleted.features = Array.isArray(feResult) ? feResult.length : 0;
    
    // Also clean up old scanner data and trending tokens
    await q(`DELETE FROM scanner_opportunities WHERE ts < $1`, [cutoffDate.toISOString()]);
    await q(`DELETE FROM trending_tokens WHERE ts < $1`, [cutoffDate.toISOString()]);
    
    logger.info({ deleted, retainDays }, "Historical data prune complete");
    
    res.json({ 
      success: true, 
      deleted,
      retainDays,
      cutoffDate,
      note: "Run VACUUM in database console to reclaim disk space"
    });
  } catch (err) {
    console.error("Failed to prune history:", err);
    logger.error({ error: String(err) }, "Prune history failed");
    res.status(500).json({ success: false, error: "Prune failed: " + String(err) });
  }
});

initializeDatabase().then(() => {
  return initRuntimeConfig();
}).then(() => {
  initBotStateFromConfig();
  server.listen(5000, "0.0.0.0", () => {
    console.log(`Dashboard listening on http://0.0.0.0:5000`);
  });
}).catch((e) => {
  console.error("Failed to init:", e);
  server.listen(5000, "0.0.0.0", () => {
    console.log(`Dashboard listening on http://0.0.0.0:5000 (init failed)`);
  });
});
