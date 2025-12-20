import { createContext, useContext } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameAction } from '@shared/protocol';

export type MatchStatus = 'waiting' | 'active' | 'paused' | 'finished';

interface PlayerState {
  connected: boolean;
}

export interface MatchState {
  matchId: string;
  status: MatchStatus;
  players: Record<string, PlayerState>;
  gameState?: Record<string, unknown>;
}

export interface MatchResult {
  status: "finished";
  reason: string;
  winner?: string;
  draw?: boolean;
}

interface EscrowPayout {
  playerId: string;
  amount: number;
}

export interface EscrowResult {
  payouts: EscrowPayout[];
  fee: number;
}

export interface GameState {
  matchId: string;
  game: string;
  status: MatchStatus;
  gameState: Record<string, unknown>;
  result?: MatchResult;
}

export interface MatchFoundData {
  matchId: string;
  game: string;
  asset: string;
  amount: number;
  players: string[];
}

export interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  matchState: MatchState | null;
  gameState: GameState | null;
  matchResult: MatchResult | null;
  escrowResult: EscrowResult | null;
  matchFound: MatchFoundData | null;
  actionRejected: string | null;
  isWaitingForServer: boolean;
  isMatchFinished: boolean;
  joinMatch: (matchId: string, playerId: string) => void;
  leaveMatch: (matchId: string, playerId: string) => void;
  sendGameAction: (action: GameAction) => void;
  findMatch: (game: string, asset: string, amount: number, playerId: string) => void;
  clearMatchFound: () => void;
  disconnect: () => void;
}

export const SocketContext = createContext<SocketContextValue | undefined>(undefined);

export function useSocket() {
  const context = useContext(SocketContext);
  if (context === undefined) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
