import { useState, useEffect, useCallback } from "react";
import { Chessboard } from "react-chessboard";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/context/LanguageContext";
import type { Match, ChessMove } from "@shared/protocol";

interface ChessGameProps {
  matchId?: string;
  playerId?: string;
  onFinish?: (result: { winnerId?: string; loserId?: string; draw?: boolean; reason: string } | "win" | "loss" | "draw") => void;
}

export function ChessGame({ matchId, playerId, onFinish }: ChessGameProps) {
  const { t } = useLanguage();
  const [match, setMatch] = useState<Match | null>(null);
  const [loading, setLoading] = useState(!!matchId);
  const [error, setError] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState(false);

  const fetchMatch = useCallback(async () => {
    if (!matchId) return;
    
    try {
      const res = await fetch(`/api/matches/${matchId}`);
      if (!res.ok) {
        throw new Error("Failed to fetch match");
      }
      const data: Match = await res.json();
      setMatch(data);
      setError(null);

      if (data.status === "finished" && data.result && onFinish) {
        onFinish({
          winnerId: data.result.winnerId,
          loserId: data.result.loserId,
          draw: data.result.draw,
          reason: data.result.reason,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [matchId, onFinish]);

  useEffect(() => {
    if (matchId) {
      fetchMatch();
    }
  }, [matchId, fetchMatch]);

  if (!matchId || !playerId) {
    return (
      <div className="flex flex-col items-center justify-center h-full space-y-8">
        <div className="w-full max-w-md aspect-square">
          <Chessboard
            options={{
              position: "start",
              allowDragging: false,
              boardStyle: {
                borderRadius: "8px",
                boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)",
              },
              darkSquareStyle: { backgroundColor: "#4a5568" },
              lightSquareStyle: { backgroundColor: "#718096" },
            }}
          />
        </div>
        <div className="text-center text-muted-foreground">
          <p className="text-sm font-mono">{t("Chess game preview", "Chess game preview")}</p>
          <p className="text-xs mt-2">{t("Waiting for match...", "Waiting for match...")}</p>
        </div>
      </div>
    );
  }

  const isPlayerWhite = match?.players.whiteId === playerId;
  const isPlayerBlack = match?.players.blackId === playerId;
  const isMyTurn =
    match?.status === "active" &&
    ((match.state.turn === "w" && isPlayerWhite) ||
      (match.state.turn === "b" && isPlayerBlack));

  const handleMove = ({
    piece,
    sourceSquare,
    targetSquare,
  }: {
    piece: { pieceType: string; position: string; isSparePiece: boolean };
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    if (!match || match.status !== "active" || !isMyTurn || pendingMove || !targetSquare) {
      return false;
    }

    const move: ChessMove = {
      from: sourceSquare,
      to: targetSquare,
    };

    const pieceType = piece.pieceType;
    if (pieceType[1]?.toLowerCase() === "p") {
      const targetRank = parseInt(targetSquare[1]);
      if ((pieceType[0] === "w" && targetRank === 8) || (pieceType[0] === "b" && targetRank === 1)) {
        move.promotion = "q";
      }
    }

    setPendingMove(true);

    fetch(`/api/matches/${matchId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, move }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json();
          setError(errData.error || "Invalid move");
          fetchMatch();
          return;
        }

        const updatedMatch: Match = await res.json();
        setMatch(updatedMatch);
        setError(null);

        if (updatedMatch.status === "finished" && updatedMatch.result && onFinish) {
          onFinish({
            winnerId: updatedMatch.result.winnerId,
            loserId: updatedMatch.result.loserId,
            draw: updatedMatch.result.draw,
            reason: updatedMatch.result.reason,
          });
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Move failed");
        fetchMatch();
      })
      .finally(() => {
        setPendingMove(false);
      });

    return true;
  };

  const handleResign = async () => {
    if (!match || match.status !== "active") return;

    try {
      const res = await fetch(`/api/matches/${matchId}/resign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId }),
      });

      if (!res.ok) {
        const errData = await res.json();
        setError(errData.error || "Resign failed");
        return;
      }

      const updatedMatch: Match = await res.json();
      setMatch(updatedMatch);

      if (updatedMatch.result && onFinish) {
        onFinish({
          winnerId: updatedMatch.result.winnerId,
          loserId: updatedMatch.result.loserId,
          draw: updatedMatch.result.draw,
          reason: updatedMatch.result.reason,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resign failed");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-muted-foreground">{t("Loading...", "Loading...")}</span>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-destructive">{error || t("Match not found", "Match not found")}</span>
      </div>
    );
  }

  const getTurnText = () => {
    if (match.status === "finished") {
      if (match.result?.draw) {
        return t("Game ended in a draw", "Game ended in a draw");
      }
      if (match.result?.winnerId === playerId) {
        return t("You won!", "You won!");
      }
      if (match.result?.loserId === playerId) {
        return t("You lost", "You lost");
      }
      return t("Game finished", "Game finished");
    }

    if (isMyTurn) {
      return t("Your turn", "Your turn");
    }
    return t("Opponent's turn", "Opponent's turn");
  };

  const getStatusColor = () => {
    if (match.status === "finished") {
      if (match.result?.winnerId === playerId) return "text-primary";
      if (match.result?.loserId === playerId) return "text-destructive";
      return "text-muted-foreground";
    }
    return isMyTurn ? "text-primary" : "text-muted-foreground";
  };

  return (
    <div className="flex flex-col items-center justify-center h-full space-y-4">
      <div className={`text-lg font-semibold ${getStatusColor()}`}>
        {getTurnText()}
        {match.state.isCheck && match.status === "active" && (
          <span className="ml-2 text-yellow-500">({t("Check", "Check")})</span>
        )}
      </div>

      {match.status === "finished" && match.result && (
        <div className="text-sm text-muted-foreground">
          {t("Reason", "Reason")}: {match.result.reason}
        </div>
      )}

      {error && (
        <div className="text-sm text-destructive">{error}</div>
      )}

      <div className="w-full max-w-md aspect-square">
        <Chessboard
          options={{
            position: match.state.fen,
            onPieceDrop: handleMove,
            boardOrientation: isPlayerBlack ? "black" : "white",
            allowDragging: match.status === "active" && isMyTurn && !pendingMove,
            boardStyle: {
              borderRadius: "8px",
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)",
            },
            darkSquareStyle: { backgroundColor: "#4a5568" },
            lightSquareStyle: { backgroundColor: "#718096" },
          }}
        />
      </div>

      {match.status === "active" && (isPlayerWhite || isPlayerBlack) && (
        <Button
          onClick={handleResign}
          variant="destructive"
          className="font-display uppercase tracking-widest"
        >
          {t("Resign", "Resign")}
        </Button>
      )}
    </div>
  );
}
