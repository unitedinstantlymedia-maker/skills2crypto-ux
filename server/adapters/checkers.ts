import type { GameAdapter, GameResult } from "./types";

export interface CheckersState {
  board: string;
  turn: "red" | "black";
  gameOver: boolean;
  winnerId?: string;
  isDraw?: boolean;
}

export interface CheckersMove {
  action: "claim_win" | "claim_loss" | "claim_draw";
  playerId: string;
}

export const checkersAdapter: GameAdapter<CheckersState, CheckersMove> = {
  gameType: "checkers",

  initState(): CheckersState {
    return {
      board: "initial",
      turn: "red",
      gameOver: false,
    };
  },

  validateMove(
    state: CheckersState,
    move: CheckersMove,
    _playerId: string,
    _players: { whiteId: string; blackId: string }
  ): boolean {
    if (state.gameOver) return false;
    return ["claim_win", "claim_loss", "claim_draw"].includes(move.action);
  },

  applyMove(state: CheckersState, move: CheckersMove): CheckersState {
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
    state: CheckersState,
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
    state: CheckersState,
    players: { whiteId: string; blackId: string }
  ): string {
    return state.turn === "red" ? players.whiteId : players.blackId;
  },
};
