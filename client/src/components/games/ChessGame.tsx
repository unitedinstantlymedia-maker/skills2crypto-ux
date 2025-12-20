import { useEffect, useMemo } from "react";
import { Chessboard } from "react-chessboard";
import { useSocket } from "@/context/useSocket";

interface ChessState {
  fen: string;
  turn: "w" | "b";
  isCheck?: boolean;
  isCheckmate?: boolean;
  isDraw?: boolean;
  isStalemate?: boolean;
}

type Props = {
  matchId: string;
  playerId: string;
  onFinish?: (result: { winner?: string; draw?: boolean; reason?: string }) => void;
};

export function ChessGame({ matchId, playerId, onFinish }: Props) {
  const { gameState, matchResult, sendGameAction, isWaitingForServer, isMatchFinished, actionRejected } = useSocket();

  const chessState = useMemo<ChessState | null>(() => {
    if (!gameState?.gameState) return null;
    return gameState.gameState as unknown as ChessState;
  }, [gameState]);

  useEffect(() => {
    if (matchResult && onFinish) {
      onFinish({
        winner: matchResult.winner,
        draw: matchResult.draw,
        reason: matchResult.reason,
      });
    }
  }, [matchResult, onFinish]);

  function handlePieceDrop(sourceSquare: string, targetSquare: string): boolean {
    if (isWaitingForServer || isMatchFinished) return false;
    if (!chessState) return false;

    sendGameAction({
      matchId,
      playerId,
      type: "move",
      payload: { from: sourceSquare, to: targetSquare },
    });

    return true;
  }

  function resign() {
    if (isWaitingForServer || isMatchFinished) return;

    sendGameAction({
      matchId,
      playerId,
      type: "resign",
    });
  }

  if (!chessState || !chessState.fen) {
    return (
      <div style={{ color: "#888", textAlign: "center", padding: 40 }}>
        Waiting for game state...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <Chessboard
        {...({
          position: chessState.fen,
          onPieceDrop: handlePieceDrop,
          arePiecesDraggable: !isWaitingForServer && !isMatchFinished,
          customDarkSquareStyle: { backgroundColor: "#4a5568" },
          customLightSquareStyle: { backgroundColor: "#718096" },
          customBoardStyle: {
            borderRadius: "8px",
            boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)",
          },
        } as any)}
      />

      {!isMatchFinished && (
        <div style={{ marginTop: 12, color: "#ccc" }}>
          Turn: {chessState.turn === "w" ? "White" : "Black"}
          {chessState.isCheck && " (Check)"}
        </div>
      )}

      {isWaitingForServer && !isMatchFinished && (
        <div style={{ marginTop: 8, color: "#888" }}>Processing...</div>
      )}

      {actionRejected && !isMatchFinished && (
        <div style={{ marginTop: 8, color: "#f66" }}>
          Move rejected: {actionRejected}
        </div>
      )}

      {isMatchFinished && matchResult && (
        <div style={{ marginTop: 12, padding: 16, backgroundColor: "#1a1a2e", borderRadius: 8 }}>
          <div style={{ color: "#6f6", fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>
            Game Finished
          </div>
          <div style={{ color: "#ccc" }}>
            {matchResult.draw ? (
              <span>Draw</span>
            ) : matchResult.winner ? (
              <span>
                Winner: {matchResult.winner === playerId ? "You" : "Opponent"}
              </span>
            ) : null}
          </div>
          <div style={{ color: "#888", marginTop: 4 }}>
            Reason: {matchResult.reason}
          </div>
        </div>
      )}

      {!isMatchFinished && (
        <button
          style={{
            marginTop: 12,
            padding: "8px 16px",
            backgroundColor: "#c53030",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isWaitingForServer ? "not-allowed" : "pointer",
            opacity: isWaitingForServer ? 0.5 : 1,
          }}
          onClick={resign}
          disabled={isWaitingForServer}
        >
          Resign
        </button>
      )}
    </div>
  );
}

export default ChessGame;
