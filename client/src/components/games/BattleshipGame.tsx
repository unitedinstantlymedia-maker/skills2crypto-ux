import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useGame } from '@/context/GameContext';
import { useLanguage } from '@/context/LanguageContext';
import { cn } from '@/lib/utils';
import { BattleshipEngine, BattleshipState, Ship, CellState } from './battleship/BattleshipEngine';

type Result = 'win' | 'loss' | 'draw';

interface BattleshipGameProps {
  onFinish: (result: Result) => void;
}

const GRID_SIZE = 10;
const TURN_TIME = 60000;

export function BattleshipGame({ onFinish }: BattleshipGameProps) {
  const { t } = useLanguage();
  const { state } = useGame();
  const matchId = state.currentMatch?.id;

  const socketRef = useRef<Socket | null>(null);
  const engineRef = useRef<BattleshipEngine | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameEndedRef = useRef(false);

  const [gameState, setGameState] = useState<BattleshipState | null>(null);
  const [playerRole, setPlayerRole] = useState<'player1' | 'player2' | null>(null);
  const [waitingForOpponent, setWaitingForOpponent] = useState(true);
  const [opponentReady, setOpponentReady] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [gameEnded, setGameEnded] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [turnTime, setTurnTime] = useState(TURN_TIME);
  const [lastSunkMessage, setLastSunkMessage] = useState<string | null>(null);
  const [myReady, setMyReady] = useState(false);

  const [selectedShip, setSelectedShip] = useState<string | null>(null);
  const [isHorizontal, setIsHorizontal] = useState(true);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);

  useEffect(() => {
    if (!matchId) return;

    const playerId = state.wallet?.address || localStorage.getItem('playerId') || `player-${Date.now()}`;
    localStorage.setItem('playerId', playerId);

    const socket = io({
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[BattleshipGame] connected');
      setIsConnected(true);
      socket.emit('join-battleship-match', { matchId, playerId });
    });

    socket.on('battleship-role-assigned', (data: { role: 'player1' | 'player2' }) => {
      console.log('[BattleshipGame] role assigned:', data.role);
      setPlayerRole(data.role);

      const engine = new BattleshipEngine(setGameState, data.role);
      engineRef.current = engine;
      setGameState(engine.getState());
    });

    socket.on('battleship-game-start', () => {
      console.log('[BattleshipGame] game start');
      setWaitingForOpponent(false);
    });

    socket.on('opponent-ready', () => {
      console.log('[BattleshipGame] opponent ready');
      setOpponentReady(true);
    });

    socket.on('battle-phase-start', (data: { firstTurn: 'player1' | 'player2' }) => {
      console.log('[BattleshipGame] battle phase start, first turn:', data.firstTurn);
      if (engineRef.current) {
        engineRef.current.startBattle();
        engineRef.current.setTurn(data.firstTurn);
        setTurnTime(TURN_TIME);
      }
    });

    socket.on('attack-result', (data: {
      row: number;
      col: number;
      hit: boolean;
      sunkShip: Ship | null;
      gameOver: boolean;
      nextTurn: 'player1' | 'player2';
    }) => {
      console.log('[BattleshipGame] attack result:', data);
      if (engineRef.current) {
        engineRef.current.recordMyAttack(data.row, data.col, data.hit, data.sunkShip, data.gameOver);

        if (data.sunkShip) {
          setLastSunkMessage(`You sunk the ${data.sunkShip.name}!`);
          setTimeout(() => setLastSunkMessage(null), 3000);
        }

        if (data.gameOver && !gameEndedRef.current) {
          gameEndedRef.current = true;
          setGameEnded(true);
          setResultMessage(t('Victory! You sunk all enemy ships!', 'Victory! You sunk all enemy ships!'));
          setTimeout(() => onFinish('win'), 2000);
        } else {
          setTurnTime(TURN_TIME);
        }
      }
    });

    socket.on('opponent-attack', (data: {
      row: number;
      col: number;
      hit: boolean;
      sunkShipCells?: { row: number; col: number }[];
      sunkShipName?: string;
      gameOver: boolean;
    }) => {
      console.log('[BattleshipGame] opponent attack:', data);
      if (engineRef.current) {
        engineRef.current.recordOpponentAttack(data.row, data.col, data.hit, data.sunkShipCells);

        if (data.sunkShipName) {
          setLastSunkMessage(`Your ${data.sunkShipName} was sunk!`);
          setTimeout(() => setLastSunkMessage(null), 3000);
        }

        if (data.gameOver && !gameEndedRef.current) {
          gameEndedRef.current = true;
          setGameEnded(true);
          setResultMessage(t('Defeat! All your ships were sunk!', 'Defeat! All your ships were sunk!'));
          setTimeout(() => onFinish('loss'), 2000);
        } else {
          setTurnTime(TURN_TIME);
        }
      }
    });

    socket.on('turn-skipped', (data: { skippedPlayer: 'player1' | 'player2' }) => {
      console.log('[BattleshipGame] turn skipped:', data.skippedPlayer);
      if (engineRef.current) {
        const nextTurn = data.skippedPlayer === 'player1' ? 'player2' : 'player1';
        engineRef.current.setTurn(nextTurn);
        setTurnTime(TURN_TIME);
      }
    });

    socket.on('opponent-disconnected', () => {
      if (!gameEndedRef.current) {
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t('Opponent disconnected - You win!', 'Opponent disconnected - You win!'));
        setTimeout(() => onFinish('win'), 2000);
      }
    });

    if (socket.connected) {
      setIsConnected(true);
      socket.emit('join-battleship-match', { matchId, playerId });
    } else {
      socket.connect();
    }

    return () => {
      socket.off('connect');
      socket.off('battleship-role-assigned');
      socket.off('battleship-game-start');
      socket.off('opponent-ready');
      socket.off('battle-phase-start');
      socket.off('attack-result');
      socket.off('opponent-attack');
      socket.off('turn-skipped');
      socket.off('opponent-disconnected');
      socket.disconnect();
    };
  }, [matchId, onFinish, t, state.wallet?.address]);

  useEffect(() => {
    if (!gameState || gameState.phase !== 'battle' || gameEnded) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      setTurnTime(prev => {
        if (prev <= 1000) {
          if (engineRef.current?.isMyTurn() && socketRef.current && matchId) {
            socketRef.current.emit('battleship-timeout', { matchId, role: playerRole });
          }
          return TURN_TIME;
        }
        return prev - 1000;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [gameState?.phase, gameState?.currentTurn, gameEnded, matchId, playerRole]);

  const handlePlaceShip = useCallback((row: number, col: number) => {
    if (!engineRef.current || !selectedShip) return;

    if (engineRef.current.placeShip(selectedShip, row, col, isHorizontal)) {
      setSelectedShip(null);
    }
  }, [selectedShip, isHorizontal]);

  const handleRemoveShip = useCallback((shipId: string) => {
    if (engineRef.current) {
      engineRef.current.removeShip(shipId);
    }
  }, []);

  const handleReady = useCallback(() => {
    if (!engineRef.current || !socketRef.current || !matchId) return;
    if (!engineRef.current.isAllShipsPlaced()) return;

    const placements = engineRef.current.getShipPlacements();
    socketRef.current.emit('battleship-ready', { matchId, placements });
    setMyReady(true);
  }, [matchId]);

  const handleAttack = useCallback((row: number, col: number) => {
    if (!engineRef.current || !socketRef.current || !matchId) return;
    if (!engineRef.current.canAttack(row, col)) return;

    socketRef.current.emit('battleship-attack', { matchId, row, col });
  }, [matchId]);

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return `${seconds}s`;
  };

  const getPreviewCells = useCallback(() => {
    if (!selectedShip || !hoverCell || !engineRef.current) return [];

    const config = engineRef.current.getShipConfigs().find(s => s.id === selectedShip);
    if (!config) return [];

    const cells: { row: number; col: number; valid: boolean }[] = [];
    const canPlace = engineRef.current.canPlaceShip(selectedShip, hoverCell.row, hoverCell.col, isHorizontal);

    for (let i = 0; i < config.size; i++) {
      const r = isHorizontal ? hoverCell.row : hoverCell.row + i;
      const c = isHorizontal ? hoverCell.col + i : hoverCell.col;
      if (r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE) {
        cells.push({ row: r, col: c, valid: canPlace });
      }
    }

    return cells;
  }, [selectedShip, hoverCell, isHorizontal]);

  const renderCell = (
    cellState: CellState,
    row: number,
    col: number,
    isMyBoard: boolean,
    isClickable: boolean,
    onClick: () => void,
    previewCells: { row: number; col: number; valid: boolean }[] = []
  ) => {
    const isPreview = previewCells.some(c => c.row === row && c.col === col);
    const previewValid = previewCells.find(c => c.row === row && c.col === col)?.valid;

    let bgColor = 'bg-blue-900/50';
    let content = null;

    if (isPreview) {
      bgColor = previewValid ? 'bg-green-500/50' : 'bg-red-500/50';
    } else if (cellState === 'ship' && isMyBoard) {
      bgColor = 'bg-slate-500';
    } else if (cellState === 'hit') {
      bgColor = 'bg-red-600';
      content = <div className="w-3 h-3 bg-orange-400 rounded-full animate-pulse" />;
    } else if (cellState === 'miss') {
      bgColor = 'bg-blue-800';
      content = <div className="w-2 h-2 bg-white/40 rounded-full" />;
    } else if (cellState === 'sunk') {
      bgColor = 'bg-red-800';
      content = <div className="w-3 h-3 bg-red-400 rounded-full" />;
    }

    return (
      <div
        key={`${row}-${col}`}
        className={cn(
          "aspect-square border border-blue-700/30 flex items-center justify-center transition-all duration-100",
          bgColor,
          isClickable && cellState === 'empty' && !isPreview && "cursor-pointer hover:bg-blue-600/50"
        )}
        onClick={isClickable ? onClick : undefined}
        onMouseEnter={() => setHoverCell({ row, col })}
        onMouseLeave={() => setHoverCell(null)}
      >
        {content}
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

  if (!gameState || !playerRole) return null;

  if (gameState.phase === 'setup') {
    const shipConfigs = engineRef.current?.getShipConfigs() || [];
    const placedShipIds = engineRef.current?.getPlacedShipIds() || [];
    const allPlaced = engineRef.current?.isAllShipsPlaced() || false;
    const previewCells = getPreviewCells();

    return (
      <div className="w-full flex flex-col gap-4">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2">{t('Place Your Ships', 'Place Your Ships')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('Select a ship below, then click on the grid to place it', 'Select a ship below, then click on the grid to place it')}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 justify-center mb-2">
          {shipConfigs.map(ship => {
            const isPlaced = placedShipIds.includes(ship.id);
            const isSelected = selectedShip === ship.id;

            return (
              <button
                key={ship.id}
                onClick={() => {
                  if (isPlaced) {
                    handleRemoveShip(ship.id);
                  } else {
                    setSelectedShip(isSelected ? null : ship.id);
                  }
                }}
                disabled={myReady}
                className={cn(
                  "px-3 py-2 rounded-lg text-sm font-medium transition-all",
                  isPlaced && "bg-green-600 text-white",
                  isSelected && "bg-yellow-500 text-black ring-2 ring-yellow-300",
                  !isPlaced && !isSelected && "bg-slate-700 text-white hover:bg-slate-600",
                  myReady && "opacity-50 cursor-not-allowed"
                )}
              >
                {ship.name} ({ship.size})
                {isPlaced && " ✓"}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setIsHorizontal(!isHorizontal)}
          disabled={myReady}
          className={cn(
            "mx-auto px-4 py-2 bg-slate-700 rounded-lg text-sm hover:bg-slate-600 transition-colors",
            myReady && "opacity-50 cursor-not-allowed"
          )}
        >
          {t('Orientation:', 'Orientation:')} {isHorizontal ? '⟷ ' + t('Horizontal', 'Horizontal') : '⟵ ' + t('Vertical', 'Vertical')}
        </button>

        <div className="w-full max-w-xs mx-auto aspect-square rounded-lg overflow-hidden border-2 border-blue-600/50 shadow-xl">
          <div className="grid grid-cols-10 grid-rows-10 w-full h-full bg-blue-950">
            {Array.from({ length: GRID_SIZE }).map((_, row) =>
              Array.from({ length: GRID_SIZE }).map((_, col) => {
                const cellState = gameState.myBoard[row][col];
                const canClick = !myReady && !!selectedShip;

                return renderCell(
                  cellState,
                  row,
                  col,
                  true,
                  canClick,
                  () => handlePlaceShip(row, col),
                  previewCells
                );
              })
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 items-center mt-2">
          {!myReady ? (
            <button
              onClick={handleReady}
              disabled={!allPlaced}
              className={cn(
                "px-6 py-3 rounded-lg font-bold text-lg transition-all",
                allPlaced
                  ? "bg-green-600 hover:bg-green-500 text-white"
                  : "bg-slate-700 text-slate-400 cursor-not-allowed"
              )}
            >
              {allPlaced ? t('Ready for Battle!', 'Ready for Battle!') : t('Place all ships first', 'Place all ships first')}
            </button>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-green-400 font-medium">{t('Waiting for opponent to place ships...', 'Waiting for opponent to place ships...')}</p>
            </div>
          )}

          {opponentReady && !myReady && (
            <p className="text-green-400 animate-pulse">
              {t('Opponent is ready!', 'Opponent is ready!')}
            </p>
          )}
        </div>
      </div>
    );
  }

  const isMyTurn = gameState.currentTurn === playerRole;

  return (
    <div className="w-full flex flex-col gap-3">
      {resultMessage && (
        <div className={cn(
          "text-center py-3 rounded-lg font-bold text-lg animate-pulse",
          gameState.winner === playerRole ? "bg-green-600" : "bg-red-600"
        )}>
          {resultMessage}
        </div>
      )}

      {lastSunkMessage && (
        <div className="text-center py-2 bg-orange-600 rounded-lg font-bold text-sm animate-bounce">
          {lastSunkMessage}
        </div>
      )}

      <div className={cn(
        "flex items-center justify-between px-4 py-2 rounded-lg",
        isMyTurn ? "bg-green-600/20 ring-2 ring-green-500" : "bg-zinc-800"
      )}>
        <span className="font-semibold text-sm">
          {isMyTurn ? t('🎯 Your Turn - Attack!', '🎯 Your Turn - Attack!') : t("⏳ Opponent's Turn", "⏳ Opponent's Turn")}
        </span>
        <div className={cn(
          "font-mono text-base font-bold px-3 py-1 rounded",
          turnTime < 10000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700"
        )}>
          {formatTime(turnTime)}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <h3 className="text-center text-xs font-semibold mb-1 text-red-400">
            {t('🎯 Enemy Waters', '🎯 Enemy Waters')}
          </h3>
          <div className="aspect-square rounded-lg overflow-hidden border-2 border-red-600/50 shadow-xl">
            <div className="grid grid-cols-10 grid-rows-10 w-full h-full bg-blue-950">
              {Array.from({ length: GRID_SIZE }).map((_, row) =>
                Array.from({ length: GRID_SIZE }).map((_, col) => {
                  const cellState = gameState.enemyBoard[row][col];
                  const canAttack = isMyTurn && !gameEnded && cellState === 'empty';

                  return renderCell(
                    cellState,
                    row,
                    col,
                    false,
                    canAttack,
                    () => handleAttack(row, col)
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-center text-xs font-semibold mb-1 text-blue-400">
            {t('🚢 Your Fleet', '🚢 Your Fleet')}
          </h3>
          <div className="aspect-square rounded-lg overflow-hidden border-2 border-blue-600/50 shadow-xl">
            <div className="grid grid-cols-10 grid-rows-10 w-full h-full bg-blue-950">
              {Array.from({ length: GRID_SIZE }).map((_, row) =>
                Array.from({ length: GRID_SIZE }).map((_, col) => {
                  const cellState = gameState.myBoard[row][col];
                  return renderCell(cellState, row, col, true, false, () => {});
                })
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-between text-xs px-2">
        <div>
          <span className="text-muted-foreground">{t('Enemy ships:', 'Enemy ships:')}</span>{' '}
          <span className="font-bold text-red-400">{gameState.enemyShipsRemaining}</span>
        </div>
        <div>
          <span className="text-muted-foreground">{t('Your ships:', 'Your ships:')}</span>{' '}
          <span className="font-bold text-green-400">
            {gameState.myShips.filter(s => !s.sunk).length}/{gameState.myShips.length}
          </span>
        </div>
      </div>
    </div>
  );
}
