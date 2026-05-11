import type { Express } from "express";
import type { Server } from "http";
import type { Server as SocketIOServer } from "socket.io";
import { eq, or, desc, asc, and, gt } from "drizzle-orm";
import { findOrCreateMatch } from "./matchmaking/redisMatchmaking";
import { checkSystemAddress, getSystemAddressesStatus } from "./security/systemAddresses";
import type { Game, Asset } from "./core/types";
import { db } from "./db";
import { matches, matchMoves, type ChallengeData, type ChallengeStatus, type ChallengeHistoryEntry } from "../shared/schema";
import { verifyMatchToken } from "./security/matchToken";
import { redis } from "./redis";
import { nanoid } from "nanoid";
import { timingSafeEqual } from "crypto";
import { rlTight, rlMedium, rlLoose } from "./security/rateLimit";
import { getMatchmakingCooldownRemainingMs } from "./security/socketLimits";
import {
  getAbuseCountersStatus,
  recordMatchmakingCooldownRejection,
} from "./security/abuseCounters";
import { isOraclePaused, setPause, getPauseStatus, type PauseScope } from "./security/oraclePause";
import {
  touchUser,
  getUserStatus,
  getUser,
  setUserStatus,
  checkDepositBanForWallets,
} from "./users/userStatus";
import { requireAdminWallet } from "./security/adminAuth";
import { UserStatusEnum } from "../shared/schema";
import { getOpsAlertStatus } from "./security/opsAlert";
import { getReconciliationStatus } from "./security/reconciliation";
import { getNetworkFees } from "./security/networkFees";
import { isValidWalletShape } from "../shared/walletShape";

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

