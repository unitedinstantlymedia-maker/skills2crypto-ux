import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";

import { registerRoutes } from "./routes";
import { setupVite } from "./vite";

// =======================
// CONFIG
// =======================
const PORT = Number(process.env.PORT || 5000);
const NODE_ENV = process.env.NODE_ENV || "development";

// =======================
// APP SETUP
// =======================
const app = express();
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());

// =======================
// SOCKET.IO
// =======================
io.on("connection", (socket) => {
  console.log("[skills2crypto] socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("[skills2crypto] socket disconnected:", socket.id);
  });
});

// =======================
// ROUTES
// =======================
await registerRoutes(httpServer, app, io);

// =======================
// FRONTEND (DEV / PROD)
// =======================
if (NODE_ENV === "production") {
  // prod — serve static files
  app.use(express.static("dist/public"));
  app.get("/", (_req, res) => {
    res.send("skills2crypto API running");
  });
} else {
  // dev — setup Vite middleware
  await setupVite(httpServer, app);
}

// =======================
// START SERVER (ONE TIME)
// =======================
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[skills2crypto] server running on port ${PORT}`);
});



