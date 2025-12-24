
import { useState } from "react";
import { useLanguage } from "@/context/LanguageContext";

interface ChessGameProps {
  onFinish: (result: "win" | "loss" | "draw") => void;
}

type Piece = {
  type: "pawn" | "rook" | "knight" | "bishop" | "queen" | "king";
  color: "white" | "black";
};

type Square = Piece | null;
type Board = Square[][];

const PIECES_UNICODE = {
  white: {
    king: "♔",
    queen: "♕",
    rook: "♖",
    bishop: "♗",
    knight: "♘",
    pawn: "♙",
  },
  black: {
    king: "♚",
    queen: "♛",
    rook: "♜",
    bishop: "♝",
    knight: "♞",
    pawn: "♟",
  },
};

function createInitialBoard(): Board {
  const board: Board = Array(8).fill(null).map(() => Array(8).fill(null));
  
  // Black pieces (top)
  board[0] = [
    { type: "rook", color: "black" },
    { type: "knight", color: "black" },
    { type: "bishop", color: "black" },
    { type: "queen", color: "black" },
    { type: "king", color: "black" },
    { type: "bishop", color: "black" },
    { type: "knight", color: "black" },
    { type: "rook", color: "black" },
  ];
  board[1] = Array(8).fill(null).map(() => ({ type: "pawn", color: "black" } as Piece));
  
  // White pieces (bottom)
  board[6] = Array(8).fill(null).map(() => ({ type: "pawn", color: "white" } as Piece));
  board[7] = [
    { type: "rook", color: "white" },
    { type: "knight", color: "white" },
    { type: "bishop", color: "white" },
    { type: "queen", color: "white" },
    { type: "king", color: "white" },
    { type: "bishop", color: "white" },
    { type: "knight", color: "white" },
    { type: "rook", color: "white" },
  ];
  
  return board;
}

export function ChessGame({ onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const [board, setBoard] = useState<Board>(createInitialBoard());
  const [selectedSquare, setSelectedSquare] = useState<[number, number] | null>(null);
  const [currentTurn, setCurrentTurn] = useState<"white" | "black">("white");
  const [moveHistory, setMoveHistory] = useState<string[]>([]);

  const handleSquareClick = (row: number, col: number) => {
    const piece = board[row][col];

    if (selectedSquare === null) {
      // Select a piece
      if (piece && piece.color === currentTurn) {
        setSelectedSquare([row, col]);
      }
    } else {
      const [fromRow, fromCol] = selectedSquare;
      const selectedPiece = board[fromRow][fromCol];

      // If clicking the same square, deselect
      if (fromRow === row && fromCol === col) {
        setSelectedSquare(null);
        return;
      }

      // If clicking another piece of the same color, select it instead
      if (piece && piece.color === currentTurn) {
        setSelectedSquare([row, col]);
        return;
      }

      // Attempt to move
      if (selectedPiece && isValidMove(fromRow, fromCol, row, col, selectedPiece, board)) {
        const newBoard = board.map(r => [...r]);
        newBoard[row][col] = selectedPiece;
        newBoard[fromRow][fromCol] = null;
        
        setBoard(newBoard);
        setSelectedSquare(null);
        setCurrentTurn(currentTurn === "white" ? "black" : "white");
        
        const move = `${String.fromCharCode(97 + fromCol)}${8 - fromRow} → ${String.fromCharCode(97 + col)}${8 - row}`;
        setMoveHistory([...moveHistory, move]);
      } else {
        setSelectedSquare(null);
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-4 p-4">
      <div className="text-sm font-mono text-muted-foreground">
        {currentTurn === "white" ? "⚪ White's Turn" : "⚫ Black's Turn"}
      </div>

      <div className="w-full max-w-[400px] aspect-square bg-black/40 border-2 border-white/10 rounded-lg grid grid-cols-8 grid-rows-8 overflow-hidden">
        {board.map((row, rowIndex) =>
          row.map((piece, colIndex) => {
            const isLight = (rowIndex + colIndex) % 2 === 1;
            const isSelected = selectedSquare?.[0] === rowIndex && selectedSquare?.[1] === colIndex;
            
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
                  <span className={piece.color === "white" ? "text-white drop-shadow-md" : "text-gray-800"}>
                    {PIECES_UNICODE[piece.color][piece.type]}
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

// Basic move validation (simplified - doesn't check all chess rules)
function isValidMove(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  piece: Piece,
  board: Board
): boolean {
  const targetPiece = board[toRow][toCol];
  
  // Can't capture own pieces
  if (targetPiece && targetPiece.color === piece.color) {
    return false;
  }

  const rowDiff = Math.abs(toRow - fromRow);
  const colDiff = Math.abs(toCol - fromCol);
  const rowDir = toRow - fromRow;
  const colDir = toCol - fromCol;

  switch (piece.type) {
    case "pawn":
      const direction = piece.color === "white" ? -1 : 1;
      const startRow = piece.color === "white" ? 6 : 1;
      
      // Move forward
      if (colDiff === 0 && !targetPiece) {
        if (rowDir === direction) return true;
        if (fromRow === startRow && rowDir === 2 * direction && !board[fromRow + direction][fromCol]) return true;
      }
      
      // Capture diagonally
      if (colDiff === 1 && rowDir === direction && targetPiece) {
        return true;
      }
      return false;

    case "rook":
      if (rowDiff === 0 || colDiff === 0) {
        return isPathClear(fromRow, fromCol, toRow, toCol, board);
      }
      return false;

    case "knight":
      return (rowDiff === 2 && colDiff === 1) || (rowDiff === 1 && colDiff === 2);

    case "bishop":
      if (rowDiff === colDiff) {
        return isPathClear(fromRow, fromCol, toRow, toCol, board);
      }
      return false;

    case "queen":
      if (rowDiff === 0 || colDiff === 0 || rowDiff === colDiff) {
        return isPathClear(fromRow, fromCol, toRow, toCol, board);
      }
      return false;

    case "king":
      return rowDiff <= 1 && colDiff <= 1;

    default:
      return false;
  }
}

function isPathClear(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  board: Board
): boolean {
  const rowStep = toRow === fromRow ? 0 : (toRow - fromRow) / Math.abs(toRow - fromRow);
  const colStep = toCol === fromCol ? 0 : (toCol - fromCol) / Math.abs(toCol - fromCol);

  let currentRow = fromRow + rowStep;
  let currentCol = fromCol + colStep;

  while (currentRow !== toRow || currentCol !== toCol) {
    if (board[currentRow][currentCol] !== null) {
      return false;
    }
    currentRow += rowStep;
    currentCol += colStep;
  }

  return true;
}
