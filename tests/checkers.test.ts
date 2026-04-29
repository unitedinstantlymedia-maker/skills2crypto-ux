import { describe, expect, it } from "vitest";
import {
  allLegalMoves,
  applyMove,
  BOARD_SIZE,
  cloneBoard,
  colorHasAnyJump,
  countPieces,
  deserializeBoard,
  findLegalMove,
  getJumpsFromSquare,
  getSimpleMovesFromSquare,
  initialBoard,
  legalMovesFromSquare,
  makeEmptyBoard,
  serializeBoard,
  statusFor,
  type Board,
  type Piece,
} from "../shared/games/checkers";

function place(b: Board, row: number, col: number, p: Piece | null) {
  b[row][col] = p;
}

describe("checkers engine — initial board", () => {
  it("places 12 red and 12 black pieces on dark squares only", () => {
    const b = initialBoard();
    let red = 0, black = 0, lightOccupied = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const p = b[r][c];
        if (!p) continue;
        if ((r + c) % 2 === 0) lightOccupied++;
        if (p.color === "red") red++;
        else black++;
      }
    }
    expect(red).toBe(12);
    expect(black).toBe(12);
    expect(lightOccupied).toBe(0);
  });

  it("red occupies rows 5..7, black rows 0..2", () => {
    const b = initialBoard();
    for (let c = 0; c < BOARD_SIZE; c++) {
      for (let r = 0; r < 3; r++) {
        if ((r + c) % 2 === 1) expect(b[r][c]?.color).toBe("black");
      }
      for (let r = 5; r < 8; r++) {
        if ((r + c) % 2 === 1) expect(b[r][c]?.color).toBe("red");
      }
    }
  });
});

describe("checkers engine — simple moves & directions", () => {
  it("red men move only diagonally up; black men only down", () => {
    const b = makeEmptyBoard();
    place(b, 5, 0, { color: "red", type: "man" });
    const redMoves = getSimpleMovesFromSquare(b, { row: 5, col: 0 });
    expect(redMoves).toHaveLength(1);
    expect(redMoves[0].to).toEqual({ row: 4, col: 1 });

    const b2 = makeEmptyBoard();
    place(b2, 2, 1, { color: "black", type: "man" });
    const blackMoves = getSimpleMovesFromSquare(b2, { row: 2, col: 1 });
    expect(blackMoves.map((m) => m.to)).toEqual(
      expect.arrayContaining([
        { row: 3, col: 0 },
        { row: 3, col: 2 },
      ]),
    );
    expect(blackMoves).toHaveLength(2);
  });

  it("kings move all four diagonals", () => {
    const b = makeEmptyBoard();
    place(b, 4, 3, { color: "red", type: "king" });
    const moves = getSimpleMovesFromSquare(b, { row: 4, col: 3 });
    expect(moves.map((m) => m.to)).toEqual(
      expect.arrayContaining([
        { row: 3, col: 2 },
        { row: 3, col: 4 },
        { row: 5, col: 2 },
        { row: 5, col: 4 },
      ]),
    );
    expect(moves).toHaveLength(4);
  });
});

describe("checkers engine — jumps & forced capture", () => {
  it("getJumpsFromSquare detects a single jump and returns its capture", () => {
    const b = makeEmptyBoard();
    place(b, 5, 2, { color: "red", type: "man" });
    place(b, 4, 3, { color: "black", type: "man" });
    const jumps = getJumpsFromSquare(b, { row: 5, col: 2 });
    expect(jumps).toHaveLength(1);
    expect(jumps[0].to).toEqual({ row: 3, col: 4 });
    expect(jumps[0].captures).toEqual([{ row: 4, col: 3 }]);
  });

  it("colorHasAnyJump returns true when a jump exists anywhere for that side", () => {
    const b = makeEmptyBoard();
    place(b, 5, 2, { color: "red", type: "man" });
    place(b, 4, 3, { color: "black", type: "man" });
    // Red 5,2 jumps black 4,3 → 3,4. Black 4,3 jumps red 5,2 → 6,1.
    expect(colorHasAnyJump(b, "red")).toBe(true);
    expect(colorHasAnyJump(b, "black")).toBe(true);
  });

  it("colorHasAnyJump returns false when no jumps exist", () => {
    const b = makeEmptyBoard();
    place(b, 5, 0, { color: "red", type: "man" });
    place(b, 0, 1, { color: "black", type: "man" });
    expect(colorHasAnyJump(b, "red")).toBe(false);
    expect(colorHasAnyJump(b, "black")).toBe(false);
  });

  it("forced capture: simple moves are filtered out when a jump exists", () => {
    const b = makeEmptyBoard();
    place(b, 5, 2, { color: "red", type: "man" });
    place(b, 4, 3, { color: "black", type: "man" });
    place(b, 6, 7, { color: "red", type: "man" });
    const movesA = legalMovesFromSquare(b, { row: 5, col: 2 }, "red");
    expect(movesA.every((m) => m.captures.length > 0)).toBe(true);
    const movesB = legalMovesFromSquare(b, { row: 6, col: 7 }, "red");
    expect(movesB).toHaveLength(0);
    const all = allLegalMoves(b, "red");
    expect(all.every((m) => m.captures.length > 0)).toBe(true);
  });
});

