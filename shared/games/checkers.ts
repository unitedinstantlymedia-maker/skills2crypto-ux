// Pure rules engine for American checkers (8x8), 1v1.
// Imported by both server (turn enforcement, validation, terminal
// detection) and client (move highlighting, optimistic legality).
//
// Coordinates: {row, col} with row/col in [0..7]. Pieces sit on dark
// squares only — `(row + col) % 2 === 1`. Red starts on rows 5..7
// (bottom of the board) and moves "up" (decreasing row). Black starts
// on rows 0..2 and moves "down" (increasing row). Men promote to
// kings on reaching the opposite back rank — kings move and capture
// in all four diagonal directions one step.

export const BOARD_SIZE = 8;
export const INITIAL_TIME_MS = 10 * 60 * 1000;

export type PieceColor = "red" | "black";
export type PieceType = "man" | "king";

export interface Piece {
  color: PieceColor;
  type: PieceType;
}

export interface Position {
  row: number;
  col: number;
}

export interface Move {
  from: Position;
  to: Position;
  // Captured squares (empty for non-jump moves). Single-step jumps have
  // exactly one entry; this engine treats multi-jumps as a CHAIN of
  // single-step jumps so each emitted Move has at most one capture.
  captures: Position[];
}

export type Board = (Piece | null)[][];

export type Status = "ok" | "win_red" | "win_black";

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export function posEq(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col;
}

export function makeEmptyBoard(): Board {
  const b: Board = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    b.push(new Array<Piece | null>(BOARD_SIZE).fill(null));
  }
  return b;
}

export function cloneBoard(b: Board): Board {
  const out: Board = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    out.push(b[r].slice());
  }
  return out;
}

export function getPiece(b: Board, p: Position): Piece | null {
  if (!inBounds(p.row, p.col)) return null;
  return b[p.row][p.col];
}

export function initialBoard(): Board {
  const b = makeEmptyBoard();
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if ((row + col) % 2 === 1) b[row][col] = { color: "black", type: "man" };
    }
  }
  for (let row = 5; row < 8; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if ((row + col) % 2 === 1) b[row][col] = { color: "red", type: "man" };
    }
  }
  return b;
}

function directionsFor(piece: Piece): [number, number][] {
  if (piece.type === "king") {
    return [
      [-1, -1], [-1, 1], [1, -1], [1, 1],
    ];
  }
  return piece.color === "red"
    ? [[-1, -1], [-1, 1]]
    : [[1, -1], [1, 1]];
}

// Single-jump moves available from `from`. Each returned Move captures
// exactly one piece — multi-jumps are emitted by the server as a chain
// of separate `applyMove` calls + re-checks via `getJumpsFromSquare`.
export function getJumpsFromSquare(b: Board, from: Position): Move[] {
  const piece = getPiece(b, from);
  if (!piece) return [];
  const moves: Move[] = [];
  for (const [dr, dc] of directionsFor(piece)) {
    const jumpRow = from.row + dr;
    const jumpCol = from.col + dc;
    const landRow = from.row + dr * 2;
    const landCol = from.col + dc * 2;
    if (!inBounds(landRow, landCol)) continue;
    const jumped = b[jumpRow]?.[jumpCol];
    const land = b[landRow][landCol];
    if (jumped && jumped.color !== piece.color && land === null) {
      moves.push({
        from,
        to: { row: landRow, col: landCol },
        captures: [{ row: jumpRow, col: jumpCol }],
      });
    }
  }
  return moves;
}

export function getSimpleMovesFromSquare(b: Board, from: Position): Move[] {
  const piece = getPiece(b, from);
  if (!piece) return [];
  const moves: Move[] = [];
  for (const [dr, dc] of directionsFor(piece)) {
    const nr = from.row + dr;
    const nc = from.col + dc;
    if (!inBounds(nr, nc)) continue;
    if (b[nr][nc] === null) {
      moves.push({ from, to: { row: nr, col: nc }, captures: [] });
    }
  }
  return moves;
}

// Color has to capture if any of its pieces has at least one jump.
export function colorHasAnyJump(b: Board, color: PieceColor): boolean {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const p = b[r][c];
      if (!p || p.color !== color) continue;
      if (getJumpsFromSquare(b, { row: r, col: c }).length > 0) return true;
    }
  }
  return false;
}

