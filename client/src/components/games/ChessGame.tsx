import { useState, useCallback, useEffect } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useLanguage } from "@/context/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Crown, Flag } from "lucide-react";

type Result = "win" | "loss" | "draw";

interface ChessGameProps {
  onFinish: (result: Result) => void;
}

export function ChessGame({ onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const [game, setGame] = useState(new Chess());
  const [gamePosition, setGamePosition] = useState(game.fen());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [playerColor] = useState<"white" | "black">("white");

  // Update game status when position changes
  useEffect(() => {
    if (game.isCheckmate()) {
      const winner = game.turn() === "w" ? "Black" : "White";
      console.log(`Checkmate! ${winner} wins!`);
    } else if (game.isGameOver()) {
      console.log("Game Over!");
    }
  }, [gamePosition, game]);

  const makeMove = useCallback((sourceSquare: string, targetSquare: string) => {
    try {
      const move = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });

      if (move) {
        setGamePosition(game.fen());
        setMoveHistory(prev => [...prev, move.san]);
        return true;
      }
    } catch (error) {
      console.log("Invalid move:", error);
    }
    return false;
  }, [game]);

  const onPieceDrop = (sourceSquare: string, targetSquare: string) => {
    return makeMove(sourceSquare, targetSquare);
  };

  const handleResign = () => {
    onFinish("loss");
  };

  const handleOfferDraw = () => {
    onFinish("draw");
  };

  const handleClaimWin = () => {
    onFinish("win");
  };

  const resetGame = () => {
    const newGame = new Chess();
    setGame(newGame);
    setGamePosition(newGame.fen());
    setMoveHistory([]);
  };

  const getGameStatus = () => {
    if (game.isCheckmate()) {
      const winner = game.turn() === "w" ? "Black" : "White";
      return `Checkmate! ${winner} wins!`;
    }
    if (game.isDraw()) return "Draw!";
    if (game.isStalemate()) return "Stalemate - Draw!";
    if (game.isThreefoldRepetition()) return "Draw by threefold repetition!";
    if (game.isInsufficientMaterial()) return "Draw by insufficient material!";
    if (game.isCheck()) return "Check!";
    return `${game.turn() === "w" ? "White" : "Black"} to move`;
  };

  return (
    <div className="w-full space-y-4">
      {/* Game Status */}
      <Card className="bg-card/50 border-white/10 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {game.isCheck() && <Crown className="h-5 w-5 text-yellow-500 animate-pulse" />}
            <span className="font-mono text-sm font-bold">
              {getGameStatus()}
            </span>
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            {t("Move", "Move")} #{Math.floor(moveHistory.length / 2) + 1}
          </div>
        </div>
      </Card>

      {/* Chess Board */}
      <div className="w-full aspect-square max-w-[500px] mx-auto rounded-lg overflow-hidden border-2 border-white/20 shadow-2xl">
        <Chessboard
          position={gamePosition}
          onPieceDrop={onPieceDrop}
          boardOrientation={playerColor}
          customBoardStyle={{
            borderRadius: "4px",
          }}
          customDarkSquareStyle={{
            backgroundColor: "#4a4a4a",
          }}
          customLightSquareStyle={{
            backgroundColor: "#e8e8e8",
          }}
        />
      </div>

      {/* Move History */}
      {moveHistory.length > 0 && (
        <Card className="bg-card/50 border-white/10 p-3 max-h-32 overflow-y-auto">
          <div className="text-xs font-mono space-y-1">
            <div className="font-bold text-muted-foreground mb-2">
              {t("Move History", "Move History")}:
            </div>
            <div className="grid grid-cols-2 gap-x-4">
              {moveHistory.map((move, index) => (
                <div key={index} className="flex gap-2">
                  <span className="text-muted-foreground">
                    {index % 2 === 0 ? `${Math.floor(index / 2) + 1}.` : ""}
                  </span>
                  <span>{move}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Game Controls */}
      <div className="flex gap-2 flex-wrap justify-center">
        <Button
          onClick={resetGame}
          variant="outline"
          size="sm"
          className="text-xs"
        >
          {t("Reset Board", "Reset Board")}
        </Button>

        {game.isGameOver() && (
          <>
            {game.isCheckmate() && (
              <Button
                onClick={handleClaimWin}
                variant="default"
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-xs"
              >
                <Crown className="h-3 w-3 mr-1" />
                {t("Claim Victory", "Claim Victory")}
              </Button>
            )}
            {(game.isDraw() || game.isStalemate()) && (
              <Button
                onClick={handleOfferDraw}
                variant="default"
                size="sm"
                className="bg-yellow-600 hover:bg-yellow-700 text-xs"
              >
                {t("Accept Draw", "Accept Draw")}
              </Button>
            )}
          </>
        )}

        {!game.isGameOver() && (
          <>
            <Button
              onClick={handleOfferDraw}
              variant="outline"
              size="sm"
              className="text-xs"
            >
              {t("Offer Draw", "Offer Draw")}
            </Button>
            <Button
              onClick={handleResign}
              variant="destructive"
              size="sm"
              className="text-xs"
            >
              <Flag className="h-3 w-3 mr-1" />
              {t("Resign", "Resign")}
            </Button>
          </>
        )}
      </div>

      {/* Game Over Message */}
      {game.isGameOver() && (
        <Card className="bg-primary/10 border-primary/30 p-4 text-center">
          <p className="font-display font-bold text-lg text-primary">
            {game.isCheckmate() && t("Game Over - Checkmate!", "Game Over - Checkmate!")}
            {game.isDraw() && t("Game Over - Draw!", "Game Over - Draw!")}
            {game.isStalemate() && t("Game Over - Stalemate!", "Game Over - Stalemate!")}
          </p>
        </Card>
      )}
    </div>
  );
}