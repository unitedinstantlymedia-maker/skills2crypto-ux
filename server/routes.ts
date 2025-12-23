import type { Express } from "express";
import type { Server } from "http";
import type { Server as SocketIOServer } from "socket.io";

import { findOrCreateMatch } from "./matchmaking/redisMatchmaking";
import type { Game, Asset } from "./core/types.js";

const GAMES: readonly Game[] = ["chess", "tetris", "checkers", "battleship"] as const;
const ASSETS: readonly Asset[] = ["USDT", "ETH", "TON"] as const;

function isGame(x: unknown): x is Game {
  return typeof x === "string" && (GAMES as readonly string[]).includes(x);
}
function isAsset(x: unknown): x is Asset {
  return typeof x === "string" && (ASSETS as readonly string[]).includes(x);
}

type FindMatchBody = {
  game: Game;
  asset: Asset;
  stake: number | string;
  socketId: string;
};

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  io: SocketIOServer
): Promise<Server> {

  app.post("/api/find-match", async (req, res) => {
    const { game, asset, stake, socketId } = (req.body ?? {}) as Partial<FindMatchBody>;

  
    if (!isGame(game) || !isAsset(asset) || !socketId) {
      return res.status(400).json({ error: "bad params" });
    }
    const numericStake = Number(stake);
    if (!Number.isFinite(numericStake) || numericStake <= 0) {
      return res.status(400).json({ error: "invalid stake" });
    }

    try {
      const result = await findOrCreateMatch({
        game,
        asset,
        stake: numericStake,
        socketId: String(socketId),
      });

      
      if (result?.status === "matched" && Array.isArray(result.players)) {
        for (const sid of result.players) {
          io.to(String(sid)).emit("match-found", { matchId: result.matchId });
        }
      }

      return res.status(200).json(result);
    } catch (err) {
      console.error("find-match failed:", err);
      return res.status(500).json({ error: "matchmaking_failed" });
    }
  });

  return httpServer;
}

export default registerRoutes;