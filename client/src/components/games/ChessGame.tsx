import { useEffect, useState } from "react";
import { Chessboard } from "react-chessboard";

type Match = {
  id: string;
  state: {
    fen: string;
    turn: "white" | "black";
    status: "active" | "finished";
  };
  result?: {
    winnerId?: string;
    reason?: string;
  };
};

type Props = {
  matchId?: string;
  playerId?: string;
  onFinish?: (result: any) => void;
};

export function ChessGame({
  matchId,
  playerId = "playerA",
  onFinish
}: Props) {
  const [match, setMatch] = useState<Match | null>(null);

  useEffect(() => {
    async function init() {
      if (!matchId) {
        const res = await fetch("/api/matches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game: "chess",
            asset: "USDT",
            stake: 20,
            whiteId: "playerA",
            blackId: "playerB"
          })
        });
        const created = await res.json();
        setMatch(created);
        return;
      }

      const res = await fetch(`/api/matches/${matchId}`);
      const loaded = await res.json();
      setMatch(loaded);
    }

    init();
  }, [matchId]);

  function handlePieceDrop({ sourceSquare, targetSquare }: { piece: any; sourceSquare: string; targetSquare: string | null }): boolean {
    if (!match || !targetSquare) return false;

    fetch(`/api/matches/${match.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        move: { from: sourceSquare, to: targetSquare }
      })
    })
      .then((res) => {
        if (!res.ok) {
          fetch(`/api/matches/${match.id}`).then(r => r.json()).then(setMatch);
          return;
        }
        return res.json();
      })
      .then((updated) => {
        if (!updated) return;
        setMatch(updated);
        if (updated.state.status === "finished" && onFinish) {
          onFinish(updated.result);
        }
      });

    return true;
  }

  async function resign() {
    if (!match) return;

    const res = await fetch(`/api/matches/${match.id}/resign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId })
    });

    const updated = await res.json();
    setMatch(updated);
    onFinish?.(updated.result);
  }

  if (!match) {
    return <div style={{ color: "#888" }}>Loading match…</div>;
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <Chessboard
        options={{
          position: match.state.fen,
          onPieceDrop: handlePieceDrop,
          allowDragging: match.state.status === "active",
          darkSquareStyle: { backgroundColor: "#4a5568" },
          lightSquareStyle: { backgroundColor: "#718096" },
          boardStyle: {
            borderRadius: "8px",
            boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)"
          }
        }}
      />

      <div style={{ marginTop: 12, color: "#ccc" }}>
        Turn: {match.state.turn}
      </div>

      {match.state.status === "finished" && (
        <div style={{ marginTop: 12, color: "#6f6" }}>
          Game finished
        </div>
      )}

      <button
        style={{ marginTop: 12 }}
        onClick={resign}
      >
        Resign
      </button>
    </div>
  );
}

export default ChessGame;
