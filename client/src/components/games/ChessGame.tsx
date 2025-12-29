import { useState, useEffect, useCallback, useRef } from 'react';
import { Chess, Square } from 'chess.js';
import { io, Socket } from 'socket.io-client';
import { useLanguage } from "@/context/LanguageContext";
import { useGame } from "@/context/GameContext";
import { PIECE_COMPONENTS } from './chess/ChessPieces';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Flag } from 'lucide-react';

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
  
  const [game, setGame] = useState(() => new Chess());
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [legalMoves, setLegalMoves] = useState<Square[]>([]);
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);
  const [playerColor, setPlayerColor] = useState<'white' | 'black' | null>(null);
  const [whiteTime, setWhiteTime] = useState(INITIAL_TIME);
  const [blackTime, setBlackTime] = useState(INITIAL_TIME);
  const [gameOver, setGameOver] = useState(false);
  const [gameResult, setGameResult] = useState<string>('');
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPiece, setDragPiece] = useState<{ square: Square; x: number; y: number } | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [waitingForOpponent, setWaitingForOpponent] = useState(true);
  
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const gameRef = useRef(game);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  const matchId = state.currentMatch?.id;
  const playerId = state.wallet.address || 'anonymous';

  const isPlayerTurn = playerColor && game.turn() === (playerColor === 'white' ? 'w' : 'b');

  useEffect(() => {
    if (!matchId || matchId === 'pending') return;

    const socket = io('/', {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
      withCredentials: true
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[ChessGame] socket connected');
      setIsConnected(true);
      socket.emit('join-match', { matchId, playerId });
    });

    socket.on('color-assigned', (data: { color: 'white' | 'black' }) => {
      console.log('[ChessGame] color assigned:', data.color);
      setPlayerColor(data.color);
    });

    socket.on('game-start', (data: { fen: string; whiteTime: number; blackTime: number }) => {
      console.log('[ChessGame] game started');
      setWaitingForOpponent(false);
      setGame(new Chess(data.fen));
      setWhiteTime(data.whiteTime);
      setBlackTime(data.blackTime);
    });

    socket.on('opponent-move', (data: { from: string; to: string; fen: string; san: string; whiteTime: number; blackTime: number }) => {
      console.log('[ChessGame] opponent move:', data.san);
      const newGame = new Chess(data.fen);
      setGame(newGame);
      setLastMove({ from: data.from as Square, to: data.to as Square });
      setMoveHistory(prev => [...prev, data.san]);
      setWhiteTime(data.whiteTime);
      setBlackTime(data.blackTime);
      
      if (newGame.isCheckmate()) {
        const winner = newGame.turn() === 'w' ? 'black' : 'white';
        handleGameEnd('checkmate', winner);
      } else if (newGame.isStalemate() || newGame.isDraw()) {
        handleGameEnd('draw', 'draw');
      }
    });

    socket.on('opponent-resigned', (data: { color: 'white' | 'black' }) => {
      console.log('[ChessGame] opponent resigned');
      setGameOver(true);
      setGameResult(t('Opponent resigned - You win!', 'Opponent resigned - You win!'));
      if (timerRef.current) clearInterval(timerRef.current);
      setTimeout(() => onFinish('win'), 2000);
    });

    socket.on('opponent-timeout', (data: { color: 'white' | 'black' }) => {
      console.log('[ChessGame] opponent timeout');
      setGameOver(true);
      setGameResult(t('Opponent ran out of time - You win!', 'Opponent ran out of time - You win!'));
      if (timerRef.current) clearInterval(timerRef.current);
      setTimeout(() => onFinish('win'), 2000);
    });

    socket.on('disconnect', () => {
      console.log('[ChessGame] socket disconnected');
      setIsConnected(false);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, [matchId, playerId, onFinish, t]);

  useEffect(() => {
    if (gameOver || waitingForOpponent) return;

    timerRef.current = setInterval(() => {
      const currentGame = gameRef.current;
      if (currentGame.turn() === 'w') {
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
  }, [gameOver, waitingForOpponent]);

  const handleGameEnd = useCallback((reason: string, winner: 'white' | 'black' | 'draw') => {
    if (timerRef.current) clearInterval(timerRef.current);
    setGameOver(true);
    
    if (winner === 'draw') {
      setGameResult(t('Draw!', 'Draw!'));
      setTimeout(() => onFinish('draw'), 2000);
    } else {
      const playerWins = winner === playerColor;
      setGameResult(playerWins ? t('You win!', 'You win!') : t('You lose!', 'You lose!'));
      setTimeout(() => onFinish(playerWins ? 'win' : 'loss'), 2000);
    }
  }, [playerColor, onFinish, t]);

  const handleTimeout = useCallback((color: 'white' | 'black') => {
    if (timerRef.current) clearInterval(timerRef.current);
    setGameOver(true);
    
    const result: Result = color === playerColor ? 'loss' : 'win';
    setGameResult(color === 'white' ? t('Black wins on time!', 'Black wins on time!') : t('White wins on time!', 'White wins on time!'));
    
    if (color === playerColor && socketRef.current && matchId) {
      socketRef.current.emit('chess-timeout', { matchId, color });
    }
    
    setTimeout(() => onFinish(result), 2000);
  }, [playerColor, onFinish, t, matchId]);

  const checkGameEnd = useCallback(() => {
    if (game.isCheckmate()) {
      const winner = game.turn() === 'w' ? 'black' : 'white';
      handleGameEnd('checkmate', winner);
      return true;
    }
    if (game.isStalemate() || game.isDraw()) {
      handleGameEnd('draw', 'draw');
      return true;
    }
    return false;
  }, [game, handleGameEnd]);

  const makeMove = useCallback((from: Square, to: Square) => {
    if (!isPlayerTurn || !playerColor) return false;
    
    try {
      const move = game.move({ from, to, promotion: 'q' });
      if (move) {
        const newGame = new Chess(game.fen());
        setGame(newGame);
        setLastMove({ from, to });
        setMoveHistory(prev => [...prev, move.san]);
        setSelectedSquare(null);
        setLegalMoves([]);

        if (socketRef.current && matchId) {
          socketRef.current.emit('chess-move', {
            matchId,
            from,
            to,
            promotion: 'q',
            fen: game.fen(),
            san: move.san,
            whiteTime,
            blackTime
          });
        }

        checkGameEnd();
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }, [game, isPlayerTurn, playerColor, matchId, whiteTime, blackTime, checkGameEnd]);

  const handleSquareClick = useCallback((square: Square) => {
    if (gameOver || !isPlayerTurn || waitingForOpponent) return;
    
    const piece = game.get(square);
    
    const canSelectPiece = () => {
      if (!piece) return false;
      return piece.color === (playerColor === 'white' ? 'w' : 'b');
    };
    
    if (selectedSquare) {
      if (legalMoves.includes(square)) {
        makeMove(selectedSquare, square);
      } else if (canSelectPiece()) {
        setSelectedSquare(square);
        const moves = game.moves({ square, verbose: true });
        setLegalMoves(moves.map(m => m.to as Square));
      } else {
        setSelectedSquare(null);
        setLegalMoves([]);
      }
    } else if (canSelectPiece()) {
      setSelectedSquare(square);
      const moves = game.moves({ square, verbose: true });
      setLegalMoves(moves.map(m => m.to as Square));
    }
  }, [game, selectedSquare, legalMoves, makeMove, playerColor, gameOver, isPlayerTurn, waitingForOpponent]);

  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent, square: Square) => {
    if (gameOver || !isPlayerTurn || waitingForOpponent) return;
    
    const piece = game.get(square);
    if (!piece || piece.color !== (playerColor === 'white' ? 'w' : 'b')) return;

    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    setIsDragging(true);
    setDragPiece({ square, x: clientX, y: clientY });
    setSelectedSquare(square);
    const moves = game.moves({ square, verbose: true });
    setLegalMoves(moves.map(m => m.to as Square));
  }, [game, playerColor, gameOver, isPlayerTurn, waitingForOpponent]);

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
    let file = Math.floor((clientX - rect.left) / squareSize);
    let rank = Math.floor((clientY - rect.top) / squareSize);
    
    if (playerColor === 'black') {
      file = 7 - file;
      rank = 7 - rank;
    }
    
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
  }, [isDragging, dragPiece, legalMoves, makeMove, playerColor]);

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
    if (gameOver || !playerColor) return;
    setGameOver(true);
    setGameResult(t('You resigned', 'You resigned'));
    if (timerRef.current) clearInterval(timerRef.current);
    
    if (socketRef.current && matchId) {
      socketRef.current.emit('chess-resign', { matchId, color: playerColor });
    }
    
    setTimeout(() => onFinish('loss'), 1500);
  }, [gameOver, playerColor, onFinish, t, matchId]);

  const formatTime = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const renderSquare = (file: number, rank: number) => {
    const displayFile = playerColor === 'black' ? 7 - file : file;
    const displayRank = playerColor === 'black' ? 7 - rank : rank;
    
    const square = `${FILES[displayFile]}${RANKS[displayRank]}` as Square;
    const piece = game.get(square);
    const isLight = (displayFile + displayRank) % 2 === 0;
    const isSelected = selectedSquare === square;
    const isLegalMove = legalMoves.includes(square);
    const isLastMoveSquare = lastMove && (lastMove.from === square || lastMove.to === square);
    const isInCheck = game.isCheck() && piece?.type === 'k' && piece.color === game.turn();
    const isDragSource = dragPiece?.square === square;

    const PieceComponent = piece ? PIECE_COMPONENTS[piece.type] : null;

    return (
      <div
        key={`${file}-${rank}`}
        className={cn(
          "relative flex items-center justify-center transition-colors duration-150",
          isLight ? "bg-stone-200" : "bg-stone-600",
          isSelected && "ring-4 ring-emerald-400 ring-inset",
          isLastMoveSquare && !isSelected && (isLight ? "bg-emerald-200" : "bg-emerald-700"),
          isInCheck && "bg-red-500/70",
          isPlayerTurn && !waitingForOpponent ? "cursor-pointer" : "cursor-default"
        )}
        onClick={() => handleSquareClick(square)}
        onMouseDown={(e) => handleDragStart(e, square)}
        onTouchStart={(e) => handleDragStart(e, square)}
      >
        {file === 0 && (
          <span className="absolute left-1 top-0.5 text-[10px] font-medium opacity-60">
            {RANKS[displayRank]}
          </span>
        )}
        {rank === 7 && (
          <span className="absolute right-1 bottom-0.5 text-[10px] font-medium opacity-60">
            {FILES[displayFile]}
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

  const opponentTime = playerColor === 'white' ? blackTime : whiteTime;
  const myTime = playerColor === 'white' ? whiteTime : blackTime;
  const isOpponentTurn = playerColor && game.turn() !== (playerColor === 'white' ? 'w' : 'b');

  if (waitingForOpponent) {
    return (
      <div className="w-full flex flex-col items-center justify-center gap-4 py-12">
        <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-lg font-medium">{t('Waiting for opponent...', 'Waiting for opponent...')}</p>
        <p className="text-sm text-muted-foreground">
          {isConnected ? t('Connected', 'Connected') : t('Connecting...', 'Connecting...')}
        </p>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-4">
      <div className={cn(
        "flex items-center justify-between px-4 py-3 rounded-lg",
        isOpponentTurn ? "bg-zinc-800 ring-2 ring-green-500" : "bg-zinc-800/50"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-4 h-4 rounded-full border-2",
            playerColor === 'white' ? "bg-zinc-900 border-zinc-600" : "bg-white border-zinc-400"
          )} />
          <span className="font-semibold">{t('Opponent', 'Opponent')}</span>
        </div>
        <div className={cn(
          "font-mono text-lg font-bold px-3 py-1 rounded",
          opponentTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700"
        )}>
          {formatTime(opponentTime)}
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
        isPlayerTurn ? "bg-zinc-800 ring-2 ring-green-500" : "bg-zinc-800/50"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-4 h-4 rounded-full border-2",
            playerColor === 'white' ? "bg-white border-zinc-400" : "bg-zinc-900 border-zinc-600"
          )} />
          <span className="font-semibold">{t('You', 'You')} ({playerColor})</span>
        </div>
        <div className={cn(
          "font-mono text-lg font-bold px-3 py-1 rounded",
          myTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700"
        )}>
          {formatTime(myTime)}
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
