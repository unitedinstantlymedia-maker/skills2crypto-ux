export type Game = 'chess' | 'tetris' | 'checkers' | 'battleship' | 'dominoes';
export type Asset = 'USDT' | 'ETH' | 'BNB' | 'TON';

export type FindMatchRequest = {
  game: Game;
  asset: Asset;
  stake: number;
  socketId: string;
  walletAddress: string;
};

export type FindMatchResponse =
  | { status: 'waiting' }
  | { status: 'matched'; matchId: string; players: string[] };

/**
 * Centralized API base. Set VITE_API_BASE in client/.env (or Netlify env)
 * when frontend and backend live on different hosts (Netlify + Railway).
 * Leave empty in local Replit dev — Express serves both.
 *
 * Trailing slashes are stripped so callers can always pass a leading "/".
 */
function rawBase(): string {
  const v = (import.meta.env?.VITE_API_BASE ?? '').trim();
  return v.replace(/\/+$/, '');
}

export const API_BASE = rawBase();

/** Builds a fully-qualified API URL from a leading-slash path. */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) path = '/' + path;
  return `${API_BASE}${path}`;
}

/**
 * Socket.IO base URL. Empty string means same-origin (default).
 * When VITE_API_BASE is set we hand its origin to socket.io-client.
 */
export function socketUrl(): string {
  return API_BASE || '/';
}

export async function findMatch(
  body: FindMatchRequest
): Promise<FindMatchResponse> {
  const res = await fetch(apiUrl('/api/find-match'), {
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
