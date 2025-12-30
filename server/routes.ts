import type { Express } from "express";
import type { Server } from "http";
import type { Server as SocketIOServer } from "socket.io";
import { eq, or, desc } from "drizzle-orm";
import { findOrCreateMatch } from "./matchmaking/redisMatchmaking";
import type { Game, Asset } from "./server/core/types";
import { db } from "./db";
import { matches } from "../shared/schema";
import { redis } from "./redis";
import { nanoid } from "nanoid";

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

  // =====================
  // CHALLENGE FRIEND FEATURE
  // =====================
  
  // Create a new challenge
  app.post("/api/create-challenge", async (req, res) => {
    const { game, asset, stake, challengerId, challengerName } = req.body ?? {};
    
    if (!isGame(game) || !isAsset(asset)) {
      return res.status(400).json({ error: "Invalid game or asset" });
    }
    
    const numericStake = Number(stake);
    if (!Number.isFinite(numericStake) || numericStake <= 0) {
      return res.status(400).json({ error: "Invalid stake" });
    }
    
    if (!challengerId) {
      return res.status(400).json({ error: "Challenger ID required" });
    }
    
    // Generate unique challenge ID
    const challengeId = nanoid(12);
    
    // Store in Redis with 1-hour TTL
    const challengeData = {
      challengeId,
      game,
      asset,
      stake: numericStake,
      challengerId,
      challengerName: challengerName || "Unknown",
      createdAt: Date.now(),
      status: "pending"
    };
    
    await redis.set(`challenge:${challengeId}`, JSON.stringify(challengeData), { ex: 3600 });
    
    // Build the shareable URL
    const baseUrl = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.REPL_SLUG && process.env.REPL_OWNER
        ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
        : "http://localhost:5000";
    
    const shareUrl = `${baseUrl}/challenge/${challengeId}`;
    
    console.log(`[challenge] created ${challengeId} by ${challengerId}`);
    
    return res.status(200).json({
      challengeId,
      shareUrl,
      expiresIn: 3600
    });
  });
  
  // Get challenge details
  app.get("/api/challenge/:challengeId", async (req, res) => {
    const { challengeId } = req.params;
    
    if (!challengeId) {
      return res.status(400).json({ error: "Challenge ID required" });
    }
    
    const data = await redis.get(`challenge:${challengeId}`);
    
    if (!data) {
      return res.status(404).json({ error: "Challenge not found or expired" });
    }
    
    const challenge = typeof data === "string" ? JSON.parse(data) : data;
    
    return res.status(200).json(challenge);
  });
  
  // Accept a challenge - creates a match between challenger and accepter
  app.post("/api/accept-challenge", async (req, res) => {
    const { challengeId, accepterId, accepterSocketId } = req.body ?? {};
    
    if (!challengeId || !accepterId || !accepterSocketId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const data = await redis.get(`challenge:${challengeId}`);
    
    if (!data) {
      return res.status(404).json({ error: "Challenge not found or expired" });
    }
    
    const challenge = typeof data === "string" ? JSON.parse(data) : data;
    
    if (challenge.status !== "pending") {
      return res.status(400).json({ error: "Challenge already accepted" });
    }
    
    if (challenge.challengerId === accepterId) {
      return res.status(400).json({ error: "Cannot accept your own challenge" });
    }
    
    // Generate match ID
    const matchId = nanoid(16);
    
    // Update challenge status
    challenge.status = "accepted";
    challenge.accepterId = accepterId;
    challenge.matchId = matchId;
    await redis.set(`challenge:${challengeId}`, JSON.stringify(challenge), { ex: 3600 });
    
    // Store match data in Redis for the game
    const matchData = {
      matchId,
      game: challenge.game,
      asset: challenge.asset,
      stake: challenge.stake,
      player1Id: challenge.challengerId,
      player2Id: accepterId,
      challengeId,
      status: "waiting_for_players"
    };
    await redis.set(`match:${matchId}`, JSON.stringify(matchData), { ex: 7200 });
    
    console.log(`[challenge] ${challengeId} accepted by ${accepterId}, match ${matchId} created`);
    
    // Notify the accepter's socket about the match
    io.to(accepterSocketId).emit("challenge-match-created", { 
      matchId, 
      game: challenge.game,
      challengeId 
    });
    
    return res.status(200).json({
      matchId,
      game: challenge.game,
      asset: challenge.asset,
      stake: challenge.stake,
      challengerId: challenge.challengerId,
      challengerName: challenge.challengerName
    });
  });

  app.get("/api/history/:playerId", async (req, res) => {
    const { playerId } = req.params;
    
    if (!playerId) {
      return res.status(400).json({ error: "playerId required" });
    }

    try {
      const results = await db.select().from(matches)
        .where(or(eq(matches.player1Id, playerId), eq(matches.player2Id, playerId)))
        .orderBy(desc(matches.timestamp))
        .limit(50);

      const history = results.map(m => {
        let result: 'win' | 'loss' | 'draw';
        let payout = 0;
        
        if (m.winnerId === playerId) {
          result = 'win';
          payout = m.payout;
        } else if (m.loserId === playerId) {
          result = 'loss';
          payout = 0;
        } else {
          result = 'draw';
          payout = m.payout;
        }
        
        return {
          id: m.id,
          game: m.gameType,
          asset: m.asset,
          stake: m.stake,
          result,
          pot: m.pot,
          fee: m.fee,
          payout,
          timestamp: m.timestamp,
        };
      });

      return res.status(200).json(history);
    } catch (err) {
      console.error("fetch history failed:", err);
      return res.status(200).json([]);
    }
  });

  return httpServer;
}

export default registerRoutes;