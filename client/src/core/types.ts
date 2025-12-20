// Core types for the application

export type Asset = 'USDT' | 'ETH' | 'TON';
export type Game = 'Chess' | 'Tetris' | 'Checkers' | 'Battleship';
export type MatchStatus = 'finding' | 'active' | 'finished' | 'cancelled';
export type MatchResult = 'win' | 'loss' | 'draw';

export interface WalletState {
  connected: boolean;
  address: string | null;
  balances: Record<Asset, number>;
}

export interface MatchParams {
  game: Game;
  asset: Asset;
  stake: number; // float amount
}

export interface Match {
  id: string;
  game: Game;
  asset: Asset;
  stake: number;
  status: MatchStatus;
  players: [string, string?]; // [player1, player2]
  startTime?: number;
  result?: MatchResult;
  payout?: number;
  fee?: number;
}

export interface HistoryEntry {
  id: string;
  game: Game;
  asset: Asset;
  stake: number;
  result: MatchResult;
  pot: number;
  fee: number;
  payout: number;
  timestamp: number;
}

// Helper to generate canonical queue key
export function getQueueKey(game: Game, asset: Asset, stake: number): string {
  return `${game}:${asset}:${Number(stake).toFixed(2)}`;
}
