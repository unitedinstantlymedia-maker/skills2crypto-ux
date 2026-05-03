import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { db } from "./db";
import { matches, matchMoves } from "../shared/schema";
import { issueMatchToken } from "./security/matchToken";
import { eq } from "drizzle-orm";
import {
  applyMove as chessApplyMove,
  detectTerminal as chessDetectTerminal,
  INITIAL_TIME_MS as CHESS_INITIAL_TIME_MS,
  newGame as chessNewGame,
  type Chess as ChessInstance,
} from "../shared/games/chess";
import {
  blockedWinner as dominoesBlockedWinner,
  canPlayAt as dominoesCanPlayAt,
  dealHands as dominoesDealHands,
  hasLegalMove as dominoesHasLegalMove,
  INITIAL_TIME_MS as DOMINOES_INITIAL_TIME_MS,
  placeTile as dominoesPlaceTile,
  type ChainEnd as DominoesChainEnd,
  type PlacedTile as DominoesPlacedTile,
  type PlayerRole as DominoesPlayerRole,
  type Tile as DominoesTile,
} from "../shared/games/dominoes";
import {
  allLegalMoves as checkersAllLegalMoves,
  applyMove as checkersApplyMove,
  countPieces as checkersCountPieces,
  findLegalMove as checkersFindLegalMove,
  getJumpsFromSquare as checkersGetJumpsFromSquare,
  initialBoard as checkersInitialBoard,
  INITIAL_TIME_MS as CHECKERS_INITIAL_TIME_MS,
  isCaptureMove as checkersIsCaptureMove,
  serializeBoard as checkersSerializeBoard,
  type Board as CheckersBoard,
  type PieceColor as CheckersColor,
  type Position as CheckersPosition,
} from "../shared/games/checkers";
import {
  applyMove as xiangqiApplyMove,
  detectPerpetualCheckLoser as xiangqiDetectPerpetualCheckLoser,
  findGeneral as xiangqiFindGeneral,
  initialBoard as xiangqiInitialBoard,
  INITIAL_TIME_MS as XIANGQI_INITIAL_TIME_MS,
  isCaptureMove as xiangqiIsCaptureMove,
  isInCheck as xiangqiIsInCheck,
  isLegalMove as xiangqiIsLegalMove,
  positionKey as xiangqiPositionKey,
  serializeBoard as xiangqiSerializeBoard,
  statusFor as xiangqiStatusFor,
  type Board as XiangqiBoard,
  type Color as XiangqiColor,
  type HistoryEntry as XiangqiHistoryEntry,
  type Square as XiangqiSquare,
} from "../shared/games/xiangqi";

// Spec rule: 60 full moves (= 120 plies) without a capture ⇒ automatic draw.
const XIANGQI_NO_CAPTURE_DRAW_PLIES = 120;
import { redis } from "./redis";
import {
  acquireSocketSlot,
  releaseSocketSlot,
  setMatchmakingCooldown,
} from "./security/socketLimits";

interface SocketOptions {
  isProd: boolean;
  allowedOrigins: string[];
}

interface ChessMoveInput {
  matchId: string;
  from: string;
  to: string;
  promotion?: string;
}

interface PlayerInfo {
  socketId: string;
  color: 'white' | 'black';
}

interface MatchRoom {
  players: Map<string, PlayerInfo>;
  game: ChessInstance;
  whiteTime: number;
  blackTime: number;
  lastTickAt: number;
  lastMove: { from: string; to: string; san: string } | null;
  started: boolean;
}

const matchRooms = new Map<string, MatchRoom>();
const socketToPlayer = new Map<string, { matchId: string; playerId: string; gameType?: string }>();
const playerToSocket = new Map<string, string>(); // playerId -> socketId (for reconnect tracking)
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>(); // playerId -> timeout

interface GameResult {
  matchId: string;
  gameType: string;
  winnerId: string | null;
  loserId: string | null;
  result: 'win' | 'loss' | 'draw';
  reason: string;
  timestamp: number;
}

const gameResults = new Map<string, GameResult>();

const FEE_RATE = 0.03;

// ---------------------------------------------------------------------------
// Anti-cheat L1 — durable move history (Task #43).
//
// recordMatchMove appends one row to `match_moves` for every move that the
// authoritative server-side validator has just accepted. Two design rules:
//
//   1. The socket hot path must NEVER be blocked by Postgres. We schedule
//      the insert with setImmediate and never await it; transient DB
//      latency or outages cannot stall live gameplay.
//   2. Every row carries a 1-based ply derived from in-memory state, so
//      ordering is correct even if writes complete out of order. The
//      cache also lets us compute msSinceLastMove without a round-trip.
//
// On insert failure we retry with exponential backoff up to a small bound
// and then drop the row with a warning — losing one audit row is strictly
// preferable to crashing the game loop.
// ---------------------------------------------------------------------------
interface MoveLogState {
  nextPly: number;
  lastTsMs: number | null;
}
const moveLogState = new Map<string, MoveLogState>();
const MOVE_LOG_MAX_RETRIES = 3;
const MOVE_LOG_RETRY_BASE_MS = 100;

function recordMatchMove(
  matchId: string,
  gameType: string,
  actorId: string,
  payload: Record<string, unknown>,
): void {
  if (!matchId || !actorId) return;
  let state = moveLogState.get(matchId);
  if (!state) {
    state = { nextPly: 1, lastTsMs: null };
    moveLogState.set(matchId, state);
  }
  const nowMs = Date.now();
  const ply = state.nextPly++;
  const msSinceLastMove = state.lastTsMs == null ? null : Math.max(0, nowMs - state.lastTsMs);
  state.lastTsMs = nowMs;

  const row = {
    matchId,
    gameType,
    ply,
    actorId,
    payload,
    serverTimestampMs: nowMs,
    msSinceLastMove,
  };

  setImmediate(() => {
    void (async () => {
      let attempt = 0;
      while (attempt < MOVE_LOG_MAX_RETRIES) {
        try {
          await db.insert(matchMoves).values(row);
          return;
        } catch (err: any) {
          attempt++;
          if (attempt >= MOVE_LOG_MAX_RETRIES) {
            console.warn(
              "[move-log] insert failed after retries:",
              matchId, gameType, "ply=", ply,
              err?.message || err,
            );
            return;
          }
          await new Promise((r) => setTimeout(r, MOVE_LOG_RETRY_BASE_MS * (1 << (attempt - 1))));
        }
      }
    })();
  });
}

// Exposed for tests; never call from the socket hot path.
export function _resetMatchMoveLogStateForTests(): void {
  moveLogState.clear();
}

// Verify a join attempt's claimed `playerId` against the match's
// canonical participant set, then mint and emit the per-(matchId,
// playerId) HMAC token used to authenticate REST move-history fetches.
//
// Why this matters: `playerId` arrives over the socket as a
// client-supplied string. Without verification, an attacker who
// knows a match's id and a participant's wallet address could
// connect, claim that wallet as their `playerId`, and the server
// would happily mint a token granting them read access to that
// participant's private move log. We anchor identity in the
// match metadata (Redis-first, Postgres fallback for matches whose
// Redis hash has rotated out) and emit the token only when the
// claimed wallet is one of the two real addr1/addr2 participants.
//
// Runs asynchronously so it never stalls the socket join hot path —
// reconnection cancellation, room assembly, color/role assignment,
// and game-start gating all proceed synchronously as before.
function verifyAndIssueMatchToken(
  socket: Socket,
  matchId: string,
  playerId: string,
): void {
  void (async () => {
    try {
      let addr1: string | null = null;
      let addr2: string | null = null;
      try {
        const md = await redis.hgetall(`match:${matchId}`);
        if (md && (md.addr1 || md.player1Id)) {
          addr1 = String(md.addr1 || md.player1Id);
          addr2 = String(md.addr2 || md.player2Id);
        }
      } catch (err: any) {
        console.warn("[matchToken] redis lookup failed:", err?.message || err);
      }
      if (!addr1 || !addr2) {
        try {
          const rows = await db
            .select({
              player1Id: matches.player1Id,
              player2Id: matches.player2Id,
            })
            .from(matches)
            .where(eq(matches.matchId, matchId))
            .limit(1);
          if (rows.length > 0) {
            addr1 = rows[0].player1Id;
            addr2 = rows[0].player2Id;
          }
        } catch (err: any) {
          console.warn("[matchToken] db lookup failed:", err?.message || err);
        }
      }
      if (!addr1 || !addr2) {
        // No canonical participant set yet (e.g. matchmaking hash
        // has not landed). Without a trusted reference we MUST NOT
        // issue a token — better to deny later REST reads than to
        // hand out unverifiable credentials.
        console.warn(
          "[matchToken] no participant record for match — skipping token",
          matchId,
        );
        return;
      }
      if (playerId !== addr1 && playerId !== addr2) {
        console.warn(
          "[matchToken] join playerId does not match canonical participants — denying token",
          { matchId, playerId },
        );
        return;
      }
      socket.emit("match-token", {
        matchId,
        token: issueMatchToken(matchId, playerId),
      });
    } catch (err: any) {
      console.error("[matchToken] unexpected failure:", err?.message || err);
    }
  })();
}

// Test seams: seed in-memory game rooms into a "ready to receive a
// move" state so the per-game move-handler wiring (and its
// `recordMatchMove` call) can be exercised without standing up the
// full placement / deal / clock-tick prelude. Production code paths
// never touch these — they're only invoked from tests/match-moves.test.ts.
export function __seedBattleshipRoomForTest(
  matchId: string,
  attackerId: string,
  defenderId: string,
): void {
  const room = battleshipRooms.get(matchId);
  if (!room) throw new Error(`battleship room not found: ${matchId}`);
  const attacker = room.players.get(attackerId);
  const defender = room.players.get(defenderId);
  if (!attacker || !defender) {
    throw new Error("seed requires both players already joined");
  }
  // Single one-cell ship for the defender so the attacker can land a
  // legal cell at (0, 0) and miss everywhere else. Sufficient to drive
  // one battleship-attack through the move-recording path.
  defender.ships = [
    { id: 'destroyer', name: 'Destroyer', size: 1, cells: [{ row: 9, col: 9 }], hits: 0, sunk: false },
  ];
  defender.ready = true;
  attacker.ships = [
    { id: 'destroyer', name: 'Destroyer', size: 1, cells: [{ row: 0, col: 0 }], hits: 0, sunk: false },
  ];
  attacker.ready = true;
  room.battlePhase = true;
  room.currentTurn = attacker.role;
}

export function __seedDominoesRoomForTest(
  matchId: string,
  starterId: string,
  starterTile: { a: number; b: number },
): void {
  const room = dominoesRooms.get(matchId);
  if (!room) throw new Error(`dominoes room not found: ${matchId}`);
  const starter = room.players.get(starterId);
  if (!starter) throw new Error("seed requires starter joined");
  // Hand the starter a single playable tile == starterTile so the
  // first dominoes-move is unambiguously legal. The opponent's hand
  // can stay empty for this test — we never poll their move.
  starter.hand = [{ a: starterTile.a, b: starterTile.b }];
  room.dealt = true;
  room.chain = [];
  room.leftEnd = null;
  room.rightEnd = null;
  room.currentTurn = starter.role;
  room.starterTile = starterTile;
  room.lastTickAt = Date.now();
}

