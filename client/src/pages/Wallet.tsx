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
        
        {(['USDT', 'ETH', 'TON'] as const).map((asset) => (
          <Card key={asset} className="bg-card/50 border-white/10">
            <CardContent className="p-4 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  asset === 'USDT' ? 'bg-green-500/20 text-green-500' :
                  asset === 'ETH' ? 'bg-blue-500/20 text-blue-500' :
                  'bg-blue-400/20 text-blue-400'
                }`}>
                  {asset[0]}
                </div>
                <span className="font-display font-bold">{asset}</span>
              </div>
              <div className="font-mono font-bold text-lg">
                {wallet.balances[asset].toFixed(4)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Platform Fees (Transparency) removed as per request */}
    </div>
  );
}
