import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { db } from "./db";
import { matches } from "../shared/schema";
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
import { redis } from "./redis";

interface SocketOptions {
  isProd: boolean;
  allowedOrigins: string[];
}

interface ChessMove {
  matchId: string;
  from: string;
  to: string;
  promotion?: string;
  fen: string;
  san: string;
  whiteTime: number;
  blackTime: number;
}

interface PlayerInfo {
  socketId: string;
  color: 'white' | 'black';
}

interface MatchRoom {
  players: Map<string, PlayerInfo>;
  fen: string;
  whiteTime: number;
  blackTime: number;
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

      // Match has fully resolved — drop it from the per-process tracking
      // sets so they don't leak across the lifetime of the server.
      gameStartedMatches.delete(matchId);
      gameMovesRecorded.delete(matchId);
      fundedMatches.delete(matchId);

      settleMatchOnChain(matchId, winnerId, resultType, reason).catch(err => {
        console.error("[socket] on-chain settlement failed:", matchId, err?.message || err);
      });
    } else {
      console.warn("[socket] could not fetch match data from Redis for DB save:", matchId);
    }
  } catch (err) {
    console.error("[socket] failed to save match to database:", err);
  }

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

interface TetrisRoom {
  players: Map<string, string>;
  started: boolean;
}

const tetrisRooms = new Map<string, TetrisRoom>();

interface CheckersPlayerInfo {
  socketId: string;
  color: 'red' | 'black';
}

interface CheckersRoom {
  players: Map<string, CheckersPlayerInfo>;
  started: boolean;
}

