// Pure rules engine for Xiangqi (Chinese chess), 1v1.
// Imported by both the server (turn enforcement, validation, end-detection)
// and the client (move highlighting, optimistic legality checks).
//
// Coordinates: {file, rank} with file in [0..8] and rank in [0..9].
// Red sits on ranks 0..4, black on ranks 5..9. The river runs between
// ranks 4 and 5. Each side's palace is a 3x3 square: red at files 3..5
// rank 0..2; black at files 3..5 rank 7..9. Pieces sit ON intersections,
// not inside squares — `BOARD_FILES` x `BOARD_RANKS` = 9 x 10.

export const BOARD_FILES = 9;
export const BOARD_RANKS = 10;
export const INITIAL_TIME_MS = 15 * 60 * 1000;

export type Color = "red" | "black";

// Piece types — single-letter codes for compact serialisation.
export type PieceType =
  | "G" // General
  | "A" // Advisor
  | "E" // Elephant
  | "H" // Horse
  | "R" // Chariot (Rook-like)
  | "C" // Cannon
  | "S"; // Soldier (Pawn)

export interface Piece {
  type: PieceType;
  color: Color;
}

// `null` at a square means empty. The board is indexed [file][rank] so
// board[f][r] is the piece (or null) at the intersection (f, r).
export type Board = (Piece | null)[][];

export interface Square {
  file: number;
  rank: number;
}

export interface Move {
  from: Square;
  to: Square;
}

export type EndReason =
  | "checkmate"
  | "stalemate"
  | "general_captured"
  | "timeout"
  | "resign"
  | "draw_agreement"
  | "fifty_move_rule"
  | "disconnect";

export function inBounds(f: number, r: number): boolean {
  return f >= 0 && f < BOARD_FILES && r >= 0 && r < BOARD_RANKS;
}

export function squareEq(a: Square, b: Square): boolean {
  return a.file === b.file && a.rank === b.rank;
}

// True if (f, r) sits inside the palace belonging to `color`.
export function inPalace(f: number, r: number, color: Color): boolean {
  if (f < 3 || f > 5) return false;
  return color === "red" ? r >= 0 && r <= 2 : r >= 7 && r <= 9;
}

// True once a piece of `color` has crossed the river. Soldiers gain the
// sideways move; elephants are forbidden.
export function crossedRiver(r: number, color: Color): boolean {
  return color === "red" ? r >= 5 : r <= 4;
}

export function makeEmptyBoard(): Board {
  const b: Board = [];
  for (let f = 0; f < BOARD_FILES; f++) {
    b.push(new Array(BOARD_RANKS).fill(null));
  }
  return b;
}

export function cloneBoard(b: Board): Board {
  const out: Board = [];
  for (let f = 0; f < BOARD_FILES; f++) {
    out.push(b[f].slice());
  }
  return out;
}

// Standard opening position. Red at the bottom (rank 0..4), black at top.
export function initialBoard(): Board {
  const b = makeEmptyBoard();
  const place = (f: number, r: number, type: PieceType, color: Color) => {
    b[f][r] = { type, color };
  };
  // Red back rank (rank 0)
  const back: PieceType[] = ["R", "H", "E", "A", "G", "A", "E", "H", "R"];
  back.forEach((t, f) => place(f, 0, t, "red"));
  // Red cannons at rank 2, files 1 and 7
  place(1, 2, "C", "red");
  place(7, 2, "C", "red");
  // Red soldiers at rank 3, files 0,2,4,6,8
  for (const f of [0, 2, 4, 6, 8]) place(f, 3, "S", "red");
  // Black back rank (rank 9)
  back.forEach((t, f) => place(f, 9, t, "black"));
  // Black cannons at rank 7
  place(1, 7, "C", "black");
  place(7, 7, "C", "black");
  // Black soldiers at rank 6
  for (const f of [0, 2, 4, 6, 8]) place(f, 6, "S", "black");
  return b;
}

export function getPiece(b: Board, sq: Square): Piece | null {
  if (!inBounds(sq.file, sq.rank)) return null;
  return b[sq.file][sq.rank];
}

