import { useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useGame } from "@/context/GameContext";
import { useLanguage } from "@/context/LanguageContext";

import { ChessGame } from "@/components/games/ChessGame";
import { TetrisGame } from "@/components/games/TetrisGame";
import { CheckersGame } from "@/components/games/CheckersGame";
import { WaitingRoom } from "@/components/games/WaitingRoom";

// ВАЖНО: selectedGame = 'chess' | 'tetris' | 'checkers' | 'battleship'
export default function Play() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();

  // если матча нет — уходим на главную
  useEffect(() => {
    if (!state.currentMatch) setLocation("/");
  }, [state.currentMatch, setLocation]);

  const handleFinish = async (result: "win" | "loss" | "draw") => {
    await actions.finishMatch(result);
    setLocation("/result");
  };

  // компонент активной игры по ключу
  const ActiveGame = useMemo(() => {
    switch (state.selectedGame) {
      case "chess":
        return () => <ChessGame onFinish={handleFinish} />;
      case "tetris":
        return () => <TetrisGame onFinish={handleFinish} />;
      case "checkers":
        return () => <CheckersGame onFinish={handleFinish} />;
      case "battleship":
        return () => (
          <div className="flex flex-col items-center justify-center text-center space-y-4 animate-in fade-in duration-500">
            <div className="w-24 h-24 rounded-full bg-blue-500/10 flex items-center justify-center border border-blue-500/20">
              <span className="text-4xl">🚢</span>
            </div>
            <h2 className="text-2xl font-display font-bold uppercase tracking-wider text-blue-400">
              Battleship
            </h2>
            <p className="text-muted-foreground font-mono">
              {t("Game interface coming soon!", "Game interface coming soon!")}
            </p>
          </div>
        );
      default:
        return null;
    }
  }, [state.selectedGame]); // eslint-disable-line

  if (!state.selectedGame) return null;

  // оба игрока должны быть в currentMatch.players
  const hasBothPlayers =
    (state.currentMatch?.players?.filter(Boolean).length ?? 0) === 2;

  // если второго ещё нет — экран ожидания
  if (!hasBothPlayers) return <WaitingRoom />;

  const pot = ((state.currentMatch?.stake ?? 0) * 2).toFixed(0);

  return (
    <div className="h-full flex flex-col">
      {/* верхняя строка статуса */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="font-mono text-xs uppercase text-muted-foreground">
            {t("Live Match", "Live Match")}
          </span>
        </div>
        <div className="font-mono font-bold text-primary">
          {t("Pot", "Pot")}: {pot} {state.selectedAsset}
        </div>
      </div>

      {/* игровое поле */}
      <div className="flex-1 flex items-center justify-center">
        {ActiveGame && <ActiveGame />}
      </div>

      {/* КНОПКИ РЕЗУЛЬТАТА — ОТДЕЛЬНЫМ БЛОКОМ НИЖЕ КВАДРАТА И ВЫШЕ НАВИГАЦИИ */}
      <div className="flex justify-center gap-2 mb-4">
        <Button onClick={() => handleFinish("win")} className="bg-green-600 hover:bg-green-700 text-white">
          {t("Victory", "Victory")}
        </Button>
        <Button onClick={() => handleFinish("draw")} className="bg-yellow-500 hover:bg-yellow-600 text-white">
          {t("Draw", "Draw")}
        </Button>
        <Button variant="destructive" onClick={() => handleFinish("loss")}>
          {t("Defeat", "Defeat")}
        </Button>
      </div>
    </div>
  );
}