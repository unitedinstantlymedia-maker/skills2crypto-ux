import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  Asset, 
  Game, 
  Match, 
  WalletState,
  getQueueKey,
  HistoryEntry
} from '@/core/types';
import { walletAdapter } from '@/core/wallet/WalletAdapter';
import { walletStore } from '@/core/wallet/WalletStore'; // Need store for subscription
import { matchmakingService } from '@/core/matchmaking/MatchmakingService';
import { mockEscrowAdapter } from '@/core/escrow/MockEscrowAdapter';
import { historyStore } from '@/core/history/HistoryStore';

interface GameContextValue {
  state: {
    selectedGame: Game | null;
    selectedAsset: Asset;
    stakeAmount: number;
    wallet: WalletState;
    currentMatch: Match | null;
    history: HistoryEntry[];
    isFinding: boolean;
  };
  actions: {
    connectWallet: () => Promise<void>;
    selectGame: (game: Game) => void;
    selectAsset: (asset: Asset) => void;
    setStake: (amount: number) => void;
    startSearch: () => Promise<void>;
    cancelSearch: () => void;
    finishMatch: (result: 'win' | 'loss' | 'draw') => Promise<void>;
  };
  dispatch: React.Dispatch<any>; // Deprecated
}

const GameContext = createContext<GameContextValue | undefined>(undefined);

