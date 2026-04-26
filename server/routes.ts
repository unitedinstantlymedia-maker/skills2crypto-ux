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
import { randomBytes } from "crypto";

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

    // Per-asset wallet validation: BNB/ETH require an EVM 0x-address; USDT
    // requires a Tron base58 address (T…); TON accepts any non-empty address.
    let cleanWallet = "";
    if (walletAddress && typeof walletAddress === "string") {
      if (asset === "BNB" || asset === "ETH") {
        if (/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) cleanWallet = walletAddress;
      } else if (asset === "USDT") {
        if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddress)) cleanWallet = walletAddress;
      } else {
        // TON — keep raw address; deeper validation happens in the TON adapter.
        cleanWallet = walletAddress;
      }
    }
    if (!cleanWallet) {
      return res.status(400).json({
        error: `Wallet address required for asset ${asset} (BNB/ETH need EVM, USDT needs Tron base58, TON needs TON address)`,
      });
    }

    // TON pre-flight: confirm the player has enough TON to cover the stake +
    // gasReserve before we queue them. The actual deposit happens after the
    // server calls PrepareMatch on-chain (via tonOracle), but we still gate
    // queueing so a player without funds doesn't lock the opponent.
    if (asset === "TON") {
      try {
        const { TonClient } = await import("@ton/ton");
        const { Address, fromNano } = await import("@ton/core");
        const client = new TonClient({
          endpoint: process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC",
          apiKey: process.env.TON_API_KEY,
        });
        const balanceNano = await client.getBalance(Address.parse(cleanWallet));
        const balanceTon = Number(fromNano(balanceNano));
        // V2: stake + ~0.1 TON gas headroom (deposit send + future settle send).
        const required = numericStake + 0.1;
        if (balanceTon < required) {
          return res.status(412).json({
            error: "ton_insufficient_balance",
            message: `Wallet balance (${balanceTon} TON) below required (${required} TON).`,
            requiredTon: required,
            balanceTon,
          });
        }
      } catch (err: any) {
        console.error("[find-match] TON readiness check failed:", err?.message || err);
        return res.status(503).json({
          error: "ton_readiness_unavailable",
          message: "Could not verify TON balance — try again shortly.",
        });
      }
    }

    // USDT pre-flight: a Tron player must have already approved at least
    // `stake` USDT to the escrow before we queue them. V2 contract pulls
    // exactly stake (no gasReserve padding).
    // Otherwise depositUSDT will revert at funding time and the opponent's
    // stake gets locked unproductively. The frontend should call
    // /api/tron/sponsor-trx + approve before reaching this endpoint.
    if (asset === "USDT") {
      try {
        const { createTronOracle } = await import("./oracle/tronOracle");
        const tron = createTronOracle();
        const allowance = await tron.getUsdtAllowance(cleanWallet);
        const stakeUnits = BigInt(Math.round(numericStake * 1_000_000));
        // Match the readiness gate: require allowance >= MAX_UINT256 / 2,
        // which guarantees the player did the one-time approve(MAX) and the
        // allowance can't deplete mid-session.
        const MAX_HALF = (1n << 255n);
        const required = stakeUnits > MAX_HALF ? stakeUnits : MAX_HALF;
        if (allowance < required) {
          return res.status(412).json({
            error: "usdt_not_approved",
            message: `USDT allowance (${allowance.toString()}) is below required (${required.toString()}). Approve USDT to the escrow before searching.`,
            requiredUnits: required.toString(),
            currentAllowanceUnits: allowance.toString(),
          });
        }
      } catch (err: any) {
        console.error("[find-match] USDT readiness check failed:", err?.message || err);
        // Fail open with a clear message rather than silently queueing.
        return res.status(503).json({
          error: "tron_readiness_unavailable",
          message: "Could not verify USDT allowance — try again shortly.",
        });
      }
    }

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
    
    // CLIENT_PUBLIC_URL is the deployed Netlify (or single-host) origin where
    // the React client lives — challenge invite links must point at the
    // *client*, not the API. In production this is required; in dev we fall
    // back to the Replit dev domain (and only then to localhost).
    let baseUrl: string;
    if (process.env.CLIENT_PUBLIC_URL) {
      baseUrl = process.env.CLIENT_PUBLIC_URL.replace(/\/+$/, "");
    } else if (process.env.NODE_ENV === "production") {
      console.error("[challenge] CLIENT_PUBLIC_URL is required in production");
      return res.status(500).json({
        error: "Server misconfigured: CLIENT_PUBLIC_URL is not set",
      });
    } else if (process.env.REPLIT_DEV_DOMAIN) {
      baseUrl = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    } else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
      baseUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
    } else {
      baseUrl = "http://localhost:5000";
    }
    
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

  /**
   * Removed in V2 (Task #16): server-side session keys. The V2 escrow
   * contracts have no registerSessionKey / sessionNonces — every match is
   * authorised by a fresh EIP-712 MatchAuth signed by the oracle. We keep
   * the routes as 410 stubs so old clients see a clear error.
   */
  app.all(["/api/session/nonce", "/api/session/register"], (_req, res) => {
    return res.status(410).json({
      error: "Session keys were removed in escrow V2. Use /api/oracle/match-auth for per-match authorisation.",
    });
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

      // 15-minute deposit window.
      const deadline = Math.floor(Date.now() / 1000) + 15 * 60;

      const auth = await oracle.signMatchAuth({
        matchId,
        player1,
        player2,
        stake: stakeBigInt,
        deadline,
      });

      await redis.set(authKey, JSON.stringify(auth), { ex: 60 * 20 });
      // Reverse index so the on-chain MatchActive listener (which receives
      // the keccak256 bytes32) can resolve back to the app matchId and
      // emit the socket event into the correct `match:${matchId}` room.
      await redis.set(`match_by_hash:${auth.matchIdBytes32.toLowerCase()}`, matchId, { ex: 60 * 60 * 24 });

      console.log(`[oracle/match-auth:${chain}] issued for match ${matchId}: stake=${stakeBigInt.toString()}, deadline=${deadline}`);

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

      // V2 status: 0=None, 1=WaitingForP2, 2=Active, 3=Settled
      const statusLabel = ["none", "waiting_for_p2", "active", "settled"][m.status] ?? "unknown";
      // For backwards compat with the existing client adapter (which checks
      // status === 1 to mean "fully funded"), remap to the v1 numbering it
      // expects. Will tighten once the adapter switches to the labelled enum.
      const compatStatus = m.status === 2 ? 1 : m.status === 3 ? 2 : m.status === 1 ? 3 : 0;
      return res.json({
        matchId,
        chain,
        chainId: oracle.chainId,
        status: compatStatus,
        statusV2: m.status,
        statusLabel,
        firstDepositor: m.firstDepositor,
        deadline: m.deadline,
      });
    } catch (err: any) {
      console.error("[oracle/match-status] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Status lookup failed" });
    }
  });

  // ============================================================
  // Tron USDT TRC-20 endpoints (Task #13)
  // ============================================================

  /**
   * Returns EIP-712 typed-data + per-player nonces a TronLink wallet must sign
   * for the on-chain depositUSDT call. Cached in Redis so both players get
   * consistent nonces during the deposit window.
   */
  app.post("/api/tron/deposit-auth", async (req, res) => {
    const { matchId } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.stake || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }
      if (String(matchData.asset) !== "USDT") {
        return res.status(400).json({ error: `Asset '${matchData.asset}' is not USDT (Tron)` });
      }
      if (!matchData.addr1 || !matchData.addr2) {
        return res.status(404).json({ error: "Match missing wallet addresses" });
      }

      const player1 = String(matchData.addr1);
      const player2 = String(matchData.addr2);
      const stakeNum = Number(matchData.stake);

      const authKey = `tron_deposit_auth:${matchId}`;
      const cached = await redis.get(authKey);
      if (cached) {
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        return res.json(parsed);
      }

      const { createTronOracle } = await import("./oracle/tronOracle");
      const tron = createTronOracle();
      const auth = await tron.buildDepositAuth({
        matchId,
        player1Base58: player1,
        player2Base58: player2,
        stakeUsdt: stakeNum,
      });

      await redis.set(authKey, JSON.stringify(auth), { ex: 60 * 20 });
      console.log(`[tron/deposit-auth] issued for match ${matchId}: stake=${auth.stake}`);
      return res.json(auth);
    } catch (err: any) {
      console.error("[tron/deposit-auth] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Failed to build deposit auth" });
    }
  });

  /**
   * Collects each player's signed Deposit message. Once both have submitted,
   * the oracle bundles the two sigs and broadcasts depositUSDT on Tron
   * (single on-chain call pulls both stakes via prior allowance).
   */
  app.post("/api/tron/deposit-sig", async (req, res) => {
    const { matchId, signature } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }
    if (!signature || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    try {
      const authKey = `tron_deposit_auth:${matchId}`;
      const cachedAuth = await redis.get(authKey);
      if (!cachedAuth) {
        return res.status(404).json({ error: "Deposit auth expired or missing — request a fresh one" });
      }
      const auth = typeof cachedAuth === "string" ? JSON.parse(cachedAuth) : cachedAuth;

      const { createTronOracle } = await import("./oracle/tronOracle");
      const tron = createTronOracle();

      // Determine which player this signature belongs to by trying both.
      let matchedPlayer: "1" | "2" | null = null;
      if (
        tron.verifyDepositSig({
          matchIdBytes32: auth.matchIdBytes32,
          stakeUnits: auth.stake,
          nonce: auth.nonce1,
          expectedPlayerEvmHex: auth.player1EvmHex,
          signature,
        })
      ) {
        matchedPlayer = "1";
      } else if (
        tron.verifyDepositSig({
          matchIdBytes32: auth.matchIdBytes32,
          stakeUnits: auth.stake,
          nonce: auth.nonce2,
          expectedPlayerEvmHex: auth.player2EvmHex,
          signature,
        })
      ) {
        matchedPlayer = "2";
      }

      if (!matchedPlayer) {
        return res.status(400).json({ error: "Signature does not match either player" });
      }

      const sigKey = `tron_deposit_sig:${matchId}`;
      // hsetnx-style — preserve first sig per slot, ignore retries.
      const existing = await redis.hgetall(sigKey);
      const slot = matchedPlayer === "1" ? "sig1" : "sig2";
      if (!existing || !existing[slot]) {
        await redis.hset(sigKey, { [slot]: signature });
        await redis.expire(sigKey, 60 * 20);
      }

      const after = (await redis.hgetall(sigKey)) || {};
      const sig1 = after.sig1 ? String(after.sig1) : null;
      const sig2 = after.sig2 ? String(after.sig2) : null;

      if (sig1 && sig2) {
        // Idempotency guard so duplicate posts can't trigger two deposits.
        const dispatchKey = `tron_deposit_dispatch:${matchId}`;
        const claimed = await redis.set(dispatchKey, "1", { ex: 7200, nx: true });
        if (claimed) {
          console.log(`[tron/deposit-sig] both sigs received for ${matchId} — broadcasting depositUSDT`);
          tron
            .submitDepositUSDTGasless({
              matchId,
              stakeUnits: auth.stake,
              player1EvmHex: auth.player1EvmHex,
              player2EvmHex: auth.player2EvmHex,
              sig1,
              sig2,
            })
            .then(async (r) => {
              console.log(`[tron/deposit-sig] depositUSDT broadcast tx=${r.txid}`);
              // Funding succeeded — release the gameplay gate the same way
              // the EVM watchMatchActive listener does for native deposits.
              try {
                const { markMatchFunded } = await import("./socket");
                markMatchFunded(matchId);
                io.to(`match:${matchId}`).emit("match-funded", {
                  matchId,
                  chain: "TRON",
                  player1: auth.player1,
                  player2: auth.player2,
                });
              } catch (e: any) {
                console.error(`[tron/deposit-sig] failed to emit match-funded:`, e?.message || e);
              }
            })
            .catch(async (err) => {
              console.error(`[tron/deposit-sig] depositUSDT failed:`, err?.message || err);
              // Release the dispatch lock so a retry is possible.
              await redis.del(dispatchKey);
            });
        }
        return res.json({ status: "dispatched", player: matchedPlayer });
      }
      return res.json({ status: "waiting", player: matchedPlayer });
    } catch (err: any) {
      console.error("[tron/deposit-sig] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Failed to process signature" });
    }
  });

  /**
   * Polled by the client to know when the on-chain match has flipped to Active.
   * Returns the same shape as /api/oracle/match-status.
   */
  app.get("/api/tron/match-status/:matchId", async (req, res) => {
    const { matchId } = req.params;
    if (!matchId) return res.status(400).json({ error: "matchId required" });

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }
      if (String(matchData.asset) !== "USDT") {
        return res.status(400).json({ error: "Not a Tron USDT match" });
      }

      const { createTronOracle } = await import("./oracle/tronOracle");
      const tron = createTronOracle();
      const m = await tron.getMatchOnChain(matchId);

      // V2 Tron status: 0=None, 1=Active, 2=Settled.
      const statusLabel = ["none", "active", "settled"][m.status] ?? "unknown";
      return res.json({
        matchId,
        chain: "TRON",
        chainId: tron.chainId,
        status: m.status,
        statusLabel,
      });
    } catch (err: any) {
      console.error("[tron/match-status] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Status lookup failed" });
    }
  });

  /**
   * GET /api/tron/config
   * Public Tron config so the frontend can call approve() against the right
   * escrow contract without hardcoding addresses per environment.
   */
  app.get("/api/tron/config", async (_req, res) => {
    try {
      const { createTronOracle } = await import("./oracle/tronOracle");
      const tron = createTronOracle();
      return res.json({
        chainId: tron.chainId,
        escrowBase58: tron.escrowAddressBase58,
        escrowEvmHex: tron.escrowAddressEvmHex,
        usdtBase58: tron.usdtAddressBase58,
      });
    } catch (err: any) {
      console.error("[tron/config] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Config unavailable" });
    }
  });

  /**
   * GET /api/tron/readiness?wallet=<base58>&stake=<usdt>
   * Returns whether the player has enough TRX to pay the one-time approve()
   * tx and whether their USDT allowance to the escrow already covers the
   * requested stake. Used as a pre-flight before /api/find-match for USDT.
   */
  app.get("/api/tron/readiness", async (req, res) => {
    const wallet = String(req.query.wallet || "");
    const stake = Number(req.query.stake || 0);
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(wallet)) {
      return res.status(400).json({ error: "Invalid Tron wallet" });
    }
    if (!Number.isFinite(stake) || stake <= 0) {
      return res.status(400).json({ error: "Invalid stake" });
    }
    try {
      const { createTronOracle } = await import("./oracle/tronOracle");
      const tron = createTronOracle();
      const [trx, allowance, estimate] = await Promise.all([
        tron.getPlayerBalanceTrx(wallet),
        tron.getUsdtAllowance(wallet),
        tron.estimateApproveTrxCost(wallet),
      ]);
      const stakeUnits = BigInt(Math.round(stake * 1_000_000));
      // Onboarding gate: a healthy player should have done approve(MAX) once,
      // so allowance >> any single stake. We require allowance >= MAX_UINT256 / 2,
      // which is satisfied iff the user did the proper MAX approve and not a
      // single-stake approve (which would silently deplete and brick the
      // gasless deposit on the next match).
      const MAX_HALF = (1n << 255n);
      const allowanceOk = allowance >= MAX_HALF;
      const stakeOk = allowance >= stakeUnits;
      return res.json({
        wallet,
        trxBalance: trx,
        usdtAllowance: allowance.toString(),
        approveReady: allowanceOk,
        approveStakeOk: stakeOk,
        trxReady: allowanceOk || trx >= estimate.trx,
        approveTrxCostEstimate: estimate.trx,
        approveEnergyEstimate: estimate.energy,
      });
    } catch (err: any) {
      console.error("[tron/readiness] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Readiness check failed" });
    }
  });

  /**
   * Removed in V2 (Task #16): /api/tron/sponsor-challenge and
   * /api/tron/sponsor-trx. Players now pay their own TRX for the one-time
   * approve(escrow, MAX). The escrow contract auto-funds the oracle from
   * a 0.5% USDT settlement fee via on-chain SunSwap, eliminating the need
   * for a sponsor flow.
   */
  app.all(["/api/tron/sponsor-challenge", "/api/tron/sponsor-trx"], (_req, res) => {
    return res.status(410).json({
      error: "TRX sponsorship was removed in escrow V2. Players pay their own TRX for the one-time USDT approve.",
    });
  });


  /**
   * GET /api/escrow/settle-auth/:matchId
   * Returns the oracle-signed MatchOutcome auth for a finished EVM or TON
   * match. The winner (or any player on Draw / Disconnect) uses this to call
   * settleMatch on-chain themselves and pay their own gas.
   *
   * For TRON USDT matches the oracle settles directly, so this endpoint
   * returns 409 — clients should poll /api/tron/match-status instead.
   *
   * Idempotent: the auth is persisted in Redis under `settle_auth:${matchId}`
   * for 7 days so repeated polls return the same signature.
   */
  const settleAuthHandler = async (req: any, res: any) => {
    const matchId = String(req.params.matchId || req.body?.matchId || "");
    if (!matchId) return res.status(400).json({ error: "matchId required" });
    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }
      if (String(matchData.asset) === "USDT") {
        return res.status(409).json({
          error: "tron_oracle_settled",
          message: "Tron USDT matches are settled by the oracle — poll /api/tron/match-status.",
        });
      }
      const raw = await redis.get<string | object>(`settle_auth:${matchId}`);
      if (!raw) {
        return res.status(404).json({
          error: "settle_auth_pending",
          message: "Match has not been resolved by the oracle yet.",
        });
      }
      const auth = typeof raw === "string" ? JSON.parse(raw) : raw;
      return res.json(auth);
    } catch (err: any) {
      console.error("[escrow/settle-auth] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Settle-auth lookup failed" });
    }
  };
  app.get("/api/escrow/settle-auth/:matchId", settleAuthHandler);
  app.post("/api/escrow/settle-auth/:matchId", settleAuthHandler);
  app.post("/api/escrow/settle-auth", settleAuthHandler);

  // ============================================================
  // Oracle health check (Task #10)
  // ============================================================
  //
  // Reports the live status of every chain's oracle / escrow contract:
  //   - BSC / ETH: signer-only in V2 (oracle never broadcasts), so we
  //     surface the wallet's native balance for visibility but it is not
  //     a "gas" balance — funds are not required for matches to settle.
  //   - Tron: oracle still broadcasts USDT deposits + settlements and
  //     pays TRX. The `okForGas` flag flips false when balance falls
  //     below `TRON_MIN_GAS_TRX`.
  //   - TON: signer-only; we surface the contract's own TON balance
  //     (which is what funds payouts) instead of an oracle wallet.
  //
  // Each chain is wrapped in its own try/catch so a single misconfigured
  // chain does not blank out the others. HTTP status is always 200 — the
  // response body documents which chains are healthy.
  app.get("/api/health/oracles", async (_req, res) => {
    const results: Record<string, any> = {};

    for (const chain of ["BSC", "ETH"] as const) {
      try {
        const { createEvmOracle } = await import("./oracle/evmOracle");
        const o = createEvmOracle(chain);
        const balance = await o.getOracleBalance();
        results[chain] = {
          ok: true,
          role: "signer-only",
          oracleAddress: o.address,
          escrowAddress: o.escrowAddress,
          chainId: o.chainId,
          nativeBalance: balance,
          okForGas: true,
          note: "V2 oracle does not broadcast — balance is informational",
        };
      } catch (err: any) {
        results[chain] = { ok: false, error: err?.message || String(err) };
      }
    }

    try {
      const { createTronOracle } = await import("./oracle/tronOracle");
      const t = createTronOracle();
      const trx = await t.getOracleBalanceTrx();
      const minTrx = Number(process.env.TRON_MIN_GAS_TRX ?? 50);
      results.TRON = {
        ok: true,
        role: "broadcaster",
        oracleAddress: t.oracleAddress,
        escrowAddress: t.escrowAddressBase58,
        chainId: t.chainId,
        nativeBalance: trx,
        minGasBalance: minTrx,
        okForGas: trx >= minTrx,
        accumulatedGasFundUSDT: (await t.getAccumulatedGasFundUSDT()).toString(),
      };
    } catch (err: any) {
      results.TRON = { ok: false, error: err?.message || String(err) };
    }

    try {
      const { createTonOracle } = await import("./oracle/tonOracle");
      const t = createTonOracle();
      const escrowBalance = await t.getEscrowBalanceTon();
      results.TON = {
        ok: true,
        role: "signer-only",
        escrowAddress: t.escrowAddressFriendly,
        escrowBalance,
        oraclePubkeyHex: await t.getOraclePubkeyHex(),
        okForGas: true,
        note: "V2 oracle does not broadcast — escrow balance is contract liquidity",
      };
    } catch (err: any) {
      results.TON = { ok: false, error: err?.message || String(err) };
    }

    const overallOk = Object.values(results).every((r) => r.ok && r.okForGas !== false);
    return res.json({ ok: overallOk, chains: results, timestamp: Date.now() });
  });

  // ============================================================
  // TON native escrow endpoints (Task #14)
  // ============================================================

  /**
   * GET /api/ton/config
   * Public TON config so the frontend knows the escrow address + chain info.
   */
  app.get("/api/ton/config", async (_req, res) => {
    try {
      const { createTonOracle } = await import("./oracle/tonOracle");
      const ton = createTonOracle();
      return res.json({
        chain: "TON",
        escrowAddress: ton.escrowAddressFriendly,
        platformWallet: ton.platformWalletFriendly,
        oraclePubkeyHex: await ton.getOraclePubkeyHex(),
      });
    } catch (err: any) {
      console.error("[ton/config] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "TON config unavailable" });
    }
  });

  /**
   * GET /api/ton/readiness?wallet=<friendly>&stake=<ton>
   * Confirms the player wallet exists on-chain and has enough TON to cover
   * stake + gas reserve. Used as a pre-flight before /api/find-match.
   */
  app.get("/api/ton/readiness", async (req, res) => {
    const wallet = String(req.query.wallet || "");
    const stake = Number(req.query.stake || 0);
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    if (!Number.isFinite(stake) || stake <= 0) {
      return res.status(400).json({ error: "Invalid stake" });
    }
    try {
      const { TonClient } = await import("@ton/ton");
      const { Address, fromNano } = await import("@ton/core");
      const client = new TonClient({
        endpoint: process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC",
        apiKey: process.env.TON_API_KEY,
      });
      const balanceNano = await client.getBalance(Address.parse(wallet));
      const balanceTon = Number(fromNano(balanceNano));
      // V2: player needs stake + ~0.05 TON gas (their own send) + ~0.05 TON
      // headroom for the future Settle TX they may broadcast.
      const requiredTon = stake + 0.1;
      return res.json({
        wallet,
        balanceTon,
        requiredTon,
        ready: balanceTon >= requiredTon,
        message: balanceTon >= requiredTon
          ? null
          : `Wallet has ${balanceTon} TON; needs ≥ ${requiredTon}`,
      });
    } catch (err: any) {
      console.error("[ton/readiness] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Readiness check failed" });
    }
  });

  /**
   * POST /api/ton/deposit-info
   * Body: { matchId }
   *
   * V2: PrepareMatch is gone — the contract auto-creates the match on the
   * first Deposit message. We just return the BOC the player must send.
   */
  app.post("/api/ton/deposit-info", async (req, res) => {
    const { matchId } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }
    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.stake || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }
      if (String(matchData.asset) !== "TON") {
        return res.status(400).json({ error: `Asset '${matchData.asset}' is not TON` });
      }
      if (!matchData.addr1 || !matchData.addr2) {
        return res.status(404).json({ error: "Match missing wallet addresses" });
      }

      const player1 = String(matchData.addr1);
      const player2 = String(matchData.addr2);
      const stakeNum = Number(matchData.stake);

      const { createTonOracle } = await import("./oracle/tonOracle");
      const ton = createTonOracle();

      const GAS_BUFFER_TON = 0.05;
      const amountTon = stakeNum + GAS_BUFFER_TON;
      const amountNano = BigInt(Math.round(amountTon * 1e9)).toString();
      const payloadBoc = ton.encodeDepositPayload({
        matchId,
        player1Friendly: player1,
        player2Friendly: player2,
        stakeTon: stakeNum,
      });
      const validUntilSec = Math.floor(Date.now() / 1000) + 15 * 60;

      console.log(
        `[ton/deposit-info] match=${matchId} amount=${amountTon} TON (stake=${stakeNum} + gas=${GAS_BUFFER_TON})`
      );
      return res.json({
        matchId,
        escrowAddress: ton.escrowAddressFriendly,
        amountNano,
        amountTon,
        gasBufferTon: GAS_BUFFER_TON,
        payloadBoc,
        validUntilSec,
      });
    } catch (err: any) {
      console.error("[ton/deposit-info] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Failed to build deposit info" });
    }
  });

  /**
   * GET /api/ton/match-status/:matchId
   * Polled by the client until the on-chain match flips to ACTIVE (= both
   * players have funded). When that happens we also fire match-funded so
   * the existing socket-based gameplay gate releases.
   */
  app.get("/api/ton/match-status/:matchId", async (req, res) => {
    const { matchId } = req.params;
    if (!matchId) return res.status(400).json({ error: "matchId required" });
    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }
      if (String(matchData.asset) !== "TON") {
        return res.status(400).json({ error: "Not a TON match" });
      }
      const { createTonOracle } = await import("./oracle/tonOracle");
      const ton = createTonOracle();
      const m = await ton.getMatchOnChain(matchId);
      const status = m?.status ?? 0;
      const statusLabel = ["none", "pending", "active", "settled", "cancelled"][status] ?? "unknown";

      // Once the match is active and we haven't already fired match-funded,
      // emit it so the gameplay flow proceeds the same way as for EVM/Tron.
      if (status === 2) {
        const fundedKey = `ton_funded_emitted:${matchId}`;
        const first = await redis.set(fundedKey, "1", { ex: 60 * 60 * 24, nx: true });
        if (first) {
          try {
            const { markMatchFunded } = await import("./socket");
            markMatchFunded(matchId);
            io.to(`match:${matchId}`).emit("match-funded", {
              matchId,
              chain: "TON",
              player1: matchData.addr1,
              player2: matchData.addr2,
            });
            console.log(`[ton/match-status] match-funded emitted for ${matchId}`);
          } catch (e: any) {
            console.error("[ton/match-status] failed to emit match-funded:", e?.message || e);
          }
        }
      }

      return res.json({
        matchId,
        chain: "TON",
        status,
        statusLabel,
        p1Funded: m?.p1Funded ?? false,
        p2Funded: m?.p2Funded ?? false,
      });
    } catch (err: any) {
      console.error("[ton/match-status] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Status lookup failed" });
    }
  });

  /**
   * POST /api/ton/notify-deposit
   * Body: { matchId, txInfo?, playerAddress? }
   *
   * Log-only breadcrumb fired by the client right after `tc.sendTransaction`
   * resolves. Useful for forensic correlation between client wallet activity
   * and the server-side `/api/ton/match-status` poller, but does NOT itself
   * release the gameplay gate.
   *
   * Why not act on it?  The notification is unauthenticated — `playerAddress`
   * is a self-asserted string with no cryptographic proof that the caller
   * controls that wallet. Acting on it would let any party who knew
   * `{matchId, addr1, addr2}` force a `match-funded` emission and start
   * gameplay before funds were actually escrowed. The on-chain
   * `/api/ton/match-status` poller (which now reads the contract correctly
   * after the `getMatchOnChain` tuple-decoding fix) is the only authoritative
   * trigger for `markMatchFunded`.
   */
  app.post("/api/ton/notify-deposit", async (req, res) => {
    const { matchId, txInfo, playerAddress } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }
    console.log(
      `[ton/notify-deposit] match=${matchId} player=${typeof playerAddress === "string" ? playerAddress : "?"} txInfo=${JSON.stringify(txInfo || {})}`,
    );
    return res.json({ ok: true });
  });

  return httpServer;
}

export default registerRoutes;