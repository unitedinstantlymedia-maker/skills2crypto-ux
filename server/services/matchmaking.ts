import { nanoid } from "nanoid";
import { WebSocket as WsWebSocket } from "ws";
import { log } from "../index";

export type Asset = "USDT" | "ETH" | "TON";

export interface Player {
  id: string;
  socket?: WsWebSocket;
}

export interface Match {
  id: string;
  game: string;
  asset: Asset;
  amount: number;
  players: [string, string];
  status: "waiting" | "active" | "finished";
  createdAt: number;
}

interface QueueEntry {
  playerId: string;
  timestamp: number;
}

const matchQueue: Map<string, QueueEntry> = new Map();
const matches: Map<string, Match> = new Map();
const playerSockets: Map<string, WsWebSocket> = new Map();

function getQueueKey(game: string, asset: Asset, amount: number): string {
  return `${game}|${asset}|${amount}`;
}

export function registerPlayer(playerId: string, socket: WsWebSocket): void {
  playerSockets.set(playerId, socket);
  log(`Player registered: ${playerId}`, "matchmaking");
}

export function unregisterPlayer(playerId: string): void {
  playerSockets.delete(playerId);
  
  Array.from(matchQueue.entries()).forEach(([key, entry]) => {
    if (entry.playerId === playerId) {
      matchQueue.delete(key);
      log(`Player ${playerId} removed from queue: ${key}`, "matchmaking");
    }
  });
  
  log(`Player unregistered: ${playerId}`, "matchmaking");
}

export function getPlayerSocket(playerId: string): WsWebSocket | undefined {
  return playerSockets.get(playerId);
}

export interface FindMatchResult {
  status: "waiting" | "matched";
  matchId?: string;
  match?: Match;
}

export function findMatch(
  game: string,
  asset: Asset,
  amount: number,
  playerId: string
): FindMatchResult {
  const key = getQueueKey(game, asset, amount);
  const existingEntry = matchQueue.get(key);

  if (existingEntry && existingEntry.playerId !== playerId) {
    matchQueue.delete(key);
    
    const matchId = nanoid(12);
    const match: Match = {
      id: matchId,
      game,
      asset,
      amount,
      players: [existingEntry.playerId, playerId],
      status: "active",
      createdAt: Date.now(),
    };
    
    matches.set(matchId, match);
    
    log(`Match created: ${matchId} | ${game} | ${asset} | ${amount} | Players: ${existingEntry.playerId} vs ${playerId}`, "matchmaking");

    notifyPlayers(match);
    
    return { status: "matched", matchId, match };
  }

  if (!existingEntry || existingEntry.playerId === playerId) {
    matchQueue.set(key, { playerId, timestamp: Date.now() });
    log(`Player ${playerId} joined queue: ${key}`, "matchmaking");
    return { status: "waiting" };
  }

  return { status: "waiting" };
}

function notifyPlayers(match: Match): void {
  const [player1, player2] = match.players;
  
  const socket1 = playerSockets.get(player1);
  const socket2 = playerSockets.get(player2);
  
  const baseMessage = {
    type: "match_found",
    matchId: match.id,
    game: match.game,
    asset: match.asset,
    amount: match.amount,
  };

  if (socket1 && socket1.readyState === 1) {
    socket1.send(JSON.stringify({ ...baseMessage, opponentId: player2 }));
    log(`Notified player ${player1} of match ${match.id}`, "matchmaking");
  }
  
  if (socket2 && socket2.readyState === 1) {
    socket2.send(JSON.stringify({ ...baseMessage, opponentId: player1 }));
    log(`Notified player ${player2} of match ${match.id}`, "matchmaking");
  }
}

export function getMatchById(matchId: string): Match | undefined {
  return matches.get(matchId);
}

export function cancelSearch(playerId: string): boolean {
  let cancelled = false;
  
  Array.from(matchQueue.entries()).forEach(([key, entry]) => {
    if (entry.playerId === playerId) {
      matchQueue.delete(key);
      cancelled = true;
      log(`Player ${playerId} cancelled search: ${key}`, "matchmaking");
    }
  });
  
  return cancelled;
}

export function getQueueStats(): { queueSize: number; activeMatches: number } {
  return {
    queueSize: matchQueue.size,
    activeMatches: Array.from(matches.values()).filter(m => m.status === "active").length,
  };
}
