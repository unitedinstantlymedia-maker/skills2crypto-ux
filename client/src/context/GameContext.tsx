import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';

import { walletAdapter } from '@/core/wallet/WalletAdapter';
import { walletStore } from '@/core/wallet/WalletStore';
import { mockEscrowAdapter } from '@/core/escrow/MockEscrowAdapter';
import { historyStore } from '@/core/history/HistoryStore';
import type { WalletState, HistoryEntry } from '@/core/types';

// типы и API-клиент
import { findMatch } from '@/lib/api';
import type { Game, Asset } from '@/lib/api';

type MatchState =
  | null
  | {
      id: string;
      game: Game;
      asset: Asset;
      stake: number;
      status: 'waiting' | 'active' | 'finished';
      players?: string[];
      result?: 'win' | 'loss' | 'draw';
      payout?: number;
      fee?: number;
    };

interface GameContextValue {
  state: {
    selectedGame: Game | null;
    selectedAsset: Asset;
    stakeAmount: number;
    wallet: WalletState;
    currentMatch: MatchState;
    history: HistoryEntry[];
    isFinding: boolean;
  };
  actions: {
    connectWallet: () => Promise<void>;
    selectGame: (g: Game) => void;
    selectAsset: (a: Asset) => void;
    setStake: (n: number) => void;
    startSearch: () => Promise<void>;
    cancelSearch: () => void;
    finishMatch: (r: 'win' | 'loss' | 'draw') => Promise<void>;
  };
  dispatch: React.Dispatch<any>; // совместимость со старым кодом
}

const Ctx = createContext<GameContextValue | undefined>(undefined);

export function GameProvider({ children }: { children: React.ReactNode }) {
  // ------- state
  const [walletState, setWalletState] = useState<WalletState>(walletStore.getState());
  const [selectedGame, setSelectedGame] = useState<Game | null>(() => {
    const s = localStorage.getItem('skills2crypto_selected_game');
    return s ? (s as Game) : null;
  });
  const [selectedAsset, setSelectedAsset] = useState<Asset>('USDT');
  const [stakeAmount, setStakeAmount] = useState<number>(20);
  const [currentMatch, setCurrentMatch] = useState<MatchState>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isFinding, setIsFinding] = useState(false);

  // ------- socket
  const socketRef = useRef<Socket | null>(null);

  // создаём/храним одно подключение
  useEffect(() => {
    const s = io('/', {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 10000,
      autoConnect: true,
      withCredentials: true
    });
    socketRef.current = s;

    s.on('connect', () => {
      console.log('[socket] connected', s.id);
    });

    s.on('connect_error', (err) => {
      console.warn('[socket] connect_error', err?.message);
    });

    s.on('reconnect_attempt', (n) => {
      console.log('[socket] reconnect_attempt', n);
    });

    s.on('reconnect', (n) => {
      console.log('[socket] reconnected', n);
    });

    s.on('reconnect_failed', () => {
      console.error('[socket] reconnect_failed');
    });

    // прилетел матч для нас
    s.on('match-found', (payload: { matchId: string }) => {
      if (!isFinding || !selectedGame) return;
      console.log('[socket] match-found', payload);

      setIsFinding(false);
      // фиксируем активный матч
      setCurrentMatch((prev) => ({
        id: payload.matchId,
        game: selectedGame,
        asset: selectedAsset,
        stake: stakeAmount,
        status: 'active',
      }));

      // блокируем средства
      void mockEscrowAdapter
        .lockFunds(payload.matchId, selectedAsset, stakeAmount)
        .catch((e) => console.error('lockFunds failed', e));
    });

    s.on('disconnect', (reason) => {
      console.log('[socket] disconnected', reason);
    });

    return () => {
      s.removeAllListeners();
      s.close();
      socketRef.current = null;
    };
  }, [isFinding, selectedGame, selectedAsset, stakeAmount]);

  // ------- persistence
  useEffect(() => {
    if (selectedGame) localStorage.setItem('skills2crypto_selected_game', selectedGame);
  }, [selectedGame]);

  // ------- wallet subscribe
  useEffect(() => walletStore.subscribe(setWalletState), []);

  // ------- fetch history when wallet connects
  useEffect(() => {
    if (walletState.address) {
      historyStore.fetchHistory(walletState.address).then(setHistory);
    }
  }, [walletState.address]);

  const connectWallet = async () => {
    await walletAdapter.connect();
  };

  const startSearch = async () => {
    if (!selectedGame) {
      console.warn('[GameContext] game not selected');
      return;
    }
    if (!walletState.address) {
      console.warn('[GameContext] wallet not connected');
      return;
    }
    const sock = socketRef.current;
    if (!sock || !sock.id) {
      console.warn('[GameContext] socket not ready');
      return;
    }

    // можно показать предупреждение о балансе, но не блокируем прототип
    const netFee = mockEscrowAdapter.getEstimatedNetworkFee(selectedAsset);
    const required = stakeAmount + netFee;
    if (!walletAdapter.canAfford(selectedAsset, required)) {
      console.warn('[GameContext] low balance (allowed to proceed in prototype)');
    }

    setIsFinding(true);
    setCurrentMatch({
      id: 'pending',
      game: selectedGame,
      asset: selectedAsset,
      stake: stakeAmount,
      status: 'waiting',
    });

    try {
      const res = await findMatch({
        game: selectedGame,
        asset: selectedAsset,
        stake: stakeAmount,
        socketId: sock.id,
      });

      if (res.status === 'matched') {
        // мгновенно нашли — активируем
        setIsFinding(false);
        setCurrentMatch({
          id: res.matchId,
          game: selectedGame,
          asset: selectedAsset,
          stake: stakeAmount,
          status: 'active',
          players: res.players,
        });

        // присоединяемся к комнате и блокируем средства
        sock.emit('join-match', res.matchId);
        await mockEscrowAdapter.lockFunds(res.matchId, selectedAsset, stakeAmount);
      } else {
        // waiting — ждём событие match-found
        console.log('[GameContext] queued, waiting for match-found');
      }
    } catch (e) {
      console.error('findMatch failed', e);
      setIsFinding(false);
      setCurrentMatch(null);
    }
  };

  const cancelSearch = () => {
    setIsFinding(false);
    // на сервере явного cancel нет — достаточно убрать локальный флаг ожидания
    if (currentMatch?.status === 'waiting') {
      setCurrentMatch(null);
    }
  };

  const finishMatch = async (result: 'win' | 'loss' | 'draw') => {
    if (!currentMatch) return;

    const { payout, fee } = await mockEscrowAdapter.settleMatch(
      currentMatch.id,
      currentMatch.asset,
      currentMatch.stake,
      result
    );

    const safePayout = Number(payout);
    const safeFee = Number(fee);

    setCurrentMatch({
      ...currentMatch,
      status: 'finished',
      result,
      payout: safePayout,
      fee: safeFee,
    });

    if (walletState.address) {
      historyStore.invalidateCache();
      historyStore.fetchHistory(walletState.address).then(setHistory);
    }
  };

  const value = useMemo<GameContextValue>(
    () => ({
      state: {
        selectedGame,
        selectedAsset,
        stakeAmount,
        wallet: walletState,
        currentMatch,
        history,
        isFinding,
      },
      actions: {
        connectWallet,
        selectGame: setSelectedGame,
        selectAsset: setSelectedAsset,
        setStake: (n: number) => setStakeAmount(n),
        startSearch,
        cancelSearch,
        finishMatch,
      },
      dispatch: () => {},
    }),
    [selectedGame, selectedAsset, stakeAmount, walletState, currentMatch, history, isFinding]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}