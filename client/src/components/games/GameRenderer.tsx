import ChessGame from "./ChessGame";
import { TetrisGame } from "./TetrisGame";
import { CheckersGame } from "./CheckersGame";
import { useLanguage } from "@/context/LanguageContext";
import type { Match } from "@/core/types";

export interface GameRendererProps {
  match: Match;
  onFinish: (result: "win" | "loss" | "draw") => void;
}

type GameComponent = React.ComponentType<{
  matchId: string;
  playerId: string;
  onFinish: (result: "win" | "loss" | "draw") => void;
}>;

const gameRegistry: Record<string, GameComponent> = {
  chess: ChessGame as GameComponent,
  tetris: TetrisGame as unknown as GameComponent,
  checkers: CheckersGame as unknown as GameComponent,
};

export function GameRenderer({ match, onFinish }: GameRendererProps) {
  const { t } = useLanguage();
  
  const playerId = match.players?.[0] || "player1";
  const gameKey = match.game.toLowerCase();
  const GameComponent = gameRegistry[gameKey];

  if (!GameComponent) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <div className="text-destructive text-xl font-bold">
          {t("game.error", "Game Error")}
        </div>
        <div className="text-muted-foreground text-center">
          {t("game.adapterMissing", "Game adapter not found for")}: <strong>{match.game}</strong>
        </div>
        <div className="text-sm text-muted-foreground">
          {t("game.availableGames", "Available games")}: {Object.keys(gameRegistry).join(", ")}
        </div>
      </div>
    );
  }

  const handleFinish = (result: "win" | "loss" | "draw" | {
    winnerId?: string;
    loserId?: string;
    draw?: boolean;
    reason?: string;
  }) => {
    if (typeof result === "string") {
      onFinish(result);
    } else {
      const simpleResult: "win" | "loss" | "draw" = result.draw
        ? "draw"
        : result.winnerId === playerId
        ? "win"
        : "loss";
      onFinish(simpleResult);
    }
  };

  return (
    <GameComponent
      matchId={match.id}
      playerId={playerId}
      onFinish={handleFinish}
    />
  );
}

export function getAvailableGames(): string[] {
  return Object.keys(gameRegistry);
}
