import { describe, expect, it } from "vitest";
import {
  applyMove,
  allLegalMoves,
  cloneBoard,
  deserializeBoard,
  findGeneral,
  initialBoard,
  isCaptureMove,
  isInCheck,
  isLegalMove,
  legalMovesFromSquare,
  makeEmptyBoard,
  pseudoLegalDestinations,
  serializeBoard,
  statusFor,
  type Board,
  type Color,
  type Move,
  type PieceType,
} from "../shared/games/xiangqi";

function placeOnly(pieces: { f: number; r: number; type: PieceType; color: Color }[]): Board {
  const b = makeEmptyBoard();
  for (const p of pieces) {
    b[p.f][p.r] = { type: p.type, color: p.color };
  }
  return b;
}

describe("Xiangqi rules engine", () => {
  it("initial board has 32 pieces in correct opening positions", () => {
    const b = initialBoard();
    let count = 0;
    for (let f = 0; f < 9; f++) {
      for (let r = 0; r < 10; r++) {
        if (b[f][r]) count++;
      }
    }
    expect(count).toBe(32);
    expect(b[4][0]).toEqual({ type: "G", color: "red" });
    expect(b[4][9]).toEqual({ type: "G", color: "black" });
    expect(b[1][2]).toEqual({ type: "C", color: "red" });
    expect(b[7][7]).toEqual({ type: "C", color: "black" });
  });

  it("general is confined to its palace and moves orthogonally one step", () => {
    const b = placeOnly([
      { f: 4, r: 1, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" }, // off the same file via column 4
    ]);
    // Block flying-general by sticking a piece between them.
    b[4][5] = { type: "S", color: "red" };
    const moves = legalMovesFromSquare(b, { file: 4, rank: 1 });
    const dests = moves.map((m) => `${m.file}-${m.rank}`).sort();
    // From (4,1) inside palace: can go to (3,1), (5,1), (4,0), (4,2).
    expect(dests).toEqual(["3-1", "4-0", "4-2", "5-1"]);
  });

  it("flying-general rule: generals on the same open file see each other in check", () => {
    const b = placeOnly([
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    // Both generals are simultaneously checked by the other under the
    // flying-general rule — file 4 is empty between them.
    expect(isInCheck(b, "red")).toBe(true);
    expect(isInCheck(b, "black")).toBe(true);
    // Block the file with a single piece — flying general suppressed.
    const b2 = cloneBoard(b);
    b2[4][5] = { type: "S", color: "red" };
    expect(isInCheck(b2, "red")).toBe(false);
    expect(isInCheck(b2, "black")).toBe(false);
  });

  it("advisor stays inside the palace on diagonals only", () => {
    const b = placeOnly([
      { f: 3, r: 0, type: "A", color: "red" },
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    const dests = legalMovesFromSquare(b, { file: 3, rank: 0 }).map((m) => `${m.file}-${m.rank}`).sort();
    // From (3,0): only diagonal (4,1) — (2,1) is outside the palace.
    expect(dests).toEqual(["4-1"]);
  });

  it("elephant can't cross the river and is blocked at the midpoint", () => {
    const b = placeOnly([
      { f: 2, r: 0, type: "E", color: "red" },
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    const dests = pseudoLegalDestinations(b, { file: 2, rank: 0 });
    // From (2,0) diagonal-2 jumps without crossing river: (0,2), (4,2).
    // (Cannot go to (-2,2) or (2,-2) — out of bounds. Cannot go to (4,-2).)
    expect(dests.map((d) => `${d.file}-${d.rank}`).sort()).toEqual(["0-2", "4-2"]);
    // Block midpoint at (3,1).
    b[3][1] = { type: "S", color: "red" };
    const blocked = pseudoLegalDestinations(b, { file: 2, rank: 0 });
    // (4,2) blocked, (0,2) still open.
    expect(blocked.map((d) => `${d.file}-${d.rank}`)).toEqual(["0-2"]);
  });

  it("horse is hobbled by an adjacent piece on the leg", () => {
    const b = placeOnly([
      { f: 1, r: 0, type: "H", color: "red" },
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    // From (1,0): destinations (0,2), (2,2), (3,1) are open. (-1,2) off-board.
    const open = pseudoLegalDestinations(b, { file: 1, rank: 0 }).map((d) => `${d.file}-${d.rank}`).sort();
    expect(open).toEqual(["0-2", "2-2", "3-1"]);
    // Hobble the leg towards (1,1) — blocks (0,2) and (2,2).
    b[1][1] = { type: "S", color: "red" };
    const hobbled = pseudoLegalDestinations(b, { file: 1, rank: 0 }).map((d) => `${d.file}-${d.rank}`).sort();
    expect(hobbled).toEqual(["3-1"]);
  });

  it("chariot slides any number of squares orthogonally and stops at first piece", () => {
    const b = placeOnly([
      { f: 0, r: 0, type: "R", color: "red" },
      { f: 0, r: 5, type: "S", color: "black" }, // enemy at (0,5)
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    const dests = pseudoLegalDestinations(b, { file: 0, rank: 0 });
    const ranks = dests.filter((d) => d.file === 0).map((d) => d.rank).sort((a, b) => a - b);
    // Up file 0: ranks 1..5 (capture at 5).
    expect(ranks).toEqual([1, 2, 3, 4, 5]);
    // Files >0 along rank 0 are open up to (3,0), then blocked by general at (4,0).
    const filesOnRank0 = dests.filter((d) => d.rank === 0).map((d) => d.file).sort((a, b) => a - b);
    expect(filesOnRank0).toEqual([1, 2, 3]);
  });

  it("cannon needs exactly one screen to capture", () => {
    const b = placeOnly([
      { f: 1, r: 2, type: "C", color: "red" },
      { f: 1, r: 5, type: "S", color: "red" },   // screen
      { f: 1, r: 8, type: "S", color: "black" }, // capture target
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    const dests = pseudoLegalDestinations(b, { file: 1, rank: 2 });
    const upFile1 = dests.filter((d) => d.file === 1 && d.rank > 2).map((d) => d.rank).sort((a, b) => a - b);
    // Empty squares (3,4) for non-capture, then capture at (1,8). NOT (1,5)
    // (own piece) and NOT any square between 5 and 8 (those are non-capture
    // moves blocked by the screen).
    expect(upFile1).toEqual([3, 4, 8]);
    // Removing the screen → cannon can no longer capture (1,8).
    b[1][5] = null;
    const dests2 = pseudoLegalDestinations(b, { file: 1, rank: 2 });
    const upFile1b = dests2.filter((d) => d.file === 1 && d.rank > 2).map((d) => d.rank).sort((a, b) => a - b);
    expect(upFile1b).toEqual([3, 4, 5, 6, 7]);
  });

  it("soldier moves forward only before river, gains sideways after crossing", () => {
    // Red soldier before river at (4,3) — only (4,4).
    const b1 = placeOnly([
      { f: 4, r: 3, type: "S", color: "red" },
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    expect(pseudoLegalDestinations(b1, { file: 4, rank: 3 }).map((d) => `${d.file}-${d.rank}`)).toEqual(["4-4"]);
    // Red soldier across river at (4,5) — (4,6), (3,5), (5,5). Block (4,6) with king to keep test clean.
    const b2 = placeOnly([
      { f: 4, r: 5, type: "S", color: "red" },
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    expect(
      pseudoLegalDestinations(b2, { file: 4, rank: 5 }).map((d) => `${d.file}-${d.rank}`).sort(),
    ).toEqual(["3-5", "4-6", "5-5"]);
  });

  it("checkmate detection: red is mated with all escape squares attacked", () => {
    // Red king at (3,0) — escapes are (3,1) and (4,0) (palace corner).
    // Black rook on file 3 checks the king. Another black rook on file 4
    // covers (4,0). King has no escape and no piece can interpose or
    // capture the checker.
    const b = placeOnly([
      { f: 3, r: 0, type: "G", color: "red" },
      { f: 3, r: 5, type: "R", color: "black" }, // checks king on file 3
      { f: 4, r: 5, type: "R", color: "black" }, // covers (4,0) escape
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    expect(isInCheck(b, "red")).toBe(true);
    expect(statusFor(b, "red")).toBe("checkmate");
  });

  it("stalemate detection: side has no legal moves but is not in check", () => {
    // Red king at (3,0) — only escape squares are (3,1) and (4,0).
    // Black rook at (1,1) attacks rank 1, covering (3,1) without
    // attacking the king (king is on rank 0). Black rook at (4,5)
    // attacks file 4 (empty), covering (4,0) without attacking the
    // king (king is on file 3). Black king tucked away on file 6 to
    // avoid any flying-general interaction.
    const b = placeOnly([
      { f: 3, r: 0, type: "G", color: "red" },
      { f: 1, r: 1, type: "R", color: "black" }, // covers (3,1)
      { f: 4, r: 5, type: "R", color: "black" }, // covers (4,0)
      { f: 6, r: 9, type: "G", color: "black" },
    ]);
    expect(isInCheck(b, "red")).toBe(false);
    expect(statusFor(b, "red")).toBe("stalemate");
  });

  it("isLegalMove rejects moves that would leave own general in check", () => {
    // Red has only general at (4,0) and a chariot at (4,1) acting as
    // shield against black chariot at (4,5). Moving the shield exposes
    // the general → illegal.
    const b = placeOnly([
      { f: 4, r: 0, type: "G", color: "red" },
      { f: 4, r: 1, type: "R", color: "red" },
      { f: 4, r: 5, type: "R", color: "black" },
      { f: 4, r: 9, type: "G", color: "black" },
    ]);
    // Sliding the red rook off the file → leaves general in check.
    const move: Move = { from: { file: 4, rank: 1 }, to: { file: 3, rank: 1 } };
    expect(isLegalMove(b, "red", move)).toBe(false);
    // Sliding the red rook UP file 4 (still on file 4) → still legal.
    const move2: Move = { from: { file: 4, rank: 1 }, to: { file: 4, rank: 2 } };
    expect(isLegalMove(b, "red", move2)).toBe(true);
  });

  it("isCaptureMove returns true only when destination is occupied", () => {
    const b = initialBoard();
    expect(isCaptureMove(b, { from: { file: 0, rank: 0 }, to: { file: 0, rank: 1 } })).toBe(false);
    // Place black piece at (0, 4) for the chariot to capture.
    b[0][4] = { type: "S", color: "black" };
    expect(isCaptureMove(b, { from: { file: 0, rank: 0 }, to: { file: 0, rank: 4 } })).toBe(true);
  });

  it("serialize/deserialize round-trips a populated board", () => {
    const b = initialBoard();
    const s = serializeBoard(b);
    expect(s).toHaveLength(90);
    const back = deserializeBoard(s);
    expect(serializeBoard(back)).toBe(s);
    expect(findGeneral(back, "red")).toEqual({ file: 4, rank: 0 });
  });

  it("applyMove updates the board immutably and captures correctly", () => {
    const b = initialBoard();
    // Place black soldier in path of red chariot, then capture.
    b[0][4] = { type: "S", color: "black" };
    const before = serializeBoard(b);
    const next = applyMove(b, { from: { file: 0, rank: 0 }, to: { file: 0, rank: 4 } });
    expect(serializeBoard(b)).toBe(before); // input unchanged
    expect(next[0][0]).toBe(null);
    expect(next[0][4]).toEqual({ type: "R", color: "red" });
  });

  it("opening position has a positive number of legal moves for red", () => {
    const b = initialBoard();
    const moves = allLegalMoves(b, "red");
    expect(moves.length).toBeGreaterThan(20);
  });
});
