import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, AlertTriangle, Zap, Gamepad2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface SessionKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSign: () => void;
  isSigning: boolean;
  isRegistering: boolean;
  error: string | null;
}

export function SessionKeyDialog({
  open,
  onOpenChange,
  onSign,
  isSigning,
  isRegistering,
  error,
}: SessionKeyDialogProps) {
  const { t } = useLanguage();
  const isLoading = isSigning || isRegistering;

  return (
    <Dialog open={open} onOpenChange={isLoading ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md bg-zinc-900 border-zinc-700 text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white text-lg">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            {t('Authorize Seamless Gaming', 'Authorize Seamless Gaming')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-zinc-300 text-sm leading-relaxed">
            {t('session_key_description', 'To let you play matches instantly without approving every transaction, please sign a one-time permission. This allows the game server to handle deposits and payouts automatically.')}
          </p>

          <div className="space-y-2.5">
            <div className="flex items-start gap-2.5">
              <Zap className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <span className="text-sm text-zinc-300">
                {t('session_key_benefit_1', 'No more popups when you find a match.')}
              </span>
            </div>
            <div className="flex items-start gap-2.5">
              <Gamepad2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <span className="text-sm text-zinc-300">
                {t('session_key_benefit_2', "Just click 'Find Match' and play.")}
              </span>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-950/50 border border-red-800">
            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
            className="text-zinc-400"
          >
            {t('Skip for now', 'Skip for now')}
          </Button>
          <Button
            onClick={onSign}
            disabled={isLoading}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {isSigning && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isRegistering && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isSigning
              ? t('Signing...', 'Signing...')
              : isRegistering
                ? t('Registering...', 'Registering...')
                : t('Authorize', 'Authorize')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
