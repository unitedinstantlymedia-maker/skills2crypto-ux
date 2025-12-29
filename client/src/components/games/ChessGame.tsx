import { useState, useEffect, useCallback, useRef } from 'react';
import { Chess, Square, Move, PieceSymbol } from 'chess.js';
import { useLanguage } from "@/context/LanguageContext";
import { useGame } from "@/context/GameContext";
import { PIECE_COMPONENTS } from './chess/ChessPieces';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Flag, RotateCcw } from 'lucide-react';

type Result = "win" | "loss" | "draw";

interface ChessGameProps {
  onFinish: (result: Result) => void;
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

const INITIAL_TIME = 30 * 60 * 1000;

export function ChessGame({ onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const { state } = useGame();
  
  const isDemoMode = typeof window !== 'undefined' && window.location.pathname.includes('demo');
  
  const [game, setGame] = useState(() => new Chess());
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [legalMoves, setLegalMoves] = useState<Square[]>([]);
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);
  const [playerColor] = useState<'white' | 'black'>('white');
  const [whiteTime, setWhiteTime] = useState(INITIAL_TIME);
  const [blackTime, setBlackTime] = useState(INITIAL_TIME);
  const [gameOver, setGameOver] = useState(false);
  const [gameResult, setGameResult] = useState<string>('');
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPiece, setDragPiece] = useState<{ square: Square; x: number; y: number } | null>(null);
  
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const isPlayerTurn = isDemoMode ? true : game.turn() === (playerColor === 'white' ? 'w' : 'b');

  useEffect(() => {
    if (gameOver) return;

    timerRef.current = setInterval(() => {
      if (game.turn() === 'w') {
        setWhiteTime(prev => {
          if (prev <= 1000) {
            handleTimeout('white');
            return 0;
          }
          return prev - 1000;
        });
      } else {
        setBlackTime(prev => {
          if (prev <= 1000) {
            handleTimeout('black');
            return 0;
          }
          return prev - 1000;
        });
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [game.turn(), gameOver]);

  const handleTimeout = useCallback((color: 'white' | 'black') => {
    if (timerRef.current) clearInterval(timerRef.current);
    setGameOver(true);
    const result: Result = color === playerColor ? 'loss' : 'win';
    setGameResult(color === 'white' ? t('Black wins on time!', 'Black wins on time!') : t('White wins on time!', 'White wins on time!'));
    setTimeout(() => onFinish(result), 2000);
  }, [playerColor, onFinish, t]);

  const checkGameEnd = useCallback(() => {
    if (game.isCheckmate()) {
      setGameOver(true);
      const winner = game.turn() === 'w' ? 'black' : 'white';
      setGameResult(winner === 'white' ? t('White wins by checkmate!', 'White wins by checkmate!') : t('Black wins by checkmate!', 'Black wins by checkmate!'));
      const result: Result = winner === playerColor ? 'win' : 'loss';
      setTimeout(() => onFinish(result), 2000);
      return true;
    }
    if (game.isStalemate()) {
      setGameOver(true);
      setGameResult(t('Stalemate - Draw!', 'Stalemate - Draw!'));
      setTimeout(() => onFinish('draw'), 2000);
      return true;
    }
    if (game.isDraw()) {
      setGameOver(true);
      setGameResult(t('Draw!', 'Draw!'));
      setTimeout(() => onFinish('draw'), 2000);
      return true;
    }
    return false;
  }, [game, playerColor, onFinish, t]);

  const makeMove = useCallback((from: Square, to: Square) => {
    try {
      const move = game.move({ from, to, promotion: 'q' });
      if (move) {
        setGame(new Chess(game.fen()));
        setLastMove({ from, to });
        setMoveHistory(prev => [...prev, move.san]);
        setSelectedSquare(null);
        setLegalMoves([]);
        checkGameEnd();
        
        if (!isDemoMode && !gameOver && !isPlayerTurn) {
          setTimeout(() => makeAIMove(), 500);
        }
        
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }, [game, checkGameEnd, gameOver, isPlayerTurn, isDemoMode]);

  const makeAIMove = useCallback(() => {
    if (gameOver) return;
    
    const moves = game.moves({ verbose: true });
    if (moves.length === 0) return;
    
    const randomMove = moves[Math.floor(Math.random() * moves.length)];
    game.move(randomMove);
    setGame(new Chess(game.fen()));
    setLastMove({ from: randomMove.from as Square, to: randomMove.to as Square });
    setMoveHistory(prev => [...prev, randomMove.san]);
    checkGameEnd();
  }, [game, gameOver, checkGameEnd]);

  useEffect(() => {
    if (!isPlayerTurn && !gameOver && moveHistory.length === 0) {
    }
  }, [isPlayerTurn, gameOver, makeAIMove, moveHistory.length]);

  const handleSquareClick = useCallback((square: Square) => {
    if (gameOver || !isPlayerTurn) return;

    const piece = game.get(square);
    const currentTurnColor = game.turn();
    
    if (selectedSquare) {
      if (legalMoves.includes(square)) {
        makeMove(selectedSquare, square);
      } else if (piece && (isDemoMode ? piece.color === currentTurnColor : piece.color === (playerColor === 'white' ? 'w' : 'b'))) {
        setSelectedSquare(square);
        const moves = game.moves({ square, verbose: true });
        setLegalMoves(moves.map(m => m.to as Square));
      } else {
        setSelectedSquare(null);
        setLegalMoves([]);
      }
    } else if (piece && (isDemoMode ? piece.color === currentTurnColor : piece.color === (playerColor === 'white' ? 'w' : 'b'))) {
      setSelectedSquare(square);
      const moves = game.moves({ square, verbose: true });
      setLegalMoves(moves.map(m => m.to as Square));
    }
  }, [game, selectedSquare, legalMoves, makeMove, playerColor, gameOver, isPlayerTurn, isDemoMode]);

  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent, square: Square) => {
    if (gameOver || !isPlayerTurn) return;
    
    const piece = game.get(square);
    const currentTurnColor = game.turn();
    if (!piece || (isDemoMode ? piece.color !== currentTurnColor : piece.color !== (playerColor === 'white' ? 'w' : 'b'))) return;

    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    setIsDragging(true);
    setDragPiece({ square, x: clientX, y: clientY });
    setSelectedSquare(square);
    const moves = game.moves({ square, verbose: true });
    setLegalMoves(moves.map(m => m.to as Square));
  }, [game, playerColor, gameOver, isPlayerTurn, isDemoMode]);

  const handleDragMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging || !dragPiece) return;
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    setDragPiece(prev => prev ? { ...prev, x: clientX, y: clientY } : null);
  }, [isDragging, dragPiece]);

  const handleDragEnd = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging || !dragPiece || !boardRef.current) {
      setIsDragging(false);
      setDragPiece(null);
      return;
    }

