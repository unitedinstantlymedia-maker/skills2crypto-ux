import { createContext, useContext } from 'react';
import type { 
  Asset, 
  Game, 
  Match, 
  WalletState,
  HistoryEntry
} from '@/core/types';

export interface GameContextValue {
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
  dispatch: React.Dispatch<any>;
}

export const GameContext = createContext<GameContextValue | undefined>(undefined);

export function useGame() {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return context;
}
