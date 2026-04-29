import { cn } from "@/lib/utils";

// Pip layouts are the standard 1..6 dot patterns used on real dominoes.
// Each entry is a list of [row, col] positions on a 3x3 grid.
const PIP_LAYOUTS: Record<number, [number, number][]> = {
  0: [],
  1: [[1, 1]],
  2: [
    [0, 0],
    [2, 2],
  ],
  3: [
    [0, 0],
    [1, 1],
    [2, 2],
  ],
  4: [
    [0, 0],
    [0, 2],
    [2, 0],
    [2, 2],
  ],
  5: [
    [0, 0],
    [0, 2],
    [1, 1],
    [2, 0],
    [2, 2],
  ],
  6: [
    [0, 0],
    [0, 2],
    [1, 0],
    [1, 2],
    [2, 0],
    [2, 2],
  ],
};

function PipFace({ value, accent }: { value: number; accent: boolean }) {
  const positions = PIP_LAYOUTS[value] || [];
  return (
    <div className="relative w-full h-full grid grid-cols-3 grid-rows-3 p-1">
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((col) => {
          const has = positions.some(([r, c]) => r === row && c === col);
          return (
            <div key={`${row}-${col}`} className="flex items-center justify-center">
              {has && (
                <div
                  className={cn(
                    "rounded-full shadow-inner",
                    accent ? "bg-amber-100" : "bg-zinc-900",
                  )}
                  style={{ width: "55%", height: "55%" }}
                />
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}

export interface DominoTileProps {
  left: number;
  right: number;
  orientation?: "horizontal" | "vertical";
  size?: "sm" | "md" | "lg";
  selected?: boolean;
  playable?: boolean;
  dimmed?: boolean;
  faceDown?: boolean;
  onClick?: () => void;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<DominoTileProps["size"]>, string> = {
  sm: "w-8 h-16",
  md: "w-12 h-24",
  lg: "w-16 h-32",
};

export function DominoTile({
  left,
  right,
  orientation = "vertical",
  size = "md",
  selected,
  playable,
  dimmed,
  faceDown,
  onClick,
  className,
}: DominoTileProps) {
  const isHorizontal = orientation === "horizontal";
  // Swap dimensions when laid horizontally.
  const dims = SIZE_CLASSES[size]
    .split(" ")
    .map((c) => {
      if (!isHorizontal) return c;
      if (c.startsWith("w-")) return c.replace("w-", "h-");
      if (c.startsWith("h-")) return c.replace("h-", "w-");
      return c;
    })
    .join(" ");

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "relative flex shrink-0 rounded-md border-2 transition-all duration-150",
        "bg-gradient-to-br from-amber-50 to-amber-100 border-amber-200/40 shadow-md",
        isHorizontal ? "flex-row" : "flex-col",
        dims,
        selected && "ring-4 ring-emerald-400 -translate-y-1",
        playable && !selected && "ring-2 ring-amber-400/70",
        dimmed && "opacity-50 grayscale",
        onClick && !dimmed && "cursor-pointer hover:scale-105 active:scale-95",
        !onClick && "cursor-default",
        className,
      )}
      data-testid={`tile-${left}-${right}`}
    >
      {faceDown ? (
        <div className="w-full h-full rounded-md bg-gradient-to-br from-amber-900 to-amber-950 border border-amber-800/40" />
      ) : (
        <>
          <div className="flex-1">
            <PipFace value={left} accent={false} />
          </div>
          <div
            className={cn(
              "bg-amber-900/40",
              isHorizontal ? "w-px h-full" : "h-px w-full",
            )}
          />
          <div className="flex-1">
            <PipFace value={right} accent={false} />
          </div>
        </>
      )}
    </button>
  );
}