async function storeGameResult(
  matchId: string,
  gameType: string,
  winnerId: string | null,
  loserId: string | null,
  reason: string
): Promise<{ result: GameResult; isFirst: boolean } | null> {
  // Final safety net: never persist a "disconnect forfeit" for a match
  // where no real gameplay actually happened. We require BOTH conditions:
  //
  //   (a) The match must have been marked started (game-start emitted),
  //       AND
  //   (b) At least one authoritative gameplay action (chess-move /
  //       tetris-state / checkers-move / battleship-attack) must have
  //       landed on the server.
  //
  // (a) catches the never-started case the disconnect handler already
  // gates on. (b) is the per-game-state evidence check: if the board
  // rendered for both players but neither side ever moved before someone
  // closed their tab, we still don't write a misleading +stake/-stake
  // row — players can recover their stake through the contract's
  // RefundNoShow / refund-on-no-progress paths instead.
  const isDisconnectReason =
    reason === "disconnect" || reason === "forfeit" || reason === "abandoned";
  if (isDisconnectReason) {
    if (!gameStartedMatches.has(matchId)) {
      console.warn(
        "[socket] storeGameResult: refusing to record disconnect for never-started match:",
        matchId
      );
      return null;
    }
    if (!gameMovesRecorded.has(matchId)) {
      console.warn(
        "[socket] storeGameResult: refusing to record disconnect for match with zero recorded gameplay actions:",
        matchId
      );
      return null;
    }
  }

  const dedupKey = `gameresult_lock:${matchId}`;
  const isFirst = await redis.set(dedupKey, "1", { ex: 7200, nx: true });
  if (!isFirst) {
    console.log("[socket] duplicate game-end ignored for match:", matchId);
    const cached = gameResults.get(matchId);
    return cached ? { result: cached, isFirst: false } : null;
  }

  let resultType: 'win' | 'loss' | 'draw';
  if (winnerId && loserId) {
    resultType = 'win';
  } else if (!winnerId && !loserId) {
    resultType = 'draw';
  } else {
    resultType = 'win';
  }
  
  const timestamp = Date.now();
  const result: GameResult = {
    matchId,
    gameType,
    winnerId,
    loserId,
    result: resultType,
    reason,
    timestamp
  };
  gameResults.set(matchId, result);
  console.log("[socket] game result stored:", result);

  try {
    const matchData = await redis.hgetall(`match:${matchId}`);
    if (matchData && matchData.stake && matchData.asset && (matchData.addr1 || matchData.p1) && (matchData.addr2 || matchData.p2)) {
      const stake = Number(matchData.stake);
      const asset = String(matchData.asset);
      const player1Id = String(matchData.addr1 || matchData.p1);
      const player2Id = String(matchData.addr2 || matchData.p2);
      const pot = stake * 2;
      // V2 chain-specific fee model: every chain charges the 3% platform fee.
      // Tron USDT additionally charges a 0.5% gas-fund accumulator that
      // funds the on-chain SunSwap auto-swap (so players get TRX-free
      // settles forever). Disconnect refunds both players on-chain
      // regardless of `winnerId` from the game layer, so the DB row must
      // reflect a refund (payout = stake each, fee = 0) rather than a
      // winner-take-all amount.
      const platformFeeRate = FEE_RATE;
      const gasFundRate = asset === "USDT" ? 0.005 : 0;
      const effectiveFeeRate = platformFeeRate + gasFundRate;
      const fee = pot * effectiveFeeRate;

      const isDisconnect =
        reason === "disconnect" ||
        reason === "forfeit" ||
        reason === "abandoned";

      let payout = 0;
      let recordedFee = fee;
      if (isDisconnect) {
        // V2 disconnect refund:
        //  - EVM/TON: contract refunds full `stake` to each player (no fee).
        //  - Tron USDT: contract still deducts the half-of-gas-fund slice
        //    per player (refundPerPlayer = stake - halfGasFund) so the
        //    on-chain SunSwap accumulator stays funded. Mirror that math
        //    in the DB row so history matches the wallet receipt.
        if (asset === "USDT") {
          const halfGasFund = (pot * gasFundRate) / 2;
          payout = stake - halfGasFund;
          recordedFee = halfGasFund * 2;
        } else {
          payout = stake;
          recordedFee = 0;
        }
      } else if (resultType === 'win' && winnerId) {
        payout = pot - fee;
      } else if (resultType === 'draw') {
        payout = stake - (fee / 2);
      }

      await db.insert(matches).values({
        matchId,
        gameType,
        player1Id,
        player2Id,
        winnerId: winnerId || null,
        loserId: loserId || null,
        stake,
        asset,
        pot,
        fee: recordedFee,
        payout,
        reason,
        timestamp,
      });
      console.log("[socket] match saved to database:", matchId);

      // Anti-cheat L1: stamp a per-wallet matchmaking cooldown on both
      // players so a bot cannot re-queue the instant a match resolves.
      // The TTL is short (default 10s) — long enough to break trivial
      // automation, short enough that a human clicking "Play Again"
      // never notices.
      setMatchmakingCooldown(player1Id).catch(() => {});
      setMatchmakingCooldown(player2Id).catch(() => {});

      settleMatchOnChain(matchId, winnerId, resultType, reason).catch(err => {
        console.error("[socket] on-chain settlement failed:", matchId, err?.message || err);
      });
    } else {
      console.warn("[socket] could not fetch match data from Redis for DB save:", matchId);
    }
  } catch (err) {
    console.error("[socket] failed to save match to database:", err);
  }

  // Match has fully resolved (or attempted to) — drop per-process tracking
  // sets so they don't leak across the lifetime of the server. We do this
  // OUTSIDE the matchData-found branch so a missing Redis hash or a DB
  // failure during save still releases the in-memory state.
  gameStartedMatches.delete(matchId);
  gameMovesRecorded.delete(matchId);
  fundedMatches.delete(matchId);
  moveLogState.delete(matchId);

  return { result, isFirst: true };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function settleMatchOnChain(
  matchId: string,
  winnerId: string | null,
  resultType: 'win' | 'loss' | 'draw',
  gameReason: string
): Promise<void> {
  const lockKey = `settle_lock:${matchId}`;
  const locked = await redis.set(lockKey, "1", { ex: 7200, nx: true });
  if (!locked) {
    console.log("[settlement] already in progress for match:", matchId);
    return;
  }

  try {
    const matchData = await redis.hgetall(`match:${matchId}`);
    const addr1 = matchData?.addr1 ? String(matchData.addr1) : null;
    const addr2 = matchData?.addr2 ? String(matchData.addr2) : null;
    const asset = matchData?.asset ? String(matchData.asset) : null;

    if (!addr1 || !addr2) {
      console.warn("[settlement] skipping — no wallet addresses for match:", matchId);
      // Release the lock so a future retry (e.g. once addresses are filled
      // in by a slow-arriving deposit handler) can proceed.
      await redis.del(lockKey);
      return;
    }

    // Normalize the winner string against the canonical chain-correct
    // addresses we recorded at match-creation. Game clients are not all
    // asset-aware, so winnerId may be the wrong-chain address (e.g. an EVM
    // address for a USDT/Tron match). We resolve by case-insensitive equality
    // against addr1/addr2 and fall back to a socket-slot lookup so settlement
    // never broadcasts an address from the wrong chain.
    const normalizeWinner = (raw: string | null): string | null => {
      if (!raw) return null;
      const lc = raw.toLowerCase();
      if (addr1.toLowerCase() === lc || addr1 === raw) return addr1;
      if (addr2.toLowerCase() === lc || addr2 === raw) return addr2;
      // Try resolving via socket id slot (p1/p2 are socket ids).
      const p1 = matchData?.p1 ? String(matchData.p1) : null;
      const p2 = matchData?.p2 ? String(matchData.p2) : null;
      if (p1 && raw === p1) return addr1;
      if (p2 && raw === p2) return addr2;
      return null;
    };

    let winner: string;
    let reason: number;

    const isDisconnect = gameReason === 'disconnect' || gameReason === 'forfeit' || gameReason === 'abandoned';

    if (resultType === 'draw') {
      reason = 1;
      winner = ZERO_ADDRESS;
    } else if (isDisconnect) {
      reason = 2;
      // V2 contracts require winner == address(0) whenever reason != Normal
      // (the contract pot is split / refunded based purely on `reason`).
      // Including a non-zero winner would either revert the on-chain settle
      // or produce a payout that doesn't match the contract's branching.
      winner = ZERO_ADDRESS;
    } else if (resultType === 'win' && winnerId) {
      const resolved = normalizeWinner(winnerId);
      if (!resolved) {
        console.error(`[settlement] SKIPPING match ${matchId}: winner '${winnerId}' could not be resolved to addr1 (${addr1}) or addr2 (${addr2})`);
        await redis.del(lockKey);
        return;
      }
      reason = 0;
      winner = resolved;
    } else {
      console.error(`[settlement] SKIPPING match ${matchId}: decisive result but winner is unresolved (resultType=${resultType}, winnerId=${winnerId})`);
      await redis.del(lockKey);
      return;
    }

    // Tron USDT remains oracle-submitted (gasless for players). The contract's
    // 0.5% gas-fund accumulator + on-chain SunSwap auto-swap keeps the oracle
    // wallet topped up so this stays self-sustaining.
    if (asset === "USDT") {
      const { createTronOracle } = await import("./oracle/tronOracle");
      const tron = createTronOracle();
      const winnerEvmHex =
        winner === ZERO_ADDRESS ? ZERO_ADDRESS : tron.tronAddressToEvmHex(winner);
      console.log(`[settlement][TRON] settling match ${matchId}: winner=${winner}, reason=${reason}`);
      const result = await tron.submitSettlement(matchId, winnerEvmHex, reason);
      console.log(`[settlement][TRON] match ${matchId} settled: tx=${result.txHash}`);
      return;
    }

    // EVM (BNB / ETH) and TON: oracle only signs the MatchOutcome. The winner
    // (Normal) or either player (Draw / Disconnect) calls settleMatch on-chain
    // and pays their own gas. We persist the signed auth in Redis so the
    // /api/escrow/settle-auth endpoint serves it idempotently and emit a
    // `settle-ready` socket event so connected adapters can claim immediately.
    if (asset === "TON") {
      const { createTonOracle } = await import("./oracle/tonOracle");
      const ton = createTonOracle();
      // Hard guard: any non-Normal reason MUST drop the winner to "" so the
      // signed Settle BOC carries the placeholder address the contract
      // expects (it ignores winner when reason != Normal).
      const winnerFriendly = reason !== 0 || winner === ZERO_ADDRESS ? "" : winner;
      console.log(`[settlement][TON] signing outcome match ${matchId}: winner=${winnerFriendly}, reason=${reason}`);
      const signed = await ton.signMatchOutcome({
        matchId,
        winnerFriendly,
        reason,
      });
      const auth = {
        matchId,
        chain: "TON",
        winner: winnerFriendly,
        reason,
        payloadBoc: signed.payloadBoc,
        signatureHex: signed.signatureHex,
        escrowAddress: ton.escrowAddressFriendly,
      };
      await redis.set(`settle_auth:${matchId}`, JSON.stringify(auth), { ex: 60 * 60 * 24 * 7 });
      const io = ioRef;
      if (io) { io.to(`match:${matchId}`).emit("settle-ready", auth); io.to(`match:${matchId}`).emit("match:settle-auth", auth); }
      console.log(`[settlement][TON] settle-auth ready for ${matchId}`);
      return;
    }

    const { createEvmOracle, chainForAsset } = await import("./oracle/evmOracle");
    const chain = chainForAsset(asset || "");
    if (!chain) {
      console.warn(`[settlement] asset '${asset}' is not on a supported on-chain network — skipping settlement for ${matchId}`);
      await redis.del(lockKey);
      return;
    }
    const oracle = createEvmOracle(chain);
    // Same hard guard for EVM: contract requires winner == address(0) for
    // non-Normal reasons.
    const evmWinner = reason === 0 ? winner : ZERO_ADDRESS;
    console.log(`[settlement][${chain}] signing outcome match ${matchId}: winner=${evmWinner}, reason=${reason}`);
    const signed = await oracle.signMatchOutcome({
      matchId,
      winner: evmWinner,
      reason,
    });
    const auth = {
      matchId,
      chain,
      chainId: signed.chainId,
      escrowAddress: signed.escrowAddress,
      matchIdBytes32: signed.matchIdBytes32,
      winner: signed.winner,
      reason: signed.reason,
      oracleSig: signed.oracleSig,
    };
    await redis.set(`settle_auth:${matchId}`, JSON.stringify(auth), { ex: 60 * 60 * 24 * 7 });
    const io = ioRef;
    if (io) { io.to(`match:${matchId}`).emit("settle-ready", auth); io.to(`match:${matchId}`).emit("match:settle-auth", auth); }
    console.log(`[settlement][${chain}] settle-auth ready for ${matchId}`);
  } catch (err: any) {
    console.error(`[settlement] match ${matchId} failed:`, err?.message || err);
    await redis.del(lockKey);
  }
}

// Per-player anti-cheat tracking inside a Tetris match. We keep the
// last accepted snapshot for each player and a violation counter so a
// single bad packet doesn't kill an honest match, but a streak of them
// auto-forfeits the offender.
interface TetrisPlayerState {
  socketId: string;
  lastScore: number;
  lastLines: number;
  lastLevel: number;
  lastUpdateAt: number;
  startedAt: number;
  violations: number;
  reportedGameOver: boolean;
  // Set true the first time we accept a tetris-state packet from this
  // player. Used to gate `tetris-game-over`: a player that has never
  // submitted any authoritative gameplay snapshot cannot legitimately
  // claim they lost. NOTE: this is independent of score/lines because
  // a real top-out at 0 cleared lines is possible.
  hasAcceptedState: boolean;
  // Latest accepted board so `tetris-game-over` can re-check the
  // plausibility of the loser's claim (top of board congested) without
  // trusting any payload on the game-over event itself.
  lastBoard: (string | null)[][] | null;
}

interface TetrisRoom {
  // Map<playerId, TetrisPlayerState>. The legacy code stored just the
  // socket id as the value; we now store the full per-player tracking
  // record, but socketId is preserved on the inner shape.
  players: Map<string, TetrisPlayerState>;
  started: boolean;
}

const tetrisRooms = new Map<string, TetrisRoom>();

// Sanity-band configuration for the Tetris stopgap. These values are
// intentionally generous so legitimate fast play is never blocked; the
// goal is to catch the trivially-forged "I scored a million points and
// my board filled up" cheats, not to perfectly simulate Tetris.
const TETRIS_MAX_SCORE_PER_SECOND = 20000;
const TETRIS_VIOLATION_THRESHOLD = 3;
// Standard Tetris board is 20 rows × 10 cols. A real game-over only
// fires when a new piece can't spawn at the top, so the top rows must
// have meaningful occupancy.
const TETRIS_GAMEOVER_TOP_ROWS = 4;
const TETRIS_GAMEOVER_MIN_TOP_OCCUPIED = 4;
const TETRIS_BOARD_HEIGHT = 20;
const TETRIS_BOARD_WIDTH = 10;

function tetrisOpponentId(room: TetrisRoom, playerId: string): string | null {
  for (const id of room.players.keys()) {
    if (id !== playerId) return id;
  }
  return null;
}

function tetrisBoardLooksGameOver(board: unknown): boolean {
  if (!Array.isArray(board) || board.length < TETRIS_GAMEOVER_TOP_ROWS) return false;
  let occupiedTop = 0;
  for (let y = 0; y < TETRIS_GAMEOVER_TOP_ROWS; y++) {
    const row = board[y];
    if (!Array.isArray(row)) return false;
    for (let x = 0; x < row.length; x++) {
      if (row[x]) occupiedTop++;
    }
  }
  return occupiedTop >= TETRIS_GAMEOVER_MIN_TOP_OCCUPIED;
}

// Validate the shape of a tetris-state board payload. We don't trust
// the client at all, so reject mis-sized boards outright.
function tetrisBoardIsWellFormed(board: unknown): board is (string | null)[][] {
  if (!Array.isArray(board) || board.length !== TETRIS_BOARD_HEIGHT) return false;
  for (let y = 0; y < TETRIS_BOARD_HEIGHT; y++) {
    const row = board[y];
    if (!Array.isArray(row) || row.length !== TETRIS_BOARD_WIDTH) return false;
    for (let x = 0; x < TETRIS_BOARD_WIDTH; x++) {
      const cell = row[x];
      // Cells are either null (empty) or a colour string. Reject
      // anything else to stop crafted payloads (objects, numbers,
      // huge strings) from getting echoed to the opponent.
      if (cell !== null && (typeof cell !== 'string' || cell.length > 32)) return false;
    }
  }
  return true;
}

interface CheckersPlayerInfo {
  socketId: string;
  color: 'red' | 'black';
}

interface CheckersRoom {
  players: Map<string, CheckersPlayerInfo>;
  started: boolean;
  // Server-authoritative board, turn, clocks, and the square of the
  // piece that owes a continuation jump after a multi-jump (null when
  // no continuation is pending — the most recent move ended the turn).
  board: CheckersBoard;
  currentTurn: CheckersColor;
  redTime: number;
  blackTime: number;
  lastTickAt: number;
  pendingJumpAt: CheckersPosition | null;
}

const checkersRooms = new Map<string, CheckersRoom>();

function checkersOpponentId(room: CheckersRoom, playerId: string): string | null {
  for (const id of room.players.keys()) {
    if (id !== playerId) return id;
  }
  return null;
}

function checkersPublicState(room: CheckersRoom) {
  const now = Date.now();
  const elapsed = room.started ? Math.max(0, now - room.lastTickAt) : 0;
  const redTime =
    room.currentTurn === "red" ? Math.max(0, room.redTime - elapsed) : room.redTime;
  const blackTime =
    room.currentTurn === "black" ? Math.max(0, room.blackTime - elapsed) : room.blackTime;
  return {
    board: checkersSerializeBoard(room.board),
    currentTurn: room.currentTurn,
    redTime,
    blackTime,
    pendingJumpAt: room.pendingJumpAt,
  };
}

// Test-only: seed an existing CheckersRoom to a custom position. Used
// by integration tests to drive the room to a near-terminal state
// without playing dozens of legal moves. Not safe for production use;
// guarded by a NODE_ENV check on call.
export function __setCheckersBoardForTest(
  matchId: string,
  board: CheckersBoard,
  currentTurn: CheckersColor,
  pendingJumpAt: CheckersPosition | null = null,
): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const room = checkersRooms.get(matchId);
  if (!room) return false;
  room.board = board;
  room.currentTurn = currentTurn;
  room.pendingJumpAt = pendingJumpAt;
  room.lastTickAt = Date.now();
  return true;
}