const GAMES: readonly Game[] = ["chess", "tetris", "checkers", "battleship", "dominoes", "xiangqi"] as const;
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

  app.post("/api/find-match", rlTight, async (req, res) => {
    const { game, asset, stake, socketId, walletAddress } = (req.body ?? {}) as Partial<FindMatchBody>;
    // Off-chain kill switch: if the operator has paused this asset (or
    // global), refuse to enter matchmaking so no new money flows in.
    // Live matches still settle via /api/escrow/settle-auth which is
    // intentionally NOT pause-gated.
    if (typeof asset === "string") {
      const p = await isOraclePaused(asset);
      if (p.paused) {
        return res.status(503).json({
          error: "oracle_paused",
          message: "Matchmaking is temporarily paused by the platform. Existing matches will settle normally.",
          scope: p.scope,
          reason: p.reason,
        });
      }
    }

    if (!isGame(game) || !isAsset(asset) || !socketId) {
      return res.status(400).json({ error: "bad params" });
    }
    const numericStake = Number(stake);
    if (!Number.isFinite(numericStake) || numericStake <= 0) {
      return res.status(400).json({ error: "invalid stake" });
    }

    // Anti-cheat L1: per-wallet matchmaking cooldown. Short TTL stamped
    // on both players when their previous match settled (see
    // server/socket.ts → storeGameResult). Reject re-queue attempts
    // while the cooldown is active so trivial bots that re-queue the
    // instant a match ends never reach matchmaking.
    if (typeof walletAddress === "string" && walletAddress.length > 0) {
      const remainingMs = await getMatchmakingCooldownRemainingMs(walletAddress);
      if (remainingMs > 0) {
        const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
        recordMatchmakingCooldownRejection();
        console.warn(
          `[find-match] cooldown rejected wallet=${walletAddress} remainingMs=${remainingMs}`
        );
        return res.status(429).json({
          error: "matchmaking_cooldown",
          message: `Please wait ${remainingSec} second${remainingSec === 1 ? "" : "s"} before searching for another match.`,
          retryAfterMs: remainingMs,
          retryAfterSec: remainingSec,
        });
      }
    }

    // Wallet shape validation via shared/walletShape.ts (same validator
    // used by create-challenge and accept-challenge).
    let cleanWallet = "";
    if (walletAddress && typeof walletAddress === "string" && isValidWalletShape(asset, walletAddress)) {
      cleanWallet = walletAddress;
    }
    if (!cleanWallet) {
      return res.status(400).json({
        error: `Wallet address required for asset ${asset} (BNB/ETH need EVM, USDT needs Tron base58, TON needs TON address)`,
      });
    }

    // Block the platform's own infrastructure wallets (oracle / deployer /
    // platform/cold wallet) from ever entering matchmaking. See
    // server/security/systemAddresses.ts for the full rationale: this stops
    // both insider mistakes (operator imports the oracle key into MetaMask
    // and clicks Find Match) and external griefing attacks (anyone who
    // scrapes BscScan can see the oracle's public address and use it to
    // claim a queue slot they can never sign for, locking the matched real
    // player's deposit until the 15-min auth deadline expires).
    const sysCheck = await checkSystemAddress(asset, cleanWallet);
    if (!sysCheck.ok) {
      console.warn(`[find-match] Rejected system-address wallet ${cleanWallet} (asset=${asset}, socket=${socketId})`);
      return res.status(403).json({
        error: sysCheck.reason,
        message:
          "This wallet address is reserved for platform infrastructure (oracle / deployer / platform wallet). Please connect a different wallet.",
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

    // Anti-cheat L1 (Task #46) — HTTP-layer ban gate.
    //   - 'banned'       → explicit rejection so the client surfaces a
    //                      "your account has been suspended" toast.
    //   - 'shadowbanned' → fall through to findOrCreateMatch, which
    //                      enqueues the requester normally and never
    //                      pairs them. The HTTP response is identical
    //                      to an honest user's "waiting" so the UI
    //                      cannot tell shadowban from "queue is empty".
    //   - 'active'       → unchanged.
    // Anti-cheat L1 (Task #46): record this wallet as having interacted
    // with the system BEFORE the ban gate fires. A banned wallet still
    // hitting matchmaking is itself activity admins want to see in
    // lastSeenAt (it tells them the suspended user is still trying).
    touchUser(cleanWallet).catch(() => {});

    const status = await getUserStatus(cleanWallet);
    if (status === "banned") {
      console.warn(`[find-match] hard-banned wallet rejected: ${cleanWallet}`);
      return res.status(403).json({
        error: "banned",
        message: "Your account has been suspended. Contact support if you believe this is a mistake.",
      });
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

  // ============================================================
  // Anti-cheat L1 — Admin user-status endpoints (Task #46).
  // ============================================================
  // Internal-only; gated by ADMIN_WALLET_ALLOWLIST + per-request EVM
  // signature. There is no public UI yet — the admin dashboard is a
  // Level 2 task. See server/security/adminAuth.ts for the signature
  // contract.

  app.get("/api/admin/users/:wallet", requireAdminWallet, async (req, res) => {
    const wallet = String(req.params.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const u = await getUser(wallet);
    if (!u) {
      // Honest "this wallet has never been seen" — distinct from
      // "this wallet is active" because the admin tooling cares.
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.status(200).json({ user: u });
  });

  app.post("/api/admin/users/:wallet/status", requireAdminWallet, async (req, res) => {
    const wallet = String(req.params.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const { status, reason } = (req.body ?? {}) as { status?: string; reason?: string };
    const parsed = UserStatusEnum.safeParse(status);
    if (!parsed.success) {
      return res.status(400).json({
        error: "bad_status",
        message: "status must be 'active' | 'shadowbanned' | 'banned'.",
      });
    }
    try {
      const updated = await setUserStatus({
        wallet,
        status: parsed.data,
        reason: typeof reason === "string" && reason.length > 0 ? reason.slice(0, 200) : null,
        by: req.adminAuth?.wallet || "admin",
      });
      // If we just hard-banned a wallet, kick any of their live
      // sockets so an in-flight match can't continue under a banned
      // account. Lookup keys playerId by wallet address (matchmaking
      // flow uses wallet AS playerId).
      if (parsed.data === "banned") {
        try {
          // Use the dedicated wallet→socket map exported from
          // server/socket.ts. The matchmaking flow stores wallet AS
          // playerId, so playerToSocket is the authoritative index;
          // a previous version of this code looked at a `socket.data`
          // field that was never set, so live bans never disconnected.
          const { disconnectWalletSockets } = await import("./socket");
          const killed = disconnectWalletSockets(wallet);
          if (killed > 0) {
            console.warn(
              `[admin] hard-ban on ${wallet} kicked ${killed} live socket(s)`,
            );
          }
        } catch (e: any) {
          console.warn(`[admin] socket kick on ban failed: ${e?.message || e}`);
        }
      }
      return res.status(200).json({ user: updated });
    } catch (e: any) {
      console.error(`[admin] setUserStatus failed:`, e?.message || e);
      return res.status(500).json({ error: "set_status_failed", message: e?.message || String(e) });
    }
  });

  // =====================
  // CHALLENGE FRIEND FEATURE
  // =====================
  
  app.post("/api/create-challenge", rlTight, async (req, res) => {
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

    // Per-asset wallet format validation. Mirrors /api/find-match L66-83
    // because `challengerId` IS the wallet address that will be written
    // into the eventual match's `addr1`. If the challenger sends an
    // EVM-shaped address while the asset is USDT (Tron) or TON, every
    // downstream deposit/oracle call would fail with a confusing
    // "wrong-shape" error several screens later. Catch it here.
    {
      const a = String(challengerId);
      // Centralised in shared/walletShape.ts so all three matchmaking
      // entry points stay in sync — divergence here was the original
      // root cause of the "create-challenge accepts EVM addr for USDT"
      // bug from the audit.
      const okShape = isValidWalletShape(asset, a);
      if (!okShape) {
        return res.status(400).json({
          error: "wallet_shape_mismatch",
          message: `The connected wallet does not match the chosen asset (${asset}). Connect a ${
            asset === "BNB" || asset === "ETH"
              ? "MetaMask / EVM"
              : asset === "USDT"
              ? "TronLink"
              : "TON"
          } wallet and try again.`,
        });
      }
    }

    // System-address guard for the challenge flow.
    //
    // The client passes its EVM/Tron/TON wallet address as `challengerId`
    // (see Lobby.tsx — `realWallet.evmAddress || .tronAddress || .tonAddress`).
    // /api/find-match has the same guard; mirroring it here is required
    // because challenges are a *separate* entry point into matchmaking and
    // would otherwise allow the very same DoS / self-match-against-oracle
    // accident the blacklist exists to prevent.
    {
      const sysCheck = await checkSystemAddress(asset, String(challengerId));
      if (!sysCheck.ok) {
        console.warn(
          `[security] /api/create-challenge rejected forbidden challenger ${challengerId} for ${asset} (${sysCheck.reason})`
        );
        return res.status(403).json({
          error: sysCheck.reason,
          message:
            "This wallet is reserved for platform infrastructure and cannot play. Please use a personal wallet.",
          code: "wallet_is_system_address",
        });
      }
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
  app.get("/api/challenge/:challengeId", rlLoose, async (req, res) => {
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
  
  app.post("/api/accept-challenge", rlTight, async (req, res) => {
    const { challengeId, accepterId, accepterSocketId, accepterName } = req.body ?? {};
    
    if (!challengeId || !accepterId || !accepterSocketId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Atomic accept lock — without this, two players who click the same
    // share link within milliseconds of each other would BOTH pass the
    // `status === "pending"` check below (since the read-then-write is
    // not atomic) and BOTH spawn a match for the challenge, with the
    // last writer's matchId silently winning the stored challenge state.
    // SETNX with a short TTL guarantees only one accept request enters
    // the critical section per challenge. The lock auto-expires so a
    // crashed or slow request can't block legitimate retries forever.
    const lockKey = `challenge_accept_lock:${challengeId}`;
    const gotLock = await redis.set(lockKey, accepterId, { nx: true, ex: 30 });
    if (!gotLock) {
      return res.status(409).json({
        error: "challenge_accept_in_progress",
        message:
          "Someone else is already accepting this challenge. Please try a different match.",
      });
    }

    const data = await redis.get(`challenge:${challengeId}`);

    if (!data) {
      await redis.del(lockKey);
      return res.status(404).json({ error: "Challenge not found or expired" });
    }
    
    const challenge: ChallengeData = typeof data === "string" ? JSON.parse(data) : data;
    
    if (challenge.status !== "pending") {
      await redis.del(lockKey);
      return res.status(400).json({ error: "Challenge already accepted" });
    }
    
    if (challenge.challengerId === accepterId) {
      await redis.del(lockKey);
      return res.status(400).json({ error: "Cannot accept your own challenge" });
    }

    // Per-asset wallet format validation for the accepter. Same rationale
    // as in /api/create-challenge: `accepterId` will be written as
    // `addr2` on the match and used by every downstream deposit/oracle
    // call. The challenger's address was validated when the challenge
    // was created, so we only need to re-check the accepter here.
    {
      const a = String(accepterId);
      const okShape = isValidWalletShape(String(challenge.asset), a);
      if (!okShape) {
        await redis.del(lockKey);
        return res.status(400).json({
          error: "wallet_shape_mismatch",
          message: `Your connected wallet does not match this challenge's asset (${
            challenge.asset
          }). Connect a ${
            challenge.asset === "BNB" || challenge.asset === "ETH"
              ? "MetaMask / EVM"
              : challenge.asset === "USDT"
              ? "TronLink"
              : "TON"
          } wallet and try again.`,
        });
      }
    }

    // System-address guard for the challenge accept path. We check BOTH the
    // accepter (incoming) and the stored challenger — the latter as
    // defense-in-depth so an old pending challenge created before this
    // guard was added (or before an env var rotation enlarged the
    // forbidden set) can still be blocked at accept time.
    {
      const accepterCheck = await checkSystemAddress(challenge.asset, String(accepterId));
      if (!accepterCheck.ok) {
        await redis.del(lockKey);
        console.warn(
          `[security] /api/accept-challenge rejected forbidden accepter ${accepterId} for ${challenge.asset} (${accepterCheck.reason})`
        );
        return res.status(403).json({
          error: accepterCheck.reason,
          message:
            "This wallet is reserved for platform infrastructure and cannot play. Please use a personal wallet.",
          code: "wallet_is_system_address",
        });
      }
      const challengerCheck = await checkSystemAddress(
        challenge.asset,
        String(challenge.challengerId)
      );
      if (!challengerCheck.ok) {
        await redis.del(lockKey);
        console.warn(
          `[security] /api/accept-challenge rejected — stored challenger ${challenge.challengerId} is a forbidden system address for ${challenge.asset} (${challengerCheck.reason})`
        );
        return res.status(403).json({
          error: challengerCheck.reason,
          message:
            "This challenge cannot be accepted because the challenger's wallet is reserved for platform infrastructure.",
          code: "challenger_is_system_address",
        });
      }
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
    
    // V2: every deposit / oracle-auth / settlement endpoint reads the
    // players' wallet addresses from `addr1` / `addr2` (see
    // /api/oracle/match-auth, /api/oracle/sign-deposit-permit,
    // /api/ton/deposit-info, /api/ton/notify-deposit, and the queue path
    // in matchmaking/redisMatchmaking.ts L73-74). The challenge flow
    // previously only wrote `p1`/`p2` (which the queue uses for socket
    // ids), so challenge matches could never actually be funded — every
    // deposit attempt failed with "Match missing wallet addresses".
    // Both `challengerId` and `accepterId` ARE the wallet addresses (set
    // by the client in Lobby.tsx and Challenge.tsx), already validated
    // for shape and against the system-address blacklist above, so we
    // store them verbatim here exactly as the queue path does.
    const matchData = {
      matchId,
      game: challenge.game,
      asset: challenge.asset,
      stake: challenge.stake,
      player1Id: challenge.challengerId,
      player2Id: accepterId,
      p1: challenge.challengerId,
      p2: accepterId,
      addr1: challenge.challengerId,
      addr2: accepterId,
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

    // Release the accept lock — challenge.status is now "accepted" in
    // Redis, so the status check above will reject any future accept
    // even with the lock gone. Releasing now keeps the lock from
    // sitting on a dead key for the rest of its 30s TTL.
    await redis.del(lockKey);

    return res.status(200).json({
      matchId,
      game: challenge.game,
      asset: challenge.asset,
      stake: challenge.stake,
      challengerId: challenge.challengerId,
      challengerName: challenge.challengerName
    });
  });

  app.post("/api/cancel-challenge", rlMedium, async (req, res) => {
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

  app.get("/api/challenges/:userId", rlLoose, async (req, res) => {
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

  app.get("/api/history/:playerId", rlLoose, async (req, res) => {
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

  // Anti-cheat L1 — durable move history (Task #43).
  //
  // Returns the chronological list of server-validated moves for a match,
  // gated to the two real participants. Identity is proven by an HMAC
  // bearer token issued at socket-join time (`server/security/matchToken.ts`):
  // a raw `walletAddress` query param is NOT trusted on its own, since
  // an attacker who scraped a participant address from the chain could
  // otherwise read the private move log.
  //
  // Pagination uses a cursor-style `afterPly` parameter plus a bounded
  // page size; the client (or a forensic operator) can iterate through
  // arbitrarily long histories without the server silently truncating.
  app.get("/api/matches/:matchId/moves", rlLoose, async (req, res) => {
    const { matchId } = req.params;
    const walletAddress = typeof req.query.walletAddress === "string"
      ? req.query.walletAddress
      : "";
    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";

    if (!matchId || !walletAddress) {
      return res.status(400).json({ error: "matchId and walletAddress required" });
    }
    if (!bearer) {
      return res.status(401).json({ error: "missing_bearer_token" });
    }
    if (!verifyMatchToken(matchId, walletAddress, bearer)) {
      return res.status(401).json({ error: "invalid_match_token" });
    }

    // Pagination: bounded page size, no silent truncation. Default page
    // is generous (1000) but the client can request up to PAGE_MAX_SIZE
    // and continue with `afterPly` to walk the full history.
    const PAGE_MAX_SIZE = 5000;
    const PAGE_DEFAULT_SIZE = 1000;
    const rawLimit = Number(req.query.limit);
    const pageLimit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), PAGE_MAX_SIZE)
      : PAGE_DEFAULT_SIZE;
    const rawAfter = Number(req.query.afterPly);
    const afterPly = Number.isFinite(rawAfter) && rawAfter > 0
      ? Math.floor(rawAfter)
      : 0;

    let player1Id: string | null = null;
    let player2Id: string | null = null;
    try {
      const md = await redis.hgetall(`match:${matchId}`);
      if (md && (md.addr1 || md.player1Id)) {
        player1Id = String(md.addr1 || md.player1Id);
        player2Id = String(md.addr2 || md.player2Id);
      }
    } catch (err: any) {
      console.warn("[moves] redis lookup failed:", err?.message || err);
    }

    if (!player1Id || !player2Id) {
      try {
        const rows = await db.select({
          player1Id: matches.player1Id,
          player2Id: matches.player2Id,
        })
          .from(matches)
          .where(eq(matches.matchId, matchId))
          .limit(1);
        if (rows.length > 0) {
          player1Id = rows[0].player1Id;
          player2Id = rows[0].player2Id;
        }
      } catch (err: any) {
        console.error("[moves] match lookup failed:", err?.message || err);
        return res.status(500).json({ error: "lookup_failed" });
      }
    }

    if (!player1Id || !player2Id) {
      return res.status(404).json({ error: "match_not_found" });
    }

    // Belt-and-braces: the token already proves caller controls a
    // wallet that joined this match, but we still cross-check that the
    // wallet is actually one of the two stored participants in case
    // tokens leaked from a stale or aborted match somehow show up here.
    if (walletAddress !== player1Id && walletAddress !== player2Id) {
      return res.status(403).json({ error: "not_a_participant" });
    }

    try {
      const rows = await db.select()
        .from(matchMoves)
        .where(
          afterPly > 0
            ? and(eq(matchMoves.matchId, matchId), gt(matchMoves.ply, afterPly))
            : eq(matchMoves.matchId, matchId),
        )
        .orderBy(asc(matchMoves.ply))
        .limit(pageLimit + 1);
      const hasMore = rows.length > pageLimit;
      const page = hasMore ? rows.slice(0, pageLimit) : rows;
      return res.status(200).json({
        matchId,
        moves: page.map((r) => ({
          ply: r.ply,
          gameType: r.gameType,
          actorId: r.actorId,
          payload: r.payload,
          serverTimestampMs: r.serverTimestampMs,
          msSinceLastMove: r.msSinceLastMove,
        })),
        hasMore,
        nextAfterPly: hasMore ? page[page.length - 1].ply : null,
      });
    } catch (err: any) {
      console.error("[moves] fetch failed:", err?.message || err);
      return res.status(500).json({ error: "fetch_failed" });
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
  app.post("/api/oracle/match-auth", rlMedium, async (req, res) => {
    const { matchId } = req.body ?? {};

    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.stake || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }

      if (matchData.addr1 || matchData.addr2) {
        // Soft-ban gate (Task #46). If either participant has been
        // hard-banned since matchmaking, refuse the deposit auth so the
        // honest opponent doesn't put real money behind a match the
        // banned account can no longer settle from.
        const banGate = await checkDepositBanForWallets([
          String(matchData.addr1 || ""),
          String(matchData.addr2 || ""),
        ]);
        if (!banGate.ok) {
          return res.status(banGate.status).json(banGate.body);
        }
        touchUser(String(matchData.addr1 || "")).catch(() => {});
        touchUser(String(matchData.addr2 || "")).catch(() => {});
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
  app.get("/api/oracle/match-status/:matchId", rlLoose, async (req, res) => {
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
  app.post("/api/tron/deposit-auth", rlMedium, async (req, res) => {
    const { matchId } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || !matchData.stake || !matchData.asset) {
        return res.status(404).json({ error: "Match not found" });
      }

      if (matchData.addr1 || matchData.addr2) {
        const banGate = await checkDepositBanForWallets([
          String(matchData.addr1 || ""),
          String(matchData.addr2 || ""),
        ]);
        if (!banGate.ok) {
          return res.status(banGate.status).json(banGate.body);
        }
        touchUser(String(matchData.addr1 || "")).catch(() => {});
        touchUser(String(matchData.addr2 || "")).catch(() => {});
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
  app.post("/api/tron/deposit-sig", rlMedium, async (req, res) => {
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
  app.get("/api/tron/match-status/:matchId", rlLoose, async (req, res) => {
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
  app.get("/api/tron/config", rlLoose, async (_req, res) => {
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
  app.get("/api/tron/readiness", rlMedium, async (req, res) => {
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
  app.get("/api/escrow/settle-auth/:matchId", rlMedium, settleAuthHandler);
  app.post("/api/escrow/settle-auth/:matchId", rlMedium, settleAuthHandler);
  app.post("/api/escrow/settle-auth", rlMedium, settleAuthHandler);

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
  app.get("/api/health/oracles", rlLoose, async (_req, res) => {
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
      const { createTronOracle, getLastTrxBalanceCheck } = await import("./oracle/tronOracle");
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
        lastBalanceCheck: getLastTrxBalanceCheck(),
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

    // Per-asset off-chain pause kill-switch state. The contracts
    // themselves are not Pausable on-chain (deployed before that was
    // prioritized), so the operator's only "pause" lever is refusing
    // to issue oracle signatures — surfacing the live state here lets
    // anyone monitoring see whether the platform is accepting deposits.
    let pauseState: any;
    try {
      pauseState = await getPauseStatus();
    } catch (e: any) {
      pauseState = { error: e?.message || String(e) };
    }

    const overallOk = Object.values(results).every((r) => r.ok && r.okForGas !== false);
    return res.json({
      ok: overallOk,
      chains: results,
      systemAddresses: getSystemAddressesStatus(),
      pause: pauseState,
      ops: getOpsAlertStatus(),
      reconciliation: getReconciliationStatus(),
      abuseCounters: getAbuseCountersStatus(),
      timestamp: Date.now(),
    });
  });

  // ============================================================
  // Off-chain oracle kill-switch (Task #5)
  // ============================================================
  //
  // The live V2 escrows on every chain are NOT Pausable on-chain —
  // they were deployed before that was prioritized. So the only lever
  // we have to halt new deposits across the board is to refuse to
  // issue oracle signatures. This endpoint flips the Redis flag that
  // the oracle signing paths consult on every call.
  //
  // Auth model: shared secret in `OPS_KILLSWITCH_TOKEN` sent in the
  // X-Ops-Token header. Constant-time compare. NOT exposed to the
  // browser bundle anywhere — only ops tooling should know it.
  //
  // Settlement (signMatchOutcome / submitSettlement) is intentionally
  // NOT gated. If the platform is paused, in-flight matches still
  // resolve so escrowed funds always have a path out.
  function checkOpsToken(req: any): boolean {
    const provided = String(req.headers["x-ops-token"] || "");
    const expected = process.env.OPS_KILLSWITCH_TOKEN || "";
    if (!expected || expected.length < 16) return false;
    if (!provided || provided.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ============================================================
  // Live network-fee estimates (Task #8)
  // ============================================================
  // Returns a per-asset breakdown of the gas/network fee a player will
  // pay (or that the platform will pay on their behalf for Tron settles).
  // Cached server-side for 60s and rate-limited under the loose tier.
  app.get("/api/network-fees", rlLoose, async (_req, res) => {
    try {
      const snapshot = await getNetworkFees();
      return res.json(snapshot);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "fee estimation failed" });
    }
  });

  app.get("/api/oracle/pause", rlMedium, async (_req, res) => {
    // Public read of the current pause state. Anyone (including the
    // browser UI) can see this; only POST is protected.
    try {
      const status = await getPauseStatus();
      return res.json({ ok: true, pause: status });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/api/oracle/pause", rlMedium, async (req, res) => {
    if (!checkOpsToken(req)) {
      return res.status(403).json({ error: "forbidden" });
    }
    const { scope, paused, reason, setBy } = (req.body ?? {}) as {
      scope?: string;
      paused?: boolean;
      reason?: string;
      setBy?: string;
    };
    const validScopes: PauseScope[] = ["all", "BNB", "ETH", "USDT", "TON"];
    if (!scope || !validScopes.includes(scope as PauseScope)) {
      return res.status(400).json({
        error: "invalid scope",
        validScopes,
      });
    }
    if (typeof paused !== "boolean") {
      return res.status(400).json({ error: "paused must be a boolean" });
    }
    try {
      const record = await setPause(
        scope as PauseScope,
        paused,
        reason || null,
        setBy || "ops"
      );
      return res.json({ ok: true, scope, record });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // ============================================================
  // TON native escrow endpoints (Task #14)
  // ============================================================

  /**
   * GET /api/ton/config
   * Public TON config so the frontend knows the escrow address + chain info.
   */
  app.get("/api/ton/config", rlLoose, async (_req, res) => {
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
  app.get("/api/ton/readiness", rlMedium, async (req, res) => {
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
  app.post("/api/ton/deposit-info", rlMedium, async (req, res) => {
    const { matchId } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }
    // Off-chain pause kill-switch: TON has no oracle signature on the
    // deposit (the contract auto-creates the match on the first
    // Deposit message), so the only place we can refuse new TON
    // deposits is right here, before handing back the BOC payload.
    const pausedCheck = await isOraclePaused("TON");
    if (pausedCheck.paused) {
      return res.status(503).json({
        error: "oracle_paused",
        message: "TON deposits are temporarily paused. Existing matches will settle normally.",
        scope: pausedCheck.scope,
        reason: pausedCheck.reason,
      });
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

      const banGate = await checkDepositBanForWallets([player1, player2]);
      if (!banGate.ok) {
        return res.status(banGate.status).json(banGate.body);
      }
      touchUser(player1).catch(() => {});
      touchUser(player2).catch(() => {});

      // Defense-in-depth backstop for TON.
      //
      // Unlike EVM (signMatchAuth) and Tron (buildDepositAuth), there's no
      // oracle deposit-auth signature path on TON to reject a forbidden
      // address from. /api/ton/deposit-info is therefore the last
      // server-side checkpoint before the player builds the deposit BOC,
      // so we re-validate both addresses here. Matchmaking already blocks
      // these wallets at queue time, but this protects any future code
      // path that lands a forbidden address into a TON match without going
      // through the matchmaking guard.
      for (const [label, addr] of [["addr1", player1], ["addr2", player2]] as const) {
        const sysCheck = await checkSystemAddress("TON", addr);
        if (!sysCheck.ok) {
          console.warn(
            `[security] /api/ton/deposit-info rejected — match ${matchId} ${label}=${addr} is a forbidden system address (${sysCheck.reason})`
          );
          return res.status(403).json({
            error: sysCheck.reason,
            message:
              "This match cannot be funded because one of the wallets is reserved for platform infrastructure.",
            code: "wallet_is_system_address",
          });
        }
      }

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
  app.get("/api/ton/match-status/:matchId", rlLoose, async (req, res) => {
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
   * POST /api/ton/refund-info
   * Body: { matchId, walletAddress }
   *
   * Returns the BOC payload + escrow address + gas amount that the depositor
   * must send via TonConnect to recover funds from a single-sided pending
   * match (i.e. their opponent never deposited and the contract's
   * deposit-timeout window has elapsed). The contract enforces the actual
   * eligibility rules in `RefundNoShow`, but we pre-check here so the UI
   * can show a precise error instead of a TonKeeper "transaction failed".
   */
  app.post("/api/ton/refund-info", rlMedium, async (req, res) => {
    const { matchId, walletAddress } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }
    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({ error: "walletAddress is required" });
    }
    try {
      const { createTonOracle } = await import("./oracle/tonOracle");
      const ton = createTonOracle();
      const m = await ton.getMatchOnChain(matchId);
      if (!m) {
        return res.status(404).json({
          error: "match_not_found",
          message: "No match with that ID exists in the escrow contract.",
        });
      }
      if (m.status !== 1) {
        const label = ["none", "pending", "active", "settled", "cancelled"][m.status] ?? "unknown";
        return res.status(409).json({
          error: "not_pending",
          message: `Match is not refundable — on-chain status is '${label}'.`,
          onChainStatus: m.status,
        });
      }
      if (m.p1Funded === m.p2Funded) {
        // Either both funded (impossible for status=pending) or neither
        // funded (also impossible — first deposit creates the match).
        return res.status(409).json({
          error: "invalid_funding_state",
          message: "Match funding state is inconsistent with a single-sided refund.",
        });
      }

      // Compare normalized raw addresses so different friendly encodings
      // (bounceable vs non-bounceable, EQ vs UQ) all match.
      const { Address } = await import("@ton/core");
      let walletRaw: string;
      let p1Raw: string;
      let p2Raw: string;
      try {
        walletRaw = Address.parse(walletAddress).toRawString();
        p1Raw = Address.parse(m.player1).toRawString();
        p2Raw = Address.parse(m.player2).toRawString();
      } catch {
        return res.status(400).json({ error: "Malformed TON address" });
      }

      const depositorRaw = m.p1Funded ? p1Raw : p2Raw;
      if (walletRaw !== depositorRaw) {
        const depositorFriendly = m.p1Funded ? m.player1 : m.player2;
        return res.status(403).json({
          error: "not_depositor",
          message: `Only the original depositor (${depositorFriendly}) can claim this refund. Connect that wallet in TonConnect.`,
          depositorAddress: depositorFriendly,
        });
      }

      // Read the contract's deposit-timeout window so the UI can show the
      // exact eligibility window. Cheap read, ~1 RPC call.
      const { TonClient } = await import("@ton/ton");
      const client = new TonClient({
        endpoint: process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC",
        apiKey: process.env.TON_API_KEY,
      });
      const escrowAddr = Address.parse(ton.escrowAddressFriendly);
      let timeoutSec = 3600;
      try {
        const r = await client.runMethod(escrowAddr, "getDepositTimeoutSeconds", []);
        timeoutSec = Number(r.stack.readBigNumber());
      } catch (e: any) {
        console.warn(`[ton/refund-info] could not read getDepositTimeoutSeconds: ${e?.message || e}`);
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const eligibleAtSec = m.firstDepositAt + timeoutSec;
      // Contract uses strict `now() > firstDepositAt + timeout`, so we must
      // reject the exact-equality second too — otherwise the TX would revert
      // on-chain after the user signed the prompt.
      if (nowSec <= eligibleAtSec) {
        return res.status(409).json({
          error: "timeout_not_elapsed",
          message: `Deposit timeout has not elapsed. You can claim refund after epoch ${eligibleAtSec}.`,
          eligibleAtSec,
          firstDepositAtSec: m.firstDepositAt,
          timeoutSec,
          nowSec,
        });
      }

      const payloadBoc = ton.encodeRefundNoShowPayload(matchId);
      const gasNano = "50000000"; // 0.05 TON gas — contract refunds excess.
      const validUntilSec = nowSec + 15 * 60;

      console.log(
        `[ton/refund-info] match=${matchId} depositor=${walletAddress} elapsed=${nowSec - m.firstDepositAt}s — refund authorised`
      );
      return res.json({
        matchId,
        escrowAddress: ton.escrowAddressFriendly,
        amountNano: gasNano,
        payloadBoc,
        validUntilSec,
        stakeNano: m.stakeNano,
        depositorAddress: m.p1Funded ? m.player1 : m.player2,
      });
    } catch (err: any) {
      console.error("[ton/refund-info] Error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Failed to build refund info" });
    }
  });

  /**
   * POST /api/ton/notify-deposit
   * Body: { matchId, txInfo?, playerAddress }
   *
   * Defence-in-depth gameplay-gate fallback fired by the client right
   * after `tc.sendTransaction` resolves. When BOTH match participants
   * have independently notified for the same matchId we fire
   * `markMatchFunded` and emit `match-funded` regardless of whether the
   * `/api/ton/match-status` on-chain poller has confirmed yet. This way
   * a future regression in the toncenter `getMatch` reader can't strand
   * a paid-up game on the "waiting for on-chain confirmation" screen.
   *
   * SECURITY: `playerAddress` is required and must equal `match.addr1`
   * or `match.addr2` after canonical-form (raw `0:hex`) normalization.
   * We track the two slots independently in Redis so a single attacker
   * cannot force `match-funded` by POSTing twice with arbitrary values.
   * Note that the address itself is still self-asserted — anyone who
   * knew BOTH `addr1` and `addr2` and the matchId could in principle
   * forge two notifications. This breadcrumb only releases the off-chain
   * gameplay gate; actual settlement requires real on-chain funds (the
   * oracle refuses to sign a settle for a contract Match that isn't
   * ACTIVE on-chain), so the worst-case impact of a forged emission is
   * a chess game that can never be paid out. A future task will add a
   * TonConnect proof-of-ownership signature here so the path can be
   * promoted to fully trusted.
   */
  app.post("/api/ton/notify-deposit", rlMedium, async (req, res) => {
    const { matchId, txInfo, playerAddress } = req.body ?? {};
    if (!matchId || typeof matchId !== "string") {
      return res.status(400).json({ error: "Invalid matchId" });
    }
    if (!playerAddress || typeof playerAddress !== "string") {
      return res.status(400).json({ error: "playerAddress is required" });
    }
    console.log(
      `[ton/notify-deposit] match=${matchId} player=${playerAddress} txInfo=${JSON.stringify(txInfo || {})}`,
    );

    try {
      const matchData = await redis.hgetall(`match:${matchId}`);
      if (!matchData || String(matchData.asset || "") !== "TON") {
        return res.json({ ok: true });
      }
      const addr1 = String(matchData.addr1 || "");
      const addr2 = String(matchData.addr2 || "");
      if (!addr1 || !addr2) {
        return res.json({ ok: true });
      }

      // Normalize all three addresses to raw form so friendly vs raw vs
      // bounceable-vs-non-bounceable encodings all compare equal.
      const { Address } = await import("@ton/core");
      let notifierRaw: string;
      let addr1Raw: string;
      let addr2Raw: string;
      try {
        notifierRaw = Address.parse(playerAddress).toRawString();
        addr1Raw = Address.parse(addr1).toRawString();
        addr2Raw = Address.parse(addr2).toRawString();
      } catch {
        return res.status(400).json({ error: "Malformed TON address" });
      }

      let slot: "p1" | "p2";
      if (notifierRaw === addr1Raw) {
        slot = "p1";
      } else if (notifierRaw === addr2Raw) {
        slot = "p2";
      } else {
        console.warn(
          `[ton/notify-deposit] rejected non-participant ${playerAddress} for match ${matchId}`,
        );
        return res.status(403).json({ error: "Not a participant in this match" });
      }

      // Per-slot flags (and a SET of normalized addrs so the "count" is
      // explicitly two distinct participants, never the same one twice).
      const slotKey = `ton_notify_slot:${matchId}:${slot}`;
      await redis.set(slotKey, "1", { ex: 60 * 60 });
      const setKey = `ton_notify_count:${matchId}`;
      await redis.sadd(setKey, notifierRaw);
      await redis.expire(setKey, 60 * 60);

      const otherKey = `ton_notify_slot:${matchId}:${slot === "p1" ? "p2" : "p1"}`;
      const otherSet = await redis.get(otherKey);
      if (!otherSet) {
        return res.json({ ok: true, waitingForOther: true });
      }

      const fundedKey = `ton_funded_emitted:${matchId}`;
      const first = await redis.set(fundedKey, "1", { ex: 60 * 60 * 24, nx: true });
      if (first) {
        try {
          const { markMatchFunded } = await import("./socket");
          markMatchFunded(matchId);
          io.to(`match:${matchId}`).emit("match-funded", {
            matchId,
            chain: "TON",
            player1: addr1,
            player2: addr2,
          });
          console.log(
            `[ton/notify-deposit] match-funded emitted via notify fallback for ${matchId}`,
          );
        } catch (e: any) {
          console.error("[ton/notify-deposit] failed to emit match-funded:", e?.message || e);
        }
      }
    } catch (e: any) {
      // Defensive: never let breadcrumb bookkeeping fail the client request.
      console.error("[ton/notify-deposit] bookkeeping error:", e?.message || e);
    }

    return res.json({ ok: true });
  });

  return httpServer;
}

export default registerRoutes;