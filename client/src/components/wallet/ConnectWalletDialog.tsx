import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConnect } from "wagmi";
import { useLanguage } from "@/context/LanguageContext";
import { isTronLinkAvailable } from "@/core/wallet/TronWallet";
import { Check } from "lucide-react";

interface ConnectWalletDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTronConnect: () => Promise<string | null>;
  isEvmConnected: boolean;
  isTronConnected: boolean;
  evmAddress: string | null;
  tronAddress: string | null;
}

export function ConnectWalletDialog({
  open,
  onOpenChange,
  onTronConnect,
  isEvmConnected,
  isTronConnected,
  evmAddress,
  tronAddress,
}: ConnectWalletDialogProps) {
  const { connectors, connect, isPending } = useConnect();
  const { t } = useLanguage();

  const handleEvmConnect = (connectorIndex: number) => {
    const connector = connectors[connectorIndex];
    if (connector) {
      connect(
        { connector },
        {
          onSuccess: () => {
            if (isTronConnected) onOpenChange(false);
          },
        }
      );
    }
  };

  const handleTronConnect = async () => {
    const addr = await onTronConnect();
    if (addr && isEvmConnected) {
      onOpenChange(false);
    }
  };

  const shortenAddr = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-zinc-950 border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-xl font-display font-bold uppercase tracking-wider text-center">
            {t('Connect Wallet')}
          </DialogTitle>
          <DialogDescription className="text-center text-muted-foreground">
            {t('Connect your wallets to play and see your real balances.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <span className="text-blue-400">ETH</span> / <span className="text-yellow-400">BNB</span>
              <span className="text-muted-foreground/60">— EVM Wallet</span>
            </div>

            {isEvmConnected ? (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                <Check className="h-4 w-4 text-green-500" />
                <span className="text-sm text-green-400 font-mono">{shortenAddr(evmAddress!)}</span>
              </div>
            ) : (
              <div className="space-y-2">
                {connectors.map((connector, i) => (
                  <Button
                    key={connector.uid}
                    variant="outline"
                    className="w-full justify-start gap-3 h-12 bg-zinc-900 border-white/10 hover:bg-zinc-800 hover:border-white/20"
                    onClick={() => handleEvmConnect(i)}
                    disabled={isPending}
                  >
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-yellow-500 flex items-center justify-center text-white font-bold text-xs">
                      {connector.name === 'WalletConnect' ? 'WC' : '🦊'}
                    </div>
                    <span className="font-medium">{connector.name}</span>
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-white/10 pt-4 space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <span className="text-green-400">USDT</span>
              <span className="text-muted-foreground/60">— Tron (TRC-20)</span>
            </div>

            {isTronConnected ? (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                <Check className="h-4 w-4 text-green-500" />
                <span className="text-sm text-green-400 font-mono">{shortenAddr(tronAddress!)}</span>
              </div>
            ) : isTronLinkAvailable() ? (
              <Button
                variant="outline"
                className="w-full justify-start gap-3 h-12 bg-zinc-900 border-white/10 hover:bg-zinc-800 hover:border-white/20"
                onClick={handleTronConnect}
              >
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white font-bold text-xs">
                  T
                </div>
                <span className="font-medium">TronLink</span>
              </Button>
            ) : (
              <div className="p-3 rounded-lg bg-zinc-900 border border-white/5 text-sm text-muted-foreground">
                {t('Install TronLink extension for USDT (TRC-20) support')}
              </div>
            )}
          </div>

          {(isEvmConnected || isTronConnected) && (
            <Button
              variant="default"
              className="w-full h-12 mt-2 font-display font-bold uppercase tracking-wider"
              onClick={() => onOpenChange(false)}
            >
              {t('Done')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
