import { describe, it, expect } from "vitest";
import {
  HAND_SIZE,
  blockedWinner,
  canPlayAt,
  dealHands,
  decideStarter,
  generateTileSet,
  hasLegalMove,
  isDouble,
  mulberry32,
  pickStarterTile,
  pipCount,
  placeTile,
  shuffleInPlace,
  tileEquals,
  tilePipSum,
  type Tile,
} from "../shared/games/dominoes";

describe("dominoes engine", () => {
  it("generates exactly 28 unique double-six tiles", () => {
    const tiles = generateTileSet();
    expect(tiles.length).toBe(28);
    const seen = new Set<string>();
    for (const t of tiles) {
      expect(t.a).toBeLessThanOrEqual(t.b);
      const k = `${t.a},${t.b}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    // 7 doubles
    expect(tiles.filter(isDouble).length).toBe(7);
  });

  it("deals 7 + 7 + 14 deterministically from a seed", () => {
    const a = dealHands(12345);
    const b = dealHands(12345);
    expect(a.p1Hand.length).toBe(HAND_SIZE);
    expect(a.p2Hand.length).toBe(HAND_SIZE);
    expect(a.boneyard.length).toBe(28 - HAND_SIZE * 2);
    // identical reproducible deals
    expect(a.p1Hand.map((t) => `${t.a}${t.b}`).join()).toBe(
      b.p1Hand.map((t) => `${t.a}${t.b}`).join(),
    );
    // every tile accounted for exactly once
    const all = [...a.p1Hand, ...a.p2Hand, ...a.boneyard];
    expect(all.length).toBe(28);
    const seen = new Set(all.map((t) => `${t.a},${t.b}`));
    expect(seen.size).toBe(28);
  });

  it("decides starter as the side holding the highest double", () => {
    const p1: Tile[] = [
      { a: 6, b: 6 },
      { a: 0, b: 1 },
      { a: 2, b: 3 },
      { a: 1, b: 4 },
      { a: 0, b: 5 },
      { a: 1, b: 6 },
      { a: 0, b: 0 },
    ];
    const p2: Tile[] = [
      { a: 5, b: 5 },
      { a: 4, b: 4 },
      { a: 3, b: 3 },
      { a: 0, b: 2 },
      { a: 0, b: 3 },
      { a: 0, b: 4 },
      { a: 0, b: 6 },
    ];
    expect(decideStarter(p1, p2)).toBe("p1");
    const starterTile = pickStarterTile(p1);
    expect(starterTile.a).toBe(6);
    expect(starterTile.b).toBe(6);
  });

  it("falls back to heaviest tile when no doubles exist in either hand", () => {
    const p1: Tile[] = [
      { a: 1, b: 4 },
      { a: 0, b: 5 },
      { a: 2, b: 3 },
      { a: 0, b: 1 },
    ];
    const p2: Tile[] = [
      { a: 5, b: 6 }, // pip sum 11 — heaviest
      { a: 0, b: 2 },
      { a: 1, b: 3 },
    ];
    expect(decideStarter(p1, p2)).toBe("p2");
    expect(tileEquals(pickStarterTile(p2), { a: 5, b: 6 })).toBe(true);
  });

  it("canPlayAt and hasLegalMove behave correctly", () => {
    const hand: Tile[] = [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ];
    expect(canPlayAt(hand[0], null)).toBe(true);
    expect(canPlayAt(hand[0], 5)).toBe(false);
    expect(canPlayAt(hand[0], 2)).toBe(true);
    expect(hasLegalMove(hand, 5, 6)).toBe(false);
    expect(hasLegalMove(hand, 5, 4)).toBe(true);
  });

  it("placeTile orients the tile so the matching pip touches the chain", () => {
    // Lead with 6|6, exposes 6 on both ends.
    const lead = placeTile({ a: 6, b: 6 }, null, "right", "p1");
    expect(lead.placed.left).toBe(6);
    expect(lead.placed.right).toBe(6);
    expect(lead.newEnd).toBe(6);

    // Append 5|6 on the right — touching 6 stays inside, 5 becomes the new end.
    const r = placeTile({ a: 5, b: 6 }, 6, "right", "p2");
    expect(r.placed.left).toBe(6);
    expect(r.placed.right).toBe(5);
    expect(r.newEnd).toBe(5);

    // Append 6|2 on the left — touching 6 stays inside (right of placed), 2 becomes new end.
    const l = placeTile({ a: 6, b: 2 }, 6, "left", "p1");
    expect(l.placed.right).toBe(6);
    expect(l.placed.left).toBe(2);
    expect(l.newEnd).toBe(2);
  });

  it("placeTile throws when the tile cannot legally attach", () => {
    expect(() => placeTile({ a: 1, b: 2 }, 5, "right", "p1")).toThrow();
  });

  it("blockedWinner picks the lower pip count and returns null on a tie", () => {
    expect(blockedWinner([{ a: 0, b: 0 }], [{ a: 6, b: 6 }])).toBe("p1");
    expect(blockedWinner([{ a: 6, b: 6 }], [{ a: 0, b: 0 }])).toBe("p2");
    expect(blockedWinner([{ a: 3, b: 3 }], [{ a: 2, b: 4 }])).toBeNull();
    expect(pipCount([{ a: 1, b: 2 }, { a: 3, b: 4 }])).toBe(10);
  });

  it("mulberry32 is reproducible and shuffleInPlace is in-place", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 5; i++) expect(r1()).toBe(r2());
    const arr = [1, 2, 3, 4, 5];
    const ref = arr;
    const out = shuffleInPlace(arr, mulberry32(7));
    expect(out).toBe(ref); // same reference
    expect(out.slice().sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
