import { Button } from "@/components/ui/button";
import { useLanguage } from "@/context/LanguageContext";

interface CheckersGameProps {
  matchId: string;
  playerId: string;
  onFinish: (result: "win" | "loss" | "draw") => void;
}

export function CheckersGame({ matchId, playerId, onFinish }: CheckersGameProps) {
  const { t } = useLanguage();

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-8">
      <h2 className="text-2xl font-bold text-primary">CHECKERS</h2>

      <div className="w-full aspect-square max-w-xs bg-black/40 border-2 border-white/10 rounded-lg grid grid-cols-8 grid-rows-8 relative overflow-hidden">
         {Array.from({ length: 64 }).map((_, i) => {
          const x = i % 8;
          const y = Math.floor(i / 8);
          const isBlack = (x + y) % 2 === 1;
          return (
            <div 
              key={i} 
              className={`${isBlack ? 'bg-white/5' : 'bg-transparent'} flex items-center justify-center`} 
            >
              {isBlack && y < 3 && <div className="w-3/4 h-3/4 rounded-full bg-primary/50" />}
              {isBlack && y > 4 && <div className="w-3/4 h-3/4 rounded-full bg-accent/50" />}
            </div>
          );
        })}
      </div>

      <div className="text-center text-muted-foreground text-sm">
        {t('Mock Checkers - Click buttons to end game', 'Mock Checkers - Click buttons to end game')}
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

export default CheckersGame;
