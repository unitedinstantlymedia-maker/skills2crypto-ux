import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useLanguage } from "@/context/LanguageContext";
import { useGame } from "@/context/GameContext";
import { TetrisEngine, GameState, BOARD_DIMENSIONS, PIECE_SHAPES, PIECE_COLORS, PieceType } from './tetris/TetrisEngine';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, ChevronDown, RotateCw, ChevronsDown } from 'lucide-react';

type Result = "win" | "loss" | "draw";

interface TetrisGameProps {
  onFinish: (result: Result) => void;
}

interface OpponentState {
  board: (string | null)[][];
  score: number;
  lines: number;
  level: number;
  gameOver: boolean;
}

export function TetrisGame({ onFinish }: TetrisGameProps) {
  const { t } = useLanguage();
  const { state } = useGame();
  
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [opponentState, setOpponentState] = useState<OpponentState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [waitingForOpponent, setWaitingForOpponent] = useState(true);
  const [gameEnded, setGameEnded] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  
  const engineRef = useRef<TetrisEngine | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const gameEndedRef = useRef(false);
  const onFinishCalledRef = useRef(false);

  const matchId = state.currentMatch?.id;
  const playerId = state.wallet.address || 'anonymous';

  const sendStateUpdate = useCallback(() => {
    if (!socketRef.current || !engineRef.current || !matchId) return;
    const currentState = engineRef.current.getState();
    socketRef.current.emit('tetris-state', {
      matchId,
      board: currentState.board,
      score: currentState.score,
      lines: currentState.lines,
      level: currentState.level,
      gameOver: currentState.gameOver
    });
  }, [matchId]);

  const handleStateChange = useCallback((newState: GameState) => {
    setGameState(newState);
    
    if (newState.gameOver && !gameEndedRef.current) {
      gameEndedRef.current = true;
      setGameEnded(true);
      setResultMessage(t('You lost!', 'You lost!'));
      
      if (socketRef.current && matchId) {
        socketRef.current.emit('tetris-game-over', { matchId, playerId });
      }
    }
  }, [matchId, playerId, t]);

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
      console.log('[TetrisGame] socket connected');
      setIsConnected(true);
      socket.emit('join-tetris-match', { matchId, playerId });
    });

    socket.on('tetris-game-start', () => {
      console.log('[TetrisGame] game started');
      setWaitingForOpponent(false);
      
      const engine = new TetrisEngine(handleStateChange);
      engineRef.current = engine;
      engine.start();
    });

    socket.on('opponent-tetris-state', (data: OpponentState) => {
      setOpponentState(data);
    });

    socket.on('opponent-tetris-game-over', () => {
      if (!gameEndedRef.current) {
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t('You win!', 'You win!'));
        
        if (engineRef.current) {
          engineRef.current.stop();
        }
      }
    });

    socket.on('opponent-disconnected', (data: { forfeit: boolean }) => {
      if (data.forfeit && !gameEndedRef.current) {
        console.log('[TetrisGame] opponent disconnected - forfeit');
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t('Opponent disconnected - You win!', 'Opponent disconnected - You win!'));
        
        if (engineRef.current) {
          engineRef.current.stop();
        }
      }
    });

    socket.on('game-result', (data: { matchId: string; winnerId: string; loserId: string; reason: string }) => {
      console.log('[TetrisGame] game-result received:', data);
      if (onFinishCalledRef.current) return;
      onFinishCalledRef.current = true;
      
      gameEndedRef.current = true;
      setGameEnded(true);
      
      if (engineRef.current) {
        engineRef.current.stop();
      }
      
      const playerWins = data.winnerId === playerId;
      setResultMessage(playerWins ? t('You win!', 'You win!') : t('You lost!', 'You lost!'));
      setTimeout(() => onFinish(playerWins ? 'win' : 'loss'), 1500);
    });

    socket.on('disconnect', () => {
      console.log('[TetrisGame] socket disconnected');
      setIsConnected(false);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
      if (engineRef.current) {
        engineRef.current.stop();
      }
    };
  }, [matchId, playerId, handleStateChange, onFinish, t]);

  useEffect(() => {
    if (!gameState || gameEnded) return;
    const interval = setInterval(sendStateUpdate, 500);
    return () => clearInterval(interval);
  }, [gameState, gameEnded, sendStateUpdate]);

  useEffect(() => {
    if (waitingForOpponent || gameEnded) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!engineRef.current) return;
      
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          engineRef.current.moveLeft();
          break;
        case 'ArrowRight':
          e.preventDefault();
          engineRef.current.moveRight();
          break;
        case 'ArrowDown':
          e.preventDefault();
          engineRef.current.moveDown();
          break;
        case 'ArrowUp':
        case ' ':
          e.preventDefault();
          engineRef.current.rotate();
          break;
        case 'Shift':
          e.preventDefault();
          engineRef.current.hardDrop();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [waitingForOpponent, gameEnded]);

  const handleMobileControl = (action: 'left' | 'right' | 'down' | 'rotate' | 'drop') => {
    if (!engineRef.current || gameEnded) return;
    
    switch (action) {
      case 'left':
        engineRef.current.moveLeft();
        break;
      case 'right':
        engineRef.current.moveRight();
        break;
      case 'down':
        engineRef.current.moveDown();
        break;
      case 'rotate':
        engineRef.current.rotate();
        break;
      case 'drop':
        engineRef.current.hardDrop();
        break;
    }
  };

  const renderBoard = (board: (string | null)[][], currentPiece?: GameState['currentPiece'], ghostPos?: { x: number; y: number } | null, isOpponent = false) => {
    const cellSize = isOpponent ? 'w-2 h-2 sm:w-3 sm:h-3' : 'w-4 h-4 sm:w-5 sm:h-5';
    
    return (
      <div className={cn(
        "grid gap-px bg-zinc-800/50 p-1 rounded-lg border border-zinc-700/50",
        isOpponent ? "opacity-80" : ""
      )} style={{ gridTemplateColumns: `repeat(${BOARD_DIMENSIONS.width}, 1fr)` }}>
        {Array.from({ length: BOARD_DIMENSIONS.height }).map((_, y) =>
          Array.from({ length: BOARD_DIMENSIONS.width }).map((_, x) => {
            let cellColor = board[y]?.[x] || null;
            let isGhost = false;
            let isCurrent = false;

            if (!isOpponent && currentPiece && !cellColor) {
              const pieceX = x - currentPiece.position.x;
              const pieceY = y - currentPiece.position.y;
              if (
                pieceY >= 0 && pieceY < currentPiece.shape.length &&
                pieceX >= 0 && pieceX < currentPiece.shape[pieceY].length &&
                currentPiece.shape[pieceY][pieceX]
              ) {
                cellColor = currentPiece.color;
                isCurrent = true;
              }
            }

            if (!isOpponent && ghostPos && !cellColor && currentPiece) {
              const pieceX = x - ghostPos.x;
              const pieceY = y - ghostPos.y;
              if (
                pieceY >= 0 && pieceY < currentPiece.shape.length &&
                pieceX >= 0 && pieceX < currentPiece.shape[pieceY].length &&
                currentPiece.shape[pieceY][pieceX]
              ) {
                isGhost = true;
              }
            }

            return (
              <div
                key={`${x}-${y}`}
                className={cn(
                  cellSize,
                  "rounded-sm transition-colors duration-75",
                  cellColor ? "shadow-inner" : "bg-zinc-900/80",
                  isGhost && "border border-zinc-500/30",
                  isCurrent && "shadow-lg"
                )}
                style={cellColor ? { 
                  backgroundColor: cellColor,
                  boxShadow: `inset 2px 2px 4px rgba(255,255,255,0.2), inset -2px -2px 4px rgba(0,0,0,0.3)`
                } : undefined}
              />
            );
          })
        )}
      </div>
    );
  };

  const renderNextPiece = (pieceType: PieceType) => {
    const shape = PIECE_SHAPES[pieceType];
    const color = PIECE_COLORS[pieceType];
    
    return (
      <div className="bg-zinc-800/50 rounded-lg p-2 border border-zinc-700/50">
        <div className="text-xs text-zinc-400 mb-1 text-center">{t('Next', 'Next')}</div>
        <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${shape[0].length}, 1fr)` }}>
          {shape.map((row, y) =>
            row.map((cell, x) => (
              <div
                key={`${x}-${y}`}
                className={cn(
                  "w-3 h-3 rounded-sm",
                  cell ? "" : "bg-transparent"
                )}
                style={cell ? { 
                  backgroundColor: color,
                  boxShadow: `inset 1px 1px 2px rgba(255,255,255,0.2)`
                } : undefined}
              />
            ))
          )}
        </div>
      </div>
    );
  };

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

  if (!gameState) return null;

  const ghostPos = engineRef.current?.getGhostPosition();

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex justify-between items-start gap-4">
        <div className="flex flex-col gap-2">
          <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
            <div className="text-xs text-zinc-400">{t('Score', 'Score')}</div>
            <div className="text-xl font-bold font-mono text-primary">{gameState.score}</div>
          </div>
          <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
            <div className="text-xs text-zinc-400">{t('Lines', 'Lines')}</div>
            <div className="text-lg font-bold font-mono">{gameState.lines}</div>
          </div>
          <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
            <div className="text-xs text-zinc-400">{t('Level', 'Level')}</div>
            <div className="text-lg font-bold font-mono text-yellow-400">{gameState.level}</div>
          </div>
          {gameState.nextPiece && renderNextPiece(gameState.nextPiece)}
        </div>

        <div className="flex-1 flex justify-center">
          {renderBoard(gameState.board, gameState.currentPiece, ghostPos)}
        </div>

        {opponentState && (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-zinc-400 text-center">{t('Opponent', 'Opponent')}</div>
            {renderBoard(opponentState.board, undefined, null, true)}
            <div className="text-xs text-center font-mono">
              <span className="text-zinc-400">{t('Score', 'Score')}: </span>
              <span className="text-primary">{opponentState.score}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-center gap-2 mt-4 sm:hidden">
        <Button
          variant="outline"
          size="lg"
          className="w-14 h-14"
          onTouchStart={() => handleMobileControl('left')}
          onClick={() => handleMobileControl('left')}
        >
          <ChevronLeft className="w-6 h-6" />
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="w-14 h-14"
          onTouchStart={() => handleMobileControl('rotate')}
          onClick={() => handleMobileControl('rotate')}
        >
          <RotateCw className="w-6 h-6" />
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="w-14 h-14"
          onTouchStart={() => handleMobileControl('down')}
          onClick={() => handleMobileControl('down')}
        >
          <ChevronDown className="w-6 h-6" />
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="w-14 h-14"
          onTouchStart={() => handleMobileControl('right')}
          onClick={() => handleMobileControl('right')}
        >
          <ChevronRight className="w-6 h-6" />
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="w-14 h-14"
          onTouchStart={() => handleMobileControl('drop')}
          onClick={() => handleMobileControl('drop')}
        >
          <ChevronsDown className="w-6 h-6" />
        </Button>
      </div>

      <div className="text-center text-xs text-zinc-500 hidden sm:block">
        {t('Controls: Arrow keys to move, Space/Up to rotate, Shift for hard drop', 'Controls: Arrow keys to move, Space/Up to rotate, Shift for hard drop')}
      </div>

      {gameEnded && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-2xl p-8 text-center max-w-sm mx-4 border border-zinc-700">
            <h2 className="text-2xl font-bold mb-2">{t('Game Over', 'Game Over')}</h2>
            <p className="text-lg text-muted-foreground mb-4">{resultMessage}</p>
            <p className="text-sm text-zinc-500">{t('Final Score', 'Final Score')}: {gameState.score}</p>
            <div className="text-sm text-zinc-500 mt-4">
              {t('Redirecting...', 'Redirecting...')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
