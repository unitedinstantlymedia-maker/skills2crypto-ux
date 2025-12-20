import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server } from "http";
import { log } from "../index";
import { getAdapter } from "../adapters/registry";
import type { GameAction, Asset } from "@shared/protocol";
import { escrowEngine, type SettleResult } from "./escrow";

export type MatchStatus = "waiting" | "active" | "paused" | "finished";

interface PlayerState {
  socketId: string;
  connected: boolean;
}

interface MatchResult {
  status: "finished";
  reason: string;
  winner?: string;
  draw?: boolean;
}

interface MatchState {
  id: string;
  game: string;
  asset: string;
  amount: number;
  players: Record<string, PlayerState>;
  playerMapping: { whiteId: string; blackId: string };
  status: MatchStatus;
  gameState: Record<string, unknown>;
  result?: MatchResult;
  escrowLocked?: boolean;
  escrowResult?: SettleResult;
}

const matches: Map<string, MatchState> = new Map();
const playerToSocket: Map<string, Socket> = new Map();

let io: SocketIOServer | null = null;

export function setupSocketIO(httpServer: Server): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket: Socket) => {
    log(`Socket connected: ${socket.id}`, "socket.io");

    socket.on("join_match", (data: { matchId: string; playerId: string }) => {
      handleJoinMatch(socket, data);
    });

    socket.on("leave_match", (data: { matchId: string; playerId: string }) => {
      handleLeaveMatch(socket, data);
    });

    socket.on("game_action", (action: GameAction) => {
      handleGameAction(socket, action);
    });

    socket.on("disconnect", () => {
      handleDisconnect(socket);
    });
  });

  log("Socket.IO server initialized", "socket.io");
  return io;
}

function handleJoinMatch(socket: Socket, data: { matchId: string; playerId: string }): void {
  const { matchId, playerId } = data;

  if (!matchId || !playerId) {
    socket.emit("error", { message: "matchId and playerId are required" });
    return;
  }

  log(`Player ${playerId} attempting to join match ${matchId}`, "socket.io");

  const match = matches.get(matchId);

  if (!match) {
    log(`Match ${matchId} not found - rejecting join`, "socket.io");
    socket.emit("error", { message: "Match not found" });
    return;
  }

  if (!(playerId in match.players)) {
    log(`Player ${playerId} not authorized for match ${matchId}`, "socket.io");
    socket.emit("error", { message: "Player not authorized for this match" });
    return;
  }

  log(`[TRACE] Before join: Match ${matchId} status=${match.status}, players connected: ${Object.values(match.players).filter((p) => p.connected).length}`, "socket.io");

  match.players[playerId].socketId = socket.id;
  match.players[playerId].connected = true;

  playerToSocket.set(playerId, socket);
  socket.join(matchId);

  log(`Player ${playerId} joined match ${matchId}`, "socket.io");

  const connectedBefore = Object.values(match.players).filter((p) => p.connected).length;
  recalculateMatchStatus(match);
  const connectedAfter = Object.values(match.players).filter((p) => p.connected).length;
  
  log(`[TRACE] After recalculate: Match ${matchId} status=${match.status}, connected players: ${connectedAfter}`, "socket.io");
  
  // Emit both events to ensure clients see the updated status
  emitMatchState(matchId);
  emitGameState(matchId);
}

function handleLeaveMatch(socket: Socket, data: { matchId: string; playerId: string }): void {
  const { matchId, playerId } = data;

  if (!matchId || !playerId) {
    socket.emit("error", { message: "matchId and playerId are required" });
    return;
  }

  log(`Player ${playerId} leaving match ${matchId}`, "socket.io");

  const match = matches.get(matchId);
  if (!match) return;

  if (match.players[playerId]) {
    match.players[playerId].connected = false;
  }

  playerToSocket.delete(playerId);
  socket.leave(matchId);

  recalculateMatchStatus(match);
  emitMatchState(matchId);
}

function recalculateMatchStatus(match: MatchState): void {
  const connectedPlayers = Object.values(match.players).filter((p) => p.connected);
  const totalPlayers = Object.keys(match.players).length;

  log(`[DEBUG] recalculateMatchStatus: ${match.id} - connected: ${connectedPlayers.length}/${totalPlayers}, status: ${match.status}`, "socket.io");

  if (match.status === "finished") {
    return;
  }

  if (connectedPlayers.length >= 2) {
    if (match.status !== "active") {
      match.status = "active";
      log(`Match ${match.id} is now active (2+ players connected)`, "socket.io");
      
      if (!match.escrowLocked) {
        const playerIds = Object.keys(match.players);
        escrowEngine.lock(match.id, match.asset as Asset, match.amount, playerIds);
        match.escrowLocked = true;
      }
    }
  } else if (totalPlayers >= 2 && connectedPlayers.length < 2) {
    if (match.status === "active") {
      match.status = "paused";
      log(`Match ${match.id} paused - player disconnected`, "socket.io");
    }
  } else if (connectedPlayers.length < 2) {
    match.status = "waiting";
  }
}