const checkersRooms = new Map<string, CheckersRoom>();

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
  if (chess && chess.players.size === 2) {
    io.to(`match:${matchId}`).emit('game-start', {
      fen: chess.fen,
      whiteTime: chess.whiteTime,
      blackTime: chess.blackTime,
    });
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
    io.to(`checkers:${matchId}`).emit('checkers-game-start');
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
        room = {
          players: new Map(),
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          whiteTime: 30 * 60 * 1000,
          blackTime: 30 * 60 * 1000
        };
        matchRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('color-assigned', { color: existingPlayer.color });
        console.log("[socket] reconnect, color preserved:", existingPlayer.color);
        
        if (room.players.size === 2 && fundedMatches.has(matchId)) {
          socket.emit('game-start', {
            fen: room.fen,
            whiteTime: room.whiteTime,
            blackTime: room.blackTime
          });
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
          io.to(`match:${matchId}`).emit('game-start', {
            fen: room.fen,
            whiteTime: room.whiteTime,
            blackTime: room.blackTime
          });
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
    });

    socket.on("chess-move", (move: ChessMove) => {
      const { matchId, from, to, promotion, fen, san, whiteTime, blackTime } = move;

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

      const player = room.players.get(socketInfo.playerId);
      if (!player) {
        console.log("[socket] chess-move rejected - player not in room");
        return;
      }

      // Mark gameplay activity ONLY after socket/room/player auth has
      // passed, so a forged event from an unauthorized socket can't
      // pollute the disconnect-safety-net set.
      markGameplayActivity(matchId);

      console.log("[socket] chess-move", matchId, from, to, san, "by", player.color);
      
      room.fen = fen;
      room.whiteTime = whiteTime;
      room.blackTime = blackTime;

      socket.to(`match:${matchId}`).emit('opponent-move', {
        from,
        to,
        promotion,
        fen,
        san,
        whiteTime,
        blackTime
      });
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

    socket.on("chess-timeout", (data: { matchId: string; color: 'white' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] chess-timeout rejected - unauthorized");
        return;
      }

      const room = matchRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] chess-timeout rejected - color mismatch");
        return;
      }

      console.log("[socket] chess-timeout", data.matchId, data.color);
      
      const winnerId = data.color === 'white' 
        ? Array.from(room.players.entries()).find(([_, p]) => p.color === 'black')?.[0]
        : Array.from(room.players.entries()).find(([_, p]) => p.color === 'white')?.[0];
      const loserId = socketInfo.playerId;
      
      storeGameResult(data.matchId, 'chess', winnerId || null, loserId, 'timeout');
      
      socket.to(`match:${data.matchId}`).emit('opponent-timeout', {
        color: data.color
      });
      
      io.to(`match:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'timeout'
      });
      
      matchRooms.delete(data.matchId);
    });

    socket.on("game-end", async (data: { matchId: string; result: string; winner: string; winnerId?: string; loserId?: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        return;
      }

      console.log("[socket] game-end", data.matchId, data.result, data.winner);

      const room = matchRooms.get(data.matchId);
      let winnerId: string | null = null;
      let loserId: string | null = null;

      if (data.result === 'draw' || data.winner === 'draw') {
        winnerId = null;
        loserId = null;
      } else if (room && data.winner) {
        const winnerColor = data.winner as 'white' | 'black';
        const loserColor = winnerColor === 'white' ? 'black' : 'white';
        winnerId = Array.from(room.players.entries()).find(([_, p]) => p.color === winnerColor)?.[0] || null;
        loserId = Array.from(room.players.entries()).find(([_, p]) => p.color === loserColor)?.[0] || null;
      } else {
        winnerId = data.winnerId || null;
        loserId = data.loserId || null;
      }

      const stored = await storeGameResult(data.matchId, 'chess', winnerId, loserId, data.result);
      if (!stored || !stored.isFirst) return;
      
      io.to(`match:${data.matchId}`).emit('match-ended', data);
      io.to(`match:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: data.result
      });
      
      matchRooms.delete(data.matchId);
    });

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

      if (!room.players.has(playerId)) {
        room.players.set(playerId, socket.id);
      } else {
        room.players.set(playerId, socket.id);
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
      if (!room || !room.players.has(socketInfo.playerId)) return;

      // Mark gameplay activity ONLY after socket + room-membership auth has passed.
      markGameplayActivity(data.matchId);

      socket.to(`tetris:${data.matchId}`).emit('opponent-tetris-state', {
        board: data.board,
        score: data.score,
        lines: data.lines,
        level: data.level,
        gameOver: data.gameOver
      });
    });

    socket.on("tetris-game-over", (data: { matchId: string; playerId: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      console.log("[socket] tetris-game-over", data.matchId, data.playerId);
      
      const room = tetrisRooms.get(data.matchId);
      const winnerId = room ? Array.from(room.players.keys()).find(id => id !== data.playerId) : null;
      const loserId = data.playerId;
      
      storeGameResult(data.matchId, 'tetris', winnerId || null, loserId, 'board_filled');
      
      socket.to(`tetris:${data.matchId}`).emit('opponent-tetris-game-over');
      
      io.to(`tetris:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'board_filled'
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
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
        // Notify the surviving opponent so their disconnect banner clears.
        socket.to(`checkers:${matchId}`).emit('opponent-reconnected', { matchId });
      }

      let room = checkersRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false
        };
        checkersRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('checkers-color-assigned', { color: existingPlayer.color });
        console.log("[socket] checkers reconnect, color preserved:", existingPlayer.color);
        
        if (room.players.size === 2 && room.started) {
          socket.emit('checkers-game-start');
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
          io.to(`checkers:${matchId}`).emit('checkers-game-start');
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
      captures: { row: number; col: number }[];
      newTurn: 'red' | 'black';
      turnEnded: boolean;
      redTime: number;
      blackTime: number;
    }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-move rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) {
        console.log("[socket] checkers-move rejected - player not in room");
        return;
      }

      // Mark gameplay activity ONLY after socket/room/player auth has passed.
      markGameplayActivity(data.matchId);

      console.log("[socket] checkers-move", data.matchId, data.from, data.to, "by", player.color, "turnEnded:", data.turnEnded);

      socket.to(`checkers:${data.matchId}`).emit('opponent-checkers-move', {
        from: data.from,
        to: data.to,
        captures: data.captures,
        newTurn: data.newTurn,
        turnEnded: data.turnEnded,
        redTime: data.redTime,
        blackTime: data.blackTime
      });
    });

    socket.on("checkers-timeout", (data: { matchId: string; color: 'red' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-timeout rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] checkers-timeout rejected - color mismatch");
        return;
      }

      console.log("[socket] checkers-timeout", data.matchId, data.color);
      
      const winnerId = data.color === 'red' 
        ? Array.from(room.players.entries()).find(([_, p]) => p.color === 'black')?.[0]
        : Array.from(room.players.entries()).find(([_, p]) => p.color === 'red')?.[0];
      const loserId = socketInfo.playerId;
      
      storeGameResult(data.matchId, 'checkers', winnerId || null, loserId, 'timeout');
      
      socket.to(`checkers:${data.matchId}`).emit('opponent-checkers-timeout');
      
      io.to(`checkers:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'timeout'
      });
      
      checkersRooms.delete(data.matchId);
    });

    socket.on("checkers-game-end", (data: { matchId: string; winner: 'red' | 'black'; playerId: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-game-end rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room) return;

      console.log("[socket] checkers-game-end", data.matchId, data.winner);
      
      const winnerId = Array.from(room.players.entries()).find(([_, p]) => p.color === data.winner)?.[0];
      const loserId = Array.from(room.players.entries()).find(([_, p]) => p.color !== data.winner)?.[0];
      
      storeGameResult(data.matchId, 'checkers', winnerId || null, loserId || null, 'game_complete');
      
      io.to(`checkers:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'game_complete'
      });
      
      checkersRooms.delete(data.matchId);
    });

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
              dominoesRooms.has(matchId);
            matchRooms.delete(matchId);
            tetrisRooms.delete(matchId);
            checkersRooms.delete(matchId);
            battleshipRooms.delete(matchId);
            dominoesRooms.delete(matchId);
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
        }, 30000);

        pendingDisconnects.set(playerId, timeout);
      }

      socketToPlayer.delete(socket.id);
    });
  });

  return io;
}
