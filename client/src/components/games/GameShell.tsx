import { ReactNode } from "react";

interface GameShellProps {
  pot: string;
  children: ReactNode;
}

export function GameShell({
  pot,
  children,
}: GameShellProps) {
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

      {/* GAME CANVAS */}
      <div className="flex items-center justify-center w-full flex-1">
        <div className="relative w-full max-w-[420px] aspect-square rounded-xl border border-white/10 bg-black/40 shadow-lg overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