function startCheckersGame(io: SocketIOServer, matchId: string, room: CheckersRoom): void {
  room.board = checkersInitialBoard();
  room.currentTurn = "red";
  room.redTime = CHECKERS_INITIAL_TIME_MS;
  room.blackTime = CHECKERS_INITIAL_TIME_MS;
  room.lastTickAt = Date.now();
  room.pendingJumpAt = null;
  io.to(`checkers:${matchId}`).emit("checkers-game-start", {
    publicState: checkersPublicState(room),
  });
}

interface ShipPlacement {
  shipId: string;
  row: number;
  col: number;
  horizontal: boolean;
}

interface BattleshipShip {
  id: string;
  name: string;
  size: number;
  cells: { row: number; col: number }[];
  hits: number;
  sunk: boolean;
}

interface BattleshipPlayerInfo {
  socketId: string;
  role: 'player1' | 'player2';
  ready: boolean;
  ships: BattleshipShip[];
}

interface BattleshipRoom {
  players: Map<string, BattleshipPlayerInfo>;
  started: boolean;
  battlePhase: boolean;
  currentTurn: 'player1' | 'player2';
  attackHistory: Map<string, Set<string>>; // playerId -> set of "row,col" strings
}

const battleshipRooms = new Map<string, BattleshipRoom>();

interface DominoesPlayerInfo {
  socketId: string;
  role: DominoesPlayerRole;
  hand: DominoesTile[];
}

interface DominoesRoom {
  players: Map<string, DominoesPlayerInfo>;
  started: boolean;
  dealt: boolean;
  chain: DominoesPlacedTile[];
  leftEnd: number | null;
  rightEnd: number | null;
  currentTurn: DominoesPlayerRole;
  // The tile the starter MUST lead with — enforced server-side on the
  // first move so a malicious client can't substitute a different tile.
  // Cleared (set to null) once the lead move has been played.
  starterTile: DominoesTile | null;
  p1Time: number;
  p2Time: number;
  consecutivePasses: number;
  // Wall-clock at the moment the active player's turn started — used to
  // deduct elapsed time from their server-side clock on each move/pass so
  // the server stays the source of truth for the timer.
  lastTickAt: number;
}

const dominoesRooms = new Map<string, DominoesRoom>();

function dominoesPublicState(room: DominoesRoom) {
  let p1: DominoesPlayerInfo | undefined;
  let p2: DominoesPlayerInfo | undefined;
  for (const p of room.players.values()) {
    if (p.role === "p1") p1 = p;
    else p2 = p;
  }
  // Bleed elapsed time from the active player's clock for any consumer
  // that reads state mid-turn (snapshots, reconnect payloads).
  const now = Date.now();
  const elapsed = room.dealt ? Math.max(0, now - room.lastTickAt) : 0;
  const p1Time =
    room.currentTurn === "p1" ? Math.max(0, room.p1Time - elapsed) : room.p1Time;
  const p2Time =
    room.currentTurn === "p2" ? Math.max(0, room.p2Time - elapsed) : room.p2Time;
  return {
    chain: room.chain,
    leftEnd: room.leftEnd,
    rightEnd: room.rightEnd,
    currentTurn: room.currentTurn,
    p1TileCount: p1?.hand.length ?? 0,
    p2TileCount: p2?.hand.length ?? 0,
    p1Time,
    p2Time,
    consecutivePasses: room.consecutivePasses,
  };
}

function startDominoesGame(io: SocketIOServer, room: DominoesRoom): void {
  const seed = Math.floor(Math.random() * 0xffffffff);
  const deal = dominoesDealHands(seed);
  let p1Player: DominoesPlayerInfo | undefined;
  let p2Player: DominoesPlayerInfo | undefined;
  let p1Id = "";
  let p2Id = "";
  for (const [id, p] of room.players.entries()) {
    if (p.role === "p1") {
      p1Player = p;
      p1Id = id;
    } else {
      p2Player = p;
      p2Id = id;
    }
  }
  if (!p1Player || !p2Player) return;
  p1Player.hand = deal.p1Hand;
  p2Player.hand = deal.p2Hand;
  room.chain = [];
  room.leftEnd = null;
  room.rightEnd = null;

  // Spec tie-break: when neither hand contains a double, the heaviest tile
  // leads, and any further tie is broken by the LOWER (lexicographic) wallet
  // address. The shared engine defaults this to "p1"; we override here so
  // the in-room player IDs (= wallet addresses) drive the result.
  const noDoubles =
    !deal.p1Hand.some((t) => t.a === t.b) &&
    !deal.p2Hand.some((t) => t.a === t.b);
  const sumOf = (hand: typeof deal.p1Hand) =>
    hand.reduce((m, t) => Math.max(m, t.a + t.b), -1);
  const tied = noDoubles && sumOf(deal.p1Hand) === sumOf(deal.p2Hand);
  if (tied && p1Id && p2Id && p2Id.toLowerCase() < p1Id.toLowerCase()) {
    // p2 has the lower wallet address — they should lead. Swap the
    // starter and re-derive the lead tile from p2's hand instead.
    deal.starter = "p2";
    deal.starterTile = (() => {
      let best = deal.p2Hand[0];
      for (const t of deal.p2Hand) {
        if (t.a + t.b > best.a + best.b) best = t;
      }
      return best;
    })();
  }

  room.currentTurn = deal.starter;
  room.starterTile = deal.starterTile;
  room.p1Time = DOMINOES_INITIAL_TIME_MS;
  room.p2Time = DOMINOES_INITIAL_TIME_MS;
  room.consecutivePasses = 0;
  room.dealt = true;
  room.lastTickAt = Date.now();

  const publicState = dominoesPublicState(room);
  const p1Sock = io.sockets.sockets.get(p1Player.socketId);
  const p2Sock = io.sockets.sockets.get(p2Player.socketId);
  if (p1Sock) {
    p1Sock.emit("dominoes-game-start", {
      role: "p1",
      hand: p1Player.hand,
      publicState,
      starterTile: deal.starterTile,
    });
  }
  if (p2Sock) {
    p2Sock.emit("dominoes-game-start", {
      role: "p2",
      hand: p2Player.hand,
      publicState,
      starterTile: deal.starterTile,
    });
  }
}

function dominoesOpponentId(
  room: DominoesRoom,
  playerId: string,
): string | null {
  for (const id of room.players.keys()) {
    if (id !== playerId) return id;
  }
  return null;
}

interface XiangqiPlayerInfo {
  socketId: string;
  color: XiangqiColor;
}

interface XiangqiRoom {
  players: Map<string, XiangqiPlayerInfo>;
  started: boolean;
  // Server-authoritative board, turn, clocks, no-capture counter,
  // outstanding draw offer, and per-game position history (for
  // perpetual-check detection).
  board: XiangqiBoard;
  currentTurn: XiangqiColor;
  redTime: number;
  blackTime: number;
  lastTickAt: number;
  pliesSinceCapture: number;
  drawOfferedBy: XiangqiColor | null;
  history: XiangqiHistoryEntry[];
}

const xiangqiRooms = new Map<string, XiangqiRoom>();

function xiangqiPublicState(room: XiangqiRoom) {
  // Bleed elapsed time off the active player's clock for any consumer
  // that reads state mid-turn (snapshots, reconnect payloads).
  const now = Date.now();
  const elapsed = room.started ? Math.max(0, now - room.lastTickAt) : 0;
  const redTime =
    room.currentTurn === "red" ? Math.max(0, room.redTime - elapsed) : room.redTime;
  const blackTime =
    room.currentTurn === "black" ? Math.max(0, room.blackTime - elapsed) : room.blackTime;
  // Include a serialized snapshot of the authoritative board + the
  // no-capture counter so a reconnecting client can hydrate its engine
  // to the exact mid-game state. Without this, a refresh mid-match
  // would leave the client viewing the initial position.
  return {
    currentTurn: room.currentTurn,
    redTime,
    blackTime,
    board: xiangqiSerializeBoard(room.board),
    pliesSinceCapture: room.pliesSinceCapture,
  };
}

// Build the public-state payload broadcast by `game-start` and consumed
// by reconnecting clients. Bleeds elapsed time off the active player's
// clock so a snapshot read mid-turn returns the live remaining time.
function chessPublicState(room: MatchRoom) {
  const now = Date.now();
  const elapsed = room.started ? Math.max(0, now - room.lastTickAt) : 0;
  const turn: 'w' | 'b' = room.game.turn();
  const whiteTime = turn === "w" ? Math.max(0, room.whiteTime - elapsed) : room.whiteTime;
  const blackTime = turn === "b" ? Math.max(0, room.blackTime - elapsed) : room.blackTime;
  return {
    fen: room.game.fen(),
    whiteTime,
    blackTime,
    turn,
    lastMove: room.lastMove,
  };
}

// Initialise a fresh chess game on a room and stamp the start clock.
// Idempotent for the case where post-funding fires after a join.
function startChessGame(io: SocketIOServer, matchId: string, room: MatchRoom): void {
  if (!room.started) {
    room.game = chessNewGame();
    room.whiteTime = CHESS_INITIAL_TIME_MS;
    room.blackTime = CHESS_INITIAL_TIME_MS;
    room.lastMove = null;
    room.lastTickAt = Date.now();
    room.started = true;
  }
  io.to(`match:${matchId}`).emit("game-start", chessPublicState(room));
}

function startXiangqiGame(io: SocketIOServer, matchId: string, room: XiangqiRoom): void {
  room.board = xiangqiInitialBoard();
  room.currentTurn = "red";
  room.redTime = XIANGQI_INITIAL_TIME_MS;
  room.blackTime = XIANGQI_INITIAL_TIME_MS;
  room.lastTickAt = Date.now();
  room.pliesSinceCapture = 0;
  room.drawOfferedBy = null;
  room.history = [{ posKey: xiangqiPositionKey(room.board, room.currentTurn), checkingSide: null }];
  io.to(`xiangqi:${matchId}`).emit("xiangqi-game-start", {
    publicState: xiangqiPublicState(room),
  });
}

function xiangqiOpponentId(room: XiangqiRoom, playerId: string): string | null {
  for (const id of room.players.keys()) {
    if (id !== playerId) return id;
  }
  return null;
}

// Tracks matches whose on-chain escrow has been funded by both players
// (i.e. the contract emitted MatchActive). Game-start events are gated on
// this set so gameplay never begins before crypto is locked.
const fundedMatches = new Set<string>();

// Tracks matches where gameplay has actually started — i.e. both players
// joined the per-game room AND the funding gate released, so we emitted
// `game-start` / `tetris-game-start` / etc. The disconnect handler is
// gated on this set so a player who closes their tab BEFORE the board
// renders can never be flagged as a forfeit (which previously produced
// bogus +stake/-stake history rows for never-played TON matches whose
// `getMatch` reader was broken).
const gameStartedMatches = new Set<string>();

// Tracks matches where at least one authoritative gameplay action has
// landed on the server (chess-move, tetris-state, checkers-move,
// battleship-attack). This is the strongest possible "real game in
// progress" signal — stronger than `gameStartedMatches`, which only means
// "we sent game-start to the client". Used as the final safety net in
// `storeGameResult` so we can never persist a +stake/-stake row for a
// match where no move was ever played.
const gameMovesRecorded = new Set<string>();

let ioRef: SocketIOServer | null = null;

export function isMatchFunded(matchId: string): boolean {
  return fundedMatches.has(matchId);
}

function markGameStarted(matchId: string): void {
  gameStartedMatches.add(matchId);
}

function markGameplayActivity(matchId: string): void {
  gameMovesRecorded.add(matchId);
}

/**
 * Called by the on-chain MatchActive listener once both players have
 * deposited. Marks the match as funded and re-fires any pending game-start
 * events for game rooms that already have both players waiting.
 */
export function markMatchFunded(matchId: string): void {
  if (fundedMatches.has(matchId)) return;
  fundedMatches.add(matchId);
  console.log("[socket] match funded — releasing game-start gate", matchId);
  const io = ioRef;
  if (!io) return;

  const chess = matchRooms.get(matchId);
  if (chess && chess.players.size === 2 && !chess.started) {
    startChessGame(io, matchId, chess);
    markGameStarted(matchId);
    console.log("[socket] game-start (post-funding)", matchId);
  }

  const tetris = tetrisRooms.get(matchId);
  if (tetris && tetris.players.size === 2 && !tetris.started) {
    tetris.started = true;
    io.to(`tetris:${matchId}`).emit('tetris-game-start');
    markGameStarted(matchId);
    console.log("[socket] tetris-game-start (post-funding)", matchId);
  }

  const checkers = checkersRooms.get(matchId);
  if (checkers && checkers.players.size === 2 && !checkers.started) {
    checkers.started = true;
    startCheckersGame(io, matchId, checkers);
    markGameStarted(matchId);
    console.log("[socket] checkers-game-start (post-funding)", matchId);
  }

  const battleship = battleshipRooms.get(matchId);
  if (battleship && battleship.players.size === 2 && !battleship.started) {
    battleship.started = true;
    io.to(`battleship:${matchId}`).emit('battleship-game-start');
    markGameStarted(matchId);
    console.log("[socket] battleship-game-start (post-funding)", matchId);
  }

  const dominoes = dominoesRooms.get(matchId);
  if (dominoes && dominoes.players.size === 2 && !dominoes.started) {
    dominoes.started = true;
    startDominoesGame(io, dominoes);
    markGameStarted(matchId);
    console.log("[socket] dominoes-game-start (post-funding)", matchId);
  }

  const xiangqi = xiangqiRooms.get(matchId);
  if (xiangqi && xiangqi.players.size === 2 && !xiangqi.started) {
    xiangqi.started = true;
    startXiangqiGame(io, matchId, xiangqi);
    markGameStarted(matchId);
    console.log("[socket] xiangqi-game-start (post-funding)", matchId);
  }
}

const GRID_SIZE = 10;

