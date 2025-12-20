import React, { useEffect, useState } from 'react';
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
import { useSocket } from './useSocket';
import { GameContext, GameContextValue } from './useGame';

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

  useEffect(() => {
    if (selectedGame) {
      localStorage.setItem('skills2crypto_selected_game', selectedGame);
    }
  }, [selectedGame]);

  useEffect(() => {
    return walletStore.subscribe((newState) => {
      setWalletState(newState);
    });
  }, []);

  useEffect(() => {
    if (matchFound && isFinding && walletState.address) {
      console.log("[GameContext] matchFound received from socket:", matchFound);
      
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
      
      joinMatch(matchFound.matchId, walletState.address);
      
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

    const networkFee = mockEscrowAdapter.getEstimatedNetworkFee(selectedAsset);
    const required = stakeAmount + networkFee;
    
    console.log(`[GameContext] Checking balance for ${selectedAsset}. Required: ${required}, Have: ${walletState.balances[selectedAsset]}`);

    if (!walletAdapter.canAfford(selectedAsset, required)) {
      console.warn("[GameContext] Insufficient funds, proceeding anyway for prototype");
    }

    setIsFinding(true);
    console.log("[GameContext] Set isFinding = true");
    
    setCurrentMatch(null);

    console.log(`[GameContext] Calling server find-match API: ${selectedGame} ${selectedAsset} ${stakeAmount}`);
    socketFindMatch(selectedGame, selectedAsset, stakeAmount, walletState.address);
  };

  const cancelSearch = () => {
    setIsFinding(false);
    clearMatchFound();
  };

  const finishMatch = async (result: 'win' | 'loss' | 'draw') => {
    if (!currentMatch) return;

    const { payout, fee } = await mockEscrowAdapter.settleMatch(
      currentMatch.id, 
      currentMatch.asset, 
      currentMatch.stake, 
      result
    );

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
