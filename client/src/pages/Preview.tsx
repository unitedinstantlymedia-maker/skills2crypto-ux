
import { useGame } from "@/context/GameContext";
import { useLocation, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

import { ChessGame } from "@/components/games/ChessGame";
import { TetrisGame } from "@/components/games/TetrisGame";
import { CheckersGame } from "@/components/games/CheckersGame";
import { ErrorBoundary } from "@/components/system/ErrorBoundary";

export default function Preview() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();
  const params = useParams();
  const gameId = params.game || state.selectedGame;

  const handleFinish = async (result: "win" | "loss" | "draw") => {
    // In preview mode, just show a toast or message
    console.log(`Preview ended with result: ${result}`);
    alert(`Preview ended: ${result}`);
  };

  const renderGame = () => {
    switch (gameId) {
      case "chess":
        return <ChessGame onFinish={handleFinish} isPreview={true} />;
      case "tetris":
        return <TetrisGame onFinish={handleFinish} />;
      case "checkers":
        return <CheckersGame onFinish={handleFinish} />;
      case "battleship":
        return (
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
        return (
          <div className="text-center text-muted-foreground">
            {t("No game selected", "No game selected")}
          </div>
        );
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Button
          size="icon"
          variant="ghost"
          className="h-10 w-10 rounded-full"
          onClick={() => setLocation("/games")}
        >
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <div>
          <h1 className="text-2xl font-display font-bold uppercase tracking-wider">
            {t("Preview Mode", "Preview Mode")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {gameId} - {t("Test the game mechanics", "Test the game mechanics")}
          </p>
        </div>
      </div>

      {/* Game Container */}
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
          {renderGame()}
        </ErrorBoundary>
      </div>

      {/* Info Footer */}
      <div className="mt-4 p-4 bg-card/50 border border-white/10 rounded-lg text-center">
        <p className="text-xs text-muted-foreground">
          {t("This is preview mode. No wagers or matchmaking involved.", "This is preview mode. No wagers or matchmaking involved.")}
        </p>
      </div>
    </div>
  );
}
