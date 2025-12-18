import { Chess } from "chess.js";
import type { Match, Asset, ChessMove, ChessState, FinishReason } from "@shared/protocol";
import { payout } from "./escrowMock";

const matches = new Map<string, Match>();
const chessInstances = new Map<string, Chess>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function buildChessState(chess: Chess, moves: ChessMove[]): ChessState {
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    moves,
    isCheck: chess.isCheck(),
    isCheckmate: chess.isCheckmate(),
    isDraw: chess.isDraw(),
    isStalemate: chess.isStalemate(),
  };
}

export function createChessMatch({
  stake,
  asset,
  whiteId,
  blackId,
}: {
  stake: number;
  asset: Asset;
  whiteId: string;
  blackId: string;
}): Match {
  const id = generateId();
  const chess = new Chess();
  const now = Date.now();

  const match: Match = {
    id,
    game: "chess",
    asset,
    stake,
    pot: stake * 2,
    players: { whiteId, blackId },
    status: "active",
    createdAt: now,
    updatedAt: now,
    state: buildChessState(chess, []),
  };

  matches.set(id, match);
  chessInstances.set(id, chess);

  return match;
}

export function getMatch(id: string): Match | undefined {
  return matches.get(id);
}

export function getOrCreateChessMatch(id: string): Match {
  const existing = matches.get(id);
  if (existing) return existing;

  const chess = new Chess();
  const now = Date.now();

  const match: Match = {
    id,
    game: "chess",
    asset: "USDT",
    stake: 20,
    pot: 40,
    players: { whiteId: "playerA", blackId: "playerB" },
    status: "active",
    createdAt: now,
    updatedAt: now,
    state: buildChessState(chess, []),
  };

  matches.set(id, match);
  chessInstances.set(id, chess);

  return match;
}

function finishMatch(match: Match, chess: Chess, winnerId: string | undefined, reason: FinishReason): Match {
  match.status = "finished";
  match.updatedAt = Date.now();

  const draw = reason === "draw" || (!winnerId && reason !== "invalid");
  const loserId = winnerId
    ? winnerId === match.players.whiteId
      ? match.players.blackId
      : match.players.whiteId
    : undefined;

  match.result = {
    winnerId,
    loserId,
    draw,
    reason,
    validated: true,
  };

  if (winnerId) {
    payout({
      matchId: match.id,
      winnerId,
      asset: match.asset,
      pot: match.pot,
    });
  }

  return match;
}

export function applyChessMove(
  id: string,
  playerId: string,
  move: ChessMove
): { success: true; match: Match } | { success: false; error: string } {
  const match = matches.get(id);
  if (!match) {
    return { success: false, error: "Match not found" };
  }

  if (match.status !== "active") {
    return { success: false, error: "Match is not active" };
  }

  const chess = chessInstances.get(id);
  if (!chess) {
    return { success: false, error: "Chess instance not found" };
  }

  const expectedPlayer = chess.turn() === "w" ? match.players.whiteId : match.players.blackId;
  if (playerId !== expectedPlayer) {
    return { success: false, error: "Not your turn" };
  }

  try {
    const result = chess.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    });

    if (!result) {
      return { success: false, error: "Invalid move" };
    }

    const moves = [...match.state.moves, move];
    match.state = buildChessState(chess, moves);
    match.updatedAt = Date.now();

    if (chess.isCheckmate()) {
      const winnerId = chess.turn() === "w" ? match.players.blackId : match.players.whiteId;
      finishMatch(match, chess, winnerId, "checkmate");
    } else if (chess.isStalemate()) {
      finishMatch(match, chess, undefined, "draw");
    } else if (chess.isDraw()) {
      finishMatch(match, chess, undefined, "draw");
    }

    return { success: true, match };
  } catch {
    return { success: false, error: "Invalid move" };
  }
}

export function resignMatch(
  id: string,
  playerId: string
): { success: true; match: Match } | { success: false; error: string } {
  const match = matches.get(id);
  if (!match) {
    return { success: false, error: "Match not found" };
  }

  if (match.status !== "active") {
    return { success: false, error: "Match is not active" };
  }

  if (playerId !== match.players.whiteId && playerId !== match.players.blackId) {
    return { success: false, error: "Player not in match" };
  }

  const chess = chessInstances.get(id);
  if (!chess) {
    return { success: false, error: "Chess instance not found" };
  }

  const winnerId = playerId === match.players.whiteId ? match.players.blackId : match.players.whiteId;
  finishMatch(match, chess, winnerId, "resign");

  return { success: true, match };
}
