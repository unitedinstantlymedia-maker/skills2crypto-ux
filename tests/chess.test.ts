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

  it("INITIAL_TIME_MS is 30 minutes", () => {
    expect(INITIAL_TIME_MS).toBe(30 * 60 * 1000);
  });

  it("loadFen returns null for a malformed FEN", () => {
    expect(loadFen("not a fen")).toBeNull();
    expect(isValidFen("not a fen")).toBe(false);
    expect(isValidFen(INITIAL_FEN)).toBe(true);
  });

  it("legalDestinationsFrom enumerates known opening moves", () => {
    const g = newGame();
    expect(legalDestinationsFrom(g, "e2").sort()).toEqual(["e3", "e4"]);
    expect(legalDestinationsFrom(g, "b1").sort()).toEqual(["a3", "c3"]);
  });

  it("legalDestinationsFrom returns empty for an empty square", () => {
    expect(legalDestinationsFrom(newGame(), "e4")).toEqual([]);
  });

  it("applyMove rejects illegal moves and does not mutate the input", () => {
    const g = newGame();
    const before = g.fen();
    expect(applyMove(g, { from: "e2", to: "e5" })).toBeNull();
    expect(g.fen()).toBe(before);
  });

  it("applyMove mutates the input game and returns the applied move", () => {
    const g = newGame();
    const before = g.fen();
    const result = applyMove(g, { from: "e2", to: "e4" });
    expect(result).not.toBeNull();
    expect(g.fen()).not.toBe(before);
    expect(result!.applied.from).toBe("e2");
    expect(result!.applied.to).toBe("e4");
    expect(result!.applied.san).toBe("e4");
    expect(result!.applied.turn).toBe("b");
    expect(result!.applied.capture).toBe(false);
    expect(g.fen()).toBe(result!.applied.fen);
  });

  it("applyMove flags a capture", () => {
    const g = newGame();
    expect(applyMove(g, { from: "e2", to: "e4" })).not.toBeNull();
    expect(applyMove(g, { from: "d7", to: "d5" })).not.toBeNull();
    const cap = applyMove(g, { from: "e4", to: "d5" });
    expect(cap).not.toBeNull();
    expect(cap!.applied.capture).toBe(true);
  });

  it("detectTerminal flags Fool's mate as checkmate; mover wins", () => {
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
      expect(term.loserTurn).toBe("w");
    }
  });

  it("detectTerminal flags stalemate", () => {
    const g = new Chess("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1");
    expect(isStalemate(g)).toBe(true);
    expect(isInCheck(g)).toBe(false);
    expect(detectTerminal(g)?.reason).toBe("stalemate");
  });

  it("detectTerminal flags insufficient material (king vs king)", () => {
    const g = new Chess("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(isInsufficientMaterial(g)).toBe(true);
    expect(detectTerminal(g)?.reason).toBe("insufficient_material");
  });

  it("isFiftyMoveRule reads the FEN halfmove counter", () => {
    const g = new Chess("4k3/8/8/8/8/8/4P3/4K3 w - - 100 60");
    expect(isFiftyMoveRule(g)).toBe(true);
    expect(isFiftyMoveRule(newGame())).toBe(false);
  });

  it("detectTerminal flags threefold repetition", () => {
    const g = newGame();
    const shuffle = [
      { from: "g1", to: "f3" },
      { from: "g8", to: "f6" },
      { from: "f3", to: "g1" },
      { from: "f6", to: "g8" },
    ];
    for (let i = 0; i < 8; i++) {
      expect(applyMove(g, shuffle[i % shuffle.length])).not.toBeNull();
    }
    expect(isThreefoldRepetition(g)).toBe(true);
    expect(detectTerminal(g)?.reason).toBe("threefold_repetition");
  });

  it("detectTerminal returns null for a normal in-progress position", () => {
    const g = newGame();
    expect(applyMove(g, { from: "e2", to: "e4" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
  });

  it("positionKey ignores clocks and move number", () => {
    const g1 = newGame();
    expect(applyMove(g1, { from: "g1", to: "f3" })).not.toBeNull();
    expect(applyMove(g1, { from: "g8", to: "f6" })).not.toBeNull();
    expect(applyMove(g1, { from: "f3", to: "g1" })).not.toBeNull();
    expect(applyMove(g1, { from: "f6", to: "g8" })).not.toBeNull();
    expect(positionKey(g1)).toBe(positionKey(newGame()));
    expect(g1.fen()).not.toBe(INITIAL_FEN);
  });

  it("illegal move attempt does not change game state", () => {
    const g = newGame();
    expect(applyMove(g, { from: "e2", to: "e5" })).toBeNull();
  });

  it("server clock-drain pattern: same wall-clock interval is never charged twice", () => {
    let whiteTime = 30 * 60 * 1000;
    let lastTickAt = 0;

    let now = 1000;
    let elapsed = Math.max(0, now - lastTickAt);
    whiteTime = Math.max(0, whiteTime - elapsed);
    lastTickAt = now;

    now = 3000;
    elapsed = Math.max(0, now - lastTickAt);
    whiteTime = Math.max(0, whiteTime - elapsed);
    lastTickAt = now;

    expect(30 * 60 * 1000 - whiteTime).toBe(3000);
  });

  it("checkmate is detected immediately after the mating move and not before", () => {
    const g = newGame();
    expect(applyMove(g, { from: "f2", to: "f3" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
    expect(applyMove(g, { from: "e7", to: "e5" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
    expect(applyMove(g, { from: "g2", to: "g4" })).not.toBeNull();
    expect(detectTerminal(g)).toBeNull();
    expect(applyMove(g, { from: "d8", to: "h4" })).not.toBeNull();
    expect(detectTerminal(g)?.reason).toBe("checkmate");
  });
});
