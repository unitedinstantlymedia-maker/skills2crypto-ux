import { useEffect, useMemo } from "react";
import { Chessboard } from "react-chessboard";
import { useSocket } from "@/context/SocketContext";

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
  onFinish?: (result: { winnerId?: string; draw?: boolean; reason?: string }) => void;
};

export function ChessGame({ matchId, playerId, onFinish }: Props) {
  const { gameState, sendGameAction, isWaitingForServer, actionRejected } = useSocket();

  const chessState = useMemo<ChessState | null>(() => {
    if (!gameState?.gameState) return null;
    return gameState.gameState as unknown as ChessState;
  }, [gameState]);

  useEffect(() => {
    if (gameState?.result?.finished && onFinish) {
      onFinish({
        winnerId: gameState.result.winnerId,
        draw: gameState.result.draw,
        reason: gameState.result.reason,
      });
    }
  }, [gameState?.result, onFinish]);

  function handlePieceDrop(sourceSquare: string, targetSquare: string): boolean {
    if (isWaitingForServer) return false;
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
    if (isWaitingForServer) return;

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
        options={{
          position: chessState.fen,
          onPieceDrop: handlePieceDrop,
          arePiecesDraggable: !isWaitingForServer,
          darkSquareStyle: { backgroundColor: "#4a5568" },
          lightSquareStyle: { backgroundColor: "#718096" },
          boardStyle: {
            borderRadius: "8px",
            boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5)",
          },
        }}
      />

      <div style={{ marginTop: 12, color: "#ccc" }}>
        Turn: {chessState.turn === "w" ? "White" : "Black"}
        {chessState.isCheck && " (Check)"}
      </div>

      {isWaitingForServer && (
        <div style={{ marginTop: 8, color: "#888" }}>Processing...</div>
      )}

      {actionRejected && (
        <div style={{ marginTop: 8, color: "#f66" }}>
          Move rejected: {actionRejected}
        </div>
      )}

      {gameState?.status === "finished" && (
        <div style={{ marginTop: 12, color: "#6f6" }}>
          Game finished
          {chessState.isCheckmate && " - Checkmate!"}
          {chessState.isDraw && " - Draw"}
          {chessState.isStalemate && " - Stalemate"}
        </div>
      )}

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
        disabled={isWaitingForServer || gameState?.status === "finished"}
      >
        Resign
      </button>
    </div>
  );
}

export default ChessGame;
