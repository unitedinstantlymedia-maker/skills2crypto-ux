import { useState, useCallback, useEffect } from "react";
import { Chess, Square } from "chess.js";
import { Chessboard } from 'react-chessboard';
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Crown, Flag } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import * as THREE from "three"; // Keep this import, though it might not be directly used in the final component


type Result = "win" | "loss" | "draw";

interface ChessGameProps {
  onFinish: (result: Result) => void;
}

// ChessPiece component is removed as react-chessboard handles piece rendering.

// ChessBoard3D component is removed as react-chessboard is used instead.

export function ChessGame({ onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const [game, setGame] = useState(new Chess());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null); // Keep this state for potential future use or if you want to implement selection logic separately

  useEffect(() => {
    // Check for game over conditions
    if (game.isGameOver()) {
      if (game.isCheckmate()) {
        // If it's checkmate, the current player lost
        const result = game.turn() === 'w' ? 'loss' : 'win';
        onFinish(result);
      } else if (game.isDraw() || game.isStalemate() || game.isThreefoldRepetition() || game.isInsufficientMaterial()) {
        onFinish('draw');
      }
    }
  }, [game, onFinish]);

  const makeMove = useCallback((from: Square, to: Square) => {
    try {
      const newGame = new Chess(game.fen());
      const move = newGame.move({
        from,
        to,
        promotion: "q", // always promote to queen for simplicity
      });

      if (move) {
        setGame(newGame);
        setMoveHistory((prev) => [...prev, move.san]);
        setSelectedSquare(null); // Clear selection after a successful move
        return true;
      }
    } catch (error) {
      console.log("Invalid move:", error);
    }
    return false;
  }, [game]);

  const onSquareClick = useCallback((square: Square) => {
    // This logic is for the 3D board selection.
    // For react-chessboard, we primarily use onPieceDrop.
    // If you want to keep square selection visual feedback, you might need to add logic here
    // to highlight the selected square in the Chessboard component via customSquareStyles.
    if (!selectedSquare) {
      const piece = game.get(square);
      if (piece && piece.color === game.turn()) {
        setSelectedSquare(square);
      }
    } else {
      if (selectedSquare === square) {
        setSelectedSquare(null); // Deselect if the same square is clicked again
      } else {
        const moved = makeMove(selectedSquare, square);
        if (!moved) {
          // If the move was not made, check if the target square has a piece of the current player's color
          const piece = game.get(square);
          if (piece && piece.color === game.turn()) {
            setSelectedSquare(square); // Select the new piece
          } else {
            setSelectedSquare(null); // Deselect if it was an invalid move to an empty or opponent's square
          }
        }
      }
    }
  }, [selectedSquare, game, makeMove]);

  const onPieceDrop = useCallback(
    (sourceSquare: string, targetSquare: string) => {
      const moved = makeMove(sourceSquare as Square, targetSquare as Square);
      return moved; // Return true if move was successful, false otherwise
    },
    [makeMove]
  );

  const handleResign = () => onFinish("loss");
  const handleOfferDraw = () => onFinish("draw");
  const handleClaimWin = () => onFinish("win");

  const resetGame = () => {
    const newGame = new Chess();
    setGame(newGame);
    setMoveHistory([]);
    setSelectedSquare(null);
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

  // Custom square styles for highlighting selected square and showing legal moves (optional)
  const customSquareStyles = () => {
    const styles: { [key: string]: React.CSSProperties } = {};
    if (selectedSquare) {
      // Highlight the selected square
      styles[selectedSquare] = { backgroundColor: '#4a9eff' };

      // Highlight legal moves from the selected square
      const legalMoves = game.moves({ square: selectedSquare, verbose: true });
      legalMoves.forEach((move) => {
        styles[move.to] = { backgroundColor: '#2266cc' };
      });
    }
    return styles;
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

      {/* 2D Chess Board */}
      <div className="w-full aspect-square max-w-[500px] mx-auto rounded-lg overflow-hidden border-2 border-white/20 shadow-2xl bg-gradient-to-b from-slate-800 to-slate-900">
        <Chessboard
          position={game.fen()}
          onPieceDrop={onPieceDrop}
          boardWidth={500} // Adjust board width as needed
          customSquareStyles={customSquareStyles()}
          arePiecesDraggable={game.turn() === (game.turn() === 'w' ? 'w' : 'b')} // Enable dragging only for the current player
          onClick={onSquareClick} // Pass onSquareClick for selecting pieces
          customBoardStyle={{
            borderRadius: '8px',
            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
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