function validateShipPlacements(placements: ShipPlacement[]): { valid: boolean; error?: string } {
  if (placements.length !== 5) {
    return { valid: false, error: 'Must place exactly 5 ships' };
  }

  const requiredShips = new Set(['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer']);
  const placedShips = new Set(placements.map(p => p.shipId));
  
  for (const ship of requiredShips) {
    if (!placedShips.has(ship)) {
      return { valid: false, error: `Missing ship: ${ship}` };
    }
  }

  const occupiedCells = new Set<string>();

  for (const placement of placements) {
    const config = SHIP_CONFIGS.find(s => s.id === placement.shipId);
    if (!config) {
      return { valid: false, error: `Invalid ship: ${placement.shipId}` };
    }

    for (let i = 0; i < config.size; i++) {
      const row = placement.horizontal ? placement.row : placement.row + i;
      const col = placement.horizontal ? placement.col + i : placement.col;

      if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) {
        return { valid: false, error: `Ship ${placement.shipId} out of bounds` };
      }

      const cellKey = `${row},${col}`;
      if (occupiedCells.has(cellKey)) {
        return { valid: false, error: `Ships overlap at ${row},${col}` };
      }
      occupiedCells.add(cellKey);
    }
  }

  return { valid: true };
}

const SHIP_CONFIGS: { id: string; name: string; size: number }[] = [
  { id: 'carrier', name: 'Carrier', size: 5 },
  { id: 'battleship', name: 'Battleship', size: 4 },
  { id: 'cruiser', name: 'Cruiser', size: 3 },
  { id: 'submarine', name: 'Submarine', size: 3 },
  { id: 'destroyer', name: 'Destroyer', size: 2 },
];

// Resolve the real client IP for a Socket.io handshake. Express has
// `trust proxy` set to 1 in server/index.ts, but Socket.io does NOT
// inherit that — we have to walk X-Forwarded-For ourselves. Take the
// LEFTMOST entry (first hop = real client) when present, else fall
// back to the raw socket address.
function resolveSocketClientIp(socket: Socket): string {
  const xff = socket.handshake.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  } else if (Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0]).split(",")[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address || "unknown";
}

