import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

export type MatchStatus = 'waiting' | 'active' | 'paused' | 'finished';

interface PlayerState {
  connected: boolean;
}

interface MatchState {
  matchId: string;
  status: MatchStatus;
  players: Record<string, PlayerState>;
}

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  matchState: MatchState | null;
  joinMatch: (matchId: string, playerId: string) => void;
  leaveMatch: (matchId: string, playerId: string) => void;
  disconnect: () => void;
}

const SocketContext = createContext<SocketContextValue | undefined>(undefined);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [matchState, setMatchState] = useState<MatchState | null>(null);
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

    newSocket.on('match_found', (data: { matchId: string; game: string; players: string[] }) => {
      console.log('[Socket] match_found received:', data);
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

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setSocket(null);
      setIsConnected(false);
      setMatchState(null);
    }
  }, []);

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        matchState,
        joinMatch,
        leaveMatch,
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
