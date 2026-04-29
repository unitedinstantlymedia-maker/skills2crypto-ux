// Pure rules engine for standard chess (1v1). Wraps `chess.js` so the
// server and the client agree on legality, terminal detection, and
// position keys for repetition. Both sides import from this module —
// the client uses it for highlights / optimistic rendering, the server
// uses it as the single source of truth for every authoritative
// `chess-move` event.
//
// The wrapper is intentionally thin: it does not invent new rules. It
// pins the canonical FEN serialisation and exposes a small, stable
// surface so the rest of the codebase doesn't have to depend on
// `chess.js` directly.

import { Chess, type Move as ChessJsMove, type Square } from "chess.js";

export type Color = "w" | "b";

// 30 minute classical clock per side, matching the legacy client default.
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
  // Whose turn it now is (after the move).
  turn: Color;
  // True if the move resulted in a capture — used by callers that need
  // to reset auxiliary counters (e.g. fifty-move tracking, even though
  // chess.js handles the rule internally for us via FEN halfmove clock).
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

// Return the SAN list for legal moves from `square`, useful for the
// client to highlight destinations without trusting any server hint.
export function legalDestinationsFrom(game: Chess, square: string): string[] {
  try {
    const moves = game.moves({ square: square as Square, verbose: true }) as ChessJsMove[];
    return moves.map((m) => m.to);
  } catch {
    return [];
  }
}

// Apply a move directly to `game`. MUTATES the instance — the caller
// keeps the same Chess across the whole game so chess.js's internal
// move history is preserved (which is what powers threefold-repetition
// detection). Returns null without mutating if the move is illegal.
//
// The server stores ONE Chess per room and calls this on every
// `chess-move`. The client uses a single Chess that it discards each
// time the server broadcasts a new authoritative FEN, so mutation is
// safe on both sides.
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
      // chess.js exposes capture info via the move flags ('c'=capture, 'e'=en-passant).
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

// Fifty-move rule. chess.js exposes this via `isDraw()` as part of the
// composite draw check — we expose it on its own by reading the FEN
// halfmove counter (4th field, 0-based index 4 when split on space).
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

// Stable position-key for a Chess instance. Uses the first four
// fields of the FEN (board + side-to-move + castling + en-passant)
// because clocks and move-counts must NOT contribute to the key.
// Repetition in chess is by position regardless of move number.
export function positionKey(game: Chess): string {
  const parts = game.fen().split(" ");
  return parts.slice(0, 4).join(" ");
}

// Detect any natural terminal in the current position. Returns the
// reason in the priority order the spec requires: checkmate first
// (most specific), then stalemate, then the draw-by-rule triplet.
// Returns null if the game is still in progress. Timeout is NOT
// included — that is detected by the caller from the clocks.
export function detectTerminal(
  game: Chess,
):
  | { reason: "checkmate"; loserTurn: Color }
  | { reason: "stalemate" | "threefold_repetition" | "fifty_move_rule" | "insufficient_material" }
  | null {
  if (game.isCheckmate()) {
    // The side whose turn it is when checkmated is the LOSER.
    return { reason: "checkmate", loserTurn: game.turn() as Color };
  }
  if (game.isStalemate()) return { reason: "stalemate" };
  if (game.isThreefoldRepetition()) return { reason: "threefold_repetition" };
  if (isFiftyMoveRule(game)) return { reason: "fifty_move_rule" };
  if (game.isInsufficientMaterial()) return { reason: "insufficient_material" };
  return null;
}

export type { Chess };
