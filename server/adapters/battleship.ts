import type { GameAdapter, GameResult } from "./types";

export interface BattleshipState {
  phase: "placement" | "battle" | "finished";
  turn: "player1" | "player2";
  gameOver: boolean;
  winnerId?: string;
  isDraw?: boolean;
}

export interface BattleshipMove {
  action: "claim_win" | "claim_loss" | "claim_draw";
  playerId: string;
}

export const battleshipAdapter: GameAdapter<BattleshipState, BattleshipMove> = {
  gameType: "battleship",

  initState(): BattleshipState {
    return {
      phase: "battle",
      turn: "player1",
      gameOver: false,
    };
  },

  validateMove(
    state: BattleshipState,
    move: BattleshipMove,
    _playerId: string,
    _players: { whiteId: string; blackId: string }
  ): boolean {
    if (state.gameOver) return false;
    return ["claim_win", "claim_loss", "claim_draw"].includes(move.action);
  },

  applyMove(state: BattleshipState, move: BattleshipMove): BattleshipState {
    if (move.action === "claim_draw") {
      return {
        ...state,
        phase: "finished",
        gameOver: true,
        isDraw: true,
      };
    }
    
    return {
      ...state,
      phase: "finished",
      gameOver: true,
      winnerId: move.action === "claim_win" ? move.playerId : undefined,
      isDraw: false,
    };
  },

  checkResult(
    state: BattleshipState,
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
    state: BattleshipState,
    players: { whiteId: string; blackId: string }
  ): string {
    return state.turn === "player1" ? players.whiteId : players.blackId;
  },
};
