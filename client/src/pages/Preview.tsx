
import { useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useGame } from "@/context/GameContext";
import { useLanguage } from "@/context/LanguageContext";
import { ArrowLeft } from "lucide-react";

import { ChessGame } from "@/components/games/ChessGame";
import { TetrisGame } from "@/components/games/TetrisGame";
import { CheckersGame } from "@/components/games/CheckersGame";
import { ErrorBoundary } from "@/components/system/ErrorBoundary";

export default function Preview() {
  const { state } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();

  useEffect(() => {
    if (!state.selectedGame) setLocation("/games");
  }, [state.selectedGame, setLocation]);

  const handleFinish = async (result: "win" | "loss" | "draw") => {
    console.log("Preview ended with result:", result);
    setLocation("/games");
  };

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
  }, [state.selectedGame]);

  if (!state.selectedGame) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button
            onClick={() => setLocation("/games")}
            size="icon"
            variant="ghost"
            className="h-10 w-10 rounded-full"
          >
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <div>
            <h1 className="text-2xl font-display font-bold uppercase tracking-wider">
              {t("Preview Mode", "Preview Mode")}
            </h1>
            <p className="text-muted-foreground text-sm">{state.selectedGame}</p>
          </div>
        </div>
        <div className="px-3 py-1 rounded-full bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 text-xs font-mono uppercase">
          {t("Practice", "Practice")}
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <ErrorBoundary
          fallback={
            <div className="p-4 text-center text-sm text-red-300 bg-red-900/20 rounded-lg">
              Game crashed.{" "}
              <button className="underline" onClick={() => location.reload()}>
                Reload
              </button>
            </div>
          }
        >
          {ActiveGame && <ActiveGame />}
        </ErrorBoundary>
      </div>

      <div className="flex justify-center gap-2 mt-4">
        <Button
          onClick={() => setLocation("/games")}
          variant="outline"
          className="font-display uppercase tracking-widest"
        >
          {t("Back to Games", "Back to Games")}
        </Button>
      </div>
    </div>
  );
}
