import { useEffect } from "react";
import { useLocation, useParams } from "wouter";

import { useGame } from "@/context/GameContext";
import { useSocket, MatchStatus } from "@/context/SocketContext";
import { GameRenderer } from "@/components/games/GameRenderer";

export default function Play() {
  const { state, actions } = useGame();
  const { matchState, joinMatch, leaveMatch, isConnected } = useSocket();
  const [, setLocation] = useLocation();
  const params = useParams<{ gameId: string }>();

  useEffect(() => {
    if (!state.currentMatch) {
      setLocation("/");
      return;
    }

    const matchId = state.currentMatch.id;
    const playerId = state.wallet.address;

    if (matchId && playerId) {
      joinMatch(matchId, playerId);
    }

    return () => {
      if (matchId && playerId) {
        leaveMatch(matchId, playerId);
      }
    };
  }, [state.currentMatch?.id, state.wallet.address, joinMatch, leaveMatch, setLocation]);

  if (!state.currentMatch) {
    return null;
  }

  const match = state.currentMatch;
  const socketStatus = matchState?.status || "waiting";

  const handleFinish = async (result: "win" | "loss" | "draw") => {
    await actions.finishMatch(result);
    setLocation("/result");
  };

  const renderStatusOverlay = (status: MatchStatus) => {
    if (status === "waiting") {
      return (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-white border-t-transparent mx-auto mb-4" />
            <p className="text-white text-xl font-medium">Waiting for opponent...</p>
          </div>
        </div>
      );
    }

    if (status === "paused") {
      return (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-yellow-500 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">!</span>
            </div>
            <p className="text-white text-xl font-medium">Opponent disconnected</p>
            <p className="text-white/60 text-sm mt-2">Waiting for them to reconnect...</p>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex flex-col gap-4 p-4 relative min-h-[calc(100vh-120px)]">
      {renderStatusOverlay(socketStatus)}
      
      {socketStatus === "active" && (
        <GameRenderer
          match={match}
          onFinish={handleFinish}
        />
      )}
    </div>
  );
}
