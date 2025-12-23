import { useLanguage } from "@/context/LanguageContext";

type Result = "win" | "loss" | "draw";

export function CheckersGame({ onFinish }: { onFinish: (result: Result) => void }) {
  const { t } = useLanguage();

  return (
    <div className="w-full aspect-square bg-black/40 border-2 border-white/10 rounded-lg grid grid-cols-8 grid-rows-8 relative overflow-hidden">
      {Array.from({ length: 64 }).map((_, i) => {
        const x = i % 8;
        const y = Math.floor(i / 8);
        const isBlack = (x + y) % 2 === 1;
        return (
          <div key={i} className={`${isBlack ? "bg-white/5" : "bg-transparent"} flex items-center justify-center`}>
            {isBlack && y < 3 && <div className="w-3/4 h-3/4 rounded-full bg-primary/50" />}
            {isBlack && y > 4 && <div className="w-3/4 h-3/4 rounded-full bg-accent/50" />}
          </div>
        );
      })}
    </div>
  );
}