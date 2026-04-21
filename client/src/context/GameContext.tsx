import React, { createContext, useContext, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

import { walletAdapter } from '@/core/wallet/WalletAdapter';
import { walletStore } from '@/core/wallet/WalletStore';
import { escrowAdapter } from '@/core/escrow';
import { ensureTronUsdtReadyForStake } from '@/core/escrow/TronEscrowAdapter';
import { ensureTonReadyForStake } from '@/core/escrow/TonEscrowAdapter';
import { historyStore } from '@/core/history/HistoryStore';
import { useRealWallet } from '@/core/wallet/WalletProvider';
import type { WalletState, HistoryEntry } from '@/core/types';

import { findMatch } from '@/lib/api';
import type { Game, Asset } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

type MatchState =
  | null
  | {
      id: string;
      game: Game;
      asset: Asset;
      stake: number;
      status: 'waiting' | 'funding' | 'active' | 'finished';
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
  socket: Socket | null;
  dispatch: React.Dispatch<any>;
}

const Ctx = createContext<GameContextValue | undefined>(undefined);

export function GameProvider({ children }: { children: React.ReactNode }) {
  const realWallet = useRealWallet();
  const { toast } = useToast();
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

  const isFindingRef = useRef(isFinding);
  const selectedGameRef = useRef(selectedGame);
  const selectedAssetRef = useRef(selectedAsset);
  const stakeAmountRef = useRef(stakeAmount);
  // realWalletRef always carries the latest per-chain wallet addresses so the
  // socket `match-found` handler (registered once on mount) can read them at
  // event time. Without this, the closure would hold the empty wallet object
  // from initial mount — causing join-match to emit playerId='' for users
  // who connect their wallet after the GameProvider mounts.
  const realWalletRef = useRef(realWallet);

  useEffect(() => { isFindingRef.current = isFinding; }, [isFinding]);
  useEffect(() => { selectedGameRef.current = selectedGame; }, [selectedGame]);
  useEffect(() => { selectedAssetRef.current = selectedAsset; }, [selectedAsset]);
  useEffect(() => { stakeAmountRef.current = stakeAmount; }, [stakeAmount]);
  useEffect(() => { realWalletRef.current = realWallet; }, [realWallet]);

  const socketRef = useRef<Socket | null>(null);
  // Tracks matchIds for which a deposit attempt is already in flight, so
  // the HTTP `matched` response and a duplicate `match-found` socket emit
  // never trigger lockFunds() twice for the same match.
  const depositInFlightRef = useRef<Set<string>>(new Set());
  // Tracks matchIds for which THIS client's own deposit failed (so the
  // subsequent server-broadcast `match-cancelled` does not double-toast
  // the failing user). Both players have the match in `depositInFlight`,
  // so that flag alone is not sufficient to distinguish self vs opponent.
  const selfDepositFailedRef = useRef<Set<string>>(new Set());
  const [socketInstance, setSocketInstance] = useState<Socket | null>(null);

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
    setSocketInstance(s);

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

    s.on('match-found', (payload: { matchId: string }) => {
      const game = selectedGameRef.current;
      const asset = selectedAssetRef.current;
      const stake = stakeAmountRef.current;

      if (!isFindingRef.current || !game) {
        console.warn('[socket] match-found ignored (not searching)', payload);
        return;
      }
      // Guard against the dual codepath: if startSearch() already handled
      // an immediate `matched` response for this matchId, the HTTP path has
      // already invoked lockFunds() and we must not invoke it again here.
      if (depositInFlightRef.current.has(payload.matchId)) {
        console.log('[socket] match-found ignored — deposit already in flight', payload);
        return;
      }
      console.log('[socket] match-found', payload);

      isFindingRef.current = false;
      setIsFinding(false);
      setCurrentMatch({
        id: payload.matchId,
        game,
        asset,
        stake,
        status: 'funding',
      });

      // Use the asset-appropriate wallet address as the playerId so the server
      // and on-chain settlement reference the same chain identity. Read from
      // the ref (not the closure) so this is correct even when the user
      // connected their wallet after the GameProvider mounted.
      const rw = realWalletRef.current;
      const pid =
        asset === 'BNB' || asset === 'ETH'
          ? rw.evmAddress || ''
          : asset === 'USDT'
          ? rw.tronAddress || ''
          : asset === 'TON'
          ? rw.tonAddress || ''
          : walletStore.getState().address || '';
      if (!pid) {
        console.warn(`[socket] cannot join-match for ${asset}: no wallet connected for that chain`);
      }
      s.emit('join-match', { matchId: payload.matchId, playerId: pid });

      depositInFlightRef.current.add(payload.matchId);
      // Blocking deposit: if it fails, tell the server to cancel the match
      // and notify the opponent. The user is held in `funding` state until
      // either the on-chain deposit confirms (server emits `match-funded`)
      // or this path fails and we surface the error.
      (async () => {
        let ok = false;
        let errMsg: string | null = null;
        try {
          ok = await escrowAdapter.lockFunds(payload.matchId, asset, stake);
        } catch (e: any) {
          errMsg = e?.message || String(e);
          console.error('[GameContext] lockFunds failed (socket path):', errMsg);
        }
        if (!ok) {
          depositInFlightRef.current.delete(payload.matchId);
          selfDepositFailedRef.current.add(payload.matchId);
          s.emit('deposit-failed', {
            matchId: payload.matchId,
            playerId: realWalletRef.current.evmAddress
              || realWalletRef.current.tronAddress
              || realWalletRef.current.tonAddress
              || '',
            reason: errMsg || 'deposit_failed',
          });
          setCurrentMatch(null);
          toast({
            title: 'Deposit failed',
            description: errMsg
              ? `On-chain deposit could not complete: ${errMsg}`
              : 'On-chain deposit could not complete. Match cancelled.',
            variant: 'destructive',
          });
        }
      })();
    });

    // Spec-aligned mirror of `match-cancelled` — both events are broadcast
    // by the server when a deposit fails so any client listening on either
    // contract behaves identically.
    s.on('deposit-failed', (payload: { matchId: string; reason?: string }) => {
      console.log('[socket] deposit-failed (server)', payload);
      depositInFlightRef.current.delete(payload.matchId);
      isFindingRef.current = false;
      setIsFinding(false);
      setCurrentMatch((prev) => {
        if (!prev || (prev.id !== payload.matchId && prev.id !== 'pending')) return prev;
        return null;
      });
    });

    s.on('match-cancelled', (payload: { matchId: string; reason?: string }) => {
      console.log('[socket] match-cancelled', payload);
      const wasSelfFailure = selfDepositFailedRef.current.has(payload.matchId);
      selfDepositFailedRef.current.delete(payload.matchId);
      depositInFlightRef.current.delete(payload.matchId);
      isFindingRef.current = false;
      setIsFinding(false);
      setCurrentMatch((prev) => {
        if (!prev || (prev.id !== payload.matchId && prev.id !== 'pending')) return prev;
        return null;
      });
      // Suppress the duplicate cancellation toast ONLY for the client whose
      // own deposit just failed (they already got the specific "Deposit
      // failed" toast). The opponent — whose deposit may have succeeded
      // or never been attempted — must always be told why the match died.
      if (wasSelfFailure) return;
      toast({
        title: 'Match cancelled',
        description:
          payload.reason === 'opponent_deposit_failed' || payload.reason === 'deposit_failed'
            ? 'Your opponent could not complete the on-chain deposit. Returning to lobby.'
            : 'Match cancelled. Returning to lobby.',
        variant: 'destructive',
      });
    });

    s.on('match-funded', (payload: { matchId: string }) => {
      console.log('[socket] match-funded', payload);
      setCurrentMatch((prev) => {
        if (!prev || prev.id !== payload.matchId) return prev;
        if (prev.status !== 'funding') return prev;
        return { ...prev, status: 'active' };
      });
    });

    s.on('disconnect', (reason) => {
      console.log('[socket] disconnected', reason);
    });

    return () => {
      s.removeAllListeners();
      s.close();
      socketRef.current = null;
    };
  }, []);

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
    const event = new CustomEvent('skills2crypto:open-connect-dialog');
    window.dispatchEvent(event);
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
    const netFee = escrowAdapter.getEstimatedNetworkFee(selectedAsset);
    const required = stakeAmount + netFee;
    if (!walletAdapter.canAfford(selectedAsset, required)) {
      console.warn('[GameContext] low balance (allowed to proceed in prototype)');
    }

    isFindingRef.current = true;
    setIsFinding(true);
    setCurrentMatch({
      id: 'pending',
      game: selectedGame,
      asset: selectedAsset,
      stake: stakeAmount,
      status: 'waiting',
    });

    try {
      // Pick the wallet address that matches the asset's chain. The primary
      // walletState.address may be the EVM one even when USDT/TON wallets are
      // also connected, so we route per-asset to avoid sending mismatched IDs.
      const assetWalletAddress = (() => {
        if (selectedAsset === 'BNB' || selectedAsset === 'ETH') return realWallet.evmAddress || '';
        if (selectedAsset === 'USDT') return realWallet.tronAddress || '';
        if (selectedAsset === 'TON') return realWallet.tonAddress || '';
        return walletState.address || '';
      })();

      if (!assetWalletAddress) {
        console.warn(`[GameContext] no ${selectedAsset} wallet connected`);
        setIsFinding(false);
        setCurrentMatch(null);
        return;
      }

      // Pre-flight for USDT/Tron: ensure the player has approved the escrow
      // (prompts TronLink approve + auto-sponsors TRX if needed). This makes
      // the eventual /api/find-match call pass the server-side allowance
      // gate so we don't queue a player who can't actually fund.
      if (selectedAsset === 'USDT') {
        try {
          await ensureTronUsdtReadyForStake(stakeAmount);
        } catch (e: any) {
          console.error('[GameContext] USDT readiness failed:', e?.message || e);
          setIsFinding(false);
          setCurrentMatch(null);
          return;
        }
      }

      // TON pre-flight: confirm a TonConnect wallet is connected and that the
      // wallet has enough TON to cover the stake + on-chain gas reserve. The
      // server independently re-checks this in /api/find-match, but doing it
      // client-side first lets us surface the error immediately instead of
      // showing a queued / waiting state that would just bounce.
      if (selectedAsset === 'TON') {
        try {
          await ensureTonReadyForStake(stakeAmount);
        } catch (e: any) {
          console.error('[GameContext] TON readiness failed:', e?.message || e);
          setIsFinding(false);
          setCurrentMatch(null);
          return;
        }
      }

      const res = await findMatch({
        game: selectedGame,
        asset: selectedAsset,
        stake: stakeAmount,
        socketId: sock.id,
        walletAddress: assetWalletAddress,
      });

      if (res.status === 'matched') {
        // Immediate match — go to `funding` state and wait for the
        // `match-funded` socket event before activating gameplay.
        // Mark the matchId as in-flight BEFORE awaiting lockFunds so any
        // server-emitted `match-found` for the same matchId is ignored
        // by the socket handler above (single deposit attempt per match).
        depositInFlightRef.current.add(res.matchId);
        isFindingRef.current = false;
        setIsFinding(false);
        setCurrentMatch({
          id: res.matchId,
          game: selectedGame,
          asset: selectedAsset,
          stake: stakeAmount,
          status: 'funding',
          players: res.players,
        });

        sock.emit('join-match', { matchId: res.matchId, playerId: assetWalletAddress });
        let ok = false;
        let errMsg: string | null = null;
        try {
          ok = await escrowAdapter.lockFunds(res.matchId, selectedAsset, stakeAmount);
        } catch (e: any) {
          errMsg = e?.message || String(e);
          console.error('[GameContext] lockFunds failed (HTTP path):', errMsg);
        }
        if (!ok) {
          depositInFlightRef.current.delete(res.matchId);
          selfDepositFailedRef.current.add(res.matchId);
          sock.emit('deposit-failed', {
            matchId: res.matchId,
            playerId: assetWalletAddress,
            reason: errMsg || 'deposit_failed',
          });
          setCurrentMatch(null);
          toast({
            title: 'Deposit failed',
            description: errMsg
              ? `On-chain deposit could not complete: ${errMsg}`
              : 'On-chain deposit could not complete. Match cancelled.',
            variant: 'destructive',
          });
        }
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
    isFindingRef.current = false;
    setIsFinding(false);
    // на сервере явного cancel нет — достаточно убрать локальный флаг ожидания
    if (currentMatch?.status === 'waiting') {
      setCurrentMatch(null);
    }
  };

  const finishMatch = async (result: 'win' | 'loss' | 'draw') => {
    if (!currentMatch) return;

    const { payout, fee } = await escrowAdapter.settleMatch(
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
      socket: socketInstance,
      dispatch: () => {},
    }),
    [selectedGame, selectedAsset, stakeAmount, walletState, currentMatch, history, isFinding, socketInstance]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGame() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}