function handleGameAction(socket: Socket, action: GameAction): void {
  const { matchId, playerId, type, payload } = action;

  if (!matchId || !playerId || !type) {
    socket.emit("action_rejected", { reason: "matchId, playerId, and type are required" });
    return;
  }

  log(`Game action from ${playerId} in match ${matchId}: ${type}`, "socket.io");

  const match = matches.get(matchId);
  if (!match) {
    socket.emit("action_rejected", { reason: "Match not found" });
    return;
  }

  if (match.status === "finished" || match.result?.status === "finished") {
    socket.emit("action_rejected", { reason: "match_finished" });
    return;
  }

  if (match.status !== "active") {
    socket.emit("action_rejected", { reason: `Match is not active (status: ${match.status})` });
    return;
  }

  if (!(playerId in match.players)) {
    socket.emit("action_rejected", { reason: "Player not part of this match" });
    return;
  }

  const adapter = getAdapter(match.game);
  if (!adapter) {
    socket.emit("action_rejected", { reason: `No adapter for game: ${match.game}` });
    return;
  }

  const move = type === "move" ? payload : { action: type, playerId, ...(typeof payload === 'object' && payload !== null ? payload : {}) };

  const isValid = adapter.validateMove(
    match.gameState,
    move,
    playerId,
    match.playerMapping
  );

  if (!isValid) {
    log(`Invalid action from ${playerId}: ${type}`, "socket.io");
    socket.emit("action_rejected", { reason: "Invalid move" });
    return;
  }

  match.gameState = adapter.applyMove(match.gameState, move) as Record<string, unknown>;
  
  const result = adapter.checkResult(match.gameState, match.playerMapping);
  if (result.finished) {
    match.status = "finished";
    match.result = {
      status: "finished",
      reason: result.reason || "unknown",
      winner: result.winnerId,
      draw: result.draw,
    };
    log(`Match ${matchId} finished: ${JSON.stringify(match.result)}`, "socket.io");
    
    const escrowResult = escrowEngine.settle({
      matchId,
      asset: match.asset as Asset,
      amount: match.amount,
      winner: result.winnerId,
      draw: result.draw,
    });
    match.escrowResult = escrowResult;
    
    emitGameState(matchId);
    emitMatchFinished(matchId);
    emitEscrowResult(matchId);
    return;
  }

  emitGameState(matchId);
}

function handleDisconnect(socket: Socket): void {
  log(`Socket disconnected: ${socket.id}`, "socket.io");

  const matchEntries = Array.from(matches.entries());
  for (const [matchId, match] of matchEntries) {
    for (const [playerId, playerState] of Object.entries(match.players)) {
      if ((playerState as PlayerState).socketId === socket.id) {
        log(`Player ${playerId} disconnected from match ${matchId}`, "socket.io");
        
        match.players[playerId].connected = false;
        playerToSocket.delete(playerId);

        recalculateMatchStatus(match);
        emitMatchState(matchId);
      }
    }
  }
}

function emitMatchState(matchId: string): void {
  const match = matches.get(matchId);
  if (!match || !io) return;

  const playersPayload: Record<string, { connected: boolean }> = {};
  for (const [playerId, playerState] of Object.entries(match.players)) {
    playersPayload[playerId] = { connected: playerState.connected };
  }

  const payload = {
    matchId: match.id,
    status: match.status,
    players: playersPayload,
    gameState: match.gameState,
  };

  log(`[EMIT] match_state for ${matchId}: ${JSON.stringify(payload)}`, "socket.io");
  io.to(matchId).emit("match_state", payload);
}

function emitGameState(matchId: string): void {
  const match = matches.get(matchId);
  if (!match || !io) return;

  const payload = {
    matchId: match.id,
    game: match.game,
    status: match.status,
    gameState: match.gameState,
    result: match.result,
  };

  log(`[EMIT] game_state for ${matchId}: status=${payload.status}, ${JSON.stringify(payload)}`, "socket.io");
  io.to(matchId).emit("game_state", payload);
}

function emitMatchFinished(matchId: string): void {
  const match = matches.get(matchId);
  if (!match || !io || !match.result) return;

  log(`Emitting match_finished for ${matchId}: ${JSON.stringify(match.result)}`, "socket.io");
  io.to(matchId).emit("match_finished", match.result);
}

function emitEscrowResult(matchId: string): void {
  const match = matches.get(matchId);
  if (!match || !io || !match.escrowResult) return;

  log(`Emitting escrow_result for ${matchId}: ${JSON.stringify(match.escrowResult)}`, "socket.io");
  io.to(matchId).emit("escrow_result", match.escrowResult);
}

export function initializeMatch(
  matchId: string,
  game: string,
  asset: string,
  amount: number,
  playerIds: string[]
): void {
  const players: Record<string, PlayerState> = {};
  for (const playerId of playerIds) {
    players[playerId] = {
      socketId: "",
      connected: false,
    };
  }

  const adapter = getAdapter(game);
  const initialGameState = adapter ? adapter.initState() : {};
log(`[DEBUG] initialGameState for match ${matchId}: ${JSON.stringify(initialGameState)}`, "socket.io");
  const match: MatchState = {
    id: matchId,
    game,
    asset,
    amount,
    players,
    playerMapping: { whiteId: playerIds[0], blackId: playerIds[1] },
    status: "waiting",
    gameState: initialGameState as Record<string, unknown>,
  };

  matches.set(matchId, match);
  log(`Match ${matchId} initialized for game ${game} with initial state`, "socket.io");
}

export function getMatchState(matchId: string): MatchState | undefined {
  return matches.get(matchId);
}

export function updateMatchStatus(matchId: string, status: MatchStatus): void {
  const match = matches.get(matchId);
  if (match) {
    match.status = status;
    emitMatchState(matchId);
  }
}

export function getIO(): SocketIOServer | null {
  return io;
}
