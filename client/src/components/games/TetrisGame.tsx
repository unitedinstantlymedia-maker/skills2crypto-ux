import { Button } from "@/components/ui/button";
import { useLanguage } from "@/context/LanguageContext";

interface TetrisGameProps {
  matchId: string;
  playerId: string;
  onFinish: (result: "win" | "loss" | "draw") => void;
}

export function TetrisGame({ matchId, playerId, onFinish }: TetrisGameProps) {
  const { t } = useLanguage();

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-8">
      <div className="text-xs text-muted-foreground mb-2">
        Match: {matchId} | Player: {playerId}
      </div>
      
      <div className="w-64 h-96 bg-black/40 border-2 border-white/10 rounded-lg relative overflow-hidden p-4">
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-accent/20 to-transparent flex items-end justify-center pb-4">
          <span className="text-muted-foreground text-sm font-mono bg-black/80 px-4 py-2 rounded">
            {t('Tetris Engine Placeholder', 'Tetris Engine Placeholder')}
          </span>
        </div>
        <div className="absolute top-10 left-10 w-8 h-8 bg-primary animate-bounce" />
        <div className="absolute top-10 left-18 w-8 h-8 bg-primary animate-bounce delay-75" />
        <div className="absolute top-18 left-18 w-8 h-8 bg-primary animate-bounce delay-150" />
        <div className="absolute top-18 left-26 w-8 h-8 bg-primary animate-bounce delay-300" />
      </div>
      
      <div className="grid grid-cols-2 gap-4 w-full">
        <Button onClick={() => onFinish('win')} className="bg-primary text-primary-foreground hover:bg-primary/90 font-display uppercase tracking-widest">
          {t('Claim Win (Dev)', 'Claim Win (Dev)')}
        </Button>
        <Button onClick={() => onFinish('loss')} variant="destructive" className="font-display uppercase tracking-widest">
          {t('Game Over (Dev)', 'Game Over (Dev)')}
        </Button>
      </div>
    </div>
  );
}

export default TetrisGame;
