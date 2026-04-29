// Thin client-side wrapper around the shared dominoes rules engine.
// The server is authoritative for state — this class only exists to
// translate broadcasted public state + the player's private hand into
// React-friendly snapshots, and to surface a few derived helpers (legal
// move test, sorted hand, etc.) that the UI needs.

import {
  canPlayAt,
  hasLegalMove,
  type ChainEnd,
  type PlacedTile,
  type PlayerRole,
  type Tile,
} from "@shared/games/dominoes";

export interface DominoesPublicState {
  chain: PlacedTile[];
  leftEnd: number | null;
  rightEnd: number | null;
  currentTurn: PlayerRole;
  p1TileCount: number;
  p2TileCount: number;
  p1Time: number;
  p2Time: number;
  consecutivePasses: number;
}

export interface DominoesViewState {
  role: PlayerRole;
  hand: Tile[];
  publicState: DominoesPublicState;
  myTurn: boolean;
  mustPass: boolean;
  // Per-tile playability for the active end choice — index aligns with `hand`.
  playableLeft: boolean[];
  playableRight: boolean[];
}

export type DominoesListener = (state: DominoesViewState) => void;

export class DominoesClientEngine {
  private role: PlayerRole | null = null;
  private hand: Tile[] = [];
  private publicState: DominoesPublicState | null = null;
  private starterTile: Tile | null = null;
  private listeners = new Set<DominoesListener>();

  subscribe(fn: DominoesListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setStart(role: PlayerRole, hand: Tile[], publicState: DominoesPublicState) {
    this.role = role;
    this.hand = sortHand(hand);
    this.publicState = publicState;
    this.emit();
  }

  // Records the tile the starter MUST lead with. While this is still set
  // and the chain is empty, the view restricts playable tiles to ONLY the
  // starter tile so the UI matches the rule the server will enforce.
  setStarterTile(tile: Tile | null) {
    this.starterTile = tile;
    this.emit();
  }

  applyPublicState(publicState: DominoesPublicState) {
    this.publicState = publicState;
    // Once any tile has been laid, the starter requirement is gone.
    if (publicState.chain.length > 0) this.starterTile = null;
    this.emit();
  }

  // Replace local hand + public state with the server's authoritative
  // snapshot. Used when the server rejects a move (and emits resync) so
  // our optimistic mutation rolls back.
  applyResync(hand: Tile[], publicState: DominoesPublicState) {
    this.hand = sortHand(hand);
    this.publicState = publicState;
    if (publicState.chain.length > 0) this.starterTile = null;
    this.emit();
  }

  // Called when *we* play a tile — server has already validated it. We
  // remove the tile from our local hand so the UI updates immediately
  // instead of waiting for the broadcast round-trip.
  removeTile(idx: number) {
    if (idx >= 0 && idx < this.hand.length) {
      this.hand = [...this.hand.slice(0, idx), ...this.hand.slice(idx + 1)];
      this.emit();
    }
  }

  getRole(): PlayerRole | null {
    return this.role;
  }

  getView(): DominoesViewState | null {
    if (!this.role || !this.publicState) return null;
    const ps = this.publicState;
    const myTurn = ps.currentTurn === this.role;
    const isLead = ps.chain.length === 0;
    const starter = this.starterTile;
    // On the lead move, only the mandated starter tile is playable; on any
    // subsequent move, normal end-matching applies.
    const isStarterIdx = (i: number): boolean => {
      if (!isLead || !starter) return true;
      const t = this.hand[i];
      return t.a === starter.a && t.b === starter.b;
    };
    const playableLeft = this.hand.map((t, i) =>
      isStarterIdx(i) && canPlayAt(t, ps.leftEnd),
    );
    const playableRight = this.hand.map((t, i) =>
      isStarterIdx(i) && canPlayAt(t, ps.rightEnd),
    );
    const mustPass =
      myTurn &&
      !isLead &&
      !hasLegalMove(this.hand, ps.leftEnd, ps.rightEnd);
    return {
      role: this.role,
      hand: this.hand,
      publicState: ps,
      myTurn,
      mustPass,
      playableLeft,
      playableRight,
    };
  }

  private emit() {
    const view = this.getView();
    if (!view) return;
    for (const fn of this.listeners) fn(view);
  }
}

// Sort a hand so doubles come first (largest first), then non-doubles by
// pip sum descending. This matches how players typically arrange tiles
// in their rack.
function sortHand(hand: Tile[]): Tile[] {
  return [...hand].sort((x, y) => {
    const xd = x.a === x.b ? 1 : 0;
    const yd = y.a === y.b ? 1 : 0;
    if (xd !== yd) return yd - xd;
    const xs = x.a + x.b;
    const ys = y.a + y.b;
    if (xs !== ys) return ys - xs;
    return y.a - x.a;
  });
}

export type { ChainEnd, PlacedTile, PlayerRole, Tile };
