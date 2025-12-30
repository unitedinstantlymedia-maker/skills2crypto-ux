import express from "express";
import http from "http";
import cors from "cors";

import { registerRoutes } from "./routes";
import { setupVite } from "./vite";
import { setupSocket } from "./socket";
import { startChallengeCleanup } from "./matchmaking/challengeCleanup";

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
// ROUTES
// =======================
await registerRoutes(httpServer, app, io);

// =======================
// FRONTEND (DEV / PROD)
// =======================
if (NODE_ENV === "production") {
  // Отдаём собранный фронт
  app.use(express.static("dist/public"));
  app.get("/", (_req, res) => {
    res.send("skills2crypto API running");
  });
} else {
  // Vite middleware в деве
  await setupVite(httpServer, app);
}

// =======================
// START SERVER
// =======================
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[skills2crypto] server running on port ${PORT}`);
});


