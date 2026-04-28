import { ReactNode } from "react";
import { useGame } from "@/context/GameContext";
import { OpponentStatusBanner } from "@/components/system/OpponentStatusBanner";
import { OwnConnectionBanner } from "@/components/system/OwnConnectionBanner";

interface GameShellProps {
  pot: string;
  children: ReactNode;
}

export function GameShell({
  pot,
  children,
}: GameShellProps) {
  // Pull the live socket so we can mount the disconnect/reconnect
  // banners ONCE here instead of duplicating them inside every game
  // (Chess/Tetris/Checkers/Battleship). When the user is on a result
  // screen or hasn't finished a match yet, the socket is still
  // connected and these banners self-suppress to no-ops.
  const { socket } = useGame();
  return (
    <div className="flex flex-col items-center justify-between h-full w-full px-4 py-6">
      
      {/* HEADER */}
      <div className="flex w-full justify-between items-center mb-4 text-sm">
        <div className="flex items-center gap-2 text-green-400">
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          LIVE MATCH
        </div>
        <div className="text-green-400 font-semibold">
          Pot: {pot}
        </div>
      </div>

      {/* CONNECTION BANNERS — render slot, components self-suppress when healthy */}
      <div className="flex flex-col gap-2 w-full mb-2 empty:hidden">
        <OwnConnectionBanner socket={socket} />
        <OpponentStatusBanner socket={socket} />
      </div>

      {/* GAME CANVAS */}
      <div className="flex items-center justify-center w-full flex-1">
        <div className="relative w-full max-w-[420px] aspect-square rounded-xl border border-white/10 bg-black/40 shadow-lg overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
