import { Chess, type Move as ChessJsMove, type Square } from "chess.js";

export type Color = "w" | "b";

export const INITIAL_TIME_MS = 30 * 60 * 1000;

export const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type EndReason =
  | "checkmate"
  | "stalemate"
  | "threefold_repetition"
  | "fifty_move_rule"
  | "insufficient_material"
  | "timeout"
  | "resignation"
  | "disconnect";

export interface MoveInput {
  from: string;
  to: string;
  promotion?: string;
}

export interface AppliedMove {
  from: string;
  to: string;
  promotion?: string;
  san: string;
  fen: string;
  turn: Color;
  capture: boolean;
}

export function newGame(): Chess {
  return new Chess(INITIAL_FEN);
}

export function loadFen(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

export function isValidFen(fen: string): boolean {
  return loadFen(fen) !== null;
}

export function legalDestinationsFrom(game: Chess, square: string): string[] {
  try {
    const moves = game.moves({ square: square as Square, verbose: true }) as ChessJsMove[];
    return moves.map((m) => m.to);
  } catch {
    return [];
  }
}

// Mutates `game`. Returns null without mutating if the move is illegal.
// chess.js needs a single instance to track move history for threefold.
export function applyMove(game: Chess, move: MoveInput): { applied: AppliedMove } | null {
  let result: ChessJsMove | null = null;
  try {
    result = game.move({
      from: move.from,
      to: move.to,
      promotion: (move.promotion as "q" | "r" | "b" | "n" | undefined) ?? "q",
    }) as ChessJsMove;
  } catch {
    return null;
  }
  if (!result) return null;
  return {
    applied: {
      from: result.from,
      to: result.to,
      promotion: result.promotion,
      san: result.san,
      fen: game.fen(),
      turn: game.turn() as Color,
      capture: typeof result.flags === "string" && /[ce]/.test(result.flags),
    },
  };
}

export function isCheckmate(game: Chess): boolean {
  return game.isCheckmate();
}

export function isStalemate(game: Chess): boolean {
  return game.isStalemate();
}

export function isInsufficientMaterial(game: Chess): boolean {
  return game.isInsufficientMaterial();
}

export function isThreefoldRepetition(game: Chess): boolean {
  return game.isThreefoldRepetition();
}

export function isFiftyMoveRule(game: Chess): boolean {
  const parts = game.fen().split(" ");
  const halfmove = parts.length >= 5 ? parseInt(parts[4], 10) : 0;
  return Number.isFinite(halfmove) && halfmove >= 100;
}

export function isInCheck(game: Chess): boolean {
  return game.inCheck();
}

export function turn(game: Chess): Color {
  return game.turn() as Color;
}

export function positionKey(game: Chess): string {
  const parts = game.fen().split(" ");
  return parts.slice(0, 4).join(" ");
}

export function detectTerminal(
  game: Chess,
):
  | { reason: "checkmate"; loserTurn: Color }
  | { reason: "stalemate" | "threefold_repetition" | "fifty_move_rule" | "insufficient_material" }
  | null {
  if (game.isCheckmate()) {
    return { reason: "checkmate", loserTurn: game.turn() as Color };
  }
  if (game.isStalemate()) return { reason: "stalemate" };
  if (game.isThreefoldRepetition()) return { reason: "threefold_repetition" };
  if (isFiftyMoveRule(game)) return { reason: "fifty_move_rule" };
  if (game.isInsufficientMaterial()) return { reason: "insufficient_material" };
  return null;
}

export type { Chess };