export function setupSocket(httpServer: HttpServer, opts: SocketOptions): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: "/socket.io",
    transports: ["websocket"],
    cors: {
      origin: opts.isProd ? opts.allowedOrigins : true,
      methods: ["GET", "POST"],
      credentials: true
    }
  });
  ioRef = io;

  // Per-IP socket connection cap. We resolve the client IP from the
  // X-Forwarded-For chain (Express has `trust proxy` set to 1, so the
  // leftmost entry is the real client; Socket.io does NOT honour that
  // setting on its own). Falls back to the raw handshake address when
  // there's no proxy header.
  io.use(async (socket, next) => {
    const ip = resolveSocketClientIp(socket);
    (socket as any).data = (socket as any).data || {};
    (socket as any).data.clientIp = ip;
    const slot = await acquireSocketSlot(ip);
    if (!slot.ok) {
      console.warn(
        `[socket] rejected handshake — ip=${ip} concurrent=${slot.current} cap=${slot.max}`
      );
      const err = new Error("too_many_connections");
      (err as any).data = {
        code: "too_many_connections",
        message:
          "Too many concurrent connections from your network. Close extra tabs and try again.",
        max: slot.max,
      };
      return next(err);
    }
    (socket as any).data.slotAcquired = true;
    next();
  });

  io.on("connection", (socket) => {
    console.log("[socket] connected", socket.id);

    socket.on("join-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`match:${matchId}`);
      console.log("[socket] join match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }
      
      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);

      // Verify the claimed playerId against the match's canonical
      // participant set, then mint and emit the per-(matchId,
      // playerId) HMAC token used to authenticate REST move-history
      // fetches. See verifyAndIssueMatchToken for the full rationale —
      // critical that this NOT trust the client-supplied playerId.
      verifyAndIssueMatchToken(socket, matchId, playerId);
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
        // Notify the surviving opponent that the absent player came back so
        // their pending-disconnect banner can clear. socket.to() excludes the
        // reconnecting socket itself; that player learns from their own
        // socket.io 'connect' event.
        socket.to(`match:${matchId}`).emit('opponent-reconnected', { matchId });
      }

      let room = matchRooms.get(matchId);
      if (!room) {
        // Build the room with an UNSTARTED chess.js engine. The engine is
        // initialised for real (clocks stamped, board reset) inside
        // startChessGame, which runs once both players have joined and the
        // match is funded. Until then `room.started` stays false and the
        // clock-drain logic in chessPublicState is a no-op.
        room = {
          players: new Map(),
          game: chessNewGame(),
          whiteTime: CHESS_INITIAL_TIME_MS,
          blackTime: CHESS_INITIAL_TIME_MS,
          lastTickAt: 0,
          lastMove: null,
          started: false,
        };
        matchRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('color-assigned', { color: existingPlayer.color });
        console.log("[socket] reconnect, color preserved:", existingPlayer.color);

        // Reconnect snapshot: send the authoritative public state so the
        // client can render the live board, clocks, last-move highlight,
        // and side-to-move without trusting any cached values.
        if (room.players.size === 2 && fundedMatches.has(matchId) && room.started) {
          socket.emit('game-start', chessPublicState(room));
        }
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingColors = Array.from(room.players.values()).map(p => p.color);
      const assignedColor: 'white' | 'black' = existingColors.includes('white') ? 'black' : 'white';
      
      room.players.set(playerId, { socketId: socket.id, color: assignedColor });

      socket.emit('color-assigned', { color: assignedColor });
      console.log("[socket] color assigned", matchId, playerId, assignedColor);

      if (room.players.size === 2) {
        if (fundedMatches.has(matchId)) {
          startChessGame(io, matchId, room);
          markGameStarted(matchId);
          console.log("[socket] game-start", matchId);
        } else {
          console.log("[socket] game-start gated on funding", matchId);
          io.to(`match:${matchId}`).emit('awaiting-funding', { matchId });
        }
      }
    });

    // V2 deposit-failure cleanup. The client awaits its on-chain deposit
    // and emits this when the wallet rejected, the chain reverted, or the
    // status poll timed out. We tear the match down so neither player is
    // stuck in a "funding" state, and we surface a `match-cancelled` to
    // the room so the opponent's UI returns to the lobby instead of
    // silently waiting on a deposit that will never arrive.
    socket.on("deposit-failed", async (data: { matchId: string; playerId?: string; reason?: string }) => {
      const { matchId, reason } = data ?? {};
      if (!matchId) return;

      // AuthZ: only one of the two real participants in this match may
      // cancel it. `join-match` is unauthenticated, so socketToPlayer
      // membership alone is NOT sufficient — anyone with a matchId could
      // join the room and grief. Instead we tie cancellation to the exact
      // socket IDs / player IDs the matchmaker stored at match creation:
      //   - find-match path: matchData.p1/p2 hold the original socket.id
      //   - challenge path:  matchData.p1/p2 hold the playerId
      let authorized = false;
      try {
        const md = await redis.hgetall(`match:${matchId}`);
        if (md) {
          const p1 = md.p1 ? String(md.p1) : null;
          const p2 = md.p2 ? String(md.p2) : null;
          // (a) socket.id must literally equal one of the matchmaker-recorded
          //     ids. For find-match this is the original websocket; for
          //     challenges the recorded id is a playerId so we also map the
          //     socket through playerToSocket for an exact identity check.
          if (p1 === socket.id || p2 === socket.id) authorized = true;
          if (!authorized) {
            const sockOfP1 = p1 ? playerToSocket.get(p1) : null;
            const sockOfP2 = p2 ? playerToSocket.get(p2) : null;
            if (sockOfP1 === socket.id || sockOfP2 === socket.id) authorized = true;
          }
        }
      } catch (e: any) {
        console.warn("[socket] deposit-failed authz lookup failed:", e?.message || e);
      }
      if (!authorized) {
        console.warn(`[socket] deposit-failed REJECTED — socket ${socket.id} is not p1/p2 of match ${matchId}`);
        return;
      }

      console.warn(`[socket] deposit-failed for match ${matchId}: ${reason || 'unknown'}`);
      try {
        // Mark match as cancelled (idempotent) and clean up Redis state
        // so the matchmaker doesn't leak it. We keep the lock briefly so
        // a duplicate deposit-failed from the same client doesn't double-emit.
        const lockKey = `cancelled_lock:${matchId}`;
        const isFirst = await redis.set(lockKey, "1", { ex: 600, nx: true });
        if (!isFirst) return;
        await redis.del(`match:${matchId}`);
        await redis.del(`match_auth:${matchId}`);
        await redis.del(`tron_deposit_auth:${matchId}`);
        await redis.del(`ton_match_auth:${matchId}`);
      } catch (e: any) {
        console.error("[socket] deposit-failed cleanup error:", e?.message || e);
      }
      // Spec event (`deposit-failed`) plus the broader `match-cancelled` so
      // existing room listeners (game pages, etc.) tear down cleanly too.
      io.to(`match:${matchId}`).emit("deposit-failed", {
        matchId,
        reason: "deposit_failed",
      });
      io.to(`match:${matchId}`).emit("match-cancelled", {
        matchId,
        reason: "deposit_failed",
      });
      // Tear down any half-built game room so a stale player can't enter.
      matchRooms.delete(matchId);
      fundedMatches.delete(matchId);
      gameStartedMatches.delete(matchId);
      gameMovesRecorded.delete(matchId);
      moveLogState.delete(matchId);
    });

    socket.on("chess-move", (move: ChessMoveInput) => {
      const { matchId, from, to, promotion } = move ?? ({} as ChessMoveInput);
      if (!matchId || !from || !to) return;

      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== matchId) {
        console.log("[socket] chess-move rejected - unauthorized socket");
        return;
      }

      const room = matchRooms.get(matchId);
      if (!room) {
        console.log("[socket] chess-move rejected - no room");
        return;
      }

      if (!room.started) {
        console.log("[socket] chess-move rejected - game not started");
        return;
      }

      const player = room.players.get(socketInfo.playerId);
      if (!player) {
        console.log("[socket] chess-move rejected - player not in room");
        return;
      }

      const expectedColor: 'white' | 'black' = room.game.turn() === 'w' ? 'white' : 'black';
      if (player.color !== expectedColor) {
        console.log("[socket] chess-move rejected - not your turn", matchId, player.color);
        return;
      }

      // Drain mover's clock first; if it hit zero, settle as timeout.
      // lastTickAt is advanced even on early-return paths so the same
      // elapsed window is never charged twice.
      const now = Date.now();
      const elapsed = Math.max(0, now - room.lastTickAt);
      if (player.color === 'white') {
        room.whiteTime = Math.max(0, room.whiteTime - elapsed);
      } else {
        room.blackTime = Math.max(0, room.blackTime - elapsed);
      }
      room.lastTickAt = now;
      const drainedZero =
        (player.color === 'white' && room.whiteTime <= 0) ||
        (player.color === 'black' && room.blackTime <= 0);
      if (drainedZero) {
        const winnerColor: 'white' | 'black' = player.color === 'white' ? 'black' : 'white';
        const winnerId = Array.from(room.players.entries())
          .find(([, p]) => p.color === winnerColor)?.[0] ?? null;
        const loserId = socketInfo.playerId;
        console.log("[socket] chess-move triggered timeout for", player.color);
        storeGameResult(matchId, 'chess', winnerId, loserId, 'timeout');
        io.to(`match:${matchId}`).emit('opponent-timeout', { color: player.color });
        io.to(`match:${matchId}`).emit('game-result', {
          matchId,
          winnerId,
          loserId,
          reason: 'timeout',
        });
        matchRooms.delete(matchId);
        return;
      }

      // applyMove mutates room.game in place so chess.js retains its
      // history across the game (needed for threefold-repetition).
      const result = chessApplyMove(room.game, { from, to, promotion });
      if (!result) {
        console.log("[socket] chess-move rejected - illegal", matchId, from, to);
        return;
      }

      room.lastMove = { from: result.applied.from, to: result.applied.to, san: result.applied.san };
      room.lastTickAt = now;
      markGameplayActivity(matchId);

      recordMatchMove(matchId, 'chess', socketInfo.playerId, {
        from: result.applied.from,
        to: result.applied.to,
        promotion: result.applied.promotion ?? null,
        san: result.applied.san,
        fen: result.applied.fen,
        color: player.color,
      });

      console.log(
        "[socket] chess-move", matchId, result.applied.from, result.applied.to, result.applied.san, "by", player.color
      );

      io.to(`match:${matchId}`).emit('opponent-move', {
        from: result.applied.from,
        to: result.applied.to,
        promotion: result.applied.promotion,
        fen: result.applied.fen,
        san: result.applied.san,
        whiteTime: room.whiteTime,
        blackTime: room.blackTime,
        newTurn: result.applied.turn,
      });

      const terminal = chessDetectTerminal(room.game);
      if (terminal) {
        let winnerId: string | null = null;
        let loserId: string | null = null;
        if (terminal.reason === 'checkmate') {
          const winnerColor: 'white' | 'black' = player.color;
          const loserColor: 'white' | 'black' = winnerColor === 'white' ? 'black' : 'white';
          winnerId = Array.from(room.players.entries()).find(([, p]) => p.color === winnerColor)?.[0] ?? null;
          loserId = Array.from(room.players.entries()).find(([, p]) => p.color === loserColor)?.[0] ?? null;
        }

        console.log("[socket] chess terminal", matchId, terminal.reason);
        storeGameResult(matchId, 'chess', winnerId, loserId, terminal.reason);
        io.to(`match:${matchId}`).emit('game-result', {
          matchId,
          winnerId,
          loserId,
          reason: terminal.reason,
        });
        matchRooms.delete(matchId);
      }
    });

    socket.on("chess-resign", (data: { matchId: string; color: 'white' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] chess-resign rejected - unauthorized");
        return;
      }

      const room = matchRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] chess-resign rejected - color mismatch");
        return;
      }

      console.log("[socket] chess-resign", data.matchId, data.color);
      
      const winnerId = data.color === 'white' 
        ? Array.from(room.players.entries()).find(([_, p]) => p.color === 'black')?.[0]
        : Array.from(room.players.entries()).find(([_, p]) => p.color === 'white')?.[0];
      const loserId = socketInfo.playerId;
      
      storeGameResult(data.matchId, 'chess', winnerId || null, loserId, 'resignation');
      
      socket.to(`match:${data.matchId}`).emit('opponent-resigned', {
        color: data.color
      });
      
      io.to(`match:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'resignation'
      });
      
      matchRooms.delete(data.matchId);
    });

    // chess-timeout is a hint only — the server clock is canonical.
    socket.on("chess-timeout", (data: { matchId: string; color: 'white' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] chess-timeout rejected - unauthorized");
        return;
      }

      const room = matchRooms.get(data.matchId);
      if (!room || !room.started) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) return;

      if (data.color !== player.color) {
        console.log("[socket] chess-timeout rejected - color is not sender's");
        return;
      }

      const turnColor: 'white' | 'black' = room.game.turn() === 'w' ? 'white' : 'black';
      if (data.color !== turnColor) {
        console.log("[socket] chess-timeout rejected - not the side on the clock");
        return;
      }

      const now = Date.now();
      const elapsed = Math.max(0, now - room.lastTickAt);
      const remaining = turnColor === 'white'
        ? Math.max(0, room.whiteTime - elapsed)
        : Math.max(0, room.blackTime - elapsed);
      if (remaining > 0) {
        console.log("[socket] chess-timeout rejected - server clock disagrees", remaining);
        return;
      }

      if (turnColor === 'white') room.whiteTime = 0;
      else room.blackTime = 0;

      console.log("[socket] chess-timeout (server-confirmed)", data.matchId, turnColor);

      const winnerColor: 'white' | 'black' = turnColor === 'white' ? 'black' : 'white';
      const winnerId = Array.from(room.players.entries())
        .find(([, p]) => p.color === winnerColor)?.[0] ?? null;
      const loserId = Array.from(room.players.entries())
        .find(([, p]) => p.color === turnColor)?.[0] ?? null;

      storeGameResult(data.matchId, 'chess', winnerId, loserId, 'timeout');

      io.to(`match:${data.matchId}`).emit('opponent-timeout', { color: turnColor });
      io.to(`match:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'timeout',
      });

      matchRooms.delete(data.matchId);
    });

    // Legacy client-claimed `game-end` removed: terminals are detected
    // server-side inside `chess-move`, resignation via `chess-resign`.

    socket.on("join-tetris-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`tetris:${matchId}`);
      console.log("[socket] join tetris match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }
      
      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);

      // Verify the claimed playerId against the match's canonical
      // participant set, then mint and emit the per-(matchId,
      // playerId) HMAC token used to authenticate REST move-history
      // fetches. See verifyAndIssueMatchToken for the full rationale —
      // critical that this NOT trust the client-supplied playerId.
      verifyAndIssueMatchToken(socket, matchId, playerId);
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
        // Notify the surviving opponent so their disconnect banner clears.
        socket.to(`tetris:${matchId}`).emit('opponent-reconnected', { matchId });
      }

      let room = tetrisRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false
        };
        tetrisRooms.set(matchId, room);
      }

      const existing = room.players.get(playerId);
      if (existing) {
        // Reconnect: keep accumulated counters/timestamps, refresh socketId.
        existing.socketId = socket.id;
      } else {
        const nowTs = Date.now();
        room.players.set(playerId, {
          socketId: socket.id,
          lastScore: 0,
          lastLines: 0,
          lastLevel: 1,
          lastUpdateAt: nowTs,
          startedAt: nowTs,
          violations: 0,
          reportedGameOver: false,
          hasAcceptedState: false,
          lastBoard: null,
        });
      }

      if (room.players.size === 2 && !room.started) {
        if (fundedMatches.has(matchId)) {
          room.started = true;
          io.to(`tetris:${matchId}`).emit('tetris-game-start');
          markGameStarted(matchId);
          console.log("[socket] tetris-game-start", matchId);
        } else {
          console.log("[socket] tetris-game-start gated on funding", matchId);
        }
      }
    });

    socket.on("tetris-state", (data: {
      matchId: string;
      board: (string | null)[][];
      score: number;
      lines: number;
      level: number;
      gameOver: boolean;
    }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      // Require the sender to actually be in the tetris room for this
      // match before counting this as authoritative gameplay activity.
      // Without this check, any socket that joined `tetris:<matchId>`
      // (or otherwise spoofed `socketToPlayer`) could pollute the
      // disconnect-safety-net set by sending fake state updates.
      const room = tetrisRooms.get(data.matchId);
      if (!room) return;
      const playerId = socketInfo.playerId;
      const playerState = room.players.get(playerId);
      if (!playerState) return;

      // ----- L1 anti-cheat sanity bands -----
      // We don't simulate Tetris on the server (replay is a separate
      // tracked task); instead, we reject obviously-impossible state
      // transitions and auto-forfeit on repeat offenders.
      const now = Date.now();
      const reject = (why: string): boolean => {
        playerState.violations++;
        console.warn(
          "[socket] tetris-state rejected:", data.matchId, playerId,
          "reason=", why,
          "violations=", playerState.violations
        );
        if (playerState.violations >= TETRIS_VIOLATION_THRESHOLD) {
          const winnerId = tetrisOpponentId(room, playerId);
          console.warn(
            "[socket] tetris auto-forfeit (anticheat):", data.matchId, "loser=", playerId
          );
          storeGameResult(data.matchId, 'tetris', winnerId, playerId, 'tetris_anticheat_violation');
          io.to(`tetris:${data.matchId}`).emit('game-result', {
            matchId: data.matchId,
            winnerId,
            loserId: playerId,
            reason: 'tetris_anticheat_violation',
          });
          tetrisRooms.delete(data.matchId);
        }
        return false;
      };

      // Type / shape validation.
      if (
        typeof data.score !== 'number' || !Number.isFinite(data.score) ||
        typeof data.lines !== 'number' || !Number.isFinite(data.lines) ||
        typeof data.level !== 'number' || !Number.isFinite(data.level) ||
        typeof data.gameOver !== 'boolean' ||
        data.score < 0 || data.lines < 0 || data.level < 1
      ) {
        reject('malformed_payload');
        return;
      }
      if (!tetrisBoardIsWellFormed(data.board)) {
        reject('malformed_board');
        return;
      }

      // Monotonicity: score / lines / level only ever go up. The
      // `lastUpdateAt` is the moment we accepted the previous snapshot,
      // so it doubles as the rate-limit baseline.
      if (data.score < playerState.lastScore) {
        reject('score_decreased');
        return;
      }
      if (data.lines < playerState.lastLines) {
        reject('lines_decreased');
        return;
      }
      if (data.level < playerState.lastLevel) {
        reject('level_decreased');
        return;
      }

      // Score-rate ceiling. Allow a 1s floor so the very first packet
      // (delta_t close to zero) doesn't divide by ~0.
      const dtSec = Math.max(1, (now - playerState.lastUpdateAt) / 1000);
      const scoreDelta = data.score - playerState.lastScore;
      if (scoreDelta / dtSec > TETRIS_MAX_SCORE_PER_SECOND) {
        reject('score_rate_exceeded');
        return;
      }

      // Lines-vs-level plausibility. Engine formula is
      // level = floor(lines/10) + 1; allow +1 of slack for race
      // conditions between client renders.
      const expectedMaxLevel = Math.floor(data.lines / 10) + 2;
      if (data.level > expectedMaxLevel) {
        reject('level_implausible_for_lines');
        return;
      }

      // gameOver must be visually plausible: the top of the board
      // should actually be congested. This blocks the "I lost!" insta-
      // forfeit cheat where the loser pretends their board filled up.
      if (data.gameOver && !tetrisBoardLooksGameOver(data.board)) {
        reject('gameover_board_not_full');
        return;
      }

      // ----- accepted -----
      playerState.lastScore = data.score;
      playerState.lastLines = data.lines;
      playerState.lastLevel = data.level;
      playerState.lastUpdateAt = now;
      playerState.lastBoard = data.board;
      playerState.hasAcceptedState = true;
      // Decay violations on a clean update so brief network glitches
      // don't accumulate into a forfeit over a long match.
      if (playerState.violations > 0) playerState.violations--;

      // Mark gameplay activity ONLY after socket + room-membership +
      // sanity validation has passed.
      markGameplayActivity(data.matchId);

      // Tetris is snapshot-based, not move-based; we still log one row
      // per accepted snapshot so the audit trail captures the score /
      // lines / level trajectory used by the L1 anti-cheat bands.
      recordMatchMove(data.matchId, 'tetris', playerId, {
        score: data.score,
        lines: data.lines,
        level: data.level,
        gameOver: data.gameOver,
      });

      socket.to(`tetris:${data.matchId}`).emit('opponent-tetris-state', {
        board: data.board,
        score: data.score,
        lines: data.lines,
        level: data.level,
        gameOver: data.gameOver,
      });
    });

    socket.on("tetris-game-over", (data: { matchId: string }) => {
      // Identity comes from the authenticated socket; we deliberately
      // ignore any client-supplied `playerId`, since the loser is
      // whoever is calling this RPC.
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = tetrisRooms.get(data.matchId);
      if (!room) return;
      const loserId = socketInfo.playerId;
      const playerState = room.players.get(loserId);
      if (!playerState) return;

      // Plausibility gate: the loser must have at least one accepted
      // tetris-state snapshot AND that snapshot's board must look like
      // a real top-out (top rows congested). This blocks the
      // "instant-forfeit" cheat where a fresh socket fires
      // tetris-game-over before any gameplay, while still allowing a
      // legitimate top-out at score=0/lines=0 (possible in real Tetris
      // when no lines are cleared before the board fills).
      const plausibleTopOut =
        playerState.hasAcceptedState &&
        playerState.lastBoard !== null &&
        tetrisBoardLooksGameOver(playerState.lastBoard);
      if (!plausibleTopOut) {
        playerState.violations++;
        console.warn(
          "[socket] tetris-game-over rejected (implausible top-out):",
          data.matchId, loserId,
          "hasAcceptedState=", playerState.hasAcceptedState,
          "violations=", playerState.violations
        );
        if (playerState.violations >= TETRIS_VIOLATION_THRESHOLD) {
          const winnerId = tetrisOpponentId(room, loserId);
          storeGameResult(data.matchId, 'tetris', winnerId, loserId, 'tetris_anticheat_violation');
          io.to(`tetris:${data.matchId}`).emit('game-result', {
            matchId: data.matchId,
            winnerId,
            loserId,
            reason: 'tetris_anticheat_violation',
          });
          tetrisRooms.delete(data.matchId);
        }
        return;
      }

      playerState.reportedGameOver = true;
      const winnerId = tetrisOpponentId(room, loserId);
      console.log("[socket] tetris-game-over", data.matchId, "loser=", loserId);

      storeGameResult(data.matchId, 'tetris', winnerId, loserId, 'board_filled');

      socket.to(`tetris:${data.matchId}`).emit('opponent-tetris-game-over');

      io.to(`tetris:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'board_filled',
      });

      tetrisRooms.delete(data.matchId);
    });

    socket.on("join-checkers-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`checkers:${matchId}`);
      console.log("[socket] join checkers match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }

      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);

      // Verify the claimed playerId against the match's canonical
      // participant set, then mint and emit the per-(matchId,
      // playerId) HMAC token used to authenticate REST move-history
      // fetches. See verifyAndIssueMatchToken for the full rationale —
      // critical that this NOT trust the client-supplied playerId.
      verifyAndIssueMatchToken(socket, matchId, playerId);

      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
        socket.to(`checkers:${matchId}`).emit('opponent-reconnected', { matchId });
      }

      let room = checkersRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false,
          board: checkersInitialBoard(),
          currentTurn: 'red',
          redTime: CHECKERS_INITIAL_TIME_MS,
          blackTime: CHECKERS_INITIAL_TIME_MS,
          lastTickAt: 0,
          pendingJumpAt: null,
        };
        checkersRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('checkers-color-assigned', { color: existingPlayer.color });
        console.log("[socket] checkers reconnect, color preserved:", existingPlayer.color);

        if (room.players.size === 2 && room.started) {
          socket.emit('checkers-game-start', { publicState: checkersPublicState(room) });
        }
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] checkers match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingColors = Array.from(room.players.values()).map(p => p.color);
      const assignedColor: 'red' | 'black' = existingColors.includes('red') ? 'black' : 'red';

      room.players.set(playerId, { socketId: socket.id, color: assignedColor });

      socket.emit('checkers-color-assigned', { color: assignedColor });
      console.log("[socket] checkers color assigned", matchId, playerId, assignedColor);

      if (room.players.size === 2 && !room.started) {
        if (fundedMatches.has(matchId)) {
          room.started = true;
          startCheckersGame(io, matchId, room);
          markGameStarted(matchId);
          console.log("[socket] checkers-game-start", matchId);
        } else {
          console.log("[socket] checkers-game-start gated on funding", matchId);
        }
      }
    });

    socket.on("checkers-move", (data: {
      matchId: string;
      from: { row: number; col: number };
      to: { row: number; col: number };
    }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-move rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room || !room.started) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) {
        console.log("[socket] checkers-move rejected - player not in room");
        return;
      }

      if (player.color !== room.currentTurn) {
        console.log("[socket] checkers-move rejected - not your turn", player.color, "vs", room.currentTurn);
        return;
      }

      const isValidPos = (p: unknown): p is CheckersPosition =>
        !!p &&
        typeof (p as CheckersPosition).row === 'number' &&
        typeof (p as CheckersPosition).col === 'number' &&
        Number.isInteger((p as CheckersPosition).row) &&
        Number.isInteger((p as CheckersPosition).col) &&
        (p as CheckersPosition).row >= 0 && (p as CheckersPosition).row <= 7 &&
        (p as CheckersPosition).col >= 0 && (p as CheckersPosition).col <= 7;
      if (!isValidPos(data.from) || !isValidPos(data.to)) {
        console.log("[socket] checkers-move rejected - invalid coordinates");
        return;
      }

      // If the mover owes a continuation jump, they must move the same
      // piece — and the move must be a jump.
      if (room.pendingJumpAt && (room.pendingJumpAt.row !== data.from.row || room.pendingJumpAt.col !== data.from.col)) {
        console.log("[socket] checkers-move rejected - must continue multi-jump from", room.pendingJumpAt);
        return;
      }

      const now = Date.now();
      const elapsed = Math.max(0, now - room.lastTickAt);
      const remaining =
        player.color === 'red' ? room.redTime - elapsed : room.blackTime - elapsed;
      if (remaining <= 0) {
        console.log("[socket] checkers-move rejected - clock drained, forfeit by timeout");
        const winnerId = checkersOpponentId(room, socketInfo.playerId);
        const loserId = socketInfo.playerId;
        storeGameResult(data.matchId, 'checkers', winnerId, loserId, 'timeout');
        io.to(`checkers:${data.matchId}`).emit('game-result', {
          matchId: data.matchId,
          winnerId,
          loserId,
          reason: 'timeout',
        });
        checkersRooms.delete(data.matchId);
        return;
      }

      // Validate against the engine. If the mover owes a continuation,
      // restrict the legal set to jumps from that exact square.
      let legal;
      if (room.pendingJumpAt) {
        const jumpsFromHere = checkersGetJumpsFromSquare(room.board, room.pendingJumpAt);
        legal = jumpsFromHere.find((m) => m.to.row === data.to.row && m.to.col === data.to.col) ?? null;
      } else {
        legal = checkersFindLegalMove(room.board, player.color, data.from, data.to);
      }
      if (!legal) {
        console.log("[socket] checkers-move rejected - illegal move", data.from, "→", data.to);
        return;
      }

      const wasCapture = checkersIsCaptureMove(legal);
      const { board: nextBoard, promoted } = checkersApplyMove(room.board, legal);
      room.board = nextBoard;

      if (player.color === 'red') {
        room.redTime = Math.max(0, room.redTime - elapsed);
      } else {
        room.blackTime = Math.max(0, room.blackTime - elapsed);
      }
      room.lastTickAt = Date.now();

      // Multi-jump continuation: only after a capture, only if the SAME
      // landing piece has additional jumps available. Standard American
      // checkers rule: a man promoted to king during a jump must stop.
      let turnEnded = true;
      if (wasCapture && !promoted) {
        const further = checkersGetJumpsFromSquare(room.board, legal.to);
        if (further.length > 0) {
          room.pendingJumpAt = legal.to;
          turnEnded = false;
        }
      }
      if (turnEnded) {
        room.pendingJumpAt = null;
        room.currentTurn = player.color === 'red' ? 'black' : 'red';
      }

      markGameplayActivity(data.matchId);

      recordMatchMove(data.matchId, 'checkers', socketInfo.playerId, {
        from: legal.from,
        to: legal.to,
        captures: legal.captures,
        promoted,
        turnEnded,
        color: player.color,
      });

      io.to(`checkers:${data.matchId}`).emit('opponent-checkers-move', {
        from: legal.from,
        to: legal.to,
        captures: legal.captures,
        newTurn: room.currentTurn,
        turnEnded,
        redTime: room.redTime,
        blackTime: room.blackTime,
        pendingJumpAt: room.pendingJumpAt,
        board: checkersSerializeBoard(room.board),
      });

      if (!turnEnded) return;

      // Terminal: opponent has no pieces or no legal moves on its turn.
      const opponentColor: CheckersColor = room.currentTurn;
      const oppPieces = checkersCountPieces(room.board, opponentColor);
      const oppMoves = oppPieces > 0 ? checkersAllLegalMoves(room.board, opponentColor) : [];
      let terminalReason: string | null = null;
      if (oppPieces === 0) terminalReason = 'no_pieces';
      else if (oppMoves.length === 0) terminalReason = 'no_legal_moves';

      if (terminalReason) {
        const winnerId = Array.from(room.players.entries())
          .find(([, p]) => p.color === player.color)?.[0] ?? null;
        const loserId = Array.from(room.players.entries())
          .find(([, p]) => p.color === opponentColor)?.[0] ?? null;
        console.log("[socket] checkers terminal:", terminalReason, "winner:", player.color);
        storeGameResult(data.matchId, 'checkers', winnerId, loserId, terminalReason);
        io.to(`checkers:${data.matchId}`).emit('game-result', {
          matchId: data.matchId,
          winnerId,
          loserId,
          reason: terminalReason,
        });
        checkersRooms.delete(data.matchId);
      }
    });

    // checkers-timeout is a hint only — server clock is canonical.
    socket.on("checkers-timeout", (data: { matchId: string; color: 'red' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-timeout rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room || !room.started) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] checkers-timeout rejected - color mismatch");
        return;
      }

      if (room.currentTurn !== data.color) {
        console.log("[socket] checkers-timeout rejected - not the side on the clock");
        return;
      }

      const elapsed = Math.max(0, Date.now() - room.lastTickAt);
      const remaining =
        data.color === 'red' ? room.redTime - elapsed : room.blackTime - elapsed;
      if (remaining > 0) {
        console.log("[socket] checkers-timeout rejected - server clock disagrees", remaining);
        return;
      }

      if (data.color === 'red') room.redTime = 0;
      else room.blackTime = 0;

      const winnerId = checkersOpponentId(room, socketInfo.playerId);
      const loserId = socketInfo.playerId;

      console.log("[socket] checkers-timeout (server-confirmed)", data.matchId, data.color);

      storeGameResult(data.matchId, 'checkers', winnerId, loserId, 'timeout');

      socket.to(`checkers:${data.matchId}`).emit('opponent-checkers-timeout');
      io.to(`checkers:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'timeout',
      });

      checkersRooms.delete(data.matchId);
    });

    socket.on("checkers-resign", (data: { matchId: string; color: 'red' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = checkersRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] checkers-resign rejected - color mismatch");
        return;
      }

      const winnerId = checkersOpponentId(room, socketInfo.playerId);
      const loserId = socketInfo.playerId;

      console.log("[socket] checkers-resign", data.matchId, data.color);

      storeGameResult(data.matchId, 'checkers', winnerId, loserId, 'resignation');

      socket.to(`checkers:${data.matchId}`).emit('opponent-checkers-resigned');
      io.to(`checkers:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'resignation',
      });

      checkersRooms.delete(data.matchId);
    });

    // Legacy client-claimed `checkers-game-end` removed: terminals are
    // detected server-side inside `checkers-move`; resignation flows
    // through `checkers-resign`.

    socket.on("join-battleship-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`battleship:${matchId}`);
      console.log("[socket] join battleship match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }
      
      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);

      // Verify the claimed playerId against the match's canonical
      // participant set, then mint and emit the per-(matchId,
      // playerId) HMAC token used to authenticate REST move-history
      // fetches. See verifyAndIssueMatchToken for the full rationale —
      // critical that this NOT trust the client-supplied playerId.
      verifyAndIssueMatchToken(socket, matchId, playerId);
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
        // Notify the surviving opponent so their disconnect banner clears.
        socket.to(`battleship:${matchId}`).emit('opponent-reconnected', { matchId });
      }

      let room = battleshipRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false,
          battlePhase: false,
          currentTurn: 'player1',
          attackHistory: new Map()
        };
        battleshipRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('battleship-role-assigned', { role: existingPlayer.role });
        console.log("[socket] battleship reconnect, role preserved:", existingPlayer.role);
        
        if (room.players.size === 2 && room.started) {
          socket.emit('battleship-game-start');
          if (room.battlePhase) {
            socket.emit('battle-phase-start', { firstTurn: room.currentTurn });
          }
        }
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] battleship match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingRoles = Array.from(room.players.values()).map(p => p.role);
      const assignedRole: 'player1' | 'player2' = existingRoles.includes('player1') ? 'player2' : 'player1';
      
      room.players.set(playerId, { 
        socketId: socket.id, 
        role: assignedRole,
        ready: false,
        ships: []
      });

      socket.emit('battleship-role-assigned', { role: assignedRole });
      console.log("[socket] battleship role assigned", matchId, playerId, assignedRole);

      if (room.players.size === 2 && !room.started) {
        if (fundedMatches.has(matchId)) {
          room.started = true;
          io.to(`battleship:${matchId}`).emit('battleship-game-start');
          markGameStarted(matchId);
          console.log("[socket] battleship-game-start", matchId);
        } else {
          console.log("[socket] battleship-game-start gated on funding", matchId);
        }
      }
    });

    socket.on("battleship-ready", (data: { matchId: string; placements: ShipPlacement[] }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] battleship-ready rejected - unauthorized");
        return;
      }

      const room = battleshipRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) return;

      if (player.ready) {
        console.log("[socket] battleship-ready rejected - already ready");
        return;
      }

      const validation = validateShipPlacements(data.placements);
      if (!validation.valid) {
        console.log("[socket] battleship-ready rejected - invalid placements:", validation.error);
        socket.emit('placement-error', { error: validation.error });
        return;
      }

      const ships: BattleshipShip[] = data.placements.map(p => {
        const config = SHIP_CONFIGS.find(s => s.id === p.shipId)!;
        const cells: { row: number; col: number }[] = [];
        
        for (let i = 0; i < config.size; i++) {
          cells.push({
            row: p.horizontal ? p.row : p.row + i,
            col: p.horizontal ? p.col + i : p.col
          });
        }

        return {
          id: p.shipId,
          name: config.name,
          size: config.size,
          cells,
          hits: 0,
          sunk: false
        };
      });

      player.ships = ships;
      player.ready = true;

      console.log("[socket] battleship player ready", data.matchId, player.role);

      socket.to(`battleship:${data.matchId}`).emit('opponent-ready');

      const allReady = Array.from(room.players.values()).every(p => p.ready);
      if (allReady && !room.battlePhase) {
        room.battlePhase = true;
        room.currentTurn = 'player1';
        io.to(`battleship:${data.matchId}`).emit('battle-phase-start', { firstTurn: 'player1' });
        console.log("[socket] battleship battle phase start", data.matchId);
      }
    });

    socket.on("battleship-attack", (data: { matchId: string; row: number; col: number }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] battleship-attack rejected - unauthorized");
        return;
      }

      const room = battleshipRooms.get(data.matchId);
      if (!room || !room.battlePhase) return;

      const attacker = room.players.get(socketInfo.playerId);
      if (!attacker || attacker.role !== room.currentTurn) {
        console.log("[socket] battleship-attack rejected - not your turn");
        return;
      }

      if (data.row < 0 || data.row >= GRID_SIZE || data.col < 0 || data.col >= GRID_SIZE) {
        console.log("[socket] battleship-attack rejected - out of bounds");
        return;
      }

      // Mark gameplay activity ONLY after socket/room/turn/bounds auth has passed.
      markGameplayActivity(data.matchId);

      let attackerHistory = room.attackHistory.get(socketInfo.playerId);
      if (!attackerHistory) {
        attackerHistory = new Set();
        room.attackHistory.set(socketInfo.playerId, attackerHistory);
      }

      const attackKey = `${data.row},${data.col}`;
      if (attackerHistory.has(attackKey)) {
        console.log("[socket] battleship-attack rejected - already attacked this cell");
        return;
      }
      attackerHistory.add(attackKey);

      const defenderId = Array.from(room.players.entries()).find(([_, p]) => p.role !== attacker.role)?.[0];
      if (!defenderId) return;

      const defender = room.players.get(defenderId)!;

      let hit = false;
      let sunkShip: BattleshipShip | null = null;

      for (const ship of defender.ships) {
        const hitCell = ship.cells.find(c => c.row === data.row && c.col === data.col);
        if (hitCell) {
          hit = true;
          ship.hits++;
          if (ship.hits >= ship.size) {
            ship.sunk = true;
            sunkShip = ship;
          }
          break;
        }
      }

      const allSunk = defender.ships.every(s => s.sunk);
      const nextTurn = attacker.role === 'player1' ? 'player2' : 'player1';

      if (!allSunk) {
        room.currentTurn = nextTurn;
      }

      console.log("[socket] battleship-attack", data.matchId, data.row, data.col, hit ? "HIT" : "MISS", sunkShip?.name || "");

      recordMatchMove(data.matchId, 'battleship', socketInfo.playerId, {
        row: data.row,
        col: data.col,
        hit,
        sunkShip: sunkShip ? { id: sunkShip.id, name: sunkShip.name } : null,
        allSunk,
      });

      socket.emit('attack-result', {
        row: data.row,
        col: data.col,
        hit,
        sunkShip,
        gameOver: allSunk,
        nextTurn
      });

      const defenderSocket = io.sockets.sockets.get(defender.socketId);
      if (defenderSocket) {
        defenderSocket.emit('opponent-attack', {
          row: data.row,
          col: data.col,
          hit,
          sunkShipCells: sunkShip?.cells,
          sunkShipName: sunkShip?.name,
          gameOver: allSunk
        });
      }

      if (allSunk) {
        storeGameResult(data.matchId, 'battleship', socketInfo.playerId, defenderId, 'all_ships_sunk');
        
        io.to(`battleship:${data.matchId}`).emit('game-result', {
          matchId: data.matchId,
          winnerId: socketInfo.playerId,
          loserId: defenderId,
          reason: 'all_ships_sunk'
        });
        
        battleshipRooms.delete(data.matchId);
      }
    });

    // ─────────────────── Dominoes ───────────────────

    socket.on("join-dominoes-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`dominoes:${matchId}`);
      console.log("[socket] join dominoes match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }

      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);

      // Verify the claimed playerId against the match's canonical
      // participant set, then mint and emit the per-(matchId,
      // playerId) HMAC token used to authenticate REST move-history
      // fetches. See verifyAndIssueMatchToken for the full rationale —
      // critical that this NOT trust the client-supplied playerId.
      verifyAndIssueMatchToken(socket, matchId, playerId);

      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
        socket.to(`dominoes:${matchId}`).emit('opponent-reconnected', { matchId });
      }

      let room = dominoesRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false,
          dealt: false,
          chain: [],
          leftEnd: null,
          rightEnd: null,
          currentTurn: 'p1',
          starterTile: null,
          p1Time: DOMINOES_INITIAL_TIME_MS,
          p2Time: DOMINOES_INITIAL_TIME_MS,
          consecutivePasses: 0,
          lastTickAt: 0,
        };
        dominoesRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('dominoes-role-assigned', { role: existingPlayer.role });
        if (room.dealt) {
          // On reconnect, re-send this player's full game state. Pass
          // starterTile only while the chain is still empty so the UI can
          // re-arm the lead-tile restriction; otherwise it's irrelevant.
          socket.emit('dominoes-game-start', {
            role: existingPlayer.role,
            hand: existingPlayer.hand,
            publicState: dominoesPublicState(room),
            starterTile: room.chain.length === 0 ? room.starterTile : null,
          });
        }
        console.log("[socket] dominoes reconnect, role preserved:", existingPlayer.role);
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] dominoes match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingRoles = Array.from(room.players.values()).map(p => p.role);
      const assignedRole: DominoesPlayerRole = existingRoles.includes('p1') ? 'p2' : 'p1';

      room.players.set(playerId, {
        socketId: socket.id,
        role: assignedRole,
        hand: [],
      });

      socket.emit('dominoes-role-assigned', { role: assignedRole });
      console.log("[socket] dominoes role assigned", matchId, playerId, assignedRole);

      if (room.players.size === 2 && !room.started) {
        if (fundedMatches.has(matchId)) {
          room.started = true;
          startDominoesGame(io, room);
          markGameStarted(matchId);
          console.log("[socket] dominoes-game-start", matchId);
        } else {
          console.log("[socket] dominoes-game-start gated on funding", matchId);
        }
      }
    });

    // NOTE: Dominoes deliberately has NO `dominoes-game-end` client event.
    // Unlike checkers (which lets the client report a draw/resignation),
    // every dominoes outcome — win-by-played-out, blocked-board, timeout,
    // or disconnect-forfeit — is resolved server-side from the move/pass/
    // timeout handlers below using `storeGameResult`. Result is then
    // broadcast via the shared `game-result` event. Keeping the client
    // out of the resolution loop prevents trivially-spoofable wins.
    socket.on("dominoes-move", (data: { matchId: string; tileA: number; tileB: number; end: DominoesChainEnd }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = dominoesRooms.get(data.matchId);
      if (!room || !room.dealt) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) return;

      // Helper: shove the player's true server-side hand back at them so
      // any optimistic mutation on the client is reverted by re-sync.
      const reject = (reason: string): void => {
        console.log("[socket] dominoes-move rejected —", reason);
        socket.emit('dominoes-resync', {
          hand: player.hand,
          publicState: dominoesPublicState(room),
          reason,
        });
      };

      if (player.role !== room.currentTurn) {
        reject("not your turn");
        return;
      }
      if (data.end !== 'left' && data.end !== 'right') {
        reject("invalid end");
        return;
      }
      if (
        typeof data.tileA !== 'number' ||
        typeof data.tileB !== 'number' ||
        data.tileA < 0 || data.tileA > 6 ||
        data.tileB < 0 || data.tileB > 6
      ) {
        reject("invalid tile pips");
        return;
      }

      // Resolve by tile identity (canonical a<=b). Tile order in the hand
      // is server-private — the client uses identity so its UI can sort
      // freely without ever desyncing on indices.
      const wantA = Math.min(data.tileA, data.tileB);
      const wantB = Math.max(data.tileA, data.tileB);
      const tileIndex = player.hand.findIndex((t) => t.a === wantA && t.b === wantB);
      if (tileIndex === -1) {
        reject("tile not in hand");
        return;
      }
      const tile = player.hand[tileIndex];
      const chainEnd = data.end === 'left' ? room.leftEnd : room.rightEnd;
      if (!dominoesCanPlayAt(tile, chainEnd)) {
        reject("tile does not match end");
        return;
      }
      // Lead-tile enforcement: the very first move of the game MUST be
      // the starter's mandated highest-double (or heaviest if no doubles).
      if (room.chain.length === 0 && room.starterTile) {
        if (tile.a !== room.starterTile.a || tile.b !== room.starterTile.b) {
          reject("must lead with starter tile");
          return;
        }
      }

      // Deduct elapsed clock time from the moving player BEFORE applying the
      // move so the public-state snapshot reflects the time spent thinking.
      const now = Date.now();
      const elapsed = Math.max(0, now - room.lastTickAt);
      if (room.currentTurn === 'p1') {
        room.p1Time = Math.max(0, room.p1Time - elapsed);
      } else {
        room.p2Time = Math.max(0, room.p2Time - elapsed);
      }

      markGameplayActivity(data.matchId);

      const { placed, newEnd } = dominoesPlaceTile(tile, chainEnd, data.end, player.role);
      if (data.end === 'left') {
        room.chain.unshift(placed);
        room.leftEnd = newEnd;
        if (room.rightEnd === null) room.rightEnd = placed.right;
      } else {
        room.chain.push(placed);
        room.rightEnd = newEnd;
        if (room.leftEnd === null) room.leftEnd = placed.left;
      }
      // First lead move: both ends are exposed by the single placed tile.
      if (room.chain.length === 1) {
        room.leftEnd = placed.left;
        room.rightEnd = placed.right;
      }
      player.hand.splice(tileIndex, 1);
      room.consecutivePasses = 0;
      // The starter's lead requirement is satisfied — clear the gate.
      room.starterTile = null;

      recordMatchMove(data.matchId, 'dominoes', socketInfo.playerId, {
        type: 'place',
        tileA: wantA,
        tileB: wantB,
        end: data.end,
        role: player.role,
      });

      const winnerByEmpty = player.hand.length === 0;

      if (winnerByEmpty) {
        const opponentId = dominoesOpponentId(room, socketInfo.playerId);
        if (!opponentId) return;
        storeGameResult(data.matchId, 'dominoes', socketInfo.playerId, opponentId, 'played_out');
        io.to(`dominoes:${data.matchId}`).emit('dominoes-move-played', {
          player: player.role,
          placed,
          end: data.end,
          publicState: dominoesPublicState(room),
        });
        io.to(`dominoes:${data.matchId}`).emit('game-result', {
          matchId: data.matchId,
          winnerId: socketInfo.playerId,
          loserId: opponentId,
          reason: 'played_out',
        });
        dominoesRooms.delete(data.matchId);
        return;
      }

      // Switch turn and start the opponent's clock.
      room.currentTurn = room.currentTurn === 'p1' ? 'p2' : 'p1';
      room.lastTickAt = Date.now();

      io.to(`dominoes:${data.matchId}`).emit('dominoes-move-played', {
        player: player.role,
        placed,
        end: data.end,
        publicState: dominoesPublicState(room),
      });
    });

    socket.on("dominoes-pass", (data: { matchId: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = dominoesRooms.get(data.matchId);
      if (!room || !room.dealt) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.role !== room.currentTurn) return;

      // Server-authoritative legality: a pass is only allowed if the player
      // truly has no playable tile against either chain end.
      if (dominoesHasLegalMove(player.hand, room.leftEnd, room.rightEnd)) {
        console.log("[socket] dominoes-pass rejected — legal move available");
        return;
      }

      // Deduct elapsed clock from the passing player.
      const now = Date.now();
      const elapsed = Math.max(0, now - room.lastTickAt);
      if (room.currentTurn === 'p1') {
        room.p1Time = Math.max(0, room.p1Time - elapsed);
      } else {
        room.p2Time = Math.max(0, room.p2Time - elapsed);
      }

      markGameplayActivity(data.matchId);
      room.consecutivePasses += 1;

      recordMatchMove(data.matchId, 'dominoes', socketInfo.playerId, {
        type: 'pass',
        role: player.role,
        consecutivePasses: room.consecutivePasses,
      });

      // Two consecutive passes = blocked board → settle by lowest pip count.
      if (room.consecutivePasses >= 2) {
        let p1Player: DominoesPlayerInfo | undefined;
        let p2Player: DominoesPlayerInfo | undefined;
        let p1Id = '';
        let p2Id = '';
        for (const [id, p] of room.players.entries()) {
          if (p.role === 'p1') { p1Player = p; p1Id = id; }
          else { p2Player = p; p2Id = id; }
        }
        if (!p1Player || !p2Player) return;
        const winnerRole = dominoesBlockedWinner(p1Player.hand, p2Player.hand);
        if (winnerRole === null) {
          storeGameResult(data.matchId, 'dominoes', null, null, 'draw');
          io.to(`dominoes:${data.matchId}`).emit('dominoes-pass-played', {
            player: player.role,
            publicState: dominoesPublicState(room),
          });
          io.to(`dominoes:${data.matchId}`).emit('game-result', {
            matchId: data.matchId,
            winnerId: null,
            loserId: null,
            reason: 'draw',
          });
        } else {
          const winnerId = winnerRole === 'p1' ? p1Id : p2Id;
          const loserId = winnerRole === 'p1' ? p2Id : p1Id;
          storeGameResult(data.matchId, 'dominoes', winnerId, loserId, 'blocked');
          io.to(`dominoes:${data.matchId}`).emit('dominoes-pass-played', {
            player: player.role,
            publicState: dominoesPublicState(room),
          });
          io.to(`dominoes:${data.matchId}`).emit('game-result', {
            matchId: data.matchId,
            winnerId,
            loserId,
            reason: 'blocked',
          });
        }
        dominoesRooms.delete(data.matchId);
        return;
      }

      // Switch turn and start the opponent's clock.
      room.currentTurn = room.currentTurn === 'p1' ? 'p2' : 'p1';
      room.lastTickAt = Date.now();

      io.to(`dominoes:${data.matchId}`).emit('dominoes-pass-played', {
        player: player.role,
        publicState: dominoesPublicState(room),
      });
    });

    socket.on("dominoes-timeout", (data: { matchId: string; role: DominoesPlayerRole }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = dominoesRooms.get(data.matchId);
      if (!room || !room.dealt) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.role !== data.role || room.currentTurn !== data.role) return;

      // Server-side clock gate: only honor the timeout if the player's
      // remaining time has actually drained to zero on the authoritative
      // clock. Otherwise a malicious client could declare a fake timeout.
      const elapsed = Math.max(0, Date.now() - room.lastTickAt);
      const remaining =
        data.role === 'p1' ? room.p1Time - elapsed : room.p2Time - elapsed;
      if (remaining > 0) {
        console.log("[socket] dominoes-timeout rejected — clock not drained", remaining);
        return;
      }

      const opponentId = dominoesOpponentId(room, socketInfo.playerId);
      if (!opponentId) return;

      storeGameResult(data.matchId, 'dominoes', opponentId, socketInfo.playerId, 'timeout');
      io.to(`dominoes:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId: opponentId,
        loserId: socketInfo.playerId,
        reason: 'timeout',
      });
      dominoesRooms.delete(data.matchId);
    });

    // ───────────────────────────── Xiangqi ─────────────────────────────
    // Mirrors the Checkers shape: client-driven board state, server-
    // authoritative socket auth + turn enforcement + clock validation.
    // Wire payload for moves matches the spec contract:
    //   { from, to, redTime, blackTime, newTurn } — broadcast as
    //   `opponent-xiangqi-move`. Server overrides redTime/blackTime/newTurn
    //   with its own authoritative values.

    socket.on("join-xiangqi-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`xiangqi:${matchId}`);
      console.log("[socket] join xiangqi match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }

      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);

      // Verify the claimed playerId against the match's canonical
      // participant set, then mint and emit the per-(matchId,
      // playerId) HMAC token used to authenticate REST move-history
      // fetches. See verifyAndIssueMatchToken for the full rationale —
      // critical that this NOT trust the client-supplied playerId.
      verifyAndIssueMatchToken(socket, matchId, playerId);

      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
        socket.to(`xiangqi:${matchId}`).emit('opponent-reconnected', { matchId });
      }

      let room = xiangqiRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false,
          board: xiangqiInitialBoard(),
          currentTurn: 'red',
          redTime: XIANGQI_INITIAL_TIME_MS,
          blackTime: XIANGQI_INITIAL_TIME_MS,
          lastTickAt: 0,
          pliesSinceCapture: 0,
          drawOfferedBy: null,
          history: [],
        };
        xiangqiRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('xiangqi-color-assigned', { color: existingPlayer.color });
        console.log("[socket] xiangqi reconnect, color preserved:", existingPlayer.color);

        if (room.players.size === 2 && room.started) {
          // Re-send a fresh game-start with the live (time-bled) public
          // state so the reconnecting client lines up its own clock.
          socket.emit('xiangqi-game-start', { publicState: xiangqiPublicState(room) });
        }
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] xiangqi match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingColors = Array.from(room.players.values()).map((p) => p.color);
      const assignedColor: XiangqiColor = existingColors.includes('red') ? 'black' : 'red';

      room.players.set(playerId, { socketId: socket.id, color: assignedColor });

      socket.emit('xiangqi-color-assigned', { color: assignedColor });
      console.log("[socket] xiangqi color assigned", matchId, playerId, assignedColor);

      if (room.players.size === 2 && !room.started) {
        if (fundedMatches.has(matchId)) {
          room.started = true;
          startXiangqiGame(io, matchId, room);
          markGameStarted(matchId);
          console.log("[socket] xiangqi-game-start", matchId);
        } else {
          console.log("[socket] xiangqi-game-start gated on funding", matchId);
        }
      }
    });

    socket.on("xiangqi-move", (data: {
      matchId: string;
      from: { file: number; rank: number };
      to: { file: number; rank: number };
      // Wire-format compatibility only — server ignores client-claimed
      // turn/clock and overrides with its own authoritative values.
      newTurn?: XiangqiColor;
      redTime?: number;
      blackTime?: number;
    }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] xiangqi-move rejected - unauthorized");
        return;
      }

      const room = xiangqiRooms.get(data.matchId);
      if (!room || !room.started) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) {
        console.log("[socket] xiangqi-move rejected - player not in room");
        return;
      }

      // Server-authoritative turn enforcement: only the side whose turn
      // it currently is may submit a move. Drops out-of-turn / replay /
      // double-move attempts.
      if (player.color !== room.currentTurn) {
        console.log("[socket] xiangqi-move rejected - not your turn", player.color, "vs", room.currentTurn);
        return;
      }

      // Validate move shape before consulting the engine.
      const isValidSquare = (s: unknown): s is XiangqiSquare =>
        !!s &&
        typeof (s as XiangqiSquare).file === 'number' &&
        typeof (s as XiangqiSquare).rank === 'number' &&
        Number.isInteger((s as XiangqiSquare).file) &&
        Number.isInteger((s as XiangqiSquare).rank) &&
        (s as XiangqiSquare).file >= 0 && (s as XiangqiSquare).file <= 8 &&
        (s as XiangqiSquare).rank >= 0 && (s as XiangqiSquare).rank <= 9;
      if (!isValidSquare(data.from) || !isValidSquare(data.to)) {
        console.log("[socket] xiangqi-move rejected - invalid coordinates");
        return;
      }

      // Authoritative clock: deduct think-time first; forfeit if drained.
      const now = Date.now();
      const elapsed = Math.max(0, now - room.lastTickAt);
      const remaining =
        player.color === 'red' ? room.redTime - elapsed : room.blackTime - elapsed;
      if (remaining <= 0) {
        console.log("[socket] xiangqi-move rejected - clock drained, forfeit by timeout");
        const winnerId = xiangqiOpponentId(room, socketInfo.playerId);
        const loserId = socketInfo.playerId;
        storeGameResult(data.matchId, 'xiangqi', winnerId, loserId, 'timeout');
        io.to(`xiangqi:${data.matchId}`).emit('game-result', {
          matchId: data.matchId,
          winnerId,
          loserId,
          reason: 'timeout',
        });
        xiangqiRooms.delete(data.matchId);
        return;
      }

      // Server-authoritative legality via the shared rules engine.
      const move = { from: data.from, to: data.to };
      if (!xiangqiIsLegalMove(room.board, player.color, move)) {
        console.log("[socket] xiangqi-move rejected - illegal move", data.from, "→", data.to);
        return;
      }

      const wasCapture = xiangqiIsCaptureMove(room.board, move);
      room.board = xiangqiApplyMove(room.board, move);
      room.pliesSinceCapture = wasCapture ? 0 : room.pliesSinceCapture + 1;

      // Deduct the elapsed time we just consumed.
      if (player.color === 'red') {
        room.redTime = Math.max(0, room.redTime - elapsed);
      } else {
        room.blackTime = Math.max(0, room.blackTime - elapsed);
      }

      // Any move implicitly declines any outstanding draw offer.
      room.drawOfferedBy = null;

      const opponentColor: XiangqiColor = player.color === 'red' ? 'black' : 'red';
      room.currentTurn = opponentColor;
      room.lastTickAt = Date.now();

      markGameplayActivity(data.matchId);

      recordMatchMove(data.matchId, 'xiangqi', socketInfo.playerId, {
        from: data.from,
        to: data.to,
        wasCapture,
        color: player.color,
      });

      // Opponent-only broadcast: the mover already applied the move
      // optimistically; echoing it would double-advance their engine.
      socket.to(`xiangqi:${data.matchId}`).emit('opponent-xiangqi-move', {
        from: data.from,
        to: data.to,
        newTurn: room.currentTurn,
        redTime: room.redTime,
        blackTime: room.blackTime,
      });

      // Record this position + whether the move delivered check, for
      // perpetual-check detection downstream.
      const deliveredCheck = xiangqiIsInCheck(room.board, opponentColor);
      room.history.push({
        posKey: xiangqiPositionKey(room.board, room.currentTurn),
        checkingSide: deliveredCheck ? player.color : null,
      });

      // Terminal-state detection. Order matters: general capture first
      // (statusFor can be misleading if a general is off-board), then
      // checkmate/stalemate, then perpetual check, then 60-ply draw.
      const opponentGeneral = xiangqiFindGeneral(room.board, opponentColor);
      let terminal: { reason: string; winner: XiangqiColor | null } | null = null;
      if (!opponentGeneral) {
        terminal = { reason: 'general_captured', winner: player.color };
      } else {
        const status = xiangqiStatusFor(room.board, opponentColor);
        if (status === 'checkmate') {
          terminal = { reason: 'checkmate', winner: player.color };
        } else if (status === 'stalemate') {
          // Asian-rules stalemate: side to move loses, so mover wins.
          terminal = { reason: 'stalemate', winner: player.color };
        } else {
          const offender = xiangqiDetectPerpetualCheckLoser(room.history);
          if (offender) {
            const winner: XiangqiColor = offender === 'red' ? 'black' : 'red';
            terminal = { reason: 'perpetual_check', winner };
          } else if (room.pliesSinceCapture >= XIANGQI_NO_CAPTURE_DRAW_PLIES) {
            terminal = { reason: 'draw', winner: null };
          }
        }
      }

      if (terminal) {
        let winnerId: string | null = null;
        let loserId: string | null = null;
        if (terminal.winner) {
          for (const [id, p] of room.players.entries()) {
            if (p.color === terminal.winner) winnerId = id;
            else loserId = id;
          }
        }
        console.log("[socket] xiangqi terminal:", terminal.reason, "winner:", terminal.winner);
        storeGameResult(data.matchId, 'xiangqi', winnerId, loserId, terminal.reason);
        io.to(`xiangqi:${data.matchId}`).emit('game-result', {
          matchId: data.matchId,
          winnerId,
          loserId,
          reason: terminal.reason,
        });
        xiangqiRooms.delete(data.matchId);
      }
    });

    socket.on("xiangqi-timeout", (data: { matchId: string; color: XiangqiColor }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] xiangqi-timeout rejected - unauthorized");
        return;
      }

      const room = xiangqiRooms.get(data.matchId);
      if (!room || !room.started) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] xiangqi-timeout rejected - color mismatch");
        return;
      }

      // Authoritative clock gate: only honour the timeout if the player's
      // remaining time has truly drained on the server clock. Otherwise a
      // malicious client could declare a fake timeout against itself in
      // some weird griefing scenario.
      if (room.currentTurn !== data.color) {
        console.log("[socket] xiangqi-timeout rejected - not active player");
        return;
      }
      const elapsed = Math.max(0, Date.now() - room.lastTickAt);
      const remaining =
        data.color === 'red' ? room.redTime - elapsed : room.blackTime - elapsed;
      if (remaining > 0) {
        console.log("[socket] xiangqi-timeout rejected - clock not drained", remaining);
        return;
      }

      const winnerId = xiangqiOpponentId(room, socketInfo.playerId);
      const loserId = socketInfo.playerId;

      console.log("[socket] xiangqi-timeout", data.matchId, data.color);

      storeGameResult(data.matchId, 'xiangqi', winnerId, loserId, 'timeout');

      socket.to(`xiangqi:${data.matchId}`).emit('opponent-xiangqi-timeout');
      io.to(`xiangqi:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'timeout',
      });

      xiangqiRooms.delete(data.matchId);
    });

    // NOTE: There is deliberately no `xiangqi-game-end` client event. All
    // natural game endings (checkmate, stalemate, general capture, 60-ply
    // no-capture draw) are detected SERVER-SIDE inside `xiangqi-move`
    // using the shared rules engine, so a malicious client can't forge a
    // win. Resign / draw-agreement / disconnect / timeout each have their
    // own narrowly-scoped handler below.

    socket.on("xiangqi-resign", (data: { matchId: string; color: XiangqiColor }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = xiangqiRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] xiangqi-resign rejected - color mismatch");
        return;
      }

      const winnerId = xiangqiOpponentId(room, socketInfo.playerId);
      const loserId = socketInfo.playerId;

      console.log("[socket] xiangqi-resign", data.matchId, data.color);

      storeGameResult(data.matchId, 'xiangqi', winnerId, loserId, 'resign');

      io.to(`xiangqi:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'resign',
      });

      xiangqiRooms.delete(data.matchId);
    });

    socket.on("xiangqi-draw-offer", (data: { matchId: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = xiangqiRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) return;

      // Only one outstanding offer at a time; keep the latest offerer.
      room.drawOfferedBy = player.color;
      console.log("[socket] xiangqi-draw-offer", data.matchId, "by", player.color);
      socket.to(`xiangqi:${data.matchId}`).emit('xiangqi-draw-offered', { from: player.color });
    });

    socket.on("xiangqi-draw-accept", (data: { matchId: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      const room = xiangqiRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) return;

      // Only the side that did NOT offer can accept, and there must be
      // an outstanding offer. This blocks self-accept and replay attacks.
      if (!room.drawOfferedBy || room.drawOfferedBy === player.color) {
        console.log("[socket] xiangqi-draw-accept rejected - no valid offer");
        return;
      }

      console.log("[socket] xiangqi-draw-accept", data.matchId, "by", player.color);

      // Draw: both players logged with null winner/loser per the schema's
      // existing draw convention used by dominoes blocked-board draws.
      storeGameResult(data.matchId, 'xiangqi', null, null, 'draw_agreement');
      io.to(`xiangqi:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId: null,
        loserId: null,
        reason: 'draw_agreement',
      });

      xiangqiRooms.delete(data.matchId);
    });

    socket.on("battleship-timeout", (data: { matchId: string; role: 'player1' | 'player2' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] battleship-timeout rejected - unauthorized");
        return;
      }

      const room = battleshipRooms.get(data.matchId);
      if (!room || !room.battlePhase) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.role !== data.role || room.currentTurn !== data.role) {
        console.log("[socket] battleship-timeout rejected - role mismatch");
        return;
      }

      const nextTurn = data.role === 'player1' ? 'player2' : 'player1';
      room.currentTurn = nextTurn;

      console.log("[socket] battleship-timeout (turn skipped)", data.matchId, data.role);
      io.to(`battleship:${data.matchId}`).emit('turn-skipped', { skippedPlayer: data.role });
    });

    socket.on("disconnect", () => {
      console.log("[socket] disconnected", socket.id);
      // Release the per-IP slot first thing so a client that opens and
      // closes connections in a tight loop never gets permanently capped.
      const data = (socket as any).data || {};
      if (data.slotAcquired && data.clientIp) {
        releaseSocketSlot(data.clientIp).catch(() => {});
      }
      const socketInfo = socketToPlayer.get(socket.id);

      if (socketInfo) {
        const { matchId, playerId } = socketInfo;

        // Tell the surviving opponent immediately that this player's socket
        // dropped, with the grace deadline so the client can render a live
        // "forfeit in 0:30" countdown. We emit to all four game rooms because
        // the disconnect handler does not know which game type this match is
        // for; only the room with live subscribers will actually receive it.
        // The disconnecting socket has already left its rooms at this point,
        // so this never echoes back to the player who dropped.
        const graceUntilMs = Date.now() + 30000;
        io.to(`match:${matchId}`).emit('opponent-disconnect-pending', { matchId, graceUntilMs });
        io.to(`tetris:${matchId}`).emit('opponent-disconnect-pending', { matchId, graceUntilMs });
        io.to(`checkers:${matchId}`).emit('opponent-disconnect-pending', { matchId, graceUntilMs });
        io.to(`battleship:${matchId}`).emit('opponent-disconnect-pending', { matchId, graceUntilMs });
        io.to(`dominoes:${matchId}`).emit('opponent-disconnect-pending', { matchId, graceUntilMs });
        io.to(`xiangqi:${matchId}`).emit('opponent-disconnect-pending', { matchId, graceUntilMs });

        const timeout = setTimeout(() => {
          const currentSocketId = playerToSocket.get(playerId);
          if (currentSocketId && currentSocketId !== socket.id) {
            console.log("[socket] player has reconnected, skipping forfeit:", playerId);
            return;
          }

          pendingDisconnects.delete(playerId);
          playerToSocket.delete(playerId);

          // CRITICAL: only forfeit / settle a match if gameplay actually
          // started. Without this gate, a player who closed their tab
          // while still on the "waiting for on-chain confirmation" screen
          // would be flagged as a forfeiter — which previously produced
          // bogus +stake/-stake history rows for never-played TON matches
          // whose `getMatch` reader was broken. For never-started matches
          // we just clean the rooms and notify the lobby; on-chain refunds
          // are handled separately via the contract's RefundNoShow path,
          // which either player can trigger from their wallet once the
          // contract's deposit-timeout window elapses.
          const started = gameStartedMatches.has(matchId);
          if (!started) {
            const hadAnyRoom =
              matchRooms.has(matchId) ||
              tetrisRooms.has(matchId) ||
              checkersRooms.has(matchId) ||
              battleshipRooms.has(matchId) ||
              dominoesRooms.has(matchId) ||
              xiangqiRooms.has(matchId);
            matchRooms.delete(matchId);
            tetrisRooms.delete(matchId);
            checkersRooms.delete(matchId);
            battleshipRooms.delete(matchId);
            dominoesRooms.delete(matchId);
            xiangqiRooms.delete(matchId);
            // Also clear funded/started bookkeeping so these sets do not
            // grow unbounded over the process lifetime when matches are
            // abandoned before play.
            fundedMatches.delete(matchId);
            gameStartedMatches.delete(matchId);
            gameMovesRecorded.delete(matchId);
            if (hadAnyRoom) {
              console.log("[socket] disconnect on never-started match — emitting match-cancelled, no forfeit:", matchId);
              io.to(`match:${matchId}`).emit("match-cancelled", { matchId, reason: "never_started" });
              io.to(`tetris:${matchId}`).emit("match-cancelled", { matchId, reason: "never_started" });
              io.to(`checkers:${matchId}`).emit("match-cancelled", { matchId, reason: "never_started" });
              io.to(`battleship:${matchId}`).emit("match-cancelled", { matchId, reason: "never_started" });
              io.to(`dominoes:${matchId}`).emit("match-cancelled", { matchId, reason: "never_started" });
              io.to(`xiangqi:${matchId}`).emit("match-cancelled", { matchId, reason: "never_started" });
            }
            return;
          }

          const chessRoom = matchRooms.get(matchId);
          if (chessRoom) {
            const player = chessRoom.players.get(playerId);
            if (player) {
              const winnerId = Array.from(chessRoom.players.entries()).find(([id, _]) => id !== playerId)?.[0];

              if (winnerId) {
                storeGameResult(matchId, 'chess', winnerId, playerId, 'disconnect');
                io.to(`match:${matchId}`).emit('opponent-disconnected', { matchId, forfeit: true });
                io.to(`match:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect'
                });
              }
              matchRooms.delete(matchId);
            }
          }

          const tetrisRoom = tetrisRooms.get(matchId);
          if (tetrisRoom) {
            const winnerId = Array.from(tetrisRoom.players.keys()).find(id => id !== playerId);
            if (winnerId) {
              storeGameResult(matchId, 'tetris', winnerId, playerId, 'disconnect');
              io.to(`tetris:${matchId}`).emit('opponent-disconnected', { matchId, forfeit: true });
              io.to(`tetris:${matchId}`).emit('game-result', {
                matchId,
                winnerId,
                loserId: playerId,
                reason: 'disconnect'
              });
            }
            tetrisRooms.delete(matchId);
          }

          const checkersRoom = checkersRooms.get(matchId);
          if (checkersRoom) {
            const player = checkersRoom.players.get(playerId);
            if (player) {
              const winnerId = Array.from(checkersRoom.players.entries()).find(([id, _]) => id !== playerId)?.[0];
              if (winnerId) {
                storeGameResult(matchId, 'checkers', winnerId, playerId, 'disconnect');
                io.to(`checkers:${matchId}`).emit('opponent-disconnected', { matchId, forfeit: true });
                io.to(`checkers:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect'
                });
              }
              checkersRooms.delete(matchId);
            }
          }

          const battleshipRoom = battleshipRooms.get(matchId);
          if (battleshipRoom && battleshipRoom.battlePhase) {
            const player = battleshipRoom.players.get(playerId);
            if (player) {
              const winnerId = Array.from(battleshipRoom.players.entries()).find(([id, _]) => id !== playerId)?.[0];
              if (winnerId) {
                storeGameResult(matchId, 'battleship', winnerId, playerId, 'disconnect');
                io.to(`battleship:${matchId}`).emit('opponent-disconnected', { matchId, forfeit: true });
                io.to(`battleship:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect'
                });
              }
              battleshipRooms.delete(matchId);
            }
          }

          const dominoesRoom = dominoesRooms.get(matchId);
          if (dominoesRoom && dominoesRoom.dealt) {
            const player = dominoesRoom.players.get(playerId);
            if (player) {
              const winnerId = dominoesOpponentId(dominoesRoom, playerId);
              if (winnerId) {
                storeGameResult(matchId, 'dominoes', winnerId, playerId, 'disconnect');
                io.to(`dominoes:${matchId}`).emit('opponent-disconnected', { matchId, forfeit: true });
                io.to(`dominoes:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect'
                });
              }
              dominoesRooms.delete(matchId);
            }
          }

          const xiangqiRoom = xiangqiRooms.get(matchId);
          if (xiangqiRoom && xiangqiRoom.started) {
            const player = xiangqiRoom.players.get(playerId);
            if (player) {
              const winnerId = xiangqiOpponentId(xiangqiRoom, playerId);
              if (winnerId) {
                storeGameResult(matchId, 'xiangqi', winnerId, playerId, 'disconnect');
                io.to(`xiangqi:${matchId}`).emit('opponent-disconnected', { matchId, forfeit: true });
                io.to(`xiangqi:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect',
                });
              }
              xiangqiRooms.delete(matchId);
            }
          }
        }, 30000);

        pendingDisconnects.set(playerId, timeout);
      }

      socketToPlayer.delete(socket.id);
    });
  });

  return io;
}