    const rect = boardRef.current.getBoundingClientRect();
    const clientX = 'changedTouches' in e ? e.changedTouches[0].clientX : e.clientX;
    const clientY = 'changedTouches' in e ? e.changedTouches[0].clientY : e.clientY;
    
    const squareSize = rect.width / 8;
    const file = Math.floor((clientX - rect.left) / squareSize);
    const rank = Math.floor((clientY - rect.top) / squareSize);
    
    if (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
      const targetSquare = `${FILES[file]}${RANKS[rank]}` as Square;
      if (legalMoves.includes(targetSquare)) {
        makeMove(dragPiece.square, targetSquare);
      }
    }
    
    setIsDragging(false);
    setDragPiece(null);
    setSelectedSquare(null);
    setLegalMoves([]);
  }, [isDragging, dragPiece, legalMoves, makeMove]);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
      window.addEventListener('touchmove', handleDragMove);
      window.addEventListener('touchend', handleDragEnd);
      
      return () => {
        window.removeEventListener('mousemove', handleDragMove);
        window.removeEventListener('mouseup', handleDragEnd);
        window.removeEventListener('touchmove', handleDragMove);
        window.removeEventListener('touchend', handleDragEnd);
      };
    }
  }, [isDragging, handleDragMove, handleDragEnd]);

  const handleResign = useCallback(() => {
    if (gameOver) return;
    setGameOver(true);
    setGameResult(t('You resigned', 'You resigned'));
    if (timerRef.current) clearInterval(timerRef.current);
    setTimeout(() => onFinish('loss'), 1500);
  }, [gameOver, onFinish, t]);

  const formatTime = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const renderSquare = (file: number, rank: number) => {
    const square = `${FILES[file]}${RANKS[rank]}` as Square;
    const piece = game.get(square);
    const isLight = (file + rank) % 2 === 0;
    const isSelected = selectedSquare === square;
    const isLegalMove = legalMoves.includes(square);
    const isLastMoveSquare = lastMove && (lastMove.from === square || lastMove.to === square);
    const isInCheck = game.isCheck() && piece?.type === 'k' && piece.color === game.turn();
    const isDragSource = dragPiece?.square === square;

    const PieceComponent = piece ? PIECE_COMPONENTS[piece.type] : null;

    return (
      <div
        key={square}
        className={cn(
          "relative flex items-center justify-center transition-colors duration-150",
          isLight ? "bg-stone-200" : "bg-stone-600",
          isSelected && "ring-4 ring-emerald-400 ring-inset",
          isLastMoveSquare && !isSelected && (isLight ? "bg-emerald-200" : "bg-emerald-700"),
          isInCheck && "bg-red-500/70",
          "cursor-pointer"
        )}
        onClick={() => handleSquareClick(square)}
        onMouseDown={(e) => handleDragStart(e, square)}
        onTouchStart={(e) => handleDragStart(e, square)}
      >
        {file === 0 && (
          <span className="absolute left-1 top-0.5 text-[10px] font-medium opacity-60">
            {RANKS[rank]}
          </span>
        )}
        {rank === 7 && (
          <span className="absolute right-1 bottom-0.5 text-[10px] font-medium opacity-60">
            {FILES[file]}
          </span>
        )}
        
        {isLegalMove && (
          <div className={cn(
            "absolute rounded-full transition-all",
            piece ? "w-full h-full border-4 border-emerald-500/50" : "w-3 h-3 bg-emerald-500/50"
          )} />
        )}
        
        {PieceComponent && !isDragSource && (
          <div className="w-[85%] h-[85%] transition-transform hover:scale-105 drop-shadow-md">
            <PieceComponent 
              color={piece!.color === 'w' ? 'white' : 'black'} 
              className="w-full h-full"
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full flex flex-col gap-4">
      <div className={cn(
        "flex items-center justify-between px-4 py-3 rounded-lg",
        game.turn() === 'b' ? "bg-zinc-800 ring-2 ring-green-500" : "bg-zinc-800/50"
      )}>
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 rounded-full bg-zinc-900 border-2 border-zinc-600" />
          <span className="font-semibold">{t('Opponent', 'Opponent')}</span>
        </div>
        <div className={cn(
          "font-mono text-lg font-bold px-3 py-1 rounded",
          blackTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700"
        )}>
          {formatTime(blackTime)}
        </div>
      </div>

      <div 
        ref={boardRef}
        className="w-full aspect-square rounded-lg overflow-hidden shadow-2xl border-4 border-stone-800"
        style={{ touchAction: 'none' }}
      >
        <div className="grid grid-cols-8 grid-rows-8 w-full h-full">
          {RANKS.map((_, rankIdx) =>
            FILES.map((_, fileIdx) => renderSquare(fileIdx, rankIdx))
          )}
        </div>
      </div>

      {dragPiece && isDragging && (
        <div
          className="fixed pointer-events-none z-50 w-16 h-16"
          style={{
            left: dragPiece.x - 32,
            top: dragPiece.y - 32,
          }}
        >
          {(() => {
            const piece = game.get(dragPiece.square);
            if (!piece) return null;
            const PieceComponent = PIECE_COMPONENTS[piece.type];
            return (
              <PieceComponent 
                color={piece.color === 'w' ? 'white' : 'black'}
                className="w-full h-full drop-shadow-lg"
              />
            );
          })()}
        </div>
      )}

      <div className={cn(
        "flex items-center justify-between px-4 py-3 rounded-lg",
        game.turn() === 'w' ? "bg-zinc-800 ring-2 ring-green-500" : "bg-zinc-800/50"
      )}>
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 rounded-full bg-white border-2 border-zinc-400" />
          <span className="font-semibold">{t('You', 'You')}</span>
        </div>
        <div className={cn(
          "font-mono text-lg font-bold px-3 py-1 rounded",
          whiteTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700"
        )}>
          {formatTime(whiteTime)}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="destructive"
          size="sm"
          onClick={handleResign}
          disabled={gameOver}
          className="flex-1"
        >
          <Flag className="w-4 h-4 mr-2" />
          {t('Resign', 'Resign')}
        </Button>
      </div>

      {moveHistory.length > 0 && (
        <div className="bg-zinc-900/50 rounded-lg p-3 max-h-24 overflow-y-auto">
          <div className="flex flex-wrap gap-1 text-xs font-mono">
            {moveHistory.map((move, idx) => (
              <span key={idx} className={cn(
                "px-1.5 py-0.5 rounded",
                idx % 2 === 0 ? "bg-zinc-700" : "bg-zinc-800"
              )}>
                {idx % 2 === 0 && <span className="text-zinc-500 mr-1">{Math.floor(idx / 2) + 1}.</span>}
                {move}
              </span>
            ))}
          </div>
        </div>
      )}

      {gameOver && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-2xl p-8 text-center max-w-sm mx-4 border border-zinc-700">
            <h2 className="text-2xl font-bold mb-2">{t('Game Over', 'Game Over')}</h2>
            <p className="text-lg text-muted-foreground mb-6">{gameResult}</p>
            <div className="text-sm text-zinc-500">
              {t('Redirecting...', 'Redirecting...')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
