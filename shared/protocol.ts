export type Asset = "USDT" | "ETH" | "TON";

export type GameId = "chess" | "tetris" | "checkers" | "battleship";

export interface GameAction {
  matchId: string;
  playerId: string;
  type: string;
  payload?: unknown;
}

export type MatchStatus = "waiting" | "active" | "finished" | "cancelled";

export type FinishReason = "checkmate" | "resign" | "timeout" | "draw" | "stalemate" | "disconnect";

export interface MatchResult {
  status: "finished";
  reason: FinishReason;
  winner?: string;
  draw?: boolean;
}

export interface ChessMove {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
}

export interface ChessState {
  fen: string;
  turn: "w" | "b";
  moves: ChessMove[];
  isCheck: boolean;
  isCheckmate: boolean;
  isDraw: boolean;
  isStalemate: boolean;
  resigned?: boolean;
  resignedBy?: string;
}

export interface Match {
  id: string;
  game: "chess";
  asset: Asset;
  stake: number;
  pot: number;
  players: { whiteId: string; blackId: string };
  status: MatchStatus;
  createdAt: number;
  updatedAt: number;
  state: ChessState;
  result?: {
    winnerId?: string;
    loserId?: string;
    draw?: boolean;
    reason: FinishReason;
    validated: boolean;
  };
}
