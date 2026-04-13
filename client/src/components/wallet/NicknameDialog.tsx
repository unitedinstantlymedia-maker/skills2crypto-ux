import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/context/LanguageContext";

interface NicknameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (nickname: string) => void;
}

export function NicknameDialog({ open, onOpenChange, onSave }: NicknameDialogProps) {
  const [value, setValue] = useState("");
  const { t } = useLanguage();

  const handleSave = () => {
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 20) return;
    onSave(trimmed);
    onOpenChange(false);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm bg-zinc-950 border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-xl font-display font-bold uppercase tracking-wider text-center">
            {t('Choose Nickname')}
          </DialogTitle>
          <DialogDescription className="text-center text-muted-foreground">
            {t('This will be shown to your opponent')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('Enter your name or nickname')}
            maxLength={20}
            className="h-12 bg-zinc-900 border-white/10 text-white text-center text-lg font-display"
            autoFocus
          />
          <div className="text-center text-xs text-muted-foreground">
            2–20 {t('characters')}
          </div>
          <Button
            onClick={handleSave}
            disabled={value.trim().length < 2}
            className="w-full h-12 font-display font-bold uppercase tracking-wider"
          >
            {t('Continue')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
