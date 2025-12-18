import type { GameAdapter } from "./types";
import { chessAdapter } from "./chess";

const adapters = new Map<string, GameAdapter<unknown, unknown>>();

adapters.set("chess", chessAdapter as GameAdapter<unknown, unknown>);

export function getAdapter(gameType: string): GameAdapter<unknown, unknown> | undefined {
  return adapters.get(gameType);
}

export function registerAdapter(adapter: GameAdapter<unknown, unknown>): void {
  adapters.set(adapter.gameType, adapter);
}
