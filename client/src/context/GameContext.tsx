import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  Asset, 
  Game, 
  Match, 
  WalletState,
  HistoryEntry
} from '@/core/types';
import { walletAdapter } from '@/core/wallet/WalletAdapter';
import { walletStore } from '@/core/wallet/WalletStore';
import { mockEscrowAdapter } from '@/core/escrow/MockEscrowAdapter';
import { historyStore } from '@/core/history/HistoryStore';
import { useSocket } from './SocketContext';

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
  const { matchFound, findMatch: socketFindMatch, clearMatchFound, joinMatch } = useSocket();
  const [walletState, setWalletState] = useState<WalletState>(walletStore.getState());
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

  // Listen for matchFound from socket and set currentMatch
  useEffect(() => {
    if (matchFound && isFinding && walletState.address) {
      console.log("[GameContext] matchFound received from socket:", matchFound);
      
      // SECURITY: Only accept match if current wallet is a participant
      const isParticipant = matchFound.players.includes(walletState.address);
      if (!isParticipant && matchFound.players.length > 0) {
        console.warn("[GameContext] Ignoring match_found - wallet not a participant:", walletState.address, matchFound.players);
        return;
      }
      
      const match: Match = {
        id: matchFound.matchId,
        game: matchFound.game as Game,
        asset: matchFound.asset as Asset,
        stake: matchFound.amount,
        status: 'active',
        players: [matchFound.players[0] || walletState.address, matchFound.players[1]] as [string, string?],
        startTime: Date.now()
      };
      
      setIsFinding(false);
      setCurrentMatch(match);
      clearMatchFound();
      
      // Join the socket room for real-time game updates
      joinMatch(matchFound.matchId, walletState.address);
      
      // Lock funds now that match is active
      mockEscrowAdapter.lockFunds(match.id, match.asset, match.stake).then(success => {
        if (!success) {
          console.error("Failed to lock funds, aborting match");
          setCurrentMatch(null);
        }
      });
    }
  }, [matchFound, isFinding, walletState.address, clearMatchFound, joinMatch]);

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
    
    console.log(`[GameContext] Checking balance for ${selectedAsset}. Required: ${required}, Have: ${walletState.balances[selectedAsset]}`);

    if (!walletAdapter.canAfford(selectedAsset, required)) {
      console.warn("[GameContext] Insufficient funds, proceeding anyway for prototype");
    }

    setIsFinding(true);
    console.log("[GameContext] Set isFinding = true");
    
    // Clear any existing stale match in context before starting search
    setCurrentMatch(null);

    // Call server API to find/join matchmaking queue
    console.log(`[GameContext] Calling server find-match API: ${selectedGame} ${selectedAsset} ${stakeAmount}`);
    socketFindMatch(selectedGame, selectedAsset, stakeAmount, walletState.address);
  };

  const cancelSearch = () => {
    // TODO: Add server-side cancel endpoint
    setIsFinding(false);
    clearMatchFound();
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