// All legal moves from a single piece. Honours forced-capture: if any
// piece of the same colour anywhere on the board has a jump, only the
// jumps from `from` (if any) are returned.
export function legalMovesFromSquare(
  b: Board,
  from: Position,
  color: PieceColor,
): Move[] {
  const piece = getPiece(b, from);
  if (!piece || piece.color !== color) return [];
  if (colorHasAnyJump(b, color)) {
    return getJumpsFromSquare(b, from);
  }
  return getSimpleMovesFromSquare(b, from);
}

export function allLegalMoves(b: Board, color: PieceColor): Move[] {
  const out: Move[] = [];
  const mustJump = colorHasAnyJump(b, color);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const p = b[r][c];
      if (!p || p.color !== color) continue;
      const from: Position = { row: r, col: c };
      if (mustJump) {
        out.push(...getJumpsFromSquare(b, from));
      } else {
        out.push(...getSimpleMovesFromSquare(b, from));
      }
    }
  }
  return out;
}

// True iff `move` (matched by from/to) is in the legal-move set for
// `color` at the given position. Returns the matching Move (with the
// canonical captures array) or null.
export function findLegalMove(
  b: Board,
  color: PieceColor,
  from: Position,
  to: Position,
): Move | null {
  const candidates = legalMovesFromSquare(b, from, color);
  for (const m of candidates) {
    if (posEq(m.to, to)) return m;
  }
  return null;
}

export function isCaptureMove(move: Move): boolean {
  return move.captures.length > 0;
}

// Apply a move to a NEW board. Removes captured pieces and promotes
// the moving piece to king if it lands on the opposite back rank.
// Returns { board, promoted } so the caller can decide whether a
// just-promoted man is allowed to continue a multi-jump (American
// rules: it is NOT — but we leave the policy to the caller).
export function applyMove(b: Board, move: Move): { board: Board; promoted: boolean } {
  const next = cloneBoard(b);
  const piece = next[move.from.row][move.from.col];
  if (!piece) return { board: next, promoted: false };
  next[move.from.row][move.from.col] = null;
  for (const cap of move.captures) {
    next[cap.row][cap.col] = null;
  }
  let placed: Piece = piece;
  let promoted = false;
  if (piece.type === "man") {
    if (piece.color === "red" && move.to.row === 0) {
      placed = { color: "red", type: "king" };
      promoted = true;
    } else if (piece.color === "black" && move.to.row === BOARD_SIZE - 1) {
      placed = { color: "black", type: "king" };
      promoted = true;
    }
  }
  next[move.to.row][move.to.col] = placed;
  return { board: next, promoted };
}

// "ok" while the game continues; otherwise the colour that won. There
// are no draws by rule in this engine — a side with no legal moves on
// its turn loses.
export function statusFor(b: Board, sideToMove: PieceColor): Status {
  const moves = allLegalMoves(b, sideToMove);
  if (moves.length > 0) return "ok";
  return sideToMove === "red" ? "win_black" : "win_red";
}

// 64-char serialisation: '.', 'r' (red man), 'R' (red king), 'b'
// (black man), 'B' (black king). Row-major (row 0 first).
export function serializeBoard(b: Board): string {
  const out: string[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const p = b[r][c];
      if (!p) out.push(".");
      else if (p.color === "red") out.push(p.type === "king" ? "R" : "r");
      else out.push(p.type === "king" ? "B" : "b");
    }
  }
  return out.join("");
}

export function deserializeBoard(s: string): Board {
  const b = makeEmptyBoard();
  if (s.length !== BOARD_SIZE * BOARD_SIZE) return b;
  let i = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const ch = s[i++];
      switch (ch) {
        case "r": b[r][c] = { color: "red", type: "man" }; break;
        case "R": b[r][c] = { color: "red", type: "king" }; break;
        case "b": b[r][c] = { color: "black", type: "man" }; break;
        case "B": b[r][c] = { color: "black", type: "king" }; break;
        default: break;
      }
    }
  }
  return b;
}

export function countPieces(b: Board, color: PieceColor): number {
  let n = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const p = b[r][c];
      if (p && p.color === color) n++;
    }
  }
  return n;
}
