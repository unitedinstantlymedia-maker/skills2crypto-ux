import { GameShell } from "./GameShell";

export function ChessGame({ onFinish }: { onFinish: (r: "win" | "draw" | "loss") => void }) {
  return (
    <GameShell
      pot="40 USDT"
      onVictory={() => onFinish("win")}
      onDraw={() => onFinish("draw")}
      onDefeat={() => onFinish("loss")}
    >
      <div className="flex items-center justify-center h-full text-white/40">
        Chess Engine Placeholder
      </div>
    </GameShell>
  );
}
