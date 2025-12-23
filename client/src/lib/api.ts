export type Game = 'chess' | 'tetris' | 'checkers' | 'battleship';
export type Asset = 'USDT' | 'ETH' | 'TON';

export type FindMatchRequest = {
  game: Game;
  asset: Asset;
  stake: number;      // числом, в единицах актива
  socketId: string;   // текущий Socket.IO id клиента
};

export type FindMatchResponse =
  | { status: 'waiting' }
  | { status: 'matched'; matchId: string; players: string[] };

// If frontend and backend are on the same domain/port in dev, keep empty.
// If you proxy API elsewhere, set VITE_API_BASE in .env
const BASE = import.meta.env?.VITE_API_BASE ?? '';

// --- Single call used by the Lobby/Play screens ---
export async function findMatch(
  body: FindMatchRequest
): Promise<FindMatchResponse> {
  const res = await fetch(`${BASE}/api/find-match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`find-match failed: ${res.status}`);
  }

  const data = (await res.json()) as FindMatchResponse;
  return data;
}