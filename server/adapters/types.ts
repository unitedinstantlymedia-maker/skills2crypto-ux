import type { FinishReason } from "@shared/protocol";

export interface GameResult {
  finished: boolean;
  winnerId?: string;
  draw?: boolean;
  reason?: FinishReason;
}

export interface GameAdapter<S = unknown, M = unknown> {
  gameType: string;
  initState(): S;
  validateMove(state: S, move: M, playerId: string, players: { whiteId: string; blackId: string }): boolean;
  applyMove(state: S, move: M): S;
  checkResult(state: S, players: { whiteId: string; blackId: string }): GameResult;
  getCurrentPlayer(state: S, players: { whiteId: string; blackId: string }): string;
}
