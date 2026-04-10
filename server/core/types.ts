export type Game = 'chess' | 'tetris' | 'checkers' | 'battleship';
export type Asset = 'USDT' | 'ETH' | 'TON';
export type Outcome = 'win' | 'loss' | 'draw';

/** Запрос на поиск матча */
export interface FindMatchRequest {
  game: Game;
  asset: Asset;
  stake: number;      // сумма ставки в единицах актива
  socketId: string;   // socket.id клиента
}

/** Ответ на поиск матча */
export type FindMatchResponse =
  | { status: 'waiting' }
  | { status: 'matched'; matchId: string; players: string[] };

/** Сущности ниже — для очереди/матчей/результатов/сеттермента */
export interface Match {
  id: string;
  game: Game;
  asset: Asset;
  stake: number;
  createdAt: number;
  players: string[];  // socketId[]
}

export interface QueueItem {
  game: Game;
  asset: Asset;
  stake: number;
  socketId: string;
  enqueuedAt: number;
}

export interface MatchFound {
  matchId: string;
  players: string[]; // socketId[]
}

export interface ResultReport {
  matchId: string;
  by: string;        // socketId репортера
  outcome: Outcome;  // 'win' | 'loss' | 'draw'
}

export interface Settlement {
  matchId: string;
  outcome: Outcome;
  winner?: string;           // socketId
  stakePerPlayer: number;
  feePodPerUser: number;     // 1.5% при ничьей, иначе 3% с победителя (как договоримся)
  blockchainFeePerUser: number;
  payoutToWinner?: number;   // финальная выплата победителю
}