import type { Match, Asset, ChessState, ChessMove, FinishReason, MatchStatus } from "@shared/protocol";
import { getAdapter } from "../adapters/registry";
import { escrowService } from "./escrow";

const matches = new Map<string, Match>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export interface CreateMatchParams {
  game: string;
  asset: Asset;
  stake: number;
  whiteId: string;
  blackId: string;
}

export function createMatch(params: CreateMatchParams): Match | { error: string } {
  const adapter = getAdapter(params.game);
  if (!adapter) {
    return { error: `Unsupported game type: ${params.game}` };
  }

  const id = generateId();
  const now = Date.now();
  const state = adapter.initState() as ChessState;

  const match: Match = {
    id,
    game: params.game as "chess",
    asset: params.asset,
    stake: params.stake,
    pot: params.stake * 2,
    players: { whiteId: params.whiteId, blackId: params.blackId },
    status: "active",
    createdAt: now,
    updatedAt: now,
    state,
  };

  escrowService.lock(id, params.whiteId, params.asset, params.stake);
  escrowService.lock(id, params.blackId, params.asset, params.stake);

  matches.set(id, match);
  return match;
}

export function getMatch(id: string): Match | undefined {
  return matches.get(id);
}

export function getOrCreateMatch(id: string): Match {
  const existing = matches.get(id);
  if (existing) return existing;

  const adapter = getAdapter("chess");
  if (!adapter) {
    throw new Error("Chess adapter not found");
  }

  const now = Date.now();
  const state = adapter.initState() as ChessState;

  const match: Match = {
    id,
    game: "chess",
    asset: "USDT",
    stake: 20,
    pot: 40,
    players: { whiteId: "playerA", blackId: "playerB" },
    status: "active",
    createdAt: now,
    updatedAt: now,
    state,
  };

  matches.set(id, match);
  return match;
}

export interface MoveResult {
  success: boolean;
  match?: Match;
  error?: string;
}

export function submitMove(matchId: string, playerId: string, move: ChessMove): MoveResult {
  const match = matches.get(matchId);
  if (!match) {
    return { success: false, error: "Match not found" };
  }

  if (match.status !== "active") {
    return { success: false, error: "Match is not active" };
  }

  const adapter = getAdapter(match.game);
  if (!adapter) {
    return { success: false, error: "Game adapter not found" };
  }

  const valid = adapter.validateMove(match.state, move, playerId, match.players);
  if (!valid) {
    return { success: false, error: "Invalid move" };
  }

  match.state = adapter.applyMove(match.state, move) as ChessState;
  match.updatedAt = Date.now();

  const result = adapter.checkResult(match.state, match.players);
  if (result.finished) {
    finalizeMatch(match, result.winnerId, result.draw, result.reason);
  }

  return { success: true, match };
}

export function resignMatch(matchId: string, playerId: string): MoveResult {
  const match = matches.get(matchId);
  if (!match) {
    return { success: false, error: "Match not found" };
  }

  if (match.status !== "active") {
    return { success: false, error: "Match is not active" };
  }

  if (playerId !== match.players.whiteId && playerId !== match.players.blackId) {
    return { success: false, error: "Player not in match" };
  }

  const winnerId = playerId === match.players.whiteId ? match.players.blackId : match.players.whiteId;
  finalizeMatch(match, winnerId, false, "resign");

  return { success: true, match };
}

function finalizeMatch(
  match: Match,
  winnerId: string | undefined,
  draw: boolean | undefined,
  reason: FinishReason | undefined
): void {
  match.status = "finished";
  match.updatedAt = Date.now();

  const loserId = winnerId
    ? winnerId === match.players.whiteId
      ? match.players.blackId
      : match.players.whiteId
    : undefined;

  match.result = {
    winnerId,
    loserId,
    draw: draw ?? false,
    reason: reason ?? "invalid",
    validated: true,
  };

  if (winnerId) {
    escrowService.release(match.id, winnerId, match.asset, match.pot);
  } else if (draw) {
    escrowService.refundAll(match.id, match.asset, match.stake);
  }
}
