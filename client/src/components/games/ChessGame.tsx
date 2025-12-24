import { useState } from "react";
import { useLanguage } from "@/context/LanguageContext";
import { Chess } from "chess.js";

interface ChessGameProps {
  onFinish: (result: "win" | "loss" | "draw") => void;
}

const PIECES_UNICODE = {
  p: "♟",
  r: "♜",
  n: "♞",
  b: "♝",
  q: "♛",
  k: "♚",
  P: "♙",
  R: "♖",
  N: "♘",
  B: "♗",
  Q: "♕",
  K: "♔",
};

export function ChessGame({ onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const [game] = useState(() => new Chess());
  const [position, setPosition] = useState(game.board());
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [moveHistory, setMoveHistory] = useState<string[]>([]);

  const handleSquareClick = (row: number, col: number) => {
    const square = `${String.fromCharCode(97 + col)}${8 - row}` as any;
    const piece = game.get(square);

    if (selectedSquare === null) {
      // Select a piece if it belongs to the current player
      if (piece && piece.color === game.turn()) {
        setSelectedSquare(square);
      }
    } else {
      // If clicking the same square, deselect
      if (selectedSquare === square) {
        setSelectedSquare(null);
        return;
      }

      // If clicking another piece of the same color, select it instead
      if (piece && piece.color === game.turn()) {
        setSelectedSquare(square);
        return;
      }

      // Attempt to move
      try {
        const move = game.move({
          from: selectedSquare,
          to: square,
          promotion: "q", // Always promote to queen for simplicity
        });

        if (move) {
          setPosition(game.board());
          setSelectedSquare(null);
          setMoveHistory([...moveHistory, move.san]);

          // Check for game over
          if (game.isCheckmate()) {
            // Current player lost (since turn switched after move)
            onFinish(game.turn() === "w" ? "loss" : "win");
          } else if (game.isDraw() || game.isStalemate() || game.isThreefoldRepetition()) {
            onFinish("draw");
          }
        } else {
          setSelectedSquare(null);
        }
      } catch (e) {
        // Invalid move
        setSelectedSquare(null);
      }
    }
  };

  const currentTurn = game.turn() === "w" ? "white" : "black";
  const isCheck = game.isCheck();

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-4 p-4">
      <div className="text-sm font-mono text-muted-foreground">
        {currentTurn === "white" ? "⚪ White's Turn" : "⚫ Black's Turn"}
        {isCheck && " - Check!"}
      </div>

      <div className="w-full max-w-[400px] aspect-square bg-black/40 border-2 border-white/10 rounded-lg grid grid-cols-8 grid-rows-8 overflow-hidden">
        {position.map((row, rowIndex) =>
          row.map((piece, colIndex) => {
            const isLight = (rowIndex + colIndex) % 2 === 1;
            const square = `${String.fromCharCode(97 + colIndex)}${8 - rowIndex}`;
            const isSelected = selectedSquare === square;

            return (
              <button
                key={`${rowIndex}-${colIndex}`}
                onClick={() => handleSquareClick(rowIndex, colIndex)}
                className={`
                  relative flex items-center justify-center text-4xl cursor-pointer transition-all
                  ${isLight ? "bg-amber-100/20" : "bg-amber-900/20"}
                  ${isSelected ? "ring-2 ring-primary ring-inset" : ""}
                  hover:bg-primary/20
                `}
              >
                {piece && (
                  <span className={piece.color === "w" ? "text-white drop-shadow-md" : "text-gray-800"}>
                    {PIECES_UNICODE[piece.type.toUpperCase() === piece.type ? piece.type : piece.type.toLowerCase()]}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {moveHistory.length > 0 && (
        <div className="text-xs font-mono text-muted-foreground max-w-[400px] w-full">
          <div className="bg-black/20 rounded p-2 max-h-20 overflow-y-auto">
            {t("Moves", "Moves")}: {moveHistory.slice(-3).join(", ")}
          </div>
        </div>
      )}

      <div className="flex gap-2 w-full max-w-[400px]">
        <button
          onClick={() => onFinish("win")}
          className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded font-display uppercase text-sm"
        >
          {t("Claim Win (Dev)", "Claim Win (Dev)")}
        </button>
        <button
          onClick={() => onFinish("draw")}
          className="flex-1 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded font-display uppercase text-sm"
        >
          {t("Draw", "Draw")}
        </button>
        <button
          onClick={() => onFinish("loss")}
          className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-display uppercase text-sm"
        >
          {t("Resign (Dev)", "Resign (Dev)")}
        </button>
      </div>
    </div>
  );
}