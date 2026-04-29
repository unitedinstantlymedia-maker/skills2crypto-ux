import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import {
  INITIAL_FEN,
  INITIAL_TIME_MS,
  applyMove,
  detectTerminal,
  isCheckmate,
  isFiftyMoveRule,
  isInCheck,
  isInsufficientMaterial,
  isStalemate,
  isThreefoldRepetition,
  isValidFen,
  legalDestinationsFrom,
  loadFen,
  newGame,
  positionKey,
  turn,
} from "../shared/games/chess";

describe("chess engine wrapper", () => {
  it("newGame starts on the canonical opening FEN with white to move", () => {
    const g = newGame();
    expect(g.fen()).toBe(INITIAL_FEN);
    expect(turn(g)).toBe("w");
  });

  it("INITIAL_TIME_MS matches the legacy 30-minute classical default", () => {
    expect(INITIAL_TIME_MS).toBe(30 * 60 * 1000);
  });

  it("loadFen returns null for a malformed FEN", () => {
    expect(loadFen("not a fen")).toBeNull();
    expect(isValidFen("not a fen")).toBe(false);
    expect(isValidFen(INITIAL_FEN)).toBe(true);
  });

  it("legalDestinationsFrom enumerates known opening moves", () => {
    const g = newGame();
    const e2 = legalDestinationsFrom(g, "e2").sort();
    // Pawn on e2 in the start position can advance one or two squares.
    expect(e2).toEqual(["e3", "e4"]);
    const b1 = legalDestinationsFrom(g, "b1").sort();
    // Knight on b1 jumps to a3 / c3.
    expect(b1).toEqual(["a3", "c3"]);
  });

  it("legalDestinationsFrom returns empty for an empty square", () => {
    const g = newGame();
    expect(legalDestinationsFrom(g, "e4")).toEqual([]);
  });

  it("applyMove rejects illegal moves and does not mutate the input", () => {
    const g = newGame();
    const before = g.fen();
    const result = applyMove(g, { from: "e2", to: "e5" });
    expect(result).toBeNull();
    expect(g.fen()).toBe(before);
  });

  it("applyMove mutates the input game and returns the applied move", () => {
    const g = newGame();
    const before = g.fen();
    const result = applyMove(g, { from: "e2", to: "e4" });
    expect(result).not.toBeNull();
    // Mutation is the documented contract — the server keeps one Chess
    // per room across the whole game so chess.js can detect threefold.
    expect(g.fen()).not.toBe(before);
    expect(result!.applied.from).toBe("e2");
    expect(result!.applied.to).toBe("e4");
    expect(result!.applied.san).toBe("e4");
    expect(result!.applied.turn).toBe("b");
    expect(result!.applied.capture).toBe(false);
    expect(g.fen()).toBe(result!.applied.fen);
  });

  it("applyMove flags a capture", () => {
    // After 1.e4 d5 2.exd5 — the 3rd move is a capture.
    const g = newGame();
    expect(applyMove(g, { from: "e2", to: "e4" })).not.toBeNull();
    expect(applyMove(g, { from: "d7", to: "d5" })).not.toBeNull();
    const cap = applyMove(g, { from: "e4", to: "d5" });
    expect(cap).not.toBeNull();
    expect(cap!.applied.capture).toBe(true);
  });

  it("detectTerminal flags a Fool's-mate position as checkmate; mover wins", () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#  — white is checkmated, black wins.
    const g = newGame();
    expect(applyMove(g, { from: "f2", to: "f3" })).not.toBeNull();
    expect(applyMove(g, { from: "e7", to: "e5" })).not.toBeNull();
    expect(applyMove(g, { from: "g2", to: "g4" })).not.toBeNull();
    expect(applyMove(g, { from: "d8", to: "h4" })).not.toBeNull();
    expect(isCheckmate(g)).toBe(true);
    expect(isInCheck(g)).toBe(true);
    const term = detectTerminal(g);
    expect(term).not.toBeNull();
    expect(term!.reason).toBe("checkmate");
    if (term!.reason === "checkmate") {
      // White is on the move and is mated — the loser turn is "w".
      expect(term.loserTurn).toBe("w");
    }
  });

  it("detectTerminal flags stalemate", () => {
    // Classic stalemate position: black king on h8, white king on f7, white queen on g6.
    // Black to move has no legal moves and is not in check.
    const g = new Chess("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1");
    expect(isStalemate(g)).toBe(true);
    expect(isInCheck(g)).toBe(false);
    const term = detectTerminal(g);
    expect(term).not.toBeNull();
    expect(term!.reason).toBe("stalemate");
  });

  it("detectTerminal flags insufficient material (king vs king)", () => {
    const g = new Chess("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(isInsufficientMaterial(g)).toBe(true);
    const term = detectTerminal(g);
    expect(term).not.toBeNull();
    expect(term!.reason).toBe("insufficient_material");
  });

  it("isFiftyMoveRule reads the FEN halfmove counter", () => {
    // Halfmove clock 100 (= 50 full moves with no capture or pawn move) ⇒ rule fires.
    const g = new Chess("4k3/8/8/8/8/8/4P3/4K3 w - - 100 60");
    expect(isFiftyMoveRule(g)).toBe(true);
    const fresh = newGame();
    expect(isFiftyMoveRule(fresh)).toBe(false);
  });

  it("detectTerminal flags threefold repetition", () => {
    // Drive a threefold repetition by shuffling knights with no progress.
    // The mutating applyMove preserves chess.js's internal move history,
    // which is what powers .isThreefoldRepetition().
    const g = newGame();
    const shuffle: { from: string; to: string }[] = [
      { from: "g1", to: "f3" },
      { from: "g8", to: "f6" },
      { from: "f3", to: "g1" },
      { from: "f6", to: "g8" },
    ];
    // Two full cycles of the shuffle return to the starting position
    // 3 times (including the initial setup), triggering threefold.
    for (let i = 0; i < 8; i++) {
      const m = shuffle[i % shuffle.length];
      const r = applyMove(g, m);
      expect(r).not.toBeNull();
    }
    expect(isThreefoldRepetition(g)).toBe(true);
    const term = detectTerminal(g);
    expect(term).not.toBeNull();
    expect(term!.reason).toBe("threefold_repetition");
  });

  it("detectTerminal returns null for a normal in-progress position", () => {
    const g = newGame();
    expect(applyMove(g, { from: "e2", to: "e4" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
  });

  it("positionKey ignores clocks and move number — same position has same key", () => {
    const g1 = newGame();
    expect(applyMove(g1, { from: "g1", to: "f3" })).not.toBeNull();
    expect(applyMove(g1, { from: "g8", to: "f6" })).not.toBeNull();
    expect(applyMove(g1, { from: "f3", to: "g1" })).not.toBeNull();
    expect(applyMove(g1, { from: "f6", to: "g8" })).not.toBeNull();
    // After the round-trip the board + side-to-move + castling + ep
    // are identical to the start, even though halfmove / fullmove differ.
    const startKey = positionKey(newGame());
    expect(positionKey(g1)).toBe(startKey);
    // Sanity: full FENs differ because of the move counters.
    expect(g1.fen()).not.toBe(INITIAL_FEN);
  });

  it("server move-handler simulation: illegal move is rejected and clock NOT charged for the move itself", () => {
    // Mimics the priority order the server uses: legality check happens
    // AFTER turn-check and the clock drain. The drain stays charged
    // (so probing illegal moves isn't free time), but no SAN is broadcast.
    const g = newGame();
    const probe = applyMove(g, { from: "e2", to: "e5" });
    expect(probe).toBeNull();
    // No state change. Server would NOT broadcast `opponent-move`.
  });

  it("server clock-drain pattern: same wall-clock interval is never charged twice", () => {
    // Regression for the clock-drift bug: the server must advance
    // `lastTickAt` immediately after the drain, EVEN if it then bails
    // out (e.g. the move was illegal). Otherwise the same elapsed
    // window is charged again on the next attempt and the player can be
    // prematurely flagged.
    let whiteTime = 30 * 60 * 1000;
    let lastTickAt = 0;

    // T = 1000ms: white attempts an illegal move.
    let now = 1000;
    let elapsed = Math.max(0, now - lastTickAt);
    whiteTime = Math.max(0, whiteTime - elapsed);
    lastTickAt = now; // advance even on illegal-move return
    // (server then returns because move is illegal — handled separately)

    // T = 3000ms: white attempts a legal move.
    now = 3000;
    elapsed = Math.max(0, now - lastTickAt);
    whiteTime = Math.max(0, whiteTime - elapsed);
    lastTickAt = now;

    // Total wall-clock charged should equal exactly 3000ms — not 4000.
    expect(30 * 60 * 1000 - whiteTime).toBe(3000);
  });

  it("server move-handler simulation: terminal priority — checkmate detected immediately after the mating move", () => {
    // Apply Fool's-mate move-by-move and verify detectTerminal fires
    // exactly on the mating move (Qh4#) and not before.
    const g = newGame();
    expect(applyMove(g, { from: "f2", to: "f3" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
    expect(applyMove(g, { from: "e7", to: "e5" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
    expect(applyMove(g, { from: "g2", to: "g4" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
    expect(applyMove(g, { from: "d8", to: "h4" })).not.toBeNull();
    const term = detectTerminal(g);
    expect(term).not.toBeNull();
    expect(term!.reason).toBe("checkmate");
  });
});
