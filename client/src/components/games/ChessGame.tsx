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

export default function ChessGame({
  matchId,
  playerId = "playerA",
  onFinish
}: Props) {
  const [match, setMatch] = useState<Match | null>(null);

  // DEV: автосоздание матча
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

  async function onDrop(from: string, to: string) {
    if (!match) return false;

    const res = await fetch(`/api/matches/${match.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId,
        move: { from, to }
      })
    });

    if (!res.ok) return false;

    const updated = await res.json();
    setMatch(updated);

    if (updated.state.status === "finished" && onFinish) {
      onFinish(updated.result);
    }

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
        position={match.state.fen}
        onPieceDrop={onDrop}
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
