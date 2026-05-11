import { useState, useEffect, useCallback, useRef } from "react";
import { useLanguage } from "@/context/LanguageContext";
import { useGame } from "@/context/GameContext";
import { Button } from "@/components/ui/button";
import {
  BOARD_FILES,
  BOARD_RANKS,
  INITIAL_TIME_MS,
  type Color,
  type Square,
} from "@shared/games/xiangqi";
import { pieceGlyph } from "./xiangqi/pieces";
import { XiangqiEngine, type XiangqiClientState } from "./xiangqi/XiangqiEngine";
import { cn } from "@/lib/utils";

type Result = "win" | "loss" | "draw";

interface XiangqiGameProps {
  onFinish: (result: Result) => void;
}

interface OpponentMovePayload {
  from: Square;
  to: Square;
  newTurn: Color;
  redTime: number;
  blackTime: number;
}

export function XiangqiGame({ onFinish }: XiangqiGameProps) {
  const { t } = useLanguage();
  const { state, socket } = useGame();

  const [gameState, setGameState] = useState<XiangqiClientState | null>(null);
  const [playerColor, setPlayerColor] = useState<Color | null>(null);
  const [waitingForOpponent, setWaitingForOpponent] = useState(true);
  const [gameEnded, setGameEnded] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [redTime, setRedTime] = useState(INITIAL_TIME_MS);
  const [blackTime, setBlackTime] = useState(INITIAL_TIME_MS);
  const [drawOfferedByOpponent, setDrawOfferedByOpponent] = useState(false);
  const [drawOfferSent, setDrawOfferSent] = useState(false);

  const engineRef = useRef<XiangqiEngine | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameEndedRef = useRef(false);
  const onFinishCalledRef = useRef(false);

  const matchId = state.currentMatch?.id;
  const playerId = state.wallet.address || "anonymous";
  const nickname = state.wallet.address
    ? localStorage.getItem(`nickname_${state.wallet.address}`)
    : null;
  const [opponentNickname, setOpponentNickname] = useState<string | null>(null);
  const isConnected = !!socket?.connected;
  const isPlayerTurn = !!playerColor && gameState?.currentTurn === playerColor;

  const handleStateChange = useCallback(
    (newState: XiangqiClientState) => {
      setGameState(newState);
      // Local engine detected terminal state — show the modal and stop the
      // clock. Server's `game-result` is the canonical signal; we don't
      // notify it from here.
      if (newState.gameOver && !gameEndedRef.current) {
        gameEndedRef.current = true;
        setGameEnded(true);
        if (timerRef.current) clearInterval(timerRef.current);

        const isDraw = newState.winner === "draw";
        const playerWins = newState.winner === playerColor;
        if (isDraw) {
          setResultMessage(t("Draw!", "Draw!"));
        } else {
          setResultMessage(
            playerWins ? t("You win!", "You win!") : t("You lose!", "You lose!"),
          );
        }
      }
    },
    [playerColor, t],
  );

  useEffect(() => {
    if (!socket || !matchId || matchId === "pending") return;

    const emitJoin = () => {
      socket.emit("join-xiangqi-match", { matchId, playerId, nickname: nickname ?? undefined });
      console.log("[XiangqiGame] join-xiangqi-match emitted", matchId);
    };
    emitJoin();

    const onColorAssigned = (data: { color: Color }) => {
      console.log("[XiangqiGame] color assigned:", data.color);
      setPlayerColor(data.color);
    };

    const onGameStart = (data?: {
      publicState?: {
        redTime: number;
        blackTime: number;
        currentTurn: Color;
        board?: string;
        pliesSinceCapture?: number;
      };
      opponentNickname?: string | null;
    }) => {
      console.log("[XiangqiGame] game started", data);
      setWaitingForOpponent(false);
      if (data?.opponentNickname !== undefined) setOpponentNickname(data.opponentNickname);
      const engine = new XiangqiEngine(handleStateChange);
      engineRef.current = engine;
      // Hydrate from server snapshot so reconnect restores true state.
      if (data?.publicState?.board) {
        engine.hydrate(
          data.publicState.board,
          data.publicState.currentTurn,
          data.publicState.pliesSinceCapture ?? 0,
        );
      } else {
        engine.start();
      }
      if (data?.publicState) {
        setRedTime(data.publicState.redTime);
        setBlackTime(data.publicState.blackTime);
      }
    };

    const onOpponentMove = (data: OpponentMovePayload) => {
      console.log("[XiangqiGame] opponent move:", data);
      if (engineRef.current) {
        engineRef.current.applyOpponentMove(data.from, data.to, data.newTurn);
        setRedTime(data.redTime);
        setBlackTime(data.blackTime);
        // Any opponent move implicitly declines an outstanding draw
        // offer from us — clear the local "waiting" flag.
        setDrawOfferSent(false);
        setDrawOfferedByOpponent(false);
      }
    };

    const onOpponentTimeout = () => {
      if (!gameEndedRef.current) {
        gameEndedRef.current = true;
        setGameEnded(true);
        if (engineRef.current) engineRef.current.forceEnd(playerColor);
        setResultMessage(
          t("Opponent ran out of time - You win!", "Opponent ran out of time - You win!"),
        );
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    const onOpponentDisconnected = (data: { forfeit: boolean }) => {
      if (data.forfeit && !gameEndedRef.current) {
        console.log("[XiangqiGame] opponent disconnected - forfeit");
        gameEndedRef.current = true;
        setGameEnded(true);
        if (engineRef.current) engineRef.current.forceEnd(playerColor);
        setResultMessage(
          t("Opponent disconnected - You win!", "Opponent disconnected - You win!"),
        );
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    const onDrawOffered = (data: { from: Color }) => {
      // Only display the prompt if the offer came from the OTHER side.
      if (data.from !== playerColor) {
        setDrawOfferedByOpponent(true);
      }
    };

    const onGameResult = (data: {
      matchId: string;
      winnerId: string | null;
      loserId: string | null;
      reason: string;
    }) => {
      console.log("[XiangqiGame] game-result received:", data);
      if (onFinishCalledRef.current) return;
      onFinishCalledRef.current = true;
      gameEndedRef.current = true;
      setGameEnded(true);
      if (timerRef.current) clearInterval(timerRef.current);

      let result: Result;
      if (data.winnerId === null && data.loserId === null) {
        result = "draw";
        setResultMessage(t("Draw!", "Draw!"));
      } else if (data.winnerId === playerId) {
        result = "win";
        setResultMessage(t("You win!", "You win!"));
      } else {
        result = "loss";
        setResultMessage(t("You lose!", "You lose!"));
      }
      setTimeout(() => onFinish(result), 1500);
    };

    socket.on("connect", emitJoin);
    socket.on("xiangqi-color-assigned", onColorAssigned);
    socket.on("xiangqi-game-start", onGameStart);
    socket.on("opponent-xiangqi-move", onOpponentMove);
    socket.on("opponent-xiangqi-timeout", onOpponentTimeout);
    socket.on("opponent-disconnected", onOpponentDisconnected);
    socket.on("xiangqi-draw-offered", onDrawOffered);
    socket.on("game-result", onGameResult);

    return () => {
      socket.off("connect", emitJoin);
      socket.off("xiangqi-color-assigned", onColorAssigned);
      socket.off("xiangqi-game-start", onGameStart);
      socket.off("opponent-xiangqi-move", onOpponentMove);
      socket.off("opponent-xiangqi-timeout", onOpponentTimeout);
      socket.off("opponent-disconnected", onOpponentDisconnected);
      socket.off("xiangqi-draw-offered", onDrawOffered);
      socket.off("game-result", onGameResult);
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, matchId, playerId, handleStateChange, onFinish, t]);

  // Tick the local clock display every second. The server is
  // authoritative — when it sends opponent-xiangqi-move it overrides
  // these values. Same pattern as CheckersGame.
  useEffect(() => {
    if (waitingForOpponent || gameEnded || !gameState) return;

    timerRef.current = setInterval(() => {
      if (gameState.currentTurn === "red") {
        setRedTime((prev) => {
          if (prev <= 1000) {
            handleTimeout("red");
            return 0;
          }
          return prev - 1000;
        });
      } else {
        setBlackTime((prev) => {
          if (prev <= 1000) {
            handleTimeout("black");
            return 0;
          }
          return prev - 1000;
        });
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForOpponent, gameEnded, gameState?.currentTurn]);

  const handleTimeout = useCallback(
    (color: Color) => {
      if (timerRef.current) clearInterval(timerRef.current);
      // Only the side that owns the drained clock should report the
      // timeout — the server validates against its authoritative clock.
      if (color === playerColor) {
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t("Time is up - You lose!", "Time is up - You lose!"));
        if (socket && matchId) {
          socket.emit("xiangqi-timeout", { matchId, color: playerColor });
        }
      }
    },
    [socket, playerColor, matchId, t],
  );

  const handleSquareClick = useCallback(
    (file: number, rank: number) => {
      if (!engineRef.current || !playerColor || gameEnded) return;
      if (gameState?.currentTurn !== playerColor) return;

      const piece = gameState?.board[file]?.[rank];
      const sq: Square = { file, rank };

      if (gameState?.selectedSquare) {
        const isValidMove = gameState.validMoves.some(
          (m) => m.file === file && m.rank === rank,
        );
        if (isValidMove) {
          const from = gameState.selectedSquare;
          if (engineRef.current.makeMove(sq, playerColor)) {
            const newTurn: Color = playerColor === "red" ? "black" : "red";
            if (socket && matchId) {
              socket.emit("xiangqi-move", {
                matchId,
                from,
                to: sq,
                newTurn,
                redTime,
                blackTime,
              });
            }
            setDrawOfferedByOpponent(false);
            setDrawOfferSent(false);
          }
        } else if (piece && piece.color === playerColor) {
          engineRef.current.selectSquare(sq, playerColor);
        } else {
          engineRef.current.clearSelection();
        }
      } else if (piece && piece.color === playerColor) {
        engineRef.current.selectSquare(sq, playerColor);
      }
    },
    [gameState, playerColor, socket, matchId, gameEnded, redTime, blackTime],
  );

  const handleResign = useCallback(() => {
    if (!playerColor || !socket || !matchId || gameEnded) return;
    socket.emit("xiangqi-resign", { matchId, color: playerColor });
  }, [socket, playerColor, matchId, gameEnded]);

  const handleOfferDraw = useCallback(() => {
    if (!socket || !matchId || gameEnded || drawOfferSent) return;
    socket.emit("xiangqi-draw-offer", { matchId });
    setDrawOfferSent(true);
  }, [socket, matchId, gameEnded, drawOfferSent]);

  const handleAcceptDraw = useCallback(() => {
    if (!socket || !matchId || gameEnded) return;
    socket.emit("xiangqi-draw-accept", { matchId });
    setDrawOfferedByOpponent(false);
  }, [socket, matchId, gameEnded]);

  const handleDeclineDraw = useCallback(() => {
    setDrawOfferedByOpponent(false);
  }, []);

  const formatTime = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  if (waitingForOpponent) {
    return (
      <div className="w-full flex flex-col items-center justify-center gap-4 py-12">
        <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-lg font-medium">
          {t("Waiting for opponent...", "Waiting for opponent...")}
        </p>
        <p className="text-sm text-muted-foreground">
          {isConnected ? t("Connected", "Connected") : t("Connecting...", "Connecting...")}
        </p>
      </div>
    );
  }

  if (!gameState) return null;

  const opponentColor: Color = playerColor === "red" ? "black" : "red";
  const opponentTime = playerColor === "red" ? blackTime : redTime;
  const myTime = playerColor === "red" ? redTime : blackTime;
  const isOpponentTurn = gameState.currentTurn === opponentColor;
  // The board's UI rank ordering: black-side player views the board
  // flipped so their pieces are at the bottom.
  const flipped = playerColor === "black";

  return (
    <div className="w-full flex flex-col gap-3">
      {/* Opponent banner */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3 rounded-lg",
          isOpponentTurn ? "bg-zinc-800 ring-2 ring-amber-500" : "bg-zinc-800/50",
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-5 h-5 rounded-full border-2 shadow-md",
              opponentColor === "red"
                ? "bg-red-600 border-red-400"
                : "bg-zinc-900 border-zinc-600",
            )}
          />
          <span className="font-semibold">{opponentNickname || t("Opponent", "Opponent")}</span>
        </div>
        <div
          className={cn(
            "font-mono text-lg font-bold px-3 py-1 rounded",
            opponentTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700",
          )}
        >
          {formatTime(opponentTime)}
        </div>
      </div>

      {/* Board: pieces sit on intersections so we render a 9×10 grid of
          tappable cells with the wood texture and river label drawn via
          background gradients. */}
      <div className="w-full bg-amber-100 rounded-lg overflow-hidden shadow-2xl border-4 border-amber-900/60 relative">
        <div
          className="grid w-full"
          style={{
            gridTemplateColumns: `repeat(${BOARD_FILES}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${BOARD_RANKS}, minmax(0, 1fr))`,
            aspectRatio: `${BOARD_FILES} / ${BOARD_RANKS}`,
          }}
        >
          {Array.from({ length: BOARD_RANKS }).map((_, rIdx) => {
            // Display rank 0 = top of the screen. Red player (the default
            // orientation) sees rank 0 at the bottom, so we flip rIdx →
            // displayRank = BOARD_RANKS - 1 - rIdx for red, and identity
            // for black.
            const displayRank = flipped ? rIdx : BOARD_RANKS - 1 - rIdx;
            return Array.from({ length: BOARD_FILES }).map((_, fIdx) => {
              const displayFile = flipped ? BOARD_FILES - 1 - fIdx : fIdx;
              const piece = gameState.board[displayFile][displayRank];
              const isSelected =
                gameState.selectedSquare?.file === displayFile &&
                gameState.selectedSquare?.rank === displayRank;
              const isValid = gameState.validMoves.some(
                (m) => m.file === displayFile && m.rank === displayRank,
              );
              const isCaptureMove = isValid && !!piece;
              const isRiverEdge = displayRank === 4 || displayRank === 5;
              const inPalace =
                displayFile >= 3 &&
                displayFile <= 5 &&
                ((displayRank >= 0 && displayRank <= 2) ||
                  (displayRank >= 7 && displayRank <= 9));

              return (
                <div
                  key={`${rIdx}-${fIdx}`}
                  className={cn(
                    "relative flex items-center justify-center cursor-pointer select-none",
                    isRiverEdge ? "bg-amber-200" : "bg-amber-100",
                    inPalace && "bg-amber-200/70",
                    isSelected && "ring-4 ring-emerald-500 ring-inset z-30",
                  )}
                  onClick={() => handleSquareClick(displayFile, displayRank)}
                  data-testid={`xiangqi-cell-${displayFile}-${displayRank}`}
                >
                  {/* grid lines */}
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-amber-900/40" />
                    <div className="absolute top-1/2 left-0 right-0 h-px bg-amber-900/40" />
                  </div>

                  {/* legal-move marker */}
                  {isValid && !piece && (
                    <div className="absolute w-3 h-3 sm:w-4 sm:h-4 rounded-full bg-emerald-500/60 z-10" />
                  )}
                  {isCaptureMove && (
                    <div className="absolute inset-1 rounded-full border-[3px] border-red-500/70 z-10" />
                  )}

                  {/* piece */}
                  {piece && (
                    <div
                      className={cn(
                        "relative z-20 w-[88%] h-[88%] rounded-full flex items-center justify-center font-bold shadow-lg border-2",
                        "text-base sm:text-2xl",
                        piece.color === "red"
                          ? "bg-gradient-to-br from-amber-50 to-amber-100 text-red-700 border-red-700/70"
                          : "bg-gradient-to-br from-amber-50 to-amber-100 text-zinc-900 border-zinc-900/70",
                        isSelected && "scale-105",
                      )}
                    >
                      {pieceGlyph(piece.color, piece.type)}
                    </div>
                  )}
                </div>
              );
            });
          })}
        </div>

        {/* River label band */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 pointer-events-none">
          <div className="text-center text-amber-900/40 font-display tracking-[0.5em] text-xs sm:text-sm">
            楚 河　　　　漢 界
          </div>
        </div>
      </div>

      {/* Self banner */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3 rounded-lg",
          isPlayerTurn ? "bg-zinc-800 ring-2 ring-emerald-500" : "bg-zinc-800/50",
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-5 h-5 rounded-full border-2 shadow-md",
              playerColor === "red"
                ? "bg-red-600 border-red-400"
                : "bg-zinc-900 border-zinc-600",
            )}
          />
          <span className="font-semibold">
            {nickname || t("You", "You")} ({playerColor})
          </span>
        </div>
        <div
          className={cn(
            "font-mono text-lg font-bold px-3 py-1 rounded",
            myTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700",
          )}
        >
          {formatTime(myTime)}
        </div>
      </div>

      {/* Status hints */}
      {gameState.status === "check" && (
        <div className="text-center text-sm text-amber-400 font-medium">
          {gameState.currentTurn === playerColor
            ? t("Check! You must respond.", "Check! You must respond.")
            : t("You delivered check!", "You delivered check!")}
        </div>
      )}

      {/* Resign / Draw controls */}
      <div className="flex items-center justify-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleOfferDraw}
          disabled={gameEnded || drawOfferSent}
          data-testid="button-xiangqi-draw"
        >
          {drawOfferSent ? t("Draw offered…", "Draw offered…") : t("Offer Draw", "Offer Draw")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={handleResign}
          disabled={gameEnded}
          data-testid="button-xiangqi-resign"
        >
          {t("Resign", "Resign")}
        </Button>
      </div>

      {/* Draw offer prompt */}
      {drawOfferedByOpponent && (
        <div className="fixed inset-x-4 bottom-4 sm:bottom-8 z-40 flex justify-center">
          <div className="bg-zinc-900 border border-amber-500/70 rounded-xl px-4 py-3 shadow-2xl flex items-center gap-3 max-w-sm w-full">
            <span className="text-sm flex-1">
              {t("Opponent offers a draw.", "Opponent offers a draw.")}
            </span>
            <Button size="sm" variant="default" onClick={handleAcceptDraw} data-testid="button-xiangqi-accept-draw">
              {t("Accept", "Accept")}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDeclineDraw} data-testid="button-xiangqi-decline-draw">
              {t("Decline", "Decline")}
            </Button>
          </div>
        </div>
      )}

      {/* Game over modal */}
      {gameEnded && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-2xl p-8 text-center max-w-sm mx-4 border border-zinc-700">
            <h2 className="text-2xl font-bold mb-2">{t("Game Over", "Game Over")}</h2>
            <p className="text-lg text-muted-foreground mb-6">{resultMessage}</p>
            <div className="text-sm text-zinc-500">
              {t("Redirecting...", "Redirecting...")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
