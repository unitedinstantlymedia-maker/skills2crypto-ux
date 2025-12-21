import { useGame } from "@/context/GameContext";
import { useLocation } from "wouter";
import { ChessGame } from "@/components/games/ChessGame";
import { TetrisGame } from "@/components/games/TetrisGame";
import { CheckersGame } from "@/components/games/CheckersGame";
import { WaitingRoom } from "@/components/games/WaitingRoom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/context/LanguageContext";

export default function Play() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();

  useEffect(() => {
    if (!state.currentMatch) {
      setLocation('/');
    }
  }, [state.currentMatch, setLocation]);

  const handleFinish = async (result: 'win' | 'loss' | 'draw') => {
    await actions.finishMatch(result);
    setLocation('/result');
  };

  if (!state.selectedGame) return null;

  // Check if both players are present
  const playerCount = state.currentMatch?.players.filter(p => p).length || 0;
  const hasBothPlayers = playerCount === 2;

  // If not both players, show waiting room
  if (!hasBothPlayers) {
    return <WaitingRoom />;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="font-mono text-xs uppercase text-muted-foreground">{t('Live Match', 'Live Match')}</span>
        </div>
        <div className="font-mono font-bold text-primary">
          {t('Pot Size', 'Pot')}: {(state.currentMatch?.stake || 0) * 2} {state.selectedAsset}
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center">
        {state.selectedGame === 'Chess' && <ChessGame onFinish={handleFinish} />}
        {state.selectedGame === 'Tetris' && <TetrisGame onFinish={handleFinish} />}
        {state.selectedGame === 'Checkers' && <CheckersGame onFinish={handleFinish} />}
        {state.selectedGame === 'Battleship' && (
          <div className="flex flex-col items-center justify-center text-center space-y-4 animate-in fade-in duration-500">
             <div className="w-24 h-24 rounded-full bg-blue-500/10 flex items-center justify-center border border-blue-500/20">
               <span className="text-4xl">🚢</span>
             </div>
             <h2 className="text-2xl font-display font-bold uppercase tracking-wider text-blue-400">Battleship</h2>
             <p className="text-muted-foreground font-mono">Game interface coming soon!</p>
          </div>
        )}
      </div>

      <div className="flex justify-center gap-2 mb-4">
        <Button 
          onClick={() => handleFinish('win')}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          {t('Victory', 'Victory')}
        </Button>
        <Button 
          onClick={() => handleFinish('draw')}
          className="bg-yellow-500 hover:bg-yellow-600 text-white"
        >
          {t('Draw', 'Draw')}
        </Button>
        <Button 
          variant="destructive"
          onClick={() => handleFinish('loss')}
        >
          {t('Defeat', 'Defeat')}
        </Button>
      </div>
    </div>
  );
}
