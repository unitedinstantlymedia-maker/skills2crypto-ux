import express from "express";
import http from "http";
import cors from "cors";

import { registerRoutes } from "./routes";
import { setupVite } from "./vite";
import { setupSocket, markMatchFunded } from "./socket";
import { startChallengeCleanup } from "./matchmaking/challengeCleanup";
import { redis } from "./redis";
import { initSystemAddresses } from "./security/systemAddresses";

async function resolveAppMatchId(matchIdBytes32: string): Promise<string | null> {
  try {
    const v = await redis.get(`match_by_hash:${matchIdBytes32.toLowerCase()}`);
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

const PORT = Number(process.env.PORT ?? 5000);
const NODE_ENV = process.env.NODE_ENV ?? "development";
const isProd = NODE_ENV === "production";

// Parse allowed origins from env
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// =======================
// APP SETUP
// =======================
const app = express();
const httpServer = http.createServer(app);
const io = setupSocket(httpServer, { isProd, allowedOrigins });

startChallengeCleanup(io);

// =======================
// MIDDLEWARE
// =======================
app.use(cors({
  origin: isProd ? allowedOrigins : true,
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"]
}));
app.use(express.json());

// =======================
// HEALTH CHECK (Railway/Netlify ping)
// =======================
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// =======================
// TON CONNECT MANIFEST (dynamic — works on any domain, no env var needed)
// Must be registered BEFORE Vite/static middleware so the static file in
// client/public never shadows it.
// =======================
app.get("/tonconnect-manifest.json", (req, res) => {
  const forwardedProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host") || "";
  const origin = `${protocol}://${host}`;
  res.set("Cache-Control", "no-store");
  res.type("application/json").json({
    url: origin,
    name: "Skills2Crypto",
    iconUrl: `${origin}/favicon.png`,
  });
});

async function bootstrap() {
  // Pre-load the system-address blacklist (oracle / deployer / platform
  // wallets per chain) so the matchmaking guard rejects them on the very
  // first request instead of waiting for the lazy init to complete.
  // Failure here is non-fatal — the module is fail-open and the warning
  // is already logged inside.
  await initSystemAddresses().catch((err) => {
    console.warn(`[startup] initSystemAddresses failed (continuing): ${err?.message || err}`);
  });

  // ROUTES
  await registerRoutes(httpServer, app, io);

  // FRONTEND (DEV / PROD)
  if (NODE_ENV === "production") {
    // Отдаём собранный фронт (no-op when split-deployed: dist/public absent on Railway)
    app.use(express.static("dist/public"));
    app.get("/", (_req, res) => {
      res.send("skills2crypto API running");
    });
  } else {
    // Vite middleware в деве
    await setupVite(httpServer, app);
  }

  startServer();
}

function startServer() {
  httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[skills2crypto] server running on port ${PORT}`);

  if (!process.env.ORACLE_PRIVATE_KEY) {
    console.warn("[startup] ORACLE_PRIVATE_KEY not set — skipping EVM oracle init");
    return;
  }

  import("./oracle/evmOracle").then(({ createEvmOracle }) => {
    // Start BSC oracle + MatchActive listener if configured.
    if (process.env.BSC_RPC_URL && process.env.BSC_ESCROW_ADDRESS) {
      try {
        const bsc = createEvmOracle("BSC");
        bsc.watchMatchActive(async (evt) => {
          const appMatchId = await resolveAppMatchId(evt.matchId);
          console.log(`[MatchActive:BSC] hash=${evt.matchId} appMatchId=${appMatchId ?? "?"} stake=${evt.stake}`);
          if (!appMatchId) return;
          markMatchFunded(appMatchId);
          io.to(`match:${appMatchId}`).emit("match-funded", {
            matchId: appMatchId,
            chain: "BSC",
            player1: evt.player1,
            player2: evt.player2,
          });
        });
      } catch (err: any) {
        console.error("[startup] BSC oracle init failed:", err?.message || err);
      }
    } else {
      console.warn("[startup] BSC_RPC_URL / BSC_ESCROW_ADDRESS not set — BSC oracle disabled");
    }

    // Start ETH oracle + MatchActive listener if configured.
    if (process.env.ETH_RPC_URL && process.env.ETH_ESCROW_ADDRESS) {
      try {
        const eth = createEvmOracle("ETH");
        eth.watchMatchActive(async (evt) => {
          const appMatchId = await resolveAppMatchId(evt.matchId);
          console.log(`[MatchActive:ETH] hash=${evt.matchId} appMatchId=${appMatchId ?? "?"} stake=${evt.stake}`);
          if (!appMatchId) return;
          markMatchFunded(appMatchId);
          io.to(`match:${appMatchId}`).emit("match-funded", {
            matchId: appMatchId,
            chain: "ETH",
            player1: evt.player1,
            player2: evt.player2,
          });
        });
      } catch (err: any) {
        console.error("[startup] ETH oracle init failed:", err?.message || err);
      }
    } else {
      console.warn("[startup] ETH_RPC_URL / ETH_ESCROW_ADDRESS not set — ETH oracle disabled");
    }
  }).catch(err => {
    console.error("[startup] Failed to initialize oracle module:", err?.message || err);
  });
  });
}

bootstrap().catch(err => {
  console.error("[startup] bootstrap failed:", err?.message || err);
  process.exit(1);
});

