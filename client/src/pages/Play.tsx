import { useEffect } from "react";
import { useLocation } from "wouter";

import { useGame } from "@/context/GameContext";
import { useLanguage } from "@/context/LanguageContext";

import { GameRenderer } from "@/components/games/GameRenderer";
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

  const match = state.currentMatch;

  const handleFinish = async (result: "win" | "loss" | "draw") => {
    await actions.finishMatch(result);
    setLocation("/result");
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold">
          {t("game.playing")} — {match.game.toUpperCase()}
        </h1>

        <Button
          variant="destructive"
          onClick={() => setLocation("/")}
        >
          {t("game.exit")}
        </Button>
      </div>

      <GameRenderer
        match={match}
        onFinish={handleFinish}
      />
    </div>
  );
}
