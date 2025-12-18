import { nanoid } from "nanoid";
import { log } from "../index";
import { initializeMatch, getIO } from "./socketio";

export type Asset = "USDT" | "ETH" | "TON";

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

function getQueueKey(game: string, asset: Asset, amount: number): string {
  return `${game}|${asset}|${amount}`;
}

export function cancelQueueForPlayer(playerId: string): void {
  Array.from(matchQueue.entries()).forEach(([key, entry]) => {
    if (entry.playerId === playerId) {
      matchQueue.delete(key);
      log(`Player ${playerId} removed from queue: ${key}`, "matchmaking");
    }
  });
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

    initializeMatch(matchId, game, asset, amount, [existingEntry.playerId, playerId]);
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
  const io = getIO();
  if (!io) return;

  const [player1, player2] = match.players;
  
  const baseMessage = {
    matchId: match.id,
    game: match.game,
    asset: match.asset,
    amount: match.amount,
  };

  io.emit("match_found", {
    ...baseMessage,
    players: [player1, player2],
  });
  
  log(`Notified players of match ${match.id}`, "matchmaking");
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