export function GameProvider({ children }: { children: React.ReactNode }) {
  const [walletState, setWalletState] = useState<WalletState>(walletStore.getState());
  // Initialize from localStorage if available
  const [selectedGame, setSelectedGame] = useState<Game | null>(() => {
    const stored = localStorage.getItem('skills2crypto_selected_game');
    return stored ? (stored as Game) : null;
  });
  
  const [selectedAsset, setSelectedAsset] = useState<Asset>('USDT');
  const [stakeAmount, setStakeAmount] = useState<number>(20);
  const [currentMatch, setCurrentMatch] = useState<Match | null>(null);
  const [history, setHistory] = useState(historyStore.getHistory());
  const [isFinding, setIsFinding] = useState(false);

  // Persist selectedGame
  useEffect(() => {
    if (selectedGame) {
      localStorage.setItem('skills2crypto_selected_game', selectedGame);
    }
  }, [selectedGame]);

  // Subscribe to wallet changes
  useEffect(() => {
    return walletStore.subscribe((newState) => {
      setWalletState(newState);
    });
  }, []);

  // Poll for match updates if finding or active
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isFinding || (currentMatch && currentMatch.status === 'active')) {
      interval = setInterval(() => {
        if (walletState.address) {
          if (isFinding) console.log("[GameContext] Polling for match...");
          const match = matchmakingService.checkForMatch(walletState.address);
          if (match) {
            if (isFinding) {
              // STRICT CHECK: Only accept match if stake equals current desired stake
              // This prevents picking up stale matches from previous searches
              if (match.stake !== stakeAmount) {
                console.warn(`[GameContext] Ignored zombie match ${match.id} with wrong stake: ${match.stake}, expected: ${stakeAmount}`);
                return;
              }

              // Just found it!
              console.log("[GameContext] Polled match FOUND!", match);
              setIsFinding(false);
              setCurrentMatch(match);
              // Lock funds now that we are active
              mockEscrowAdapter.lockFunds(match.id, match.asset, match.stake).then(success => {
                if (!success) {
                   console.error("Failed to lock funds, aborting match");
                   setCurrentMatch(null);
                   // Handle error UI?
                }
              });
            } else if (currentMatch && match.status !== currentMatch.status) {
              // Update match state (e.g. finished by other player?)
              setCurrentMatch(match);
            }
          }
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isFinding, currentMatch, walletState.address]);

  const connectWallet = async () => {
    await walletAdapter.connect();
  };

  const startSearch = async () => {
    console.log("[GameContext] startSearch called");
    if (!selectedGame || !walletState.address) {
      console.warn("[GameContext] Missing game or address", { selectedGame, address: walletState.address });
      return;
    }

    // 1. Check Balance via Adapter
    const networkFee = mockEscrowAdapter.getEstimatedNetworkFee(selectedAsset);
    const required = stakeAmount + networkFee;
    
    // Log balance check
    console.log(`[GameContext] Checking balance for ${selectedAsset}. Required: ${required}, Have: ${walletState.balances[selectedAsset]}`);

    if (!walletAdapter.canAfford(selectedAsset, required)) {
      console.warn("[GameContext] Insufficient funds, proceeding anyway for prototype (or handled by UI warning)");
      // We allow proceeding if UI allows it, but maybe walletAdapter.debit will fail later?
      // For now, let's assume we proceed to Queue at least.
    }

    setIsFinding(true);
    console.log("[GameContext] Set isFinding = true");
    
    const params = {
      game: selectedGame,
      asset: selectedAsset,
      stake: stakeAmount
    };

    // Clear any existing stale match in context before starting search
    setCurrentMatch(null);

    // 2. Try Match
    console.log(`[GameContext] Calling tryMatch with params:`, JSON.stringify(params));
    const match = matchmakingService.tryMatch(params, walletState.address);
    
    if (match) {
      // Found immediately
      console.log(`[GameContext] Match found immediately! ID: ${match.id}, Stake: ${match.stake}`);
      setIsFinding(false);
      setCurrentMatch(match);
      // Lock funds
      console.log(`[GameContext] Locking funds for match ${match.id}, Asset: ${match.asset}, Stake: ${match.stake}`);
      await mockEscrowAdapter.lockFunds(match.id, match.asset, match.stake);
    } else {
      // Enqueue
      console.log(`[GameContext] No match found, enqueuing with params:`, JSON.stringify(params));
      matchmakingService.enqueue(params, walletState.address);
    }
  };

  const cancelSearch = () => {
    if (!selectedGame || !walletState.address) return;
    matchmakingService.cancel({
      game: selectedGame,
      asset: selectedAsset,
      stake: stakeAmount
    }, walletState.address);
    setIsFinding(false);
  };

  const finishMatch = async (result: 'win' | 'loss' | 'draw') => {
    if (!currentMatch) return;

    // Settle
    const { payout, fee } = await mockEscrowAdapter.settleMatch(
      currentMatch.id, 
      currentMatch.asset, 
      currentMatch.stake, 
      result
    );

    // Record History with EXPLICIT number conversion to prevent any string/stale data issues
    const safeStake = Number(currentMatch.stake);
    const safePayout = Number(payout);
    const safeFee = Number(fee);
    const safePot = safeStake * 2;

    const entry: HistoryEntry = {
      id: currentMatch.id,
      game: currentMatch.game,
      asset: currentMatch.asset,
      stake: safeStake,
      result,
      pot: safePot,
      fee: safeFee,
      payout: safePayout,
      timestamp: Date.now()
    };
    
    console.log("[GameContext] Adding History Entry:", JSON.stringify(entry));
    
    historyStore.addEntry(entry);
    setHistory(historyStore.getHistory());
    
    // Update match status locally to finished
    setCurrentMatch({
      ...currentMatch,
      status: 'finished',
      result,
      payout: safePayout,
      fee: safeFee
    });
  };

  const value: GameContextValue = {
    state: {
      selectedGame,
      selectedAsset,
      stakeAmount,
      wallet: walletState,
      currentMatch,
      history,
      isFinding
    },
    actions: {
      connectWallet,
      selectGame: setSelectedGame,
      selectAsset: setSelectedAsset,
      setStake: (amount: number) => {
        console.log(`[GameContext] Setting stake to: ${amount}`);
        setStakeAmount(amount);
      },
      startSearch,
      cancelSearch,
      finishMatch
    },
    dispatch: () => {} 
  };

  return (
    <GameContext.Provider value={value}>
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return context;
}
