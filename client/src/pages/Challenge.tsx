import { useRoute, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Swords, User, Coins, Gamepad2, AlertCircle } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { Link } from "wouter";
import { useState, useEffect } from "react";
import { useGame } from "@/context/GameContext";
import { Asset, Game } from "@/core/types";
import { useToast } from "@/hooks/use-toast";

export default function Challenge() {
  const [match, params] = useRoute("/challenge/:challengeId");
  const [, setLocation] = useLocation();
  const { t } = useLanguage();
  const { state, actions } = useGame();
  const { toast } = useToast();
  
  const [challengerName, setChallengerName] = useState("Unknown Player");
  const [challengeData, setChallengeData] = useState<{
    game?: string;
    asset?: string;
    stake?: string;
  }>({});
  const [isValid, setIsValid] = useState(true);

  useEffect(() => {
    if (match && params.challengeId) {
      // 1. Parse Name
      const parts = params.challengeId.split('-');
      if (parts.length > 1) {
        parts.pop();
        const name = parts.join(' ');
        const formattedName = name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        setChallengerName(formattedName);
      } else {
        setChallengerName(params.challengeId);
      }

      // 2. Parse Query Params
      const searchParams = new URLSearchParams(window.location.search);
      const game = searchParams.get('game');
      const asset = searchParams.get('asset');
      const stake = searchParams.get('stake');

      if (!game || !asset || !stake) {
        setIsValid(false);
      } else {
        setChallengeData({ game, asset, stake });
      }
    }
  }, [match, params]);

  const handleAccept = async () => {
    if (!state.wallet.connected) {
      toast({
         title: t("Wallet Not Connected", "Wallet Not Connected"),
         description: t("Please connect your wallet to accept the challenge.", "Please connect your wallet to accept the challenge."),
         variant: "destructive"
      });
      await actions.connectWallet();
      return;
    }

    if (challengeData.game && challengeData.asset && challengeData.stake) {
       // Set context state
       actions.selectGame(challengeData.game as Game);
       actions.selectAsset(challengeData.asset as Asset);
       actions.setStake(Number(challengeData.stake));
       
       // Simulate joining/locking funds
       await actions.startSearch();
       
       // Redirect to play
       setLocation(`/play/${challengeData.game.toLowerCase()}`);
    }
  };

  if (!isValid) {
    return (
       <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
          <AlertCircle className="h-16 w-16 text-destructive" />
          <h2 className="text-2xl font-bold">{t('Challenge not found or expired', 'Challenge not found or expired')}</h2>
          <p className="text-muted-foreground">{t('Please ask your friend to create a new challenge.', 'Please ask your friend to create a new challenge.')}</p>
          <Link href="/">
             <Button>{t('Back to Home', 'Back to Home')}</Button>
          </Link>
       </div>
    );
  }

  return (
    <div className="space-y-8 flex flex-col items-center justify-center min-h-[60vh]">
      <div className="flex items-center gap-4 w-full max-w-md">
        <Link href="/">
          <Button size="icon" variant="ghost" className="h-10 w-10 rounded-full">
            <ArrowLeft className="h-6 w-6" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('Challenge', 'Challenge')}</h1>
        </div>
      </div>

      <Card className="w-full max-w-md bg-card/50 border-white/10 p-8 space-y-8 relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
        
        <div className="text-center space-y-4">
          <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20 animate-pulse">
            <Swords className="h-10 w-10 text-primary" />
          </div>
          
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground uppercase tracking-widest">{t('Incoming Challenge', 'Incoming Challenge')}</p>
            <h2 className="text-3xl font-display font-bold text-white text-glow">{challengerName}</h2>
            <p className="text-lg text-muted-foreground">{t('wants to play', 'wants to play')}</p>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-white/5">
           <div className="flex justify-between items-center bg-black/20 p-4 rounded-lg">
              <span className="text-muted-foreground flex items-center gap-2">
                <Gamepad2 className="h-4 w-4" /> {t('Game', 'Game')}
              </span>
              <span className="font-mono font-bold text-lg">{challengeData.game}</span>
           </div>

           <div className="flex justify-between items-center bg-black/20 p-4 rounded-lg">
              <span className="text-muted-foreground flex items-center gap-2">
                <Coins className="h-4 w-4" /> {t('Wager', 'Wager')}
              </span>
              <span className="font-mono font-bold text-xl text-primary text-glow">
                {Number(challengeData.stake).toFixed(2)} {challengeData.asset}
              </span>
           </div>
           
           <div className="flex justify-between items-center bg-black/20 p-4 rounded-lg">
              <span className="text-muted-foreground flex items-center gap-2">
                <User className="h-4 w-4" /> {t('Opponent', 'Opponent')}
              </span>
              <span className="font-mono font-bold text-lg truncate max-w-[150px]">{challengerName}</span>
           </div>
        </div>

        <Button 
          onClick={handleAccept}
          className="w-full h-16 text-xl font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow shadow-[0_0_30px_rgba(38,161,123,0.3)] hover:shadow-[0_0_50px_rgba(38,161,123,0.5)] transition-all"
        >
          {state.wallet.connected ? t('Accept Challenge', 'Accept Challenge') : t('Connect Wallet', 'Connect Wallet')}
        </Button>
      </Card>
    </div>
  );
}
