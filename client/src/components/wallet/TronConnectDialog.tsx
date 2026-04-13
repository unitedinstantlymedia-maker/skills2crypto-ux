import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/context/LanguageContext";
import { isTronLinkAvailable } from "@/core/wallet/TronWallet";
import { Check } from "lucide-react";

interface TronConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: () => Promise<string | null>;
  isTronConnected: boolean;
  tronAddress: string | null;
}

export function TronConnectDialog({
  open,
  onOpenChange,
  onConnect,
  isTronConnected,
  tronAddress,
}: TronConnectDialogProps) {
  const { t } = useLanguage();

  const handleConnect = async () => {
    const addr = await onConnect();
    if (addr) onOpenChange(false);
  };

  const shortenAddr = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm bg-zinc-950 border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-lg font-display font-bold uppercase tracking-wider text-center">
            USDT — Tron (TRC-20)
          </DialogTitle>
          <DialogDescription className="text-center text-muted-foreground">
            {t('Connect TronLink for USDT TRC-20 balance')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {isTronConnected && tronAddress ? (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
              <Check className="h-4 w-4 text-green-500" />
              <span className="text-sm text-green-400 font-mono">{shortenAddr(tronAddress)}</span>
            </div>
          ) : isTronLinkAvailable() ? (
            <Button
              variant="outline"
              className="w-full justify-start gap-3 h-12 bg-zinc-900 border-white/10 hover:bg-zinc-800 hover:border-white/20"
              onClick={handleConnect}
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

          {isTronConnected && (
            <Button
              variant="default"
              className="w-full h-10 font-display font-bold uppercase tracking-wider"
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