describe("checkers engine — applyMove & promotion", () => {
  it("applyMove removes captured piece and lands the mover", () => {
    const b = makeEmptyBoard();
    place(b, 5, 2, { color: "red", type: "man" });
    place(b, 4, 3, { color: "black", type: "man" });
    const m = findLegalMove(b, "red", { row: 5, col: 2 }, { row: 3, col: 4 });
    expect(m).not.toBeNull();
    const { board: next, promoted } = applyMove(b, m!);
    expect(next[5][2]).toBeNull();
    expect(next[4][3]).toBeNull();
    expect(next[3][4]).toEqual({ color: "red", type: "man" });
    expect(promoted).toBe(false);
  });

  it("promotes a red man landing on row 0", () => {
    const b = makeEmptyBoard();
    place(b, 1, 2, { color: "red", type: "man" });
    const m = findLegalMove(b, "red", { row: 1, col: 2 }, { row: 0, col: 1 });
    expect(m).not.toBeNull();
    const { board: next, promoted } = applyMove(b, m!);
    expect(promoted).toBe(true);
    expect(next[0][1]).toEqual({ color: "red", type: "king" });
  });

  it("promotes a black man landing on row 7", () => {
    const b = makeEmptyBoard();
    place(b, 6, 1, { color: "black", type: "man" });
    const m = findLegalMove(b, "black", { row: 6, col: 1 }, { row: 7, col: 0 });
    expect(m).not.toBeNull();
    const { board: next, promoted } = applyMove(b, m!);
    expect(promoted).toBe(true);
    expect(next[7][0]).toEqual({ color: "black", type: "king" });
  });

  it("applyMove does not mutate the source board", () => {
    const b = initialBoard();
    const before = serializeBoard(b);
    const m = findLegalMove(b, "red", { row: 5, col: 0 }, { row: 4, col: 1 });
    expect(m).not.toBeNull();
    applyMove(b, m!);
    expect(serializeBoard(b)).toBe(before);
  });
});

describe("checkers engine — multi-jump as chain", () => {
  it("after a jump, getJumpsFromSquare on the landing square exposes the next jump", () => {
    const b = makeEmptyBoard();
    place(b, 5, 0, { color: "red", type: "man" });
    place(b, 4, 1, { color: "black", type: "man" });
    place(b, 2, 1, { color: "black", type: "man" });
    const m1 = findLegalMove(b, "red", { row: 5, col: 0 }, { row: 3, col: 2 });
    expect(m1).not.toBeNull();
    const { board: b2 } = applyMove(b, m1!);
    const next = getJumpsFromSquare(b2, { row: 3, col: 2 });
    expect(next).toHaveLength(1);
    expect(next[0].to).toEqual({ row: 1, col: 0 });
    expect(next[0].captures).toEqual([{ row: 2, col: 1 }]);
  });
});

describe("checkers engine — terminal", () => {
  it("statusFor: side with no pieces loses", () => {
    const b = makeEmptyBoard();
    place(b, 0, 1, { color: "red", type: "man" });
    expect(statusFor(b, "black")).toBe("win_red");
  });

  it("statusFor: side with no legal moves on its turn loses", () => {
    const b = makeEmptyBoard();
    // Pieces only sit on dark squares ((row+col)%2===1). Trap a black
    // man at (0,1): blockers at (1,0) and (1,2) (occupied by red),
    // and a red blocker at (2,3) so a jump over (1,2) → (2,3) is
    // impossible. Jump over (1,0) → (2,-1) is out of bounds.
    place(b, 0, 1, { color: "black", type: "man" });
    place(b, 1, 0, { color: "red", type: "man" });
    place(b, 1, 2, { color: "red", type: "man" });
    place(b, 2, 3, { color: "red", type: "man" });
    expect(statusFor(b, "black")).toBe("win_red");
  });

  it("statusFor: ok when at least one move exists", () => {
    expect(statusFor(initialBoard(), "red")).toBe("ok");
  });
});

describe("checkers engine — serialise round-trip", () => {
  it("serializeBoard / deserializeBoard preserves the position", () => {
    const b = initialBoard();
    const s = serializeBoard(b);
    expect(s).toHaveLength(64);
    const back = deserializeBoard(s);
    expect(serializeBoard(back)).toBe(s);
  });

  it("countPieces matches before and after serialisation", () => {
    const b = initialBoard();
    expect(countPieces(b, "red")).toBe(12);
    expect(countPieces(b, "black")).toBe(12);
    const back = deserializeBoard(serializeBoard(b));
    expect(countPieces(back, "red")).toBe(12);
    expect(countPieces(back, "black")).toBe(12);
  });
});

describe("checkers engine — cloneBoard", () => {
  it("cloneBoard is independent of the original", () => {
    const b = initialBoard();
    const c = cloneBoard(b);
    c[0][1] = null;
    expect(b[0][1]).not.toBeNull();
  });
});
