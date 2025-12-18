import { Button } from "@/components/ui/button";
import { useLanguage } from "@/context/LanguageContext";

interface BattleshipGameProps {
  matchId: string;
  playerId: string;
  onFinish: (result: "win" | "loss" | "draw") => void;
}

export function BattleshipGame({ matchId, playerId, onFinish }: BattleshipGameProps) {
  const { t } = useLanguage();

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-8">
      <div className="text-xs text-muted-foreground mb-2">
        Match: {matchId} | Player: {playerId}
      </div>

      <h2 className="text-2xl font-bold text-primary">BATTLESHIP</h2>

      <div className="w-full aspect-square max-w-xs bg-blue-900/30 border-2 border-blue-500/30 rounded-lg grid grid-cols-10 grid-rows-10 relative overflow-hidden">
        {Array.from({ length: 100 }).map((_, i) => (
          <div 
            key={i} 
            className="border border-blue-500/10 flex items-center justify-center hover:bg-blue-500/20 transition-colors cursor-crosshair"
          >
            {Math.random() > 0.9 && <div className="w-2 h-2 rounded-full bg-red-500" />}
          </div>
        ))}
      </div>
      
      <div className="text-center text-muted-foreground text-sm">
        {t('Mock Battleship - Click buttons to end game', 'Mock Battleship - Click buttons to end game')}
      </div>

      <div className="grid grid-cols-3 gap-4 w-full max-w-md">
        <Button 
          onClick={() => onFinish('win')} 
          className="bg-primary text-primary-foreground hover:bg-primary/90 font-display uppercase tracking-widest"
        >
          WIN
        </Button>
        <Button 
          onClick={() => onFinish('draw')} 
          variant="outline"
          className="font-display uppercase tracking-widest"
        >
          DRAW
        </Button>
        <Button 
          onClick={() => onFinish('loss')} 
          variant="destructive" 
          className="font-display uppercase tracking-widest"
        >
          LOSE
        </Button>
      </div>
    </div>
  );
}

export default BattleshipGame;
