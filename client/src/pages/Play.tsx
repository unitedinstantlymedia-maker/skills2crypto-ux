import { useEffect } from "react";
import { useLocation } from "wouter";

import { useGame } from "@/context/GameContext";
import { GameRenderer } from "@/components/games/GameRenderer";

export default function Play() {
  const { state, actions } = useGame();
  const [, setLocation] = useLocation();

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
      <GameRenderer
        match={match}
        onFinish={handleFinish}
      />
    </div>
  );
}
