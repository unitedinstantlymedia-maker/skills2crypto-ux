import { Chess } from "chess.js";
import type { ChessState, ChessMove } from "@shared/protocol";
import type { GameAdapter, GameResult } from "./types";

interface ChessAction extends ChessMove {
  action?: "resign";
  playerId?: string;
}

export const chessAdapter: GameAdapter<ChessState, ChessAction> = {
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
    move: ChessAction,
    playerId: string,
    players: { whiteId: string; blackId: string }
  ): boolean {
    if (state.resigned) return false;

    if (move.action === "resign") {
      return playerId === players.whiteId || playerId === players.blackId;
    }

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

  applyMove(state: ChessState, move: ChessAction): ChessState {
    if (move.action === "resign") {
      return {
        ...state,
        resigned: true,
        resignedBy: move.playerId,
      };
    }

    const chess = new Chess(state.fen);
    chess.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    });

    return {
      ...state,
      fen: chess.fen(),
      turn: chess.turn() as "w" | "b",
      moves: [...state.moves, { from: move.from, to: move.to, promotion: move.promotion }],
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
    if (state.resigned && state.resignedBy) {
      const winnerId = state.resignedBy === players.whiteId ? players.blackId : players.whiteId;
      return { finished: true, winnerId, reason: "resign" };
    }
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
