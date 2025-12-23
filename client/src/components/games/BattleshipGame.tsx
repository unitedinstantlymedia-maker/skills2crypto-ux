import { useLanguage } from "@/context/LanguageContext";

type Result = "win" | "loss" | "draw";

export function BattleshipGame({ onFinish }: { onFinish: (result: Result) => void }) {
  const { t } = useLanguage();

  return (
    <div className="w-full aspect-square bg-black/40 border-2 border-white/10 rounded-lg relative overflow-hidden p-6">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/10" />
      </div>

      <div className="h-full flex flex-col items-center justify-center gap-6">
        <h2 className="text-2xl font-display font-bold uppercase tracking-wider text-blue-400">
          {t("Battleship", "Battleship")}
        </h2>

        <div className="grid grid-cols-2 gap-6">
          <Board label={t("Your Grid", "Your Grid")} />
          <Board label={t("Enemy Grid", "Enemy Grid")} />
        </div>

        <p className="text-xs text-white/40 font-mono">
          {t("UI Placeholder — logic coming next", "UI Placeholder — logic coming next")}
        </p>
      </div>
    </div>
  );
}

function Board({ label }: { label: string }) {
  return (
    <div className="w-40 h-40 bg-white/5 border border-white/10 rounded-lg grid grid-cols-10 grid-rows-10 overflow-hidden relative">
      {Array.from({ length: 100 }).map((_, i) => (
        <div key={i} className="border border-white/5" />
      ))}
      <div className="absolute inset-0 flex items-center justify-center text-white/40 text-[10px] font-mono">
        {label}
      </div>
    </div>
  );
}