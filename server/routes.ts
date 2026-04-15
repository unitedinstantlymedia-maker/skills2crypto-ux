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
    const chainId = req.query.chainId as string;

    if (!player || !/^0x[0-9a-fA-F]{40}$/.test(player)) {
      return res.status(400).json({ error: "Invalid player address" });
    }

    const sessionAddr = process.env.SERVER_SESSION_WALLET;
    if (!sessionAddr) {
      return res.status(500).json({ error: "Server session wallet not configured" });
    }

    try {
      const { createEvmOracle } = await import("./oracle/evmOracle");
      const oracle = createEvmOracle();
      const nonce = await oracle.getSessionNonce(player);

      return res.json({
        nonce: nonce.toString(),
        sessionAddr,
        escrowAddress: oracle.escrowAddress,
      });
    } catch (err: any) {
      console.error("[session/nonce] Error:", err.message);
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

    const expectedChainId = Number(process.env.BSC_CHAIN_ID || 56);
    if (Number(chainId) !== expectedChainId) {
      return res.status(400).json({ error: `Invalid chain ID. Expected ${expectedChainId}` });
    }

    const expectedSessionAddr = process.env.SERVER_SESSION_WALLET;
    if (sessionAddr.toLowerCase() !== expectedSessionAddr?.toLowerCase()) {
      return res.status(400).json({ error: "Session address does not match server wallet" });
    }

    try {
      const { createEvmOracle } = await import("./oracle/evmOracle");
      const oracle = createEvmOracle();

      const result = await oracle.registerSessionKey(
        player,
        sessionAddr,
        BigInt(maxStakePerMatch),
        BigInt(expiry),
        signature
      );

      console.log(`[session/register] Session registered for ${player}, tx: ${result.txHash}`);
      return res.json({ txHash: result.txHash, blockNumber: result.blockNumber });
    } catch (err: any) {
      console.error("[session/register] Error:", err.message);
      return res.status(500).json({ error: err.message || "Session registration failed" });
    }
  });

  app.get("/api/session/permit-nonce", async (req, res) => {
    const owner = req.query.owner as string;
    const token = req.query.token as string;

    if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
      return res.status(400).json({ error: "Invalid owner address" });
    }
    if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
      return res.status(400).json({ error: "Invalid token address" });
    }

    try {
      const { JsonRpcProvider, Contract } = await import("ethers");
      const rpcUrl = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
      const provider = new JsonRpcProvider(rpcUrl);

      const erc20PermitAbi = [
        "function nonces(address owner) view returns (uint256)",
        "function name() view returns (string)",
      ];
      const tokenContract = new Contract(token, erc20PermitAbi, provider);

      let nonce = "0";
      let tokenName = "Tether USD";
      try {
        nonce = (await tokenContract.nonces(owner)).toString();
      } catch {
        console.warn("[permit-nonce] Token may not support EIP-2612 nonces");
      }
      try {
        tokenName = await tokenContract.name();
      } catch {
        console.warn("[permit-nonce] Could not read token name");
      }

      return res.json({ nonce, tokenName });
    } catch (err: any) {
      console.error("[permit-nonce] Error:", err.message);
      return res.status(500).json({ error: "Failed to fetch permit nonce" });
    }
  });

  app.post("/api/session/permit", async (req, res) => {
    const { owner, spender, deadline, v, r, s, nonce } = req.body ?? {};

    if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
      return res.status(400).json({ error: "Invalid owner address" });
    }
    if (!spender || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
      return res.status(400).json({ error: "Invalid spender address" });
    }
    if (!deadline || !r || !s || v === undefined) {
      return res.status(400).json({ error: "Missing permit fields" });
    }

    const expectedEscrow = process.env.BSC_ESCROW_ADDRESS;
    if (expectedEscrow && spender.toLowerCase() !== expectedEscrow.toLowerCase()) {
      return res.status(400).json({ error: "Spender must be the escrow contract" });
    }

    try {
      const permitKey = `permit:${owner.toLowerCase()}:${spender.toLowerCase()}`;
      await redis.set(
        permitKey,
        JSON.stringify({ owner, spender, deadline, v, r, s, nonce }),
        { ex: 86400 * 30 }
      );

      console.log(`[session/permit] Stored permit for ${owner} → spender ${spender}`);
      return res.json({ success: true });
    } catch (err: any) {
      console.error("[session/permit] Error:", err.message);
      return res.status(500).json({ error: "Failed to store permit" });
    }
  });

  app.post("/api/oracle/submit-deposit", async (req, res) => {
    const { matchId } = req.body ?? {};

    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }

    const lockKey = `deposit_lock:${matchId}`;
    const locked = await redis.set(lockKey, "1", { ex: 300, nx: true });
    if (!locked) {
      const existingTx = await redis.get(`deposit_tx:${matchId}`);
      if (existingTx) {
        return res.json({ txHash: existingTx, matchId, alreadyDeposited: true });
      }
      return res.status(409).json({ error: "Deposit already in progress for this match" });
    }

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.addr1 || !matchData.addr2 || !matchData.stake || !matchData.asset) {
        await redis.del(lockKey);
        return res.status(404).json({ error: "Match not found or missing wallet addresses" });
      }

      const player1 = String(matchData.addr1);
      const player2 = String(matchData.addr2);
      const asset = String(matchData.asset);
      const stakeNum = Number(matchData.stake);

      if (!/^0x[0-9a-fA-F]{40}$/.test(player1) || !/^0x[0-9a-fA-F]{40}$/.test(player2)) {
        await redis.del(lockKey);
        return res.status(400).json({ error: "Invalid player addresses in match data" });
      }

      const isNative = asset === "BNB" || asset === "ETH";
      const decimals = isNative ? 18 : 6;
      const stakeBigInt = BigInt(Math.round(stakeNum * 10 ** decimals));
      const assetTypeNum = isNative ? 1 : 0;

      const { createEvmOracle } = await import("./oracle/evmOracle");
      const oracle = createEvmOracle();

      console.log(`[oracle/submit-deposit] Generating deposit sigs for match ${matchId}`);
      console.log(`[oracle/submit-deposit]   player1: ${player1}, player2: ${player2}`);
      console.log(`[oracle/submit-deposit]   stake: ${stakeNum} ${asset} (${stakeBigInt.toString()} wei)`);

      const sig1 = await oracle.signDepositAuthorization(matchId, stakeBigInt, assetTypeNum, player1);
      const sig2 = await oracle.signDepositAuthorization(matchId, stakeBigInt, assetTypeNum, player2);

      let result;
      if (!isNative) {
        const escrowAddr = process.env.BSC_ESCROW_ADDRESS?.toLowerCase() || "";
        const permit1Raw = await redis.get(`permit:${player1.toLowerCase()}:${escrowAddr}`);
        const permit2Raw = await redis.get(`permit:${player2.toLowerCase()}:${escrowAddr}`);
        const permit1 = permit1Raw ? (typeof permit1Raw === "string" ? JSON.parse(permit1Raw) : permit1Raw) : null;
        const permit2 = permit2Raw ? (typeof permit2Raw === "string" ? JSON.parse(permit2Raw) : permit2Raw) : null;

        if (permit1 || permit2) {
          result = await oracle.submitDepositWithPermit(matchId, stakeBigInt, player1, player2, sig1, sig2, permit1, permit2);
        } else {
          result = await oracle.submitDeposit(matchId, stakeBigInt, player1, player2, sig1, sig2);
        }
      } else {
        const totalValue = stakeBigInt * 2n;
        result = await oracle.submitDepositNative(matchId, stakeBigInt, player1, player2, sig1, sig2, totalValue);
      }

      await redis.set(`deposit_tx:${matchId}`, result.txHash, { ex: 86400 });

      console.log(`[oracle/submit-deposit] Deposit for match ${matchId}: tx=${result.txHash}`);
      return res.json({
        txHash: result.txHash,
        matchId: result.matchId,
        blockNumber: result.blockNumber,
        gasUsed: result.gasUsed,
      });
    } catch (err: any) {
      await redis.del(lockKey);
      console.error("[oracle/submit-deposit] Error:", err.message);
      return res.status(500).json({ error: err.message || "Deposit submission failed" });
    }
  });

  return httpServer;
}

export default registerRoutes;