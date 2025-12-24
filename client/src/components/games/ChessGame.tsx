
import { useState, useCallback, useEffect } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useLanguage } from "@/context/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Crown, Clock, Flag } from "lucide-react";

type Result = "win" | "loss" | "draw";

interface ChessGameProps {
  onFinish: (result: Result) => void;
}

export function ChessGame({ onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const [game, setGame] = useState(new Chess());
  const [gamePosition, setGamePosition] = useState(game.fen());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [playerColor] = useState<"white" | "black">("white"); // In real multiplayer, this would be determined by matchmaking
  const [gameStatus, setGameStatus] = useState<string>("");
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);

  // Update game status
  useEffect(() => {
    if (game.isCheckmate()) {
      const winner = game.turn() === "w" ? "Black" : "White";
      setGameStatus(`Checkmate! ${winner} wins!`);
    } else if (game.isDraw()) {
      setGameStatus("Draw!");
    } else if (game.isStalemate()) {
      setGameStatus("Stalemate - Draw!");
    } else if (game.isThreefoldRepetition()) {
      setGameStatus("Draw by threefold repetition!");
    } else if (game.isInsufficientMaterial()) {
      setGameStatus("Draw by insufficient material!");
    } else if (game.isCheck()) {
      setGameStatus("Check!");
    } else {
      setGameStatus(`${game.turn() === "w" ? "White" : "Black"} to move`);
    }
  }, [gamePosition, game]);

  // Calculate legal moves for selected piece
  const calculateLegalMoves = (square: string) => {
    const moves = game.moves({ square, verbose: true });
    return moves.map(move => move.to);
  };

  const makeMove = useCallback(
    (sourceSquare: string, targetSquare: string) => {
      try {
        // Create a copy of the game to test the move
        const gameCopy = new Chess(game.fen());
        const move = gameCopy.move({
          from: sourceSquare,
          to: targetSquare,
          promotion: "q", // Always promote to queen for simplicity
        });

        if (move) {
          setGame(gameCopy);
          setGamePosition(gameCopy.fen());
          setMoveHistory([...moveHistory, move.san]);
          setSelectedSquare(null);
          setLegalMoves([]);
          return true;
        }
      } catch (error) {
        console.log("Invalid move:", error);
      }
      return false;
    },
    [game, moveHistory]
  );

  const onSquareClick = (square: string) => {
    // If no square selected, select this square (if it has a piece - allow any color in preview)
    if (!selectedSquare) {
      const piece = game.get(square);
      if (piece) {
        setSelectedSquare(square);
        setLegalMoves(calculateLegalMoves(square));
      }
    } else {
      // Try to make a move
      const moved = makeMove(selectedSquare, square);
      if (!moved) {
        // If move failed, maybe selecting a different piece
        const piece = game.get(square);
        if (piece) {
          setSelectedSquare(square);
          setLegalMoves(calculateLegalMoves(square));
        } else {
          setSelectedSquare(null);
          setLegalMoves([]);
        }
      }
    }
  };

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
    setSelectedSquare(null);
    setLegalMoves([]);
  };

  // Custom square styles for legal moves and selection
  const customSquareStyles: { [square: string]: React.CSSProperties } = {};
  
  if (selectedSquare) {
    customSquareStyles[selectedSquare] = {
      backgroundColor: "rgba(255, 255, 0, 0.4)",
    };
  }

  legalMoves.forEach(square => {
    customSquareStyles[square] = {
      background: "radial-gradient(circle, rgba(0,255,0,0.3) 25%, transparent 25%)",
      borderRadius: "50%",
    };
  });

  return (
    <div className="w-full space-y-4">
      {/* Game Status */}
      <Card className="bg-card/50 border-white/10 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {game.isCheck() && <Crown className="h-5 w-5 text-yellow-500 animate-pulse" />}
            <span className="font-mono text-sm font-bold">
              {gameStatus}
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
          onSquareClick={onSquareClick}
          boardOrientation={playerColor}
          customSquareStyles={customSquareStyles}
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
