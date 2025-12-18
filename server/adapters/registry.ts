import type { GameAdapter } from "./types";
import { chessAdapter } from "./chess";
import { tetrisAdapter } from "./tetris";
import { checkersAdapter } from "./checkers";
import { battleshipAdapter } from "./battleship";

const adapters = new Map<string, GameAdapter<unknown, unknown>>();

adapters.set("chess", chessAdapter as GameAdapter<unknown, unknown>);
adapters.set("tetris", tetrisAdapter as GameAdapter<unknown, unknown>);
adapters.set("checkers", checkersAdapter as GameAdapter<unknown, unknown>);
adapters.set("battleship", battleshipAdapter as GameAdapter<unknown, unknown>);

export function getAdapter(gameType: string): GameAdapter<unknown, unknown> | undefined {
  return adapters.get(gameType.toLowerCase());
}

export function registerAdapter(adapter: GameAdapter<unknown, unknown>): void {
  adapters.set(adapter.gameType.toLowerCase(), adapter);
}

export function getAvailableGames(): string[] {
  return Array.from(adapters.keys());
}
