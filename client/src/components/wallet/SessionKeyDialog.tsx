import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';

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
  const isLoading = isSigning || isRegistering;

  return (
    <Dialog open={open} onOpenChange={isLoading ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            Authorize Game Sessions
          </DialogTitle>
          <DialogDescription className="text-zinc-400 pt-2 space-y-2">
            <span className="block">
              To play matches with real stakes, you need to sign a one-time authorization 
              that lets the game server manage deposits and settlements on your behalf.
            </span>
            <span className="block text-xs text-zinc-500">
              This creates a session key valid for 365 days. You can revoke it anytime. 
              Your funds remain in the smart contract escrow — the server can only 
              interact within the stake limits you authorize.
            </span>
          </DialogDescription>
        </DialogHeader>

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
            Skip for now
          </Button>
          <Button
            onClick={onSign}
            disabled={isLoading}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {isSigning && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isRegistering && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isSigning
              ? 'Sign in wallet...'
              : isRegistering
                ? 'Registering on-chain...'
                : 'Sign & Authorize'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
