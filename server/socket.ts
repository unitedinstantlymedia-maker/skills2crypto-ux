import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { db } from "./db";
import { matches } from "../shared/schema";
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

// Tracks matches whose on-chain escrow has been funded by both players
// (i.e. the contract emitted MatchActive). Game-start events are gated on
// this set so gameplay never begins before crypto is locked.
const fundedMatches = new Set<string>();
let ioRef: SocketIOServer | null = null;

export function isMatchFunded(matchId: string): boolean {
  return fundedMatches.has(matchId);
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
    console.log("[socket] game-start (post-funding)", matchId);
  }

  const tetris = tetrisRooms.get(matchId);
  if (tetris && tetris.players.size === 2 && !tetris.started) {
    tetris.started = true;
    io.to(`tetris:${matchId}`).emit('tetris-game-start');
    console.log("[socket] tetris-game-start (post-funding)", matchId);
  }

  const checkers = checkersRooms.get(matchId);
  if (checkers && checkers.players.size === 2 && !checkers.started) {
    checkers.started = true;
    io.to(`checkers:${matchId}`).emit('checkers-game-start');
    console.log("[socket] checkers-game-start (post-funding)", matchId);
  }

  const battleship = battleshipRooms.get(matchId);
  if (battleship && battleship.players.size === 2 && !battleship.started) {
    battleship.started = true;
    io.to(`battleship:${matchId}`).emit('battleship-game-start');
    console.log("[socket] battleship-game-start (post-funding)", matchId);
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
          console.log("[socket] game-start", matchId);
        } else {
          console.log("[socket] game-start gated on funding", matchId);
          io.to(`match:${matchId}`).emit('awaiting-funding', { matchId });
        }
      }
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
        
        const timeout = setTimeout(() => {
          const currentSocketId = playerToSocket.get(playerId);
          if (currentSocketId && currentSocketId !== socket.id) {
            console.log("[socket] player has reconnected, skipping forfeit:", playerId);
            return;
          }
          
          pendingDisconnects.delete(playerId);
          playerToSocket.delete(playerId);
          
          const chessRoom = matchRooms.get(matchId);
          if (chessRoom) {
            const player = chessRoom.players.get(playerId);
            if (player) {
              const winnerId = Array.from(chessRoom.players.entries()).find(([id, _]) => id !== playerId)?.[0];
              
              if (winnerId) {
                storeGameResult(matchId, 'chess', winnerId, playerId, 'disconnect');
                io.to(`match:${matchId}`).emit('opponent-disconnected', { forfeit: true });
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
              io.to(`tetris:${matchId}`).emit('opponent-disconnected', { forfeit: true });
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
                io.to(`checkers:${matchId}`).emit('opponent-disconnected', { forfeit: true });
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
                io.to(`battleship:${matchId}`).emit('opponent-disconnected', { forfeit: true });
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
        }, 30000);
        
        pendingDisconnects.set(playerId, timeout);
      }
      
      socketToPlayer.delete(socket.id);
    });
  });

  return io;
}
