// Pure rules engine for double-six block dominoes (1v1).
// Imported by both the server (authoritative state, validation, deal) and
// the client (UI helpers, optimistic rendering). Keeping it in shared/
// guarantees the two sides agree on every legality check.

export const MAX_PIP = 6;
export const HAND_SIZE = 7;
export const INITIAL_TIME_MS = 10 * 60 * 1000;

export type PlayerRole = "p1" | "p2";
export type ChainEnd = "left" | "right";

export interface Tile {
  // a <= b is the canonical orientation. The same physical tile is always
  // identified by the same {a, b} pair regardless of which side is played
  // against the chain.
  a: number;
  b: number;
}

export interface PlacedTile {
  // The pips on this tile as it sits in the chain, reading left-to-right.
  // For a double the tile is laid perpendicular (visually) but the pips
  // displayed are the same on both sides, so left === right.
  left: number;
  right: number;
  // The player who placed it (for replay / animation).
  by: PlayerRole;
}

export interface PublicState {
  chain: PlacedTile[];
  leftEnd: number | null;
  rightEnd: number | null;
  currentTurn: PlayerRole;
  p1TileCount: number;
  p2TileCount: number;
  p1Time: number;
  p2Time: number;
  consecutivePasses: number;
  gameOver: boolean;
  winner: PlayerRole | "draw" | null;
  endReason: "played_out" | "blocked" | "timeout" | null;
}

export function generateTileSet(): Tile[] {
  const tiles: Tile[] = [];
  for (let a = 0; a <= MAX_PIP; a++) {
    for (let b = a; b <= MAX_PIP; b++) {
      tiles.push({ a, b });
    }
  }
  return tiles;
}

export function tileEquals(x: Tile, y: Tile): boolean {
  return x.a === y.a && x.b === y.b;
}

export function tilePipSum(t: Tile): number {
  return t.a + t.b;
}

export function isDouble(t: Tile): boolean {
  return t.a === t.b;
}

// Mulberry32 — small deterministic PRNG. Used so the server can re-derive
// the deal from a numeric seed if anything ever needs auditing.
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export interface Deal {
  p1Hand: Tile[];
  p2Hand: Tile[];
  boneyard: Tile[];
  seed: number;
  starter: PlayerRole;
  starterTile: Tile | null; // the tile the starter is required to lead with
}

export function dealHands(seed: number): Deal {
  const tiles = generateTileSet();
  shuffleInPlace(tiles, mulberry32(seed));
  const p1Hand = tiles.slice(0, HAND_SIZE);
  const p2Hand = tiles.slice(HAND_SIZE, HAND_SIZE * 2);
  const boneyard = tiles.slice(HAND_SIZE * 2);
  const starter = decideStarter(p1Hand, p2Hand);
  const starterTile = starter
    ? pickStarterTile(starter === "p1" ? p1Hand : p2Hand)
    : null;
  return { p1Hand, p2Hand, boneyard, seed, starter: starter || "p1", starterTile };
}

// Highest double across both hands leads. If neither hand holds a double
// the heaviest non-double leads. Tie-broken in favour of p1.
export function decideStarter(p1: Tile[], p2: Tile[]): PlayerRole | null {
  const hi = (hand: Tile[]) => {
    let bestDouble = -1;
    let bestPip = -1;
    for (const t of hand) {
      if (isDouble(t) && t.a > bestDouble) bestDouble = t.a;
      const p = tilePipSum(t);
      if (p > bestPip) bestPip = p;
    }
    return { bestDouble, bestPip };
  };
  const a = hi(p1);
  const b = hi(p2);
  if (a.bestDouble >= 0 || b.bestDouble >= 0) {
    return a.bestDouble >= b.bestDouble ? "p1" : "p2";
  }
  if (a.bestPip < 0 && b.bestPip < 0) return null;
  return a.bestPip >= b.bestPip ? "p1" : "p2";
}

export function pickStarterTile(hand: Tile[]): Tile {
  let bestDouble: Tile | null = null;
  let bestPip: Tile | null = null;
  for (const t of hand) {
    if (isDouble(t) && (!bestDouble || t.a > bestDouble.a)) bestDouble = t;
    if (!bestPip || tilePipSum(t) > tilePipSum(bestPip)) bestPip = t;
  }
  return bestDouble ?? bestPip!;
}

// Can `tile` be appended to the chain at `end`? The lead move (chain empty)
// is always legal regardless of `end`.
export function canPlayAt(tile: Tile, end: number | null): boolean {
  if (end === null) return true;
  return tile.a === end || tile.b === end;
}

export function hasLegalMove(
  hand: Tile[],
  leftEnd: number | null,
  rightEnd: number | null,
): boolean {
  if (leftEnd === null && rightEnd === null) return hand.length > 0;
  return hand.some((t) => canPlayAt(t, leftEnd) || canPlayAt(t, rightEnd));
}

// Orient a tile so that the side that touches the chain matches the end
// it's being played against, and return the new end exposed by the play.
// `chainEnd` is the pip currently exposed at that end of the chain;
// `attach` is which end of the chain we're attaching to.
export function placeTile(
  tile: Tile,
  chainEnd: number | null,
  attach: ChainEnd,
  by: PlayerRole,
): { placed: PlacedTile; newEnd: number } {
  if (chainEnd === null) {
    // Lead tile — orient as drawn (a left, b right).
    return { placed: { left: tile.a, right: tile.b, by }, newEnd: attach === "left" ? tile.a : tile.b };
  }
  // The side of the tile that matches `chainEnd` must touch the chain.
  let touching: number;
  let outward: number;
  if (tile.a === chainEnd) {
    touching = tile.a;
    outward = tile.b;
  } else if (tile.b === chainEnd) {
    touching = tile.b;
    outward = tile.a;
  } else {
    throw new Error(`tile ${tile.a}|${tile.b} cannot attach to ${chainEnd}`);
  }
  if (attach === "left") {
    // Outward goes to the new far-left, touching connects to current left.
    return { placed: { left: outward, right: touching, by }, newEnd: outward };
  }
  return { placed: { left: touching, right: outward, by }, newEnd: outward };
}

export function pipCount(hand: Tile[]): number {
  return hand.reduce((s, t) => s + tilePipSum(t), 0);
}

// Returns the winner under blocked-board rules, or null for a draw.
export function blockedWinner(p1Hand: Tile[], p2Hand: Tile[]): PlayerRole | null {
  const p1 = pipCount(p1Hand);
  const p2 = pipCount(p2Hand);
  if (p1 < p2) return "p1";
  if (p2 < p1) return "p2";
  return null;
}
