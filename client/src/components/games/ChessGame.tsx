import { useState, useEffect } from 'react';
import { useLanguage } from "@/context/LanguageContext";

type Result = "win" | "loss" | "draw";

type Piece = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
type PieceType = Piece | null;

interface BoardState {
  pieces: PieceType[];
  selectedSquare: number | null;
}

const INITIAL_BOARD: PieceType[] = [
  'r', 'n', 'b', 'q', 'k', 'b', 'n', 'r',
  'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p',
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P',
  'R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R',
];

const PIECE_SYMBOLS: Record<Piece, string> = {
  'P': '♙', 'N': '♘', 'B': '♗', 'R': '♖', 'Q': '♕', 'K': '♔',
  'p': '♟', 'n': '♞', 'b': '♝', 'r': '♜', 'q': '♛', 'k': '♚',
};

export function ChessGame({ onFinish }: { onFinish: (result: Result) => void }) {
  const { t } = useLanguage();
  const [board, setBoard] = useState<BoardState>({
    pieces: INITIAL_BOARD,
    selectedSquare: null
  });
  const [moveCount, setMoveCount] = useState(0);

  // Simulate a game that ends after a few moves
  useEffect(() => {
    const timer = setTimeout(() => {
      if (moveCount > 0) {
        // After 3 moves, game ends
        if (moveCount >= 3) {
          const results: Result[] = ['win', 'loss', 'draw'];
          onFinish(results[Math.floor(Math.random() * results.length)]);
        }
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [moveCount, onFinish]);

  const handleSquareClick = (index: number) => {
    setBoard(prev => ({
      ...prev,
      selectedSquare: prev.selectedSquare === index ? null : index
    }));
    setMoveCount(prev => prev + 1);
  };

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="w-full aspect-square bg-gradient-to-br from-amber-900 to-amber-950 border-4 border-amber-700 rounded-lg shadow-2xl overflow-hidden">
        <div className="grid grid-cols-8 grid-rows-8 w-full h-full">
          {board.pieces.map((piece, i) => {
            const row = Math.floor(i / 8);
            const col = i % 8;
            const isLightSquare = (row + col) % 2 === 0;
            const isSelected = board.selectedSquare === i;

            return (
              <button
                key={i}
                onClick={() => handleSquareClick(i)}
                className={`
                  flex items-center justify-center text-4xl font-bold
                  transition-colors duration-200
                  ${isLightSquare ? 'bg-amber-100' : 'bg-amber-700'}
                  ${isSelected ? 'ring-4 ring-yellow-400' : ''}
                  hover:opacity-80 active:opacity-70
                  border border-amber-600/30
                `}
              >
                {piece ? PIECE_SYMBOLS[piece] : ''}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-3 bg-black/40 border border-white/10 rounded-lg">
        <span className="text-sm text-muted-foreground font-mono">
          {t("Moves", "Moves")}: {moveCount}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("Click squares to make moves", "Click squares to make moves")}
        </span>
      </div>

      {moveCount === 0 && (
        <div className="text-center text-sm text-muted-foreground italic">
          {t("Game will end after 3 moves", "Game will end after 3 moves")}
        </div>
      )}
    </div>
  );
}
