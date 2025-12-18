import { Chess } from "chess.js";
import type { ChessState, ChessMove } from "@shared/protocol";
import type { GameAdapter, GameResult } from "./types";

export const chessAdapter: GameAdapter<ChessState, ChessMove> = {
  gameType: "chess",

  initState(): ChessState {
    const chess = new Chess();
    return {
      fen: chess.fen(),
      turn: chess.turn() as "w" | "b",
      moves: [],
      isCheck: false,
      isCheckmate: false,
      isDraw: false,
      isStalemate: false,
    };
  },

  validateMove(
    state: ChessState,
    move: ChessMove,
    playerId: string,
    players: { whiteId: string; blackId: string }
  ): boolean {
    const expectedPlayer = state.turn === "w" ? players.whiteId : players.blackId;
    if (playerId !== expectedPlayer) return false;

    const chess = new Chess(state.fen);
    try {
      const result = chess.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion,
      });
      return result !== null;
    } catch {
      return false;
    }
  },

  applyMove(state: ChessState, move: ChessMove): ChessState {
    const chess = new Chess(state.fen);
    chess.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    });

    return {
      fen: chess.fen(),
      turn: chess.turn() as "w" | "b",
      moves: [...state.moves, move],
      isCheck: chess.isCheck(),
      isCheckmate: chess.isCheckmate(),
      isDraw: chess.isDraw(),
      isStalemate: chess.isStalemate(),
    };
  },

  checkResult(
    state: ChessState,
    players: { whiteId: string; blackId: string }
  ): GameResult {
    if (state.isCheckmate) {
      const winnerId = state.turn === "w" ? players.blackId : players.whiteId;
      return { finished: true, winnerId, reason: "checkmate" };
    }
    if (state.isStalemate || state.isDraw) {
      return { finished: true, draw: true, reason: "draw" };
    }
    return { finished: false };
  },

  getCurrentPlayer(
    state: ChessState,
    players: { whiteId: string; blackId: string }
  ): string {
    return state.turn === "w" ? players.whiteId : players.blackId;
  },
};
