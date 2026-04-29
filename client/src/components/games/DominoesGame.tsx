import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGame } from "@/context/GameContext";
import { useLanguage } from "@/context/LanguageContext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DominoTile } from "./dominoes/DominoTile";
import {
  DominoesClientEngine,
  type ChainEnd,
  type DominoesPublicState,
  type DominoesViewState,
  type PlacedTile,
  type PlayerRole,
  type Tile,
} from "./dominoes/DominoesEngine";

interface DominoesGameProps {
  onFinish: (result: "win" | "loss" | "draw") => void;
}

export function DominoesGame({ onFinish }: DominoesGameProps) {
  const { state, socket } = useGame();
  const { t } = useLanguage();

  const matchId = state.currentMatch?.id;
  const playerId = state.wallet.address || "anonymous";

  const engineRef = useRef<DominoesClientEngine>(new DominoesClientEngine());
  const [view, setView] = useState<DominoesViewState | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [p1Time, setP1Time] = useState(10 * 60 * 1000);
  const [p2Time, setP2Time] = useState(10 * 60 * 1000);
  const [gameEnded, setGameEnded] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const gameEndedRef = useRef(false);
  const onFinishCalledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to engine state.
  useEffect(() => {
    const unsub = engineRef.current.subscribe((v) => {
      setView(v);
      setP1Time(v.publicState.p1Time);
      setP2Time(v.publicState.p2Time);
    });
    return unsub;
  }, []);

  // Wire socket events.
  useEffect(() => {
    if (!socket || !matchId || !playerId) return;

    socket.emit("join-dominoes-match", { matchId, playerId });

    const onGameStart = (data: {
      role: PlayerRole;
      hand: Tile[];
      publicState: DominoesPublicState;
      starterTile?: Tile | null;
    }) => {
      setWaiting(false);
      setSelectedIdx(null);
      engineRef.current.setStart(data.role, data.hand, data.publicState);
      engineRef.current.setStarterTile(data.starterTile ?? null);
    };

    // Server tells us our move was rejected (or is otherwise out of sync)
    // and ships back the authoritative hand + public state. This rolls back
    // any optimistic tile removal so the rack matches the server.
    const onResync = (data: {
      hand: Tile[];
      publicState: DominoesPublicState;
    }) => {
      engineRef.current.applyResync(data.hand, data.publicState);
      setSelectedIdx(null);
    };

    const onMovePlayed = (data: {
      player: PlayerRole;
      placed: PlacedTile;
      end: ChainEnd;
      publicState: DominoesPublicState;
    }) => {
      // The moving player has already removed their tile locally on send.
      // For the opponent's move, just absorb the new public state.
      engineRef.current.applyPublicState(data.publicState);
      setSelectedIdx(null);
    };

    const onPassPlayed = (data: {
      player: PlayerRole;
      publicState: DominoesPublicState;
    }) => {
      engineRef.current.applyPublicState(data.publicState);
      setSelectedIdx(null);
    };

    const onOpponentDisconnected = (data: { forfeit: boolean }) => {
      if (data.forfeit && !gameEndedRef.current) {
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(
          t("Opponent disconnected - You win!", "Opponent disconnected - You win!"),
        );
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    const onGameResult = (data: {
      matchId: string;
      winnerId: string | null;
      loserId: string | null;
      reason: string;
    }) => {
      if (onFinishCalledRef.current) return;
      onFinishCalledRef.current = true;
      gameEndedRef.current = true;
      setGameEnded(true);
      if (timerRef.current) clearInterval(timerRef.current);
      let result: "win" | "loss" | "draw";
      if (data.winnerId === null && data.loserId === null) {
        result = "draw";
        setResultMessage(t("Draw — equal pip count", "Draw — equal pip count"));
      } else if (data.winnerId === playerId) {
        result = "win";
        setResultMessage(t("You win!", "You win!"));
      } else {
        result = "loss";
        setResultMessage(t("You lose!", "You lose!"));
      }
      setTimeout(() => onFinish(result), 1500);
    };

    socket.on("dominoes-game-start", onGameStart);
    socket.on("dominoes-move-played", onMovePlayed);
    socket.on("dominoes-pass-played", onPassPlayed);
    socket.on("dominoes-resync", onResync);
    socket.on("opponent-disconnected", onOpponentDisconnected);
    socket.on("game-result", onGameResult);

    return () => {
      socket.off("dominoes-game-start", onGameStart);
      socket.off("dominoes-move-played", onMovePlayed);
      socket.off("dominoes-pass-played", onPassPlayed);
      socket.off("dominoes-resync", onResync);
      socket.off("opponent-disconnected", onOpponentDisconnected);
      socket.off("game-result", onGameResult);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [socket, matchId, playerId, onFinish, t]);

  // Local clock tick for the active turn. The server holds authoritative
  // time and re-syncs on every move, so this is purely a smooth UI countdown.
  useEffect(() => {
    if (waiting || gameEnded || !view) return;
    const role = view.role;
    timerRef.current = setInterval(() => {
      if (view.publicState.currentTurn === "p1") {
        setP1Time((prev) => {
          if (prev <= 1000) {
            handleTimeoutLocal(role);
            return 0;
          }
          return prev - 1000;
        });
      } else {
        setP2Time((prev) => {
          if (prev <= 1000) {
            handleTimeoutLocal(role);
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
  }, [waiting, gameEnded, view?.publicState.currentTurn, view?.role]);

  const handleTimeoutLocal = useCallback(
    (myRole: PlayerRole) => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (!view) return;
      // Only the player whose clock ran out fires this — the server validates.
      if (view.publicState.currentTurn === myRole && socket && matchId) {
        socket.emit("dominoes-timeout", { matchId, role: myRole });
        gameEndedRef.current = true;
        setGameEnded(true);
        setResultMessage(t("Time is up - You lose!", "Time is up - You lose!"));
      }
    },
    [view, socket, matchId, t],
  );

  const handleTileClick = useCallback(
    (idx: number) => {
      if (!view || !view.myTurn || gameEnded) return;
      const canL = view.playableLeft[idx];
      const canR = view.playableRight[idx];
      if (!canL && !canR) return;
      // Auto-play: if only one end is legal, send immediately.
      if (canL && !canR) {
        playTile(idx, "left");
        return;
      }
      if (canR && !canL) {
        playTile(idx, "right");
        return;
      }
      // Both ends legal — toggle selection so the player picks an end.
      setSelectedIdx(idx === selectedIdx ? null : idx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, selectedIdx, gameEnded],
  );

  const playTile = useCallback(
    (idx: number, end: ChainEnd) => {
      if (!socket || !matchId || !view) return;
      const tile = view.hand[idx];
      if (!tile) return;
      // Send tile identity (a, b) — NOT the index — so the client is free to
      // sort the rack however it wants without ever desyncing from the
      // server's canonical hand order.
      socket.emit("dominoes-move", {
        matchId,
        tileA: tile.a,
        tileB: tile.b,
        end,
      });
      // Optimistically remove the tile so the rack updates without waiting.
      // If the server rejects, the dominoes-resync handler restores the hand.
      engineRef.current.removeTile(idx);
      setSelectedIdx(null);
    },
    [socket, matchId, view],
  );

  const handlePass = useCallback(() => {
    if (!socket || !matchId || !view || !view.mustPass) return;
    socket.emit("dominoes-pass", { matchId });
  }, [socket, matchId, view]);

  const formatTime = (ms: number) => {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const myTime = view?.role === "p1" ? p1Time : p2Time;
  const oppTime = view?.role === "p1" ? p2Time : p1Time;
  const oppTileCount = useMemo(() => {
    if (!view) return 0;
    return view.role === "p1"
      ? view.publicState.p2TileCount
      : view.publicState.p1TileCount;
  }, [view]);

  if (waiting) {
    return (
      <div className="w-full flex flex-col items-center justify-center gap-4 py-12">
        <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-lg font-medium">
          {t("Dealing tiles...", "Dealing tiles...")}
        </p>
      </div>
    );
  }

  if (!view) return null;

  return (
    <div className="w-full flex flex-col gap-4">
      {/* Opponent rack (face-down) */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3 rounded-lg",
          !view.myTurn ? "bg-zinc-800 ring-2 ring-amber-500" : "bg-zinc-800/50",
        )}
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold">{t("Opponent", "Opponent")}</span>
          <div className="flex gap-1">
            {Array.from({ length: oppTileCount }).map((_, i) => (
              <DominoTile
                key={i}
                left={0}
                right={0}
                size="sm"
                faceDown
                orientation="vertical"
              />
            ))}
          </div>
        </div>
        <div
          className={cn(
            "font-mono text-lg font-bold px-3 py-1 rounded",
            oppTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700",
          )}
        >
          {formatTime(oppTime)}
        </div>
      </div>

      {/* Chain area */}
      <div className="w-full min-h-[160px] rounded-lg bg-emerald-950/40 border-2 border-amber-900/40 p-3 overflow-x-auto">
        {view.publicState.chain.length === 0 ? (
          <div className="w-full h-full min-h-[140px] flex items-center justify-center text-zinc-500 text-sm">
            {view.myTurn
              ? t("Play any tile to lead", "Play any tile to lead")
              : t(
                  "Waiting for opponent to lead...",
                  "Waiting for opponent to lead...",
                )}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-1 flex-wrap">
            {view.publicState.chain.map((tile, idx) => (
              <DominoTile
                key={idx}
                left={tile.left}
                right={tile.right}
                orientation="horizontal"
                size="sm"
              />
            ))}
          </div>
        )}
      </div>

      {/* End-selection prompts when both ends legal */}
      {selectedIdx !== null && view.playableLeft[selectedIdx] && view.playableRight[selectedIdx] && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            onClick={() => playTile(selectedIdx, "left")}
            data-testid="button-play-left"
          >
            {t("Play LEFT", "Play LEFT")} ({view.publicState.leftEnd})
          </Button>
          <Button
            variant="outline"
            onClick={() => playTile(selectedIdx, "right")}
            data-testid="button-play-right"
          >
            {t("Play RIGHT", "Play RIGHT")} ({view.publicState.rightEnd})
          </Button>
        </div>
      )}

      {/* My rack */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3 rounded-lg",
          view.myTurn ? "bg-zinc-800 ring-2 ring-emerald-500" : "bg-zinc-800/50",
        )}
      >
        <span className="font-semibold">{t("You", "You")}</span>
        <div
          className={cn(
            "font-mono text-lg font-bold px-3 py-1 rounded",
            myTime < 60000 ? "bg-red-500/20 text-red-400" : "bg-zinc-700",
          )}
        >
          {formatTime(myTime)}
        </div>
      </div>

      <div className="flex items-end justify-center gap-1 flex-wrap py-2">
        {view.hand.map((tile, idx) => {
          const playable = view.myTurn && (view.playableLeft[idx] || view.playableRight[idx]);
          return (
            <DominoTile
              key={`${tile.a}-${tile.b}-${idx}`}
              left={tile.a}
              right={tile.b}
              orientation="vertical"
              size="md"
              selected={selectedIdx === idx}
              playable={playable}
              dimmed={view.myTurn && !playable}
              onClick={view.myTurn ? () => handleTileClick(idx) : undefined}
            />
          );
        })}
      </div>

      {view.mustPass && view.myTurn && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-amber-400 font-medium">
            {t("No legal move — you must pass.", "No legal move — you must pass.")}
          </p>
          <Button onClick={handlePass} variant="default" data-testid="button-pass">
            {t("Pass", "Pass")}
          </Button>
        </div>
      )}

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
