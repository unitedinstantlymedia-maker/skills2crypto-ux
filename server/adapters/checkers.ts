import type { GameAdapter, GameResult } from "./types";

type PieceColor = "red" | "black";
type Piece = { color: PieceColor; king: boolean } | null;

export interface CheckersState {
  board: Piece[][];
  turn: PieceColor;
  gameOver: boolean;
  winnerId?: string;
  mustCaptureFrom?: { row: number; col: number };
  resigned?: boolean;
  resignedBy?: string;
}

export interface CheckersMove {
  action?: "resign";
  playerId?: string;
  from?: { row: number; col: number };
  to?: { row: number; col: number };
}

function createInitialBoard(): Piece[][] {
  const board: Piece[][] = Array(8).fill(null).map(() => Array(8).fill(null));
  
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1) {
        board[row][col] = { color: "black", king: false };
      }
    }
  }
  
  for (let row = 5; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1) {
        board[row][col] = { color: "red", king: false };
      }
    }
  }
  
  return board;
}

function isValidPosition(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function getCaptureMoves(board: Piece[][], row: number, col: number, piece: NonNullable<Piece>): { to: { row: number; col: number }; captured: { row: number; col: number } }[] {
  const captures: { to: { row: number; col: number }; captured: { row: number; col: number } }[] = [];
  
  const directions = piece.king 
    ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
    : piece.color === "red" 
      ? [[-1, -1], [-1, 1]]
      : [[1, -1], [1, 1]];
  
  for (const [dr, dc] of directions) {
    const midRow = row + dr;
    const midCol = col + dc;
    const toRow = row + 2 * dr;
    const toCol = col + 2 * dc;
    
    if (!isValidPosition(toRow, toCol)) continue;
    
    const midPiece = board[midRow][midCol];
    const toPiece = board[toRow][toCol];
    
    if (midPiece && midPiece.color !== piece.color && !toPiece) {
      captures.push({ to: { row: toRow, col: toCol }, captured: { row: midRow, col: midCol } });
    }
  }
  
  return captures;
}

function getSimpleMoves(board: Piece[][], row: number, col: number, piece: NonNullable<Piece>): { row: number; col: number }[] {
  const moves: { row: number; col: number }[] = [];
  const directions = piece.king 
    ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
    : piece.color === "red" 
      ? [[-1, -1], [-1, 1]]
      : [[1, -1], [1, 1]];
  
  for (const [dr, dc] of directions) {
    const newRow = row + dr;
    const newCol = col + dc;
    
    if (isValidPosition(newRow, newCol) && !board[newRow][newCol]) {
      moves.push({ row: newRow, col: newCol });
    }
  }
  
  return moves;
}

function hasCaptureMoves(board: Piece[][], color: PieceColor): boolean {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece && piece.color === color) {
        if (getCaptureMoves(board, row, col, piece).length > 0) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasAnyLegalMoves(board: Piece[][], color: PieceColor): boolean {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece && piece.color === color) {
        if (getCaptureMoves(board, row, col, piece).length > 0) return true;
        if (getSimpleMoves(board, row, col, piece).length > 0) return true;
      }
    }
  }
  return false;
}

function countPieces(board: Piece[][], color: PieceColor): number {
  let count = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece && piece.color === color) count++;
    }
  }
  return count;
}

export const checkersAdapter: GameAdapter<CheckersState, CheckersMove> = {
  gameType: "checkers",

  initState(): CheckersState {
    return {
      board: createInitialBoard(),
      turn: "red",
      gameOver: false,
    };
  },

  validateMove(
    state: CheckersState,
    move: CheckersMove,
    playerId: string,
    players: { whiteId: string; blackId: string }
  ): boolean {
    if (state.gameOver || state.resigned) return false;

    if (move.action === "resign") {
      return playerId === players.whiteId || playerId === players.blackId;
    }

    if (!move.from || !move.to) return false;

    const expectedPlayer = state.turn === "red" ? players.whiteId : players.blackId;
    if (playerId !== expectedPlayer) return false;

    if (state.mustCaptureFrom) {
      if (move.from.row !== state.mustCaptureFrom.row || move.from.col !== state.mustCaptureFrom.col) {
        return false;
      }
    }

    const { from, to } = move;
    if (!isValidPosition(from.row, from.col) || !isValidPosition(to.row, to.col)) return false;

    const piece = state.board[from.row][from.col];
    if (!piece || piece.color !== state.turn) return false;

    const mustCapture = hasCaptureMoves(state.board, state.turn);
    const captures = getCaptureMoves(state.board, from.row, from.col, piece);
    
    if (mustCapture) {
      return captures.some(c => c.to.row === to.row && c.to.col === to.col);
    }

    const simpleMoves = getSimpleMoves(state.board, from.row, from.col, piece);
    return simpleMoves.some(m => m.row === to.row && m.col === to.col);
  },

  applyMove(state: CheckersState, move: CheckersMove): CheckersState {
    if (move.action === "resign") {
      return {
        ...state,
        gameOver: true,
        resigned: true,
        resignedBy: move.playerId,
      };
    }

    if (!move.from || !move.to) return state;

    const newBoard = state.board.map(row => row.map(cell => cell ? { ...cell } : null));
    const { from, to } = move;
    const piece = newBoard[from.row][from.col]!;

    const rowDiff = Math.abs(to.row - from.row);
    let captured = false;

    if (rowDiff === 2) {
      const midRow = (from.row + to.row) / 2;
      const midCol = (from.col + to.col) / 2;
      newBoard[midRow][midCol] = null;
      captured = true;
    }

    newBoard[to.row][to.col] = piece;
    newBoard[from.row][from.col] = null;

    if ((piece.color === "red" && to.row === 0) || (piece.color === "black" && to.row === 7)) {
      newBoard[to.row][to.col] = { ...piece, king: true };
    }

    let mustCaptureFrom: { row: number; col: number } | undefined;
    let nextTurn = state.turn;

    if (captured) {
      const moreCaptures = getCaptureMoves(newBoard, to.row, to.col, newBoard[to.row][to.col]!);
      if (moreCaptures.length > 0) {
        mustCaptureFrom = { row: to.row, col: to.col };
      } else {
        nextTurn = state.turn === "red" ? "black" : "red";
      }
    } else {
      nextTurn = state.turn === "red" ? "black" : "red";
    }

    return {
      ...state,
      board: newBoard,
      turn: nextTurn,
      mustCaptureFrom,
    };
  },

  checkResult(
    state: CheckersState,
    players: { whiteId: string; blackId: string }
  ): GameResult {
    if (state.resigned && state.resignedBy) {
      const winnerId = state.resignedBy === players.whiteId ? players.blackId : players.whiteId;
      return { finished: true, winnerId, reason: "resign" };
    }

    const redPieces = countPieces(state.board, "red");
    const blackPieces = countPieces(state.board, "black");

    if (redPieces === 0) {
      return { finished: true, winnerId: players.blackId, reason: "checkmate" };
    }
    if (blackPieces === 0) {
      return { finished: true, winnerId: players.whiteId, reason: "checkmate" };
    }

    if (!hasAnyLegalMoves(state.board, state.turn)) {
      const winnerId = state.turn === "red" ? players.blackId : players.whiteId;
      return { finished: true, winnerId, reason: "stalemate" };
    }

    return { finished: false };
  },

  getCurrentPlayer(
    state: CheckersState,
    players: { whiteId: string; blackId: string }
  ): string {
    return state.turn === "red" ? players.whiteId : players.blackId;
  },
};
