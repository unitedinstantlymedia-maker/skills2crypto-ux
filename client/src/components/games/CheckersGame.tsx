import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from "@/context/LanguageContext";
import { useGame } from "@/context/GameContext";
import {
  CheckersEngine,
  GameState,
  Position,
  PieceColor,
  BOARD_SIZE_CONST,
  INITIAL_TIME_CONST,
} from './checkers/CheckersEngine';
import { cn } from '@/lib/utils';

type Result = "win" | "loss" | "draw";

interface CheckersGameProps {
  onFinish: (result: Result) => void;
}

interface ServerSnapshot {
  board: string;
  currentTurn: PieceColor;
  redTime: number;
  blackTime: number;
  pendingJumpAt: Position | null;
}

interface OpponentMoveData {
  from: Position;
  to: Position;
  captures: Position[];
  newTurn: PieceColor;
  turnEnded: boolean;
  redTime: number;
  blackTime: number;
  pendingJumpAt: Position | null;
  board: string;
}

export function CheckersGame({ onFinish }: CheckersGameProps) {
  const { t } = useLanguage();
  const { state, socket } = useGame();

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerColor, setPlayerColor] = useState<PieceColor | null>(null);
  const [waitingForOpponent, setWaitingForOpponent] = useState(true);
  const [gameEnded, setGameEnded] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [redTime, setRedTime] = useState(INITIAL_TIME_CONST);
  const [blackTime, setBlackTime] = useState(INITIAL_TIME_CONST);

  const engineRef = useRef<CheckersEngine | null>(null);
  const playerColorRef = useRef<PieceColor | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameEndedRef = useRef(false);
  const onFinishCalledRef = useRef(false);

  const matchId = state.currentMatch?.id;
  const playerId = state.wallet.address || 'anonymous';
  const isConnected = !!socket?.connected;

  const isPlayerTurn = playerColor && gameState?.currentTurn === playerColor;

  const handleStateChange = useCallback((newState: GameState) => {
    setGameState(newState);
  }, []);

  const ensureEngine = useCallback((): CheckersEngine => {
    if (!engineRef.current) {
      engineRef.current = new CheckersEngine(handleStateChange);
    }
    return engineRef.current;
  }, [handleStateChange]);

  const hydrate = useCallback(
    (snapshot: ServerSnapshot) => {
      const engine = ensureEngine();
      engine.hydrateFromServer(snapshot);
      setRedTime(snapshot.redTime);
      setBlackTime(snapshot.blackTime);
    },
    [ensureEngine],
  );

  useEffect(() => {
    playerColorRef.current = playerColor;
  }, [playerColor]);

  useEffect(() => {
    if (!socket || !matchId || matchId === 'pending') return;

    socket.emit('join-checkers-match', { matchId, playerId });
    console.log('[CheckersGame] join-checkers-match emitted via shared socket', matchId);

    const onColorAssigned = (data: { color: PieceColor }) => {
      console.log('[CheckersGame] color assigned:', data.color);
      setPlayerColor(data.color);
    };

    const onGameStart = (data?: { publicState?: ServerSnapshot }) => {
      console.log('[CheckersGame] game started');
      setWaitingForOpponent(false);
      if (data?.publicState) hydrate(data.publicState);
    };

    const onOpponentMove = (data: OpponentMoveData) => {
      console.log('[CheckersGame] server move broadcast:', data);
      hydrate({
        board: data.board,
        currentTurn: data.newTurn,
        redTime: data.redTime,
        blackTime: data.blackTime,
        pendingJumpAt: data.pendingJumpAt,
      });
    };

    const onOpponentTimeout = () => {
      if (!gameEndedRef.current) {
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t('Opponent ran out of time - You win!', 'Opponent ran out of time - You win!'));
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    const onOpponentResigned = () => {
      if (!gameEndedRef.current) {
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t('Opponent resigned - You win!', 'Opponent resigned - You win!'));
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    const onOpponentDisconnected = (data: { forfeit: boolean }) => {
      if (data.forfeit && !gameEndedRef.current) {
        console.log('[CheckersGame] opponent disconnected - forfeit');
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t('Opponent disconnected - You win!', 'Opponent disconnected - You win!'));
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    const onGameResult = (data: { matchId: string; winnerId: string; loserId: string; reason: string }) => {
      console.log('[CheckersGame] game-result received:', data);
      if (onFinishCalledRef.current) return;
      onFinishCalledRef.current = true;
      gameEndedRef.current = true;
      setGameEnded(true);
      if (timerRef.current) clearInterval(timerRef.current);
      const playerWins = data.winnerId === playerId;
      setResultMessage(playerWins ? t('You win!', 'You win!') : t('You lose!', 'You lose!'));
      if (engineRef.current) {
        engineRef.current.setGameOver(playerWins
          ? (playerColorRef.current ?? null)
          : (playerColorRef.current === 'red' ? 'black' : 'red'));
      }
      setTimeout(() => onFinish(playerWins ? 'win' : 'loss'), 1500);
    };

    socket.on('checkers-color-assigned', onColorAssigned);
    socket.on('checkers-game-start', onGameStart);
    socket.on('opponent-checkers-move', onOpponentMove);
    socket.on('opponent-checkers-timeout', onOpponentTimeout);
    socket.on('opponent-checkers-resigned', onOpponentResigned);
    socket.on('opponent-disconnected', onOpponentDisconnected);
    socket.on('game-result', onGameResult);

    return () => {
      socket.off('checkers-color-assigned', onColorAssigned);
      socket.off('checkers-game-start', onGameStart);
      socket.off('opponent-checkers-move', onOpponentMove);
      socket.off('opponent-checkers-timeout', onOpponentTimeout);
      socket.off('opponent-checkers-resigned', onOpponentResigned);
      socket.off('opponent-disconnected', onOpponentDisconnected);
      socket.off('game-result', onGameResult);
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [socket, matchId, playerId, hydrate, onFinish, t]);

  // Local countdown for the side-to-move. Server is canonical: every
  // server move broadcast resets both clocks to the authoritative value.
  useEffect(() => {
    if (waitingForOpponent || gameEnded || !gameState) return;

    timerRef.current = setInterval(() => {
      if (gameState.currentTurn === 'red') {
        setRedTime(prev => {
          if (prev <= 1000) {
            handleTimeout('red');
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
  }, [waitingForOpponent, gameEnded, gameState?.currentTurn]);

  const handleTimeout = useCallback((color: PieceColor) => {
    if (timerRef.current) clearInterval(timerRef.current);

    if (color === playerColor) {
      gameEndedRef.current = true;
      setGameEnded(true);
      setResultMessage(t('Time is up - You lose!', 'Time is up - You lose!'));

      if (socket && matchId) {
        socket.emit('checkers-timeout', { matchId, color: playerColor });
      }
    }
  }, [socket, playerColor, matchId, t]);

  const handleSquareClick = useCallback((row: number, col: number) => {
    if (!engineRef.current || !playerColor || gameEnded) return;
    if (gameState?.currentTurn !== playerColor) return;

    const piece = gameState?.board[row][col];

    if (gameState?.selectedPiece) {
      const isValidMove = gameState.validMoves.some(m => m.to.row === row && m.to.col === col);

      if (isValidMove) {
        const from = gameState.selectedPiece;
        // Server validates and broadcasts the canonical state — we do
        // NOT mutate the local board optimistically.
        if (socket && matchId) {
          socket.emit('checkers-move', {
            matchId,
            from,
            to: { row, col },
          });
        }
      } else if (piece && piece.color === playerColor) {
        engineRef.current.selectPiece({ row, col }, playerColor);
      } else {
        engineRef.current.clearSelection();
      }
    } else if (piece && piece.color === playerColor) {
      engineRef.current.selectPiece({ row, col }, playerColor);
    }
  }, [gameState, playerColor, socket, matchId, gameEnded]);

  const formatTime = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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

  const opponentColor = playerColor === 'red' ? 'black' : 'red';
  const opponentTime = playerColor === 'red' ? blackTime : redTime;
  const myTime = playerColor === 'red' ? redTime : blackTime;
  const isOpponentTurn = gameState.currentTurn === opponentColor;

  return (
    <div className="w-full flex flex-col gap-4">
      <div className={cn(
        "flex items-center justify-between px-4 py-3 rounded-lg",
        isOpponentTurn ? "bg-zinc-800 ring-2 ring-amber-500" : "bg-zinc-800/50"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-5 h-5 rounded-full border-2 shadow-md",
            opponentColor === 'red' ? "bg-red-600 border-red-400" : "bg-zinc-900 border-zinc-600"
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

      <div className="w-full aspect-square rounded-lg overflow-hidden shadow-2xl border-4 border-amber-900/50">
        <div className="grid grid-cols-8 grid-rows-8 w-full h-full">
          {Array.from({ length: BOARD_SIZE_CONST }).map((_, rowIdx) => {
            const displayRow = playerColor === 'black' ? 7 - rowIdx : rowIdx;

            return Array.from({ length: BOARD_SIZE_CONST }).map((_, colIdx) => {
              const displayCol = playerColor === 'black' ? 7 - colIdx : colIdx;
              const isLight = (displayRow + displayCol) % 2 === 0;
              const piece = gameState.board[displayRow][displayCol];
              const isSelected = gameState.selectedPiece?.row === displayRow && gameState.selectedPiece?.col === displayCol;
              const isValidMove = gameState.validMoves.some(m => m.to.row === displayRow && m.to.col === displayCol);
              const isCapture = gameState.validMoves.some(m => m.to.row === displayRow && m.to.col === displayCol && m.captures && m.captures.length > 0);

              return (
                <div
                  key={`${rowIdx}-${colIdx}`}
                  className={cn(
                    "relative flex items-center justify-center transition-colors duration-150",
                    isLight ? "bg-amber-100" : "bg-amber-800",
                    isSelected && "ring-4 ring-emerald-400 ring-inset",
                    isPlayerTurn && !isLight ? "cursor-pointer" : "cursor-default"
                  )}
                  onClick={() => handleSquareClick(displayRow, displayCol)}
                >
                  {isValidMove && (
                    <div className={cn(
                      "absolute rounded-full transition-all z-10",
                      isCapture
                        ? "w-full h-full border-4 border-red-500/60"
                        : "w-4 h-4 bg-emerald-500/50"
                    )} />
                  )}

                  {piece && (
                    <div className={cn(
                      "w-[80%] h-[80%] rounded-full transition-transform z-20",
                      "shadow-lg border-4",
                      piece.color === 'red'
                        ? "bg-gradient-to-br from-red-500 to-red-700 border-red-400"
                        : "bg-gradient-to-br from-zinc-700 to-zinc-900 border-zinc-500",
                      isSelected && "scale-105 shadow-xl"
                    )}>
                      {piece.type === 'king' && (
                        <div className="w-full h-full flex items-center justify-center">
                          <svg viewBox="0 0 24 24" className="w-1/2 h-1/2 fill-yellow-400 drop-shadow-md">
                            <path d="M12 1L15.5 8L23 9L17.5 14.5L19 22L12 18.5L5 22L6.5 14.5L1 9L8.5 8L12 1Z" />
                          </svg>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            });
          })}
        </div>
      </div>

      <div className={cn(
        "flex items-center justify-between px-4 py-3 rounded-lg",
        isPlayerTurn ? "bg-zinc-800 ring-2 ring-emerald-500" : "bg-zinc-800/50"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-5 h-5 rounded-full border-2 shadow-md",
            playerColor === 'red' ? "bg-red-600 border-red-400" : "bg-zinc-900 border-zinc-600"
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

      {gameState.mustCapture && isPlayerTurn && (
        <div className="text-center text-sm text-amber-400 font-medium">
          {t('You must capture!', 'You must capture!')}
        </div>
      )}

      {gameEnded && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-2xl p-8 text-center max-w-sm mx-4 border border-zinc-700">
            <h2 className="text-2xl font-bold mb-2">{t('Game Over', 'Game Over')}</h2>
            <p className="text-lg text-muted-foreground mb-6">{resultMessage}</p>
            <div className="text-sm text-zinc-500">
              {t('Redirecting...', 'Redirecting...')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
