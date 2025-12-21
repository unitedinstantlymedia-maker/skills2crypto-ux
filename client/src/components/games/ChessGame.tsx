import { useLanguage } from "@/context/LanguageContext";

export function ChessGame({ onFinish }: { onFinish: (result: 'win' | 'loss') => void }) {
  const { t } = useLanguage();

  return (
    <div className="w-full aspect-square bg-black/40 border-2 border-white/10 rounded-lg grid grid-cols-8 grid-rows-8 relative overflow-hidden">
      {/* Checkered background */}
      {Array.from({ length: 64 }).map((_, i) => {
        const x = i % 8;
        const y = Math.floor(i / 8);
        const isBlack = (x + y) % 2 === 1;
        return (
          <div 
            key={i} 
            className={`${isBlack ? 'bg-white/5' : 'bg-transparent'}`} 
          />
        );
      })}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-muted-foreground text-sm font-mono bg-black/80 px-4 py-2 rounded">
          {t('Chess Engine Placeholder', 'Chess Engine Placeholder')}
        </span>
      </div>
    </div>
  );
}