function pushIfLegalDest(
  b: Board,
  moverColor: Color,
  f: number,
  r: number,
  out: Square[],
): void {
  if (!inBounds(f, r)) return;
  const occ = b[f][r];
  if (!occ || occ.color !== moverColor) {
    out.push({ file: f, rank: r });
  }
}

// Generate the squares a single piece pseudo-legally attacks/moves to,
// IGNORING the "can't leave own general in check / face enemy general"
// rule. Used as a building block by both legal-move generation and
// check detection.
export function pseudoLegalDestinations(
  b: Board,
  from: Square,
): Square[] {
  const piece = b[from.file][from.rank];
  if (!piece) return [];
  const out: Square[] = [];
  const f = from.file;
  const r = from.rank;
  const c = piece.color;

  switch (piece.type) {
    case "G": {
      // Orthogonal one step inside palace.
      const steps: [number, number][] = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
      ];
      for (const [df, dr] of steps) {
        const nf = f + df;
        const nr = r + dr;
        if (!inPalace(nf, nr, c)) continue;
        pushIfLegalDest(b, c, nf, nr, out);
      }
      // Flying-general capture: if generals stare across an empty file,
      // the general can "fly" to capture the opposing general. We model
      // it as a pseudo-legal capture so attack detection can naturally
      // rule out positions where the kings would face each other.
      const enemyKing = findGeneral(b, c === "red" ? "black" : "red");
      if (enemyKing && enemyKing.file === f) {
        let blocked = false;
        const lo = Math.min(r, enemyKing.rank);
        const hi = Math.max(r, enemyKing.rank);
        for (let rr = lo + 1; rr < hi; rr++) {
          if (b[f][rr]) { blocked = true; break; }
        }
        if (!blocked) out.push(enemyKing);
      }
      break;
    }
    case "A": {
      // Diagonal one step inside palace.
      const steps: [number, number][] = [
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ];
      for (const [df, dr] of steps) {
        const nf = f + df;
        const nr = r + dr;
        if (!inPalace(nf, nr, c)) continue;
        pushIfLegalDest(b, c, nf, nr, out);
      }
      break;
    }
    case "E": {
      // Two-point diagonal jump; cannot cross river; blocked at midpoint.
      const steps: [number, number][] = [
        [2, 2], [2, -2], [-2, 2], [-2, -2],
      ];
      for (const [df, dr] of steps) {
        const mf = f + df / 2;
        const mr = r + dr / 2;
        const nf = f + df;
        const nr = r + dr;
        if (!inBounds(nf, nr)) continue;
        if (crossedRiver(nr, c)) continue; // can't go past river
        if (b[mf][mr]) continue; // midpoint blocked
        pushIfLegalDest(b, c, nf, nr, out);
      }
      break;
    }
    case "H": {
      // One orthogonal then one outward diagonal; blocked by orthogonal.
      const moves: { leg: [number, number]; dest: [number, number] }[] = [
        { leg: [1, 0],  dest: [2, 1] },
        { leg: [1, 0],  dest: [2, -1] },
        { leg: [-1, 0], dest: [-2, 1] },
        { leg: [-1, 0], dest: [-2, -1] },
        { leg: [0, 1],  dest: [1, 2] },
        { leg: [0, 1],  dest: [-1, 2] },
        { leg: [0, -1], dest: [1, -2] },
        { leg: [0, -1], dest: [-1, -2] },
      ];
      for (const m of moves) {
        const lf = f + m.leg[0];
        const lr = r + m.leg[1];
        if (!inBounds(lf, lr) || b[lf][lr]) continue; // hobbled
        const nf = f + m.dest[0];
        const nr = r + m.dest[1];
        pushIfLegalDest(b, c, nf, nr, out);
      }
      break;
    }
    case "R": {
      // Slide orthogonally any number of empty squares, optionally
      // capturing the first enemy piece encountered.
      const dirs: [number, number][] = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
      ];
      for (const [df, dr] of dirs) {
        let nf = f + df;
        let nr = r + dr;
        while (inBounds(nf, nr)) {
          const occ = b[nf][nr];
          if (!occ) {
            out.push({ file: nf, rank: nr });
          } else {
            if (occ.color !== c) out.push({ file: nf, rank: nr });
            break;
          }
          nf += df;
          nr += dr;
        }
      }
      break;
    }
    case "C": {
      // Slides orthogonally over empty squares like a chariot for
      // non-capture; for a capture, must cross EXACTLY one piece (the
      // "screen") before landing on an enemy piece.
      const dirs: [number, number][] = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
      ];
      for (const [df, dr] of dirs) {
        let nf = f + df;
        let nr = r + dr;
        // Phase 1: empty squares for non-capture moves.
        while (inBounds(nf, nr) && !b[nf][nr]) {
          out.push({ file: nf, rank: nr });
          nf += df;
          nr += dr;
        }
        // First piece encountered is the would-be screen. Step past it
        // and look for a capture.
        if (!inBounds(nf, nr)) continue;
        nf += df;
        nr += dr;
        while (inBounds(nf, nr)) {
          const occ = b[nf][nr];
          if (occ) {
            if (occ.color !== c) out.push({ file: nf, rank: nr });
            break;
          }
          nf += df;
          nr += dr;
        }
      }
      break;
    }
    case "S": {
      // Forward one before crossing river. After crossing, also
      // sideways. Never backward.
      const forward = c === "red" ? 1 : -1;
      pushIfLegalDest(b, c, f, r + forward, out);
      if (crossedRiver(r, c)) {
        pushIfLegalDest(b, c, f - 1, r, out);
        pushIfLegalDest(b, c, f + 1, r, out);
      }
      break;
    }
  }
  return out;
}

