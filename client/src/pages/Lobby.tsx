import { useGame } from "@/context/useGame";
import { STAKE_PRESETS } from "@/config/economy";
import { Asset } from "@/core/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLocation } from "wouter";
import { useState } from "react";
import { ArrowLeft, Coins, Zap, Info, Loader2, X, Ship, UserPlus, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { mockEscrowAdapter } from "@/core/escrow/MockEscrowAdapter";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";
import { ShareButton } from "@/components/ui/ShareButton";
import { useLanguage } from "@/context/LanguageContext";
import logoImage from '@assets/2025-12-12_07.52.28_1765519599465.jpg';

export default function Lobby() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const [customStake, setCustomStake] = useState<string>("");
  const [isChallengeMode, setIsChallengeMode] = useState(false);
  const [playerName, setPlayerName] = useState("");
  const [showChallengeLink, setShowChallengeLink] = useState(false);
  const [challengeLink, setChallengeLink] = useState("");
  const { toast } = useToast();
  const { t } = useLanguage();

  useEffect(() => {
    if (!state.selectedGame) {
      setLocation('/games');
    }
  }, [state.selectedGame, setLocation]);

  useEffect(() => {
    if (state.currentMatch && state.currentMatch.status === 'active') {
      console.log("[Lobby] Match active, redirecting to Play");
      setLocation(`/play/${state.selectedGame?.toLowerCase()}`);
    }
  }, [state.currentMatch, state.selectedGame, setLocation]);

  const handleAssetChange = (value: string) => {
    if (value) actions.selectAsset(value as Asset);
  };

  const handleStakeChange = (amount: number) => {
    console.log(`[Lobby] Stake preset clicked: ${amount}`);
    actions.setStake(amount);
    setCustomStake("");
  };

  const handleCustomStakeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomStake(val);
    if (val && !isNaN(Number(val))) {
      console.log(`[Lobby] Custom stake changed: ${Number(val)}`);
      actions.setStake(Number(val));
    }
  };

  const handleStartSearch = async () => {
    console.log(`[Lobby] Start Search clicked. Stake: ${state.stakeAmount} (Custom: "${customStake}")`);
    
    // Validation
    if (!state.wallet.connected) {
      toast({
        title: t("Wallet not connected", "Wallet not connected"),
        description: t("Please connect your wallet to play.", "Please connect your wallet to play."),
        variant: "destructive"
      });
      return;
    }

    if (state.stakeAmount <= 0) {
      toast({
        title: t("Invalid Wager", "Invalid Wager"),
        description: t("Please select a wager amount greater than 0.", "Please select a wager amount greater than 0."),
        variant: "destructive"
      });
      return;
    }

    const networkFee = mockEscrowAdapter.getEstimatedNetworkFee(state.selectedAsset);
    const totalCost = state.stakeAmount + networkFee;
    const currentBalance = state.wallet.balances[state.selectedAsset] || 0;

    if (currentBalance < totalCost) {
      toast({
        title: t("Insufficient Balance", "Insufficient Balance"),
        description: `${t('You need', 'You need')} ${totalCost.toFixed(4)} ${state.selectedAsset} ${t('but only have', 'but only have')} ${currentBalance.toFixed(4)}.`,
        variant: "destructive"
      });
      // Allow proceeding if they insist? 
      // User said "show error message when ... balance is insufficient"
      // But also said "make button always clickable". 
      // So we show error and BLOCK, or show error and PROCEED?
      // "show an error message... and ensure onClick is correctly wired"
      // Usually implies blocking action.
      // But for prototype, let's block but give a clear message.
      return; 
    }

    if (isChallengeMode) {
       const params = new URLSearchParams({
          game: state.selectedGame || 'Chess',
          asset: state.selectedAsset,
          stake: state.stakeAmount.toString()
       });
       const mockLink = `https://skills2crypto.com/challenge/${playerName.replace(/\s+/g, '-').toLowerCase()}-${Math.random().toString(36).substring(7)}?${params.toString()}`;
       setChallengeLink(mockLink);
       setShowChallengeLink(true);
       return;
    }

    await actions.startSearch();
  };

  const handleCancelSearch = () => {
    console.log("[Lobby] Cancel Search clicked");
    actions.cancelSearch();
  };

  if (state.currentMatch && state.currentMatch.status === 'active') {
    return null; 
  }

  const totalCost = state.stakeAmount;
  
  const currentBalance = state.wallet.balances[state.selectedAsset] || 0;
  const isBalanceSufficient = currentBalance >= totalCost;

  // Fee Calculation Logic
  const pot = state.stakeAmount * 2;
  const fee = pot * 0.03;
  const payout = pot - fee;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Link href="/games">
          <Button size="icon" variant="ghost" className="h-10 w-10 rounded-full">
            <ArrowLeft className="h-6 w-6" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('Lobby', 'Lobby')}</h1>
          <p className="text-muted-foreground text-sm">{state.selectedGame}</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Asset Selection */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t('Select Asset', 'Select Asset')}</label>
          <ToggleGroup type="single" value={state.selectedAsset} onValueChange={handleAssetChange} className="justify-start gap-3">
            {(['USDT', 'ETH', 'TON'] as Asset[]).map((asset) => (
              <ToggleGroupItem 
                key={asset} 
                value={asset}
                className="h-12 px-6 border border-white/10 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary/50 rounded-lg transition-all relative"
              >
                {asset}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs font-mono text-muted-foreground ml-1">
            {t('Balance', 'Balance')}: <span className={isBalanceSufficient ? "text-white" : "text-destructive font-bold"}>
              {currentBalance.toFixed(4)} {state.selectedAsset}
            </span>
          </p>
        </div>

        {/* Stake Selection */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t('Wager Amount', 'Wager Amount')}</label>
          <div className="grid grid-cols-4 gap-2">
            {STAKE_PRESETS.map((amount) => (
              <Button
                key={amount}
                variant={state.stakeAmount === amount && !customStake ? "default" : "outline"}
                onClick={() => handleStakeChange(amount)}
                className={cn(
                  "h-12 font-mono font-bold border-white/10",
                  state.stakeAmount === amount && !customStake ? "bg-accent text-accent-foreground border-accent/50" : "hover:bg-white/5 hover:text-white"
                )}
              >
                {amount}
              </Button>
            ))}
          </div>
          <div className="relative">
            <Input
              type="number"
              placeholder={t('Custom Amount', 'Custom Amount')}
              value={customStake}
              onChange={handleCustomStakeChange}
              className="h-12 bg-black/20 border-white/10 font-mono pl-10"
            />
            <Coins className="absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
          </div>
        </div>

        {/* Summary Card */}
        <Card className="bg-card/50 border-white/10 p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Pot Size', 'Pot Size')} (2x)</span>
            <span className="font-mono font-bold">{pot.toFixed(4)} {state.selectedAsset}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Fee', 'Fee')} (3%) deducted</span>
            <span className="font-mono text-muted-foreground">
              {fee.toFixed(4)} {state.selectedAsset}
            </span>
          </div>
          
          <div className="border-t border-white/10 my-2 pt-2 flex justify-between text-lg font-display font-bold">
            <span className="text-primary">{t('Potential Win', 'Potential Win')}</span>
            <span className="text-primary text-glow">
              {payout.toFixed(4)} {state.selectedAsset}
            </span>
          </div>
        </Card>

        {state.isFinding ? (
          <Button 
            onClick={handleCancelSearch}
            variant="destructive"
            className="w-full h-14 text-lg font-display font-bold uppercase tracking-widest border-glow animate-pulse"
          >
            <X className="mr-2 h-5 w-5" /> {t('Cancel Search', 'Cancel Search')}
          </Button>
        ) : showChallengeLink ? (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
             <div className="bg-card/50 border border-white/10 rounded-lg p-6 text-center space-y-4">
                <div className="flex items-center justify-center gap-1 text-lg sm:text-xl font-display font-bold tracking-tight text-primary flex-wrap">
                  <span className="text-white">skills</span>
                  <div className="relative inline-flex items-center justify-center h-14 w-14 -my-5 mx-1">
                    <img 
                      src={logoImage} 
                      alt="2" 
                      className="w-full h-full object-contain mix-blend-screen drop-shadow-[0_0_15px_rgba(255,255,255,0.8)]" 
                    />
                  </div>
                  <span className="text-white">crypto.com</span>
                  <span className="text-muted-foreground ml-0.5 truncate max-w-[150px]">/{challengeLink.split('/').pop()}</span>
                </div>
                
                <div className="relative">
                   <Input 
                      readOnly
                      value={challengeLink}
                      className="h-12 bg-black/40 border-white/10 font-mono text-xs sm:text-sm pr-12 text-center text-muted-foreground"
                   />
                   <Button
                      size="icon"
                      variant="ghost"
                      className="absolute right-1 top-1 h-10 w-10 hover:bg-white/10"
                      onClick={() => {
                        navigator.clipboard.writeText(challengeLink);
                        toast({
                           title: t("Copied!", "Copied!"),
                           description: t("Challenge link copied to clipboard", "Challenge link copied to clipboard"),
                        });
                      }}
                   >
                      <Copy className="h-4 w-4" />
                   </Button>
                </div>
                
                <p className="text-sm text-muted-foreground">
                   {t('Share this link with your friend to start the match.', 'Share this link with your friend to start the match.')}
                </p>
             </div>

             <Button 
                onClick={() => setShowChallengeLink(false)}
                className="w-full h-14 text-lg font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow"
             >
                {t('Done', 'Done')}
             </Button>
          </div>
        ) : isChallengeMode ? (
          <div className="space-y-3">
             <div className="relative">
                <Input 
                  placeholder={t("Enter your name or nickname", "Enter your name or nickname")} 
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  className="h-12 bg-black/20 border-white/10 font-mono text-center"
                />
                <p className="text-xs text-center text-muted-foreground mt-1 uppercase tracking-widest">{t('This will be shown to your opponent', 'This will be shown to your opponent')}</p>
             </div>
             <div className="flex gap-2">
                 <Button 
                    variant="outline"
                    onClick={() => setIsChallengeMode(false)}
                    className="flex-1 h-14 text-sm font-display font-bold uppercase tracking-widest hover:bg-white/5"
                 >
                    {t('Back', 'Back')}
                 </Button>
                 <Button 
                    onClick={handleStartSearch} 
                    disabled={!playerName.trim()} 
                    className="flex-[2] h-14 text-lg font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow disabled:opacity-50"
                 >
                    {t('Continue', 'Continue')}
                 </Button>
             </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button 
              onClick={handleStartSearch}
              className="flex-1 h-14 text-[10px] sm:text-xs md:text-sm font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow disabled:opacity-50 disabled:cursor-not-allowed px-1 whitespace-nowrap overflow-hidden text-ellipsis"
            >
              <Zap className="mr-1 sm:mr-2 h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" /> {t('Find Match', 'Find Match')}
            </Button>
            <Button 
              onClick={() => setIsChallengeMode(true)}
              className="flex-1 h-14 text-[10px] sm:text-xs md:text-sm font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow disabled:opacity-50 disabled:cursor-not-allowed px-1 whitespace-nowrap overflow-hidden text-ellipsis"
            >
              <UserPlus className="mr-1 sm:mr-2 h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" /> {t('Challenge Friend', 'Challenge Friend')}
            </Button>
          </div>
        )}
        
        {state.isFinding && (
           <div className="text-center text-xs text-muted-foreground animate-pulse mt-2">
             {t('Searching for opponent...', 'Searching for opponent...')} ({state.selectedAsset} {state.stakeAmount})
           </div>
        )}
      </div>
    </div>
  );
}
