import { useEffect } from "react";
import { useLocation } from "wouter";

import { useGame } from "@/context/GameContext";
import { useLanguage } from "@/context/LanguageContext";

import ChessGame from "@/components/games/ChessGame";
import { TetrisGame } from "@/components/games/TetrisGame";
import { CheckersGame } from "@/components/games/CheckersGame";

import { Button } from "@/components/ui/button";

export default function Play() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();

  useEffect(() => {
    if (!state.currentMatch) {
      setLocation("/");
    }
  }, [state.currentMatch, setLocation]);

  if (!state.currentMatch) {
    return null;
  }

  const { game, id: matchId } = state.currentMatch;
  const playerId = state.currentMatch.players?.[0] || "player1";

  const handleFinish = async (
    result:
      | "win"
      | "loss"
      | "draw"
      | {
          winnerId?: string;
          loserId?: string;
          draw?: boolean;
          reason?: string;
        }
  ) => {
    if (typeof result === "string") {
      await actions.finishMatch(result);
    } else {
      const simpleResult = result.draw
        ? "draw"
        : result.winnerId === playerId
        ? "win"
        : "loss";

      await actions.finishMatch(simpleResult);
    }

    setLocation("/result");
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold">
          {t("game.playing")} — {game.toUpperCase()}
        </h1>

        <Button
          variant="destructive"
          onClick={() => setLocation("/")}
        >
          {t("game.exit")}
        </Button>
      </div>

      {game === "Chess" && (
        <ChessGame
          matchId={matchId}
          playerId={playerId}
          onFinish={handleFinish}
        />
      )}

      {game === "Tetris" && (
        <TetrisGame onFinish={(r) => handleFinish(r)} />
      )}

      {game === "Checkers" && (
        <CheckersGame onFinish={(r) => handleFinish(r)} />
      )}
    </div>
  );
}