export function findGeneral(b: Board, color: Color): Square | null {
  for (let f = 0; f < BOARD_FILES; f++) {
    for (let r = 0; r < BOARD_RANKS; r++) {
      const p = b[f][r];
      if (p && p.type === "G" && p.color === color) return { file: f, rank: r };
    }
  }
  return null;
}

// Does ANY piece belonging to `byColor` pseudo-legally attack `target`?
// Used both for check detection and for filtering would-be self-checks.
// To avoid infinite recursion, the general's "flying-general" capture is
// handled inside pseudoLegalDestinations and also short-circuited here:
// we test each enemy piece's destinations against `target`.
export function isSquareAttacked(
  b: Board,
  target: Square,
  byColor: Color,
): boolean {
  for (let f = 0; f < BOARD_FILES; f++) {
    for (let r = 0; r < BOARD_RANKS; r++) {
      const p = b[f][r];
      if (!p || p.color !== byColor) continue;
      const dests = pseudoLegalDestinations(b, { file: f, rank: r });
      for (const d of dests) {
        if (squareEq(d, target)) return true;
      }
    }
  }
  return false;
}

export function isInCheck(b: Board, color: Color): boolean {
  const king = findGeneral(b, color);
  if (!king) return false;
  return isSquareAttacked(b, king, color === "red" ? "black" : "red");
}

// Apply a move to a NEW board (does not mutate input). Captures the
// destination piece if any. Caller is responsible for ensuring the
// move is legal — `legalMoves` already filters illegal/self-check moves.
export function applyMove(b: Board, move: Move): Board {
  const next = cloneBoard(b);
  const piece = next[move.from.file][move.from.rank];
  if (!piece) return next;
  next[move.from.file][move.from.rank] = null;
  next[move.to.file][move.to.rank] = piece;
  return next;
}

// All fully-legal moves for a single piece — i.e. pseudo-legal moves
// minus those that would leave the mover's own general in check (or
// expose the generals to a flying-general kill from each other).
export function legalMovesFromSquare(
  b: Board,
  from: Square,
): Square[] {
  const piece = b[from.file][from.rank];
  if (!piece) return [];
  const candidates = pseudoLegalDestinations(b, from);
  const out: Square[] = [];
  for (const to of candidates) {
    const next = applyMove(b, { from, to });
    if (!isInCheck(next, piece.color)) out.push(to);
  }
  return out;
}

