import { useGame } from "@/context/GameContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Wallet as WalletIcon, ShieldCheck } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export default function Wallet() {
  const { state, actions } = useGame();
  const { wallet } = state;
  const { t } = useLanguage();

  const handleConnect = async () => {
    await actions.connectWallet();
  };

  if (!wallet.connected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl animate-pulse" />
          <div className="relative h-20 w-20 rounded-full bg-card border border-white/10 flex items-center justify-center">
            <WalletIcon className="h-10 w-10 text-primary" />
          </div>
        </div>
        
        <div className="space-y-2">
          <h1 className="text-3xl font-display font-bold uppercase tracking-wider">{t('Connect Wallet', 'Connect Wallet')}</h1>
          <p className="text-muted-foreground max-w-xs mx-auto">
            {t('Connect your non-custodial wallet to play. No registration required.', 'Connect your non-custodial wallet to play. No registration required.')}
          </p>
        </div>

        <Button 
          onClick={handleConnect}
          className="h-14 px-8 text-lg font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow"
        >
          {t('Connect Now', 'Connect Now')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('My Wallet', 'My Wallet')}</h1>
      </div>

      {/* Connected Status */}
      <Card className="bg-gradient-to-br from-primary/10 to-card border-primary/30">
        <CardHeader className="pb-2">
          <div className="flex justify-between items-start">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <CardTitle className="text-sm text-primary font-bold uppercase tracking-wider">{t('Connected Securely', 'Connected Securely')}</CardTitle>
              </div>
              <div className="flex items-center gap-2 font-mono text-lg text-white">
                {wallet.address}
                <Copy className="h-4 w-4 text-muted-foreground cursor-pointer hover:text-white" />
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* User Balances */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t('Your Balances', 'Your Balances')}</h2>
          <span className="text-[10px] font-mono text-primary/70 border border-primary/30 px-2 py-1 rounded">{t('Test mode (simulated)', 'Test mode (simulated)')}</span>
        </div>
        
        {(['USDT', 'ETH', 'BNB'] as const).map((asset) => (
          <Card key={asset} className="bg-card/50 border-white/10">
            <CardContent className="p-4 flex justify-between items-center">
              <div className="flex items-center gap-3">
                {asset === 'USDT' && (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="20" cy="20" r="18" fill="#26A17B" />
                    <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(38,161,123,0.4)" strokeWidth="1" />
                    <path d="M16 13H24V15.5H21.5V27H18.5V15.5H16V13Z" fill="white" />
                  </svg>
                )}
                {asset === 'ETH' && (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="20" cy="20" r="18" fill="#3C3C3D" />
                    <path d="M20 6L28 20L20 26L12 20L20 6Z" fill="#8A92B2" />
                    <path d="M20 26L28 20L20 34L12 20L20 26Z" fill="#62688F" />
                    <path d="M20 6L28 20L20 23L12 20L20 6Z" fill="none" stroke="rgba(138,146,178,0.3)" strokeWidth="0.5" />
                  </svg>
                )}
                {asset === 'BNB' && (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="20" cy="20" r="18" fill="#F3BA2F" />
                    <path d="M20 10L23.5 13.5L18 19L15 16L20 10Z" fill="white" />
                    <path d="M25 14L28 17L25 20L22 17L25 14Z" fill="white" />
                    <path d="M20 19L23.5 22.5L18 28L15 25L20 19Z" fill="white" />
                    <path d="M15 14L18 17L15 20L12 17L15 14Z" fill="white" />
                    <path d="M20 16L22.5 18.5L20 21L17.5 18.5L20 16Z" fill="white" />
                  </svg>
                )}
                <span className="font-display font-bold">{asset}</span>
              </div>
              <div className="font-mono font-bold text-lg">
                {(wallet.balances[asset] ?? 0).toFixed(4)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Platform Fees (Transparency) removed as per request */}
    </div>
  );
}
