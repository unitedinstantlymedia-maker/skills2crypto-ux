// Re-export core types for backward compatibility
export * from "@/core/types";
export * from "@/config/economy";

// Legacy types if needed, mapped to core types
import { Asset, Game } from "@/core/types";

export type AssetType = Asset;
export type GameType = Game;

// Constants
export const PLATFORM_FEE_PERCENT = 3;
