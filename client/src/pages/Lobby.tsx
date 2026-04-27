import { useGame } from "@/context/GameContext";
import { STAKE_PRESETS } from "@/config/economy";
import { Asset } from "@/core/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLocation } from "wouter";
import { useState } from "react";
import { ArrowLeft, Coins, Zap, Info, Loader2, X, Ship, UserPlus, Copy, Check, AlertTriangle, RefreshCw } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { escrowAdapter } from "@/core/escrow";
import { ensureTronUsdtReadyForStake } from "@/core/escrow/TronEscrowAdapter";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";
import { ShareButton } from "@/components/ui/ShareButton";
import { useLanguage } from "@/context/LanguageContext";
import { useRealWallet, REQUIRED_CHAIN } from "@/core/wallet/WalletProvider";
import logoImage from '@assets/2025-12-12_07.52.28_1765519599465.jpg';

export default function Lobby() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const [customStake, setCustomStake] = useState<string>("");
  const [isChallengeMode, setIsChallengeMode] = useState(false);
  const [playerName, setPlayerName] = useState("");
  const [showChallengeLink, setShowChallengeLink] = useState(false);
  const [challengeLink, setChallengeLink] = useState("");
  // USDT one-time approve readiness. `null` = unknown/not-checked yet,
  // `true` = approve(escrow, MAX) is in place, `false` = onboarding still
  // required before we let the user enter the matchmaking queue.
  const [usdtApproveReady, setUsdtApproveReady] = useState<boolean | null>(null);
  const [isApprovingUsdt, setIsApprovingUsdt] = useState(false);
  const { toast } = useToast();
  const { t } = useLanguage();
  const realWallet = useRealWallet();
  const { isEvmConnected, isCorrectChainForAsset, switchToChain, isSwitchingChain, currentChainName, isTronConnected, isTronLinkInstalled, connectTronLink, isTonConnected, connectTonWallet } = realWallet;

  const requiredChain = (state.selectedAsset === 'BNB' || state.selectedAsset === 'ETH')
    ? REQUIRED_CHAIN[state.selectedAsset]
    : null;
  const isAnyConnected = isEvmConnected || isTronConnected || isTonConnected;
  const needsNetworkSwitch =
    state.selectedAsset === 'TON' ? !isTonConnected :
    state.selectedAsset === 'USDT' ? !isTronConnected :
    isAnyConnected && !isCorrectChainForAsset(state.selectedAsset);

  useEffect(() => {
    if (!state.selectedGame) {
      setLocation('/games');
    }
  }, [state.selectedGame, setLocation]);

  // Redirect to play when match is active
  useEffect(() => {
    if (state.currentMatch && state.currentMatch.status === 'active' && state.selectedGame) {
      console.log("[Lobby] Match active, redirecting to Play");
      setLocation(`/play/${state.selectedGame.toLowerCase()}`);
    }
  }, [state.currentMatch, state.selectedGame, setLocation]);

  // Refresh USDT readiness whenever the user picks USDT or re-connects
  // TronLink. This drives the "Approve USDT" gate below the asset picker so
  // the player can fix onboarding before clicking Find Match instead of
  // discovering the problem inside the matchmaking queue.
  useEffect(() => {
    if (state.selectedAsset !== 'USDT' || !isTronConnected) {
      setUsdtApproveReady(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const tw = (window as any).tronWeb;
        const owner = tw?.defaultAddress?.base58;
        if (!owner) {
          if (!cancelled) setUsdtApproveReady(false);
          return;
        }
        const r = await fetch(
          apiUrl(`/api/tron/readiness?wallet=${encodeURIComponent(owner)}&stake=${encodeURIComponent(String(state.stakeAmount || 1))}`)
        );
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok) setUsdtApproveReady(Boolean(data.approveReady));
        else setUsdtApproveReady(false);
      } catch {
        if (!cancelled) setUsdtApproveReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, [state.selectedAsset, isTronConnected, state.stakeAmount, isApprovingUsdt]);

  const handleApproveUsdt = async () => {
    setIsApprovingUsdt(true);
    try {
      await ensureTronUsdtReadyForStake(Math.max(state.stakeAmount, 1));
      setUsdtApproveReady(true);
      toast({
        title: t('USDT approved', 'USDT approved'),
        description: t('Your wallet is ready to play USDT matches.', 'Your wallet is ready to play USDT matches.'),
      });
    } catch (e: any) {
      toast({
        title: t('USDT approval failed', 'USDT approval failed'),
        description: e?.message || 'Could not complete the one-time USDT approve.',
        variant: 'destructive',
      });
    } finally {
      setIsApprovingUsdt(false);
    }
  };

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

    if (needsNetworkSwitch) {
      let desc: string;
      if (state.selectedAsset === 'TON') {
        desc = `${t('Connect your TON wallet to play with', 'Connect your TON wallet to play with')} TON.`;
      } else if (state.selectedAsset === 'USDT') {
        desc = `${t('Connect TronLink', 'Connect TronLink')} ${t('to play with', 'to play with')} USDT.`;
      } else {
        desc = `${t('Please switch to', 'Please switch to')} ${requiredChain?.name ?? ''} ${t('to play with', 'to play with')} ${state.selectedAsset}.`;
      }
      toast({
        title: t("Wrong Network", "Wrong Network"),
        description: desc,
        variant: "destructive"
      });
      return;
    }

    // V2 onboarding gate. The legacy "session key" flow was removed in
    // Task #16 (architecture rewrite) — wallets sign per-action via the
    // standard prompts now, so the only remaining onboarding step is the
    // one-time USDT approve(escrow, MAX). For USDT we hard-block search
    // unless we have AFFIRMATIVELY confirmed approval is in place: the
    // unknown/loading state (`null`) is treated as blocked too, so we
    // never enter the matchmaking queue with stale readiness data.
    if (state.selectedAsset === 'USDT' && usdtApproveReady !== true) {
      toast({
        title: t("Complete wallet setup first", "Complete wallet setup first"),
        description:
          usdtApproveReady === null
            ? t(
                "Checking USDT approval status... try again in a moment.",
                "Checking USDT approval status... try again in a moment."
              )
            : t(
                "Complete the one-time USDT approve before searching for a match.",
                "Complete the one-time USDT approve before searching for a match."
              ),
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

    const networkFee = escrowAdapter.getEstimatedNetworkFee(state.selectedAsset);
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
       try {
         // Challenger ID MUST match the chosen asset's chain — the server
         // writes this verbatim into the match's `addr1` and every
         // downstream deposit / oracle call relies on its shape. Picking
         // by the connected-wallet preference order (evm > tron > ton)
         // would cause e.g. a USDT challenge created from an EVM-only
         // browser to fail at deposit time on the friend's device.
         const challengerId =
           state.selectedAsset === 'BNB' || state.selectedAsset === 'ETH'
             ? realWallet.evmAddress || ''
             : state.selectedAsset === 'USDT'
             ? realWallet.tronAddress || ''
             : state.selectedAsset === 'TON'
             ? realWallet.tonAddress || ''
             : '';
         if (!challengerId) {
           toast({
             title: t("Wrong wallet for asset", "Wrong wallet for asset"),
             description: t(
               `Connect a ${
                 state.selectedAsset === 'BNB' || state.selectedAsset === 'ETH'
                   ? 'MetaMask / EVM'
                   : state.selectedAsset === 'USDT'
                   ? 'TronLink'
                   : 'TON'
               } wallet to create a ${state.selectedAsset} challenge.`,
               `Connect a ${
                 state.selectedAsset === 'BNB' || state.selectedAsset === 'ETH'
                   ? 'MetaMask / EVM'
                   : state.selectedAsset === 'USDT'
                   ? 'TronLink'
                   : 'TON'
               } wallet to create a ${state.selectedAsset} challenge.`
             ),
             variant: "destructive",
           });
           return;
         }
         const resp = await fetch(apiUrl('/api/create-challenge'), {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             game: state.selectedGame || 'Chess',
             asset: state.selectedAsset,
             stake: state.stakeAmount,
             challengerId,
             challengerName: playerName.trim() || 'Player',
           }),
         });
         if (!resp.ok) {
           const err = await resp.json().catch(() => ({}));
           throw new Error(err?.error || `Server returned ${resp.status}`);
         }
         const data = await resp.json();
         setChallengeLink(data.shareUrl);
         setShowChallengeLink(true);
       } catch (e: any) {
         toast({
           title: t('Could not create challenge', 'Could not create challenge'),
           description: e?.message || String(e),
           variant: 'destructive',
         });
       }
       return;
    }

    await actions.startSearch();
  };

  const handleCancelSearch = () => {
    console.log("[Lobby] Cancel Search clicked");
    actions.cancelSearch();
  };

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
          <ToggleGroup type="single" value={state.selectedAsset} onValueChange={handleAssetChange} className="justify-start gap-2 flex-wrap">
            {(['USDT', 'ETH', 'BNB', 'TON'] as Asset[]).map((asset) => {
              const networkLabel: Record<Asset, string> = {
                USDT: 'Tron',
                ETH: 'ETH',
                BNB: 'BSC',
                TON: 'TON',
              };
              return (
              <ToggleGroupItem 
                key={asset} 
                value={asset}
                className="h-12 px-4 sm:px-6 border border-white/10 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary/50 rounded-lg transition-all relative flex items-center gap-2"
              >
                {asset === 'TON' && (
                  <svg width="16" height="16" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
                    <circle cx="20" cy="20" r="18" fill="#0098EA" />
                    <path d="M13 15L20 11L27 15V21L20 29L13 21V15Z" fill="white" fillOpacity="0.9" />
                    <path d="M20 11L27 15V21L20 29V11Z" fill="white" fillOpacity="0.7" />
                  </svg>
                )}
                <span>{asset}</span>
                <span className="text-[10px] font-mono opacity-60 leading-none">{networkLabel[asset]}</span>
              </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          <p className="text-xs font-mono text-muted-foreground ml-1">
            {t('Balance', 'Balance')}: <span className={isBalanceSufficient ? "text-white" : "text-destructive font-bold"}>
              {currentBalance.toFixed(4)} {state.selectedAsset}
            </span>
          </p>
        </div>

        {needsNetworkSwitch && state.selectedAsset === 'TON' && (
          <Card className="bg-sky-500/5 border-sky-500/30 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-sky-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-sm text-sky-200">
                  {t('Connect your TON wallet to play with')} <span className="font-bold text-white">TON</span>
                </p>
                <Button
                  size="sm"
                  onClick={connectTonWallet}
                  className="h-9 px-4 text-sm font-display font-bold uppercase tracking-wider bg-sky-500 text-white hover:bg-sky-400"
                >
                  {t('Connect TON')}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {needsNetworkSwitch && state.selectedAsset === 'USDT' && (
          <Card className="bg-red-500/5 border-red-500/30 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-sm text-red-200">
                  {t('Connect TronLink')} {t('to play with')} <span className="font-bold text-white">USDT</span> (TRC-20)
                </p>
                {isTronLinkInstalled ? (
                  <Button
                    size="sm"
                    onClick={connectTronLink}
                    className="h-9 px-4 text-sm font-display font-bold uppercase tracking-wider bg-red-500 text-white hover:bg-red-400"
                  >
                    {t('Connect TronLink')}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('TronLink extension not detected', 'TronLink extension not detected')}
                  </p>
                )}
              </div>
            </div>
          </Card>
        )}

        {state.selectedAsset === 'USDT' && isTronConnected && usdtApproveReady === false && (
          <Card className="bg-amber-500/5 border-amber-500/30 p-4" data-testid="card-usdt-approve">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-sm text-amber-200">
                  {t(
                    'Complete one-time USDT setup so the escrow can pull your stake every match.',
                    'Complete one-time USDT setup so the escrow can pull your stake every match.'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('Costs ~30 TRX, only required once per wallet.', 'Costs ~30 TRX, only required once per wallet.')}
                </p>
                <Button
                  size="sm"
                  disabled={isApprovingUsdt}
                  onClick={handleApproveUsdt}
                  className="h-9 px-4 text-sm font-display font-bold uppercase tracking-wider bg-amber-500 text-black hover:bg-amber-400"
                  data-testid="button-approve-usdt"
                >
                  {isApprovingUsdt ? (
                    <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />{t('Approving...', 'Approving...')}</>
                  ) : (
                    t('Approve USDT', 'Approve USDT')
                  )}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {state.currentMatch && state.currentMatch.status === 'funding' && (
          <Card className="bg-primary/5 border-primary/30 p-4" data-testid="card-depositing">
            <div className="flex items-start gap-3">
              <Loader2 className="h-5 w-5 text-primary flex-shrink-0 mt-0.5 animate-spin" />
              <div className="flex-1 space-y-1">
                <p className="text-sm font-display font-bold uppercase tracking-wider text-primary">
                  {t('Depositing on-chain...', 'Depositing on-chain...')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'Confirm the transaction in your wallet. The match starts as soon as both deposits land.',
                    'Confirm the transaction in your wallet. The match starts as soon as both deposits land.'
                  )}
                </p>
              </div>
            </div>
          </Card>
        )}

        {needsNetworkSwitch && state.selectedAsset !== 'TON' && state.selectedAsset !== 'USDT' && requiredChain && (
          <Card className="bg-amber-500/5 border-amber-500/30 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <p className="text-sm text-amber-200">
                  {t('Please switch to')} <span className="font-bold text-white">{requiredChain.name}</span> {t('to play with')} <span className="font-bold text-white">{state.selectedAsset}</span>
                </p>
                {currentChainName && (
                  <p className="text-xs text-muted-foreground">
                    {t('Currently on')}: {currentChainName}
                  </p>
                )}
                <Button
                  size="sm"
                  disabled={isSwitchingChain}
                  onClick={() => switchToChain(requiredChain.chainId)}
                  className="h-9 px-4 text-sm font-display font-bold uppercase tracking-wider bg-amber-500 text-black hover:bg-amber-400"
                >
                  {isSwitchingChain ? (
                    <><RefreshCw className="h-3.5 w-3.5 mr-2 animate-spin" />{t('Switching...')}</>
                  ) : (
                    <>{t('Switch to')} {requiredChain.name}</>
                  )}
                </Button>
              </div>
            </div>
          </Card>
        )}

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
