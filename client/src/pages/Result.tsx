import { useGame } from "@/context/useGame";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Trophy, XCircle, Handshake } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { useLanguage } from "@/context/LanguageContext";

export default function Result() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();

  const result = state.currentMatch?.result;
  const isWin = result === 'win';
  const isDraw = result === 'draw';
  const payout = state.currentMatch?.payout || 0;

  useEffect(() => {
    if (!state.currentMatch?.result) {
      setLocation('/');
    }
  }, [state.currentMatch, setLocation]);

  const handlePlayAgain = () => {
    setLocation('/lobby');
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] space-y-8 text-center relative">
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", duration: 0.6 }}
        className="flex flex-col items-center gap-4"
      >
        {isWin ? (
          <div className="relative">
             <div className="absolute inset-0 rounded-full bg-primary/20 blur-2xl animate-pulse" />
             <Trophy className="h-24 w-24 text-primary drop-shadow-[0_0_15px_rgba(57,255,20,0.5)]" />
          </div>
        ) : isDraw ? (
          <div className="relative">
             <div className="absolute inset-0 rounded-full bg-yellow-500/20 blur-2xl animate-pulse" />
             <Handshake className="h-24 w-24 text-yellow-400 drop-shadow-[0_0_15px_rgba(250,204,21,0.5)]" />
          </div>
        ) : (
          <XCircle className="h-24 w-24 text-destructive opacity-80" />
        )}
        
        <h1 className={`text-5xl font-display font-bold uppercase tracking-tighter ${
          isWin ? 'text-primary text-glow' : 
          isDraw ? 'text-yellow-400 text-glow' :
          'text-muted-foreground'
        }`}>
          {isWin ? t('Victory', 'Victory') : isDraw ? t('Draw', 'Draw') : t('Defeat', 'Defeat')}
        </h1>
      </motion.div>

      <Card className="w-full bg-card/50 border-white/10 p-6 space-y-4 backdrop-blur-sm">
        {isDraw && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-yellow-200 text-sm mb-4">
            {t('Draw — all stakes have been returned to both players.', 'Draw — all stakes have been returned to both players.')}
          </div>
        )}

        <div className="space-y-1">
          <p className="text-sm text-muted-foreground uppercase tracking-wider">{t('Total Payout', 'Total Payout')}</p>
          <p className={`text-3xl font-mono font-bold ${
            isWin ? 'text-white' : 
            isDraw ? 'text-yellow-400' :
            'text-muted-foreground'
          }`}>
            {payout.toFixed(4)} {state.selectedAsset}
          </p>
          {isWin && (
            <p className="text-sm text-green-400 font-mono">
              {t('Profit', 'Profit')}: +{(payout - (state.currentMatch?.stake || 0)).toFixed(4)} {state.selectedAsset}
            </p>
          )}
        </div>
        
        {isWin && (
          <div className="pt-4 border-t border-white/10 text-xs text-muted-foreground flex justify-between">
            <span>{t('Fee', 'Fee')} (3%) deducted</span>
            <span>{state.currentMatch?.fee?.toFixed(4)} {state.selectedAsset}</span>
          </div>
        )}
        
        <div className="pt-2 border-t border-white/5 text-xs text-muted-foreground flex justify-between">
             <span>{t('Initial Stake', 'Initial Stake')}</span>
             <span>{state.currentMatch?.stake.toFixed(4)} {state.selectedAsset}</span>
        </div>
      </Card>

      <div className="w-full space-y-4">
        <Button 
          onClick={handlePlayAgain}
          className="w-full h-14 text-lg font-display font-bold uppercase tracking-widest bg-white text-black hover:bg-white/90"
        >
          {t('Play Again', 'Play Again')}
        </Button>
        
        <Link href="/">
          <Button variant="ghost" className="w-full text-muted-foreground hover:text-white">
            {t('Back to Home', 'Back to Home')}
          </Button>
        </Link>
      </div>
    </div>
  );
}
