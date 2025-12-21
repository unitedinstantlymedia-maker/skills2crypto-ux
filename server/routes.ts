import type { Express } from "express";
import type { Server } from "http";
import type { Server as SocketIOServer } from "socket.io";
import { findOrCreateMatch } from "./matchmaking/redisMatchmaking";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  io: SocketIOServer
): Promise<Server> {

  app.post("/api/find-match", async (req, res) => {
    const { game, asset, stake, socketId } = req.body;

    if (!game || !asset || !stake || !socketId) {
      return res.status(400).json({ error: "missing params" });
    }

    const result = await findOrCreateMatch({
      game,
      asset,
      stake,
      socketId,
    });

    if (result.status === "matched" && result.players) {
      (result.players as string[]).forEach((sid: string) => {
        io.to(sid).emit("match-found", {
          matchId: result.matchId,
        });
      });
    }

    res.json(result);
  });

  return httpServer;
}