import { Button } from "@/components/ui/button";
import { useLanguage } from "@/context/LanguageContext";
import { GameShell } from "./GameShell";

type Result = "win" | "loss" | "draw";

export function BattleshipGame({
  onFinish,
}: {
  onFinish: (result: Result) => void;
}) {
  const { t } = useLanguage();

  return (
    <GameShell>
      <div className="flex flex-col items-center justify-center h-full space-y-6">
        <div className="w-full max-w-md aspect-square bg-black/40 border border-white/10 rounded-xl flex flex-col items-center justify-center space-y-4">
          <div className="text-lg text-white/70 tracking-wide">
            Battleship
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="w-40 h-40 bg-white/5 border border-white/10 rounded-lg flex items-center justify-center text-white/40 text-sm">
              Your Grid
            </div>
            <div className="w-40 h-40 bg-white/5 border border-white/10 rounded-lg flex items-center justify-center text-white/40 text-sm">
              Enemy Grid
            </div>
          </div>

          <div className="text-xs text-white/40">
            UI Placeholder — logic coming next
          </div>
        </div>

        {/* DEV CONTROLS (same pattern as others) */}
        <div className="flex gap-2">
          <Button variant="success" onClick={() => onFinish("win")}>
            Victory
          </Button>
          <Button variant="warning" onClick={() => onFinish("draw")}>
            Draw
          </Button>
          <Button variant="destructive" onClick={() => onFinish("loss")}>
            Defeat
          </Button>
        </div>
      </div>
    </GameShell>
  );
}
