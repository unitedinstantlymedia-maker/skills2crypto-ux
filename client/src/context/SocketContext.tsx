import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import type { GameAction } from '@shared/protocol';

export type MatchStatus = 'waiting' | 'active' | 'paused' | 'finished';

interface PlayerState {
  connected: boolean;
}

interface MatchState {
  matchId: string;
  status: MatchStatus;
  players: Record<string, PlayerState>;
  gameState?: Record<string, unknown>;
}

interface MatchResult {
  status: "finished";
  reason: string;
  winner?: string;
  draw?: boolean;
}

interface EscrowPayout {
  playerId: string;
  amount: number;
}

interface EscrowResult {
  payouts: EscrowPayout[];
  fee: number;
}

interface GameState {
  matchId: string;
  game: string;
  status: MatchStatus;
  gameState: Record<string, unknown>;
  result?: MatchResult;
}

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  matchState: MatchState | null;
  gameState: GameState | null;
  matchResult: MatchResult | null;
  escrowResult: EscrowResult | null;
  actionRejected: string | null;
  isWaitingForServer: boolean;
  isMatchFinished: boolean;
  joinMatch: (matchId: string, playerId: string) => void;
  leaveMatch: (matchId: string, playerId: string) => void;
  sendGameAction: (action: GameAction) => void;
  disconnect: () => void;
}

const SocketContext = createContext<SocketContextValue | undefined>(undefined);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [matchState, setMatchState] = useState<MatchState | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [escrowResult, setEscrowResult] = useState<EscrowResult | null>(null);
  const [actionRejected, setActionRejected] = useState<string | null>(null);
  const [isWaitingForServer, setIsWaitingForServer] = useState(false);
  const [isMatchFinished, setIsMatchFinished] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return socketRef.current;

    const newSocket = io({
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });

    newSocket.on('connect', () => {
      console.log('[Socket] Connected:', newSocket.id);
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('[Socket] Disconnected');
      setIsConnected(false);
    });

    newSocket.on('match_state', (data: MatchState) => {
      console.log('[Socket] match_state received:', data);
      setMatchState(data);
    });

    newSocket.on('game_state', (data: GameState) => {
      console.log('[Socket] game_state received:', data);
      setGameState(data);
      setIsWaitingForServer(false);
      setActionRejected(null);
      if (data.result?.status === "finished") {
        setMatchResult(data.result);
        setIsMatchFinished(true);
      }
    });

    newSocket.on('action_rejected', (data: { reason: string }) => {
      console.log('[Socket] action_rejected:', data.reason);
      setActionRejected(data.reason);
      setIsWaitingForServer(false);
    });

    newSocket.on('match_finished', (data: MatchResult) => {
      console.log('[Socket] match_finished received:', data);
      setMatchResult(data);
      setIsMatchFinished(true);
      setIsWaitingForServer(false);
    });

    newSocket.on('match_found', (data: { matchId: string; game: string; players: string[] }) => {
      console.log('[Socket] match_found received:', data);
    });

    newSocket.on('escrow_result', (data: EscrowResult) => {
      console.log('[Socket] escrow_result received:', data);
      setEscrowResult(data);
    });

    newSocket.on('error', (error: { message: string }) => {
      console.error('[Socket] Error:', error.message);
    });

    socketRef.current = newSocket;
    setSocket(newSocket);
    return newSocket;
  }, []);

  const joinMatch = useCallback((matchId: string, playerId: string) => {
    const sock = connect();
    if (sock) {
      console.log(`[Socket] Joining match ${matchId} as ${playerId}`);
      sock.emit('join_match', { matchId, playerId });
    }
  }, [connect]);

  const leaveMatch = useCallback((matchId: string, playerId: string) => {
    if (socketRef.current) {
      console.log(`[Socket] Leaving match ${matchId}`);
      socketRef.current.emit('leave_match', { matchId, playerId });
    }
  }, []);

  const sendGameAction = useCallback((action: GameAction) => {
    if (isMatchFinished) {
      console.log('[Socket] Cannot send action - match is finished');
      return;
    }
    const sock = connect();
    if (sock) {
      console.log(`[Socket] Sending game_action:`, action);
      setIsWaitingForServer(true);
      setActionRejected(null);
      sock.emit('game_action', action);
    }
  }, [connect, isMatchFinished]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setSocket(null);
      setIsConnected(false);
      setMatchState(null);
      setGameState(null);
      setMatchResult(null);
      setEscrowResult(null);
      setActionRejected(null);
      setIsWaitingForServer(false);
      setIsMatchFinished(false);
    }
  }, []);

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        matchState,
        gameState,
        matchResult,
        escrowResult,
        actionRejected,
        isWaitingForServer,
        isMatchFinished,
        joinMatch,
        leaveMatch,
        sendGameAction,
        disconnect,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  if (context === undefined) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
