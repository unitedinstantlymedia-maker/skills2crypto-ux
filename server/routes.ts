import type { Express } from "express";
import type { Server } from "http";
import type { Server as SocketIOServer } from "socket.io";
import { eq, or, desc } from "drizzle-orm";
import { findOrCreateMatch } from "./matchmaking/redisMatchmaking";
import type { Game, Asset } from "./core/types";
import { db } from "./db";
import { matches, type ChallengeData, type ChallengeStatus, type ChallengeHistoryEntry } from "../shared/schema";
import { redis } from "./redis";
import { nanoid } from "nanoid";

const CHALLENGE_TTL = 3600;
const EXPIRED_CHALLENGE_TTL = 86400;

async function addChallengeHistory(
  challengeId: string,
  status: ChallengeStatus,
  action: string
): Promise<void> {
  const entry: ChallengeHistoryEntry = {
    timestamp: Date.now(),
    status,
    action,
  };
  await redis.rpush(`challenge:${challengeId}:history`, JSON.stringify(entry));
  await redis.expire(`challenge:${challengeId}:history`, EXPIRED_CHALLENGE_TTL);
}

const GAMES: readonly Game[] = ["chess", "tetris", "checkers", "battleship"] as const;
const ASSETS: readonly Asset[] = ["USDT", "ETH", "BNB", "TON"] as const;

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
  walletAddress?: string;
};

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  io: SocketIOServer
): Promise<Server> {

  app.post("/api/find-match", async (req, res) => {
    const { game, asset, stake, socketId, walletAddress } = (req.body ?? {}) as Partial<FindMatchBody>;

    if (!isGame(game) || !isAsset(asset) || !socketId) {
      return res.status(400).json({ error: "bad params" });
    }
    const numericStake = Number(stake);
    if (!Number.isFinite(numericStake) || numericStake <= 0) {
      return res.status(400).json({ error: "invalid stake" });
    }

    const cleanWallet = (walletAddress && /^0x[0-9a-fA-F]{40}$/.test(walletAddress))
      ? walletAddress
      : "";

    try {
      const result = await findOrCreateMatch({
        game,
        asset,
        stake: numericStake,
        socketId: String(socketId),
        walletAddress: cleanWallet,
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
  
  app.post("/api/create-challenge", async (req, res) => {
    const { game, asset, stake, challengerId, challengerName, challengerSocketId } = req.body ?? {};
    
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
    
    const challengeId = nanoid(12);
    const now = Date.now();
    
    const challengeData: ChallengeData = {
      challengeId,
      game,
      asset,
      stake: numericStake,
      challengerId,
      challengerName: challengerName || "Unknown",
      challengerSocketId: challengerSocketId || undefined,
      status: "pending",
      createdAt: now,
      expiresAt: now + (CHALLENGE_TTL * 1000),
    };
    
    await redis.set(`challenge:${challengeId}`, JSON.stringify(challengeData), { ex: EXPIRED_CHALLENGE_TTL });
    
    await redis.sadd(`user:${challengerId}:challenges`, challengeId);
    await redis.expire(`user:${challengerId}:challenges`, EXPIRED_CHALLENGE_TTL);
    
    await addChallengeHistory(challengeId, "pending", "challenge_created");
    
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
      expiresIn: CHALLENGE_TTL
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
  
  app.post("/api/accept-challenge", async (req, res) => {
    const { challengeId, accepterId, accepterSocketId, accepterName } = req.body ?? {};
    
    if (!challengeId || !accepterId || !accepterSocketId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const data = await redis.get(`challenge:${challengeId}`);
    
    if (!data) {
      return res.status(404).json({ error: "Challenge not found or expired" });
    }
    
    const challenge: ChallengeData = typeof data === "string" ? JSON.parse(data) : data;
    
    if (challenge.status !== "pending") {
      return res.status(400).json({ error: "Challenge already accepted" });
    }
    
    if (challenge.challengerId === accepterId) {
      return res.status(400).json({ error: "Cannot accept your own challenge" });
    }
    
    const matchId = nanoid(16);
    
    challenge.status = "accepted";
    challenge.accepterId = accepterId;
    challenge.accepterName = accepterName || "Unknown";
    challenge.matchId = matchId;
    
    await redis.set(`challenge:${challengeId}`, JSON.stringify(challenge), { ex: EXPIRED_CHALLENGE_TTL });
    
    await redis.sadd(`user:${accepterId}:challenges`, challengeId);
    await redis.expire(`user:${accepterId}:challenges`, EXPIRED_CHALLENGE_TTL);
    
    await addChallengeHistory(challengeId, "accepted", "challenge_accepted");
    
    const matchData = {
      matchId,
      game: challenge.game,
      asset: challenge.asset,
      stake: challenge.stake,
      player1Id: challenge.challengerId,
      player2Id: accepterId,
      p1: challenge.challengerId,
      p2: accepterId,
      challengeId,
      status: "waiting_for_players"
    };
    await redis.hset(`match:${matchId}`, matchData);
    await redis.expire(`match:${matchId}`, 7200);
    
    console.log(`[challenge] ${challengeId} accepted by ${accepterId}, match ${matchId} created`);
    
    io.to(accepterSocketId).emit("challenge-match-created", { 
      matchId, 
      game: challenge.game,
      challengeId 
    });
    
    if (challenge.challengerSocketId) {
      io.to(challenge.challengerSocketId).emit("challenge-accepted", {
        challengeId,
        matchId,
        game: challenge.game,
        accepterId,
        accepterName: accepterName || "Unknown"
      });
    }
    
    return res.status(200).json({
      matchId,
      game: challenge.game,
      asset: challenge.asset,
      stake: challenge.stake,
      challengerId: challenge.challengerId,
      challengerName: challenge.challengerName
    });
  });

  app.post("/api/cancel-challenge", async (req, res) => {
    const { challengeId, challengerId } = req.body ?? {};
    
    if (!challengeId || !challengerId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const data = await redis.get(`challenge:${challengeId}`);
    
    if (!data) {
      return res.status(404).json({ error: "Challenge not found or expired" });
    }
    
    const challenge: ChallengeData = typeof data === "string" ? JSON.parse(data) : data;
    
    if (challenge.challengerId !== challengerId) {
      return res.status(403).json({ error: "Only the challenger can cancel" });
    }
    
    if (challenge.status !== "pending") {
      return res.status(400).json({ error: `Cannot cancel challenge with status: ${challenge.status}` });
    }
    
    challenge.status = "cancelled";
    
    await redis.set(`challenge:${challengeId}`, JSON.stringify(challenge), { ex: EXPIRED_CHALLENGE_TTL });
    await addChallengeHistory(challengeId, "cancelled", "challenge_cancelled");
    
    if (challenge.challengerSocketId) {
      io.to(challenge.challengerSocketId).emit("challenge-cancelled", {
        challengeId: challenge.challengeId,
        game: challenge.game,
        stake: challenge.stake,
        asset: challenge.asset,
      });
    }
    
    console.log(`[challenge] ${challengeId} cancelled by ${challengerId}`);
    
    return res.status(200).json({ success: true, challengeId });
  });

  app.get("/api/challenges/:userId", async (req, res) => {
    const { userId } = req.params;
    const { status } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: "User ID required" });
    }
    
    try {
      const challengeIds = await redis.smembers(`user:${userId}:challenges`);
      
      if (!challengeIds || challengeIds.length === 0) {
        return res.status(200).json([]);
      }
      
      const challenges: ChallengeData[] = [];
      
      for (const cid of challengeIds) {
        const data = await redis.get(`challenge:${cid}`);
        if (data) {
          const challenge: ChallengeData = typeof data === "string" ? JSON.parse(data) : data;
          
          if (!status || challenge.status === status) {
            challenges.push(challenge);
          }
        }
      }
      
      challenges.sort((a, b) => b.createdAt - a.createdAt);
      
      return res.status(200).json(challenges);
    } catch (err) {
      console.error("fetch challenges failed:", err);
      return res.status(200).json([]);
    }
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

  app.get("/api/session/nonce", async (req, res) => {
    const player = req.query.player as string;
    const chainIdParam = Number(req.query.chainId);

    if (!player || !/^0x[0-9a-fA-F]{40}$/.test(player)) {
      return res.status(400).json({ error: "Invalid player address" });
    }

    const sessionAddr = process.env.SERVER_SESSION_WALLET;
    if (!sessionAddr) {
      return res.status(500).json({ error: "Server session wallet not configured" });
    }

    const chain = chainIdParam === 1 ? "ETH" : chainIdParam === 56 ? "BSC" : null;
    if (!chain) {
      return res.status(400).json({ error: `Unsupported chain ID ${req.query.chainId}. Expected 1 (Ethereum) or 56 (BSC).` });
    }

    const { createEvmOracle } = await import("./oracle/evmOracle");
    try {
      const oracle = createEvmOracle(chain);
      const nonce = await oracle.getSessionNonce(player);

      return res.json({
        nonce: nonce.toString(),
        sessionAddr,
        escrowAddress: oracle.escrowAddress,
        chainId: oracle.chainId,
      });
    } catch (err: any) {
      console.error(`[session/nonce:${chain}] Error:`, err.message);
      return res.status(500).json({ error: "Failed to fetch session nonce" });
    }
  });

  app.post("/api/session/register", async (req, res) => {
    const { player, sessionAddr, maxStakePerMatch, expiry, signature, chainId } = req.body ?? {};

    if (!player || !/^0x[0-9a-fA-F]{40}$/.test(player)) {
      return res.status(400).json({ error: "Invalid player address" });
    }
    if (!sessionAddr || !/^0x[0-9a-fA-F]{40}$/.test(sessionAddr)) {
      return res.status(400).json({ error: "Invalid session address" });
    }
    if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return res.status(400).json({ error: "Invalid signature" });
    }
    if (!maxStakePerMatch || !expiry) {
      return res.status(400).json({ error: "Missing maxStakePerMatch or expiry" });
    }

    const chainIdNum = Number(chainId);
    const chain = chainIdNum === 1 ? "ETH" : chainIdNum === 56 ? "BSC" : null;
    if (!chain) {
      return res.status(400).json({ error: `Unsupported chain ID ${chainId}. Expected 1 (Ethereum) or 56 (BSC).` });
    }

    const expectedSessionAddr = process.env.SERVER_SESSION_WALLET;
    if (sessionAddr.toLowerCase() !== expectedSessionAddr?.toLowerCase()) {
      return res.status(400).json({ error: "Session address does not match server wallet" });
    }

    try {
      const { createEvmOracle } = await import("./oracle/evmOracle");
      const oracle = createEvmOracle(chain);

      const result = await oracle.registerSessionKey(
        player,
        sessionAddr,
        BigInt(maxStakePerMatch),
        BigInt(expiry),
        signature
      );

      console.log(`[session/register:${chain}] Session registered for ${player}, tx: ${result.txHash}`);
      return res.json({ txHash: result.txHash, blockNumber: result.blockNumber });
    } catch (err: any) {
      console.error(`[session/register:${chain}] Error:`, err.message);
      return res.status(500).json({ error: err.message || "Session registration failed" });
    }
  });

  /**
   * Returns an EIP-712 MatchAuth oracle signature plus the exact parameters
   * the player must supply to `depositNativeAsPlayer` on-chain. Both players
   * pull the same auth (cached in Redis) for a given match.
   */
  app.post("/api/oracle/match-auth", async (req, res) => {
    const { matchId } = req.body ?? {};

    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.stake || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }

      const asset = String(matchData.asset);
      const { chainForAsset, createEvmOracle } = await import("./oracle/evmOracle");
      const chain = chainForAsset(asset);
      if (!chain) {
        return res.status(400).json({
          error: `Asset '${asset}' does not use an EVM native deposit (USDT → Tron, TON → TON).`,
        });
      }

      if (!matchData.addr1 || !matchData.addr2) {
        return res.status(404).json({ error: "Match missing wallet addresses" });
      }

      const player1 = String(matchData.addr1);
      const player2 = String(matchData.addr2);
      const stakeNum = Number(matchData.stake);

      if (!/^0x[0-9a-fA-F]{40}$/.test(player1) || !/^0x[0-9a-fA-F]{40}$/.test(player2)) {
        return res.status(400).json({ error: "Invalid player addresses in match data" });
      }

      // Return a cached auth if one is still valid so both players use identical params.
      const authKey = `match_auth:${matchId}`;
      const cached = await redis.get(authKey);
      if (cached) {
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        if (parsed.deadline > Math.floor(Date.now() / 1000) + 30) {
          return res.json(parsed);
        }
      }

      const { ethers: ethersLib } = await import("ethers");
      const stakeBigInt = ethersLib.parseUnits(String(stakeNum), 18);

      const oracle = createEvmOracle(chain);
      const gasReserve = await oracle.getGasReserveEstimate();

      // 15-minute deposit window.
      const deadline = Math.floor(Date.now() / 1000) + 15 * 60;

      const auth = await oracle.signMatchAuth({
        matchId,
        player1,
        player2,
        stake: stakeBigInt,
        gasReserve,
        deadline,
      });

      await redis.set(authKey, JSON.stringify(auth), { ex: 60 * 20 });
      // Reverse index so the on-chain MatchActive listener (which receives
      // the keccak256 bytes32) can resolve back to the app matchId and
      // emit the socket event into the correct `match:${matchId}` room.
      await redis.set(`match_by_hash:${auth.matchIdBytes32.toLowerCase()}`, matchId, { ex: 60 * 60 * 24 });

      console.log(`[oracle/match-auth:${chain}] issued for match ${matchId}: stake=${stakeBigInt.toString()}, gasReserve=${gasReserve.toString()}, deadline=${deadline}`);

      return res.json(auth);
    } catch (err: any) {
      console.error("[oracle/match-auth] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Failed to issue match auth" });
    }
  });

  /**
   * Polling endpoint clients use after submitting their native deposit.
   * Returns the on-chain match status so the UI can wait for both players.
   */
  app.get("/api/oracle/match-status/:matchId", async (req, res) => {
    const { matchId } = req.params;
    if (!matchId) return res.status(400).json({ error: "matchId required" });

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }

      const { chainForAsset, createEvmOracle } = await import("./oracle/evmOracle");
      const chain = chainForAsset(String(matchData.asset));
      if (!chain) {
        return res.status(400).json({ error: "Not an EVM native match" });
      }

      const oracle = createEvmOracle(chain);
      const m = await oracle.getMatchOnChain(matchId);

      // status: 0=None, 1=Active, 2=Settled, 3=WaitingForP2
      const statusLabel = ["none", "active", "settled", "waiting_for_p2"][m.status] ?? "unknown";
      return res.json({
        matchId,
        chain,
        chainId: oracle.chainId,
        status: m.status,
        statusLabel,
        firstDepositor: m.firstDepositor,
        deadline: m.deadline,
      });
    } catch (err: any) {
      console.error("[oracle/match-status] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Status lookup failed" });
    }
  });

  return httpServer;
}

export default registerRoutes;