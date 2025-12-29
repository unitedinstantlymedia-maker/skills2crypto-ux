import { useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useGame } from "@/context/GameContext";
import { useLanguage } from "@/context/LanguageContext";

import { ChessGame } from "@/components/games/ChessGame";
import { TetrisGame } from "@/components/games/TetrisGame";
import { CheckersGame } from "@/components/games/CheckersGame";
import { WaitingRoom } from "@/components/games/WaitingRoom";
import { ErrorBoundary } from "@/components/system/ErrorBoundary";

export default function Play() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();

  useEffect(() => {
    if (!state.currentMatch) {
      setLocation("/");
    }
  }, [state.currentMatch, setLocation]);

  const handleFinish = async (result: "win" | "loss" | "draw") => {
    await actions.finishMatch(result);
    setLocation("/result");
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
  }, [state.selectedGame]); // eslint-disable-line

  if (!state.selectedGame || !state.currentMatch) return null;

  const hasBothPlayers = (state.currentMatch?.players?.filter(Boolean).length ?? 0) === 2;

  if (!hasBothPlayers) return <WaitingRoom />;

  const pot = ((state.currentMatch?.stake ?? 0) * 2).toFixed(0);

  return (
    <div className="h-full flex flex-col">
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
    </div>
  );
}
