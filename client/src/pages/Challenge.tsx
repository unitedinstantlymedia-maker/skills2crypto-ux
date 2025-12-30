import { useRoute, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Swords, User, Coins, Gamepad2, AlertCircle, Loader2, Clock } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { Link } from "wouter";
import { useState, useEffect, useRef } from "react";
import { useGame } from "@/context/GameContext";
import { Asset, Game } from "@/core/types";
import { useToast } from "@/hooks/use-toast";
import { io, Socket } from "socket.io-client";

interface ChallengeData {
  challengeId: string;
  game: Game;
  asset: Asset;
  stake: number;
  challengerId: string;
  challengerName: string;
  status: string;
  createdAt: number;
}

export default function Challenge() {
  const [match, params] = useRoute("/challenge/:challengeId");
  const [, setLocation] = useLocation();
  const { t } = useLanguage();
  const { state, actions } = useGame();
  const { toast } = useToast();
  
  const [challengeData, setChallengeData] = useState<ChallengeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!match || !params?.challengeId) return;
    
    const challengeId = params.challengeId;
    
    const fetchChallenge = async () => {
      try {
        const res = await fetch(`/api/challenge/${challengeId}`);
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || "Challenge not found");
          setIsLoading(false);
          return;
        }
        
        const data = await res.json();
        setChallengeData(data);
        setIsLoading(false);
      } catch (err) {
        console.error("[challenge] fetch error:", err);
        setError("Failed to load challenge");
        setIsLoading(false);
      }
    };
    
    fetchChallenge();
  }, [match, params?.challengeId]);

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[challenge] socket connected', socket.id);
    });

    socket.on('challenge-match-created', (data: { matchId: string; game: string; challengeId: string }) => {
      console.log('[challenge] match created', data);
      
      if (challengeData) {
        actions.selectGame(challengeData.game);
        actions.selectAsset(challengeData.asset);
        actions.setStake(challengeData.stake);
      }
      
      setLocation(`/play/${data.game.toLowerCase()}`);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, [challengeData, actions, setLocation]);

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

    if (!challengeData || !socketRef.current?.id) {
      toast({
        title: t("Error", "Error"),
        description: t("Unable to accept challenge. Please try again.", "Unable to accept challenge. Please try again."),
        variant: "destructive"
      });
      return;
    }

    setIsAccepting(true);

    try {
      const res = await fetch('/api/accept-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: challengeData.challengeId,
          accepterId: state.wallet.address,
          accepterSocketId: socketRef.current.id
        })
      });

      if (!res.ok) {
        const data = await res.json();
        toast({
          title: t("Challenge Error", "Challenge Error"),
          description: data.error || "Failed to accept challenge",
          variant: "destructive"
        });
        setIsAccepting(false);
        return;
      }

      const result = await res.json();
      console.log('[challenge] accepted, match:', result.matchId);
      
      actions.selectGame(challengeData.game);
      actions.selectAsset(challengeData.asset);
      actions.setStake(challengeData.stake);
      
      setLocation(`/play/${challengeData.game.toLowerCase()}`);
    } catch (err) {
      console.error("[challenge] accept error:", err);
      toast({
        title: t("Error", "Error"),
        description: t("Failed to accept challenge. Please try again.", "Failed to accept challenge. Please try again."),
        variant: "destructive"
      });
      setIsAccepting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="text-muted-foreground">{t('Loading challenge...', 'Loading challenge...')}</p>
      </div>
    );
  }

  if (error || !challengeData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
        <AlertCircle className="h-16 w-16 text-destructive" />
        <h2 className="text-2xl font-bold">{t('Challenge not found or expired', 'Challenge not found or expired')}</h2>
        <p className="text-muted-foreground">{error || t('Please ask your friend to create a new challenge.', 'Please ask your friend to create a new challenge.')}</p>
        <Link href="/">
          <Button>{t('Back to Home', 'Back to Home')}</Button>
        </Link>
      </div>
    );
  }

  if (challengeData.status !== "pending") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
        <AlertCircle className="h-16 w-16 text-yellow-500" />
        <h2 className="text-2xl font-bold">{t('Challenge Already Accepted', 'Challenge Already Accepted')}</h2>
        <p className="text-muted-foreground">{t('This challenge has already been accepted by another player.', 'This challenge has already been accepted by another player.')}</p>
        <Link href="/">
          <Button>{t('Back to Home', 'Back to Home')}</Button>
        </Link>
      </div>
    );
  }

  const expiresIn = Math.max(0, Math.floor((challengeData.createdAt + 3600000 - Date.now()) / 60000));

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
            <h2 className="text-3xl font-display font-bold text-white text-glow">{challengeData.challengerName}</h2>
            <p className="text-lg text-muted-foreground">{t('wants to play', 'wants to play')}</p>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-white/5">
          <div className="flex justify-between items-center bg-black/20 p-4 rounded-lg">
            <span className="text-muted-foreground flex items-center gap-2">
              <Gamepad2 className="h-4 w-4" /> {t('Game', 'Game')}
            </span>
            <span className="font-mono font-bold text-lg capitalize">{challengeData.game}</span>
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
              <User className="h-4 w-4" /> {t('Challenger', 'Challenger')}
            </span>
            <span className="font-mono font-bold text-lg truncate max-w-[150px]">{challengeData.challengerName}</span>
          </div>

          <div className="flex justify-between items-center bg-black/20 p-4 rounded-lg">
            <span className="text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" /> {t('Expires in', 'Expires in')}
            </span>
            <span className="font-mono font-bold text-lg text-yellow-500">{expiresIn} min</span>
          </div>
        </div>

        <Button 
          onClick={handleAccept}
          disabled={isAccepting}
          className="w-full h-16 text-xl font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow shadow-[0_0_30px_rgba(38,161,123,0.3)] hover:shadow-[0_0_50px_rgba(38,161,123,0.5)] transition-all disabled:opacity-50"
        >
          {isAccepting ? (
            <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> {t('Accepting...', 'Accepting...')}</>
          ) : state.wallet.connected ? (
            t('Accept Challenge', 'Accept Challenge')
          ) : (
            t('Connect Wallet', 'Connect Wallet')
          )}
        </Button>
      </Card>
    </div>
  );
}
