import { useLanguage } from "@/context/LanguageContext";

type Result = "win" | "loss" | "draw";

export function BattleshipGame({
  onFinish,
}: {
  onFinish: (result: Result) => void;
}) {
  const { t } = useLanguage();

  return (
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
  );
}