// All legal moves for an entire side. Used for stalemate / checkmate
// detection.
export function allLegalMoves(b: Board, color: Color): Move[] {
  const out: Move[] = [];
  for (let f = 0; f < BOARD_FILES; f++) {
    for (let r = 0; r < BOARD_RANKS; r++) {
      const p = b[f][r];
      if (!p || p.color !== color) continue;
      const from: Square = { file: f, rank: r };
      for (const to of legalMovesFromSquare(b, from)) {
        out.push({ from, to });
      }
    }
  }
  return out;
}

// Returns the side to move's status: 'checkmate' (no legal moves AND in
// check), 'stalemate' (no legal moves AND not in check — Asian rules
// also treat this as a loss for the side to move), 'check' (in check
// but has at least one legal move), or 'ok'. Note: the SCORING of
// stalemate vs checkmate is identical in Xiangqi (mover loses), but we
// distinguish them so the UI can say so accurately.
export type Status = "ok" | "check" | "checkmate" | "stalemate";

export function statusFor(b: Board, sideToMove: Color): Status {
  const inCheck = isInCheck(b, sideToMove);
  const moves = allLegalMoves(b, sideToMove);
  if (moves.length === 0) return inCheck ? "checkmate" : "stalemate";
  return inCheck ? "check" : "ok";
}

export function isLegalMove(b: Board, color: Color, move: Move): boolean {
  const piece = b[move.from.file]?.[move.from.rank];
  if (!piece || piece.color !== color) return false;
  const dests = legalMovesFromSquare(b, move.from);
  return dests.some((d) => squareEq(d, move.to));
}

// Helper for "move resulted in capture" — used to reset the 60-move
// no-capture counter. Returns true if `to` was occupied by an enemy
// piece before the move (i.e. the move was a capture).
export function isCaptureMove(b: Board, move: Move): boolean {
  const target = b[move.to.file]?.[move.to.rank];
  return !!target;
}

// Compact board serialisation for the wire / DB — 90 chars, one per
// square, file-major. Uppercase = red, lowercase = black, '.' = empty.
export function serializeBoard(b: Board): string {
  const chars: string[] = [];
  for (let r = 0; r < BOARD_RANKS; r++) {
    for (let f = 0; f < BOARD_FILES; f++) {
      const p = b[f][r];
      if (!p) {
        chars.push(".");
      } else {
        chars.push(p.color === "red" ? p.type : p.type.toLowerCase());
      }
    }
  }
  return chars.join("");
}

export function deserializeBoard(s: string): Board {
  const b = makeEmptyBoard();
  if (s.length !== BOARD_FILES * BOARD_RANKS) return b;
  let i = 0;
  for (let r = 0; r < BOARD_RANKS; r++) {
    for (let f = 0; f < BOARD_FILES; f++) {
      const ch = s[i++];
      if (ch === ".") continue;
      const upper = ch.toUpperCase() as PieceType;
      const color: Color = ch === upper ? "red" : "black";
      b[f][r] = { type: upper, color };
    }
  }
  return b;
}

// Position key = serialized board + side to move. Used by the perpetual-
// check detector to recognise repeated positions.
export function positionKey(b: Board, sideToMove: Color): string {
  return serializeBoard(b) + ":" + sideToMove;
}

// One entry of the per-game move-history log used for perpetual-check
// detection. `posKey` is the position AFTER the move was applied;
// `checkingSide` is the colour that delivered check by the move (null
// if the move did not deliver check).
export interface HistoryEntry {
  posKey: string;
  checkingSide: Color | null;
}

// Basic perpetual-check rule: if the same position has occurred 3+ times
// in a single game and on every one of those occurrences the same side
// delivered check, that side loses. Returns the offending colour (the
// loser) or null. The locked spec defers full WXF rules; this is the
// minimum they require: "implement basic perpetual-check loss only."
export function detectPerpetualCheckLoser(history: HistoryEntry[]): Color | null {
  const buckets = new Map<string, HistoryEntry[]>();
  for (const e of history) {
    const list = buckets.get(e.posKey) ?? [];
    list.push(e);
    buckets.set(e.posKey, list);
  }
  for (const list of buckets.values()) {
    if (list.length < 3) continue;
    const first = list[0].checkingSide;
    if (first === null) continue;
    if (list.every((e) => e.checkingSide === first)) return first;
  }
  return null;
}
