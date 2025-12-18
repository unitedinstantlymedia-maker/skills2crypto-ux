import type { GameAdapter, GameResult } from "./types";

export interface TetrisState {
  score: number;
  level: number;
  lines: number;
  gameOver: boolean;
  winnerId?: string;
  isDraw?: boolean;
}

export interface TetrisMove {
  action: "claim_win" | "claim_loss" | "claim_draw";
  playerId: string;
}

export const tetrisAdapter: GameAdapter<TetrisState, TetrisMove> = {
  gameType: "tetris",

  initState(): TetrisState {
    return {
      score: 0,
      level: 1,
      lines: 0,
      gameOver: false,
    };
  },

  validateMove(
    state: TetrisState,
    move: TetrisMove,
    _playerId: string,
    _players: { whiteId: string; blackId: string }
  ): boolean {
    if (state.gameOver) return false;
    return ["claim_win", "claim_loss", "claim_draw"].includes(move.action);
  },

  applyMove(state: TetrisState, move: TetrisMove): TetrisState {
    if (move.action === "claim_draw") {
      return {
        ...state,
        gameOver: true,
        isDraw: true,
      };
    }
    
    return {
      ...state,
      gameOver: true,
      winnerId: move.action === "claim_win" ? move.playerId : undefined,
      isDraw: false,
    };
  },

  checkResult(
    state: TetrisState,
    players: { whiteId: string; blackId: string }
  ): GameResult {
    if (!state.gameOver) {
      return { finished: false };
    }

    if (state.isDraw) {
      return { finished: true, draw: true, reason: "draw" };
    }

    if (state.winnerId) {
      return { finished: true, winnerId: state.winnerId, reason: "checkmate" };
    }

    const loserId = players.whiteId;
    const winnerId = players.blackId;
    return { finished: true, winnerId, reason: "checkmate" };
  },

  getCurrentPlayer(
    _state: TetrisState,
    players: { whiteId: string; blackId: string }
  ): string {
    return players.whiteId;
  },
};
