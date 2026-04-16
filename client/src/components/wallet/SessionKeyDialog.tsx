import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, AlertTriangle, Zap, Gamepad2, CheckCircle2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

type OnboardingStep = 'ready' | 'signing' | 'registering' | 'done';

interface SessionKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSign: () => void;
  step: OnboardingStep;
  error: string | null;
}

export function SessionKeyDialog({
  open,
  onOpenChange,
  onSign,
  step,
  error,
}: SessionKeyDialogProps) {
  const { t } = useLanguage();
  const isLoading = step === 'signing' || step === 'registering';

  const getButtonText = () => {
    switch (step) {
      case 'signing':
        return t('Signing...', 'Signing...');
      case 'registering':
        return t('Registering...', 'Registering...');
      default:
        return t('Authorize', 'Authorize');
    }
  };

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

          {isLoading && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                {step === 'signing' ? (
                  <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                ) : (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                )}
                <span className={step !== 'signing' ? 'text-emerald-400' : ''}>
                  {t('Step 1: Session key', 'Step 1: Session key')}
                </span>
              </div>
              {step === 'registering' && (
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                  <span>{t('Step 2: On-chain registration', 'Step 2: On-chain registration')}</span>
                </div>
              )}
            </div>
          )}
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
            {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {getButtonText()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
