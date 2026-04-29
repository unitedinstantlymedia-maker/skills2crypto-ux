// Reactive client wrapper around the shared rules engine. Mirrors the
// CheckersEngine shape (callback-driven onStateChange).

import {
  applyMove,
  deserializeBoard,
  initialBoard,
  isCaptureMove,
  isInCheck,
  legalMovesFromSquare,
  statusFor,
  type Board,
  type Color,
  type Move,
  type Square,
  type Status,
} from "@shared/games/xiangqi";

export interface XiangqiClientState {
  board: Board;
  currentTurn: Color;
  selectedSquare: Square | null;
  validMoves: Square[];
  gameOver: boolean;
  winner: Color | "draw" | null;
  status: Status;
  pliesSinceCapture: number;
}

const NO_CAPTURE_DRAW_PLIES = 120;

export class XiangqiEngine {
  private state: XiangqiClientState;
  private onStateChange: (state: XiangqiClientState) => void;

  constructor(onStateChange: (state: XiangqiClientState) => void) {
    this.onStateChange = onStateChange;
    this.state = this.createInitialState();
  }

  private createInitialState(): XiangqiClientState {
    return {
      board: initialBoard(),
      currentTurn: "red",
      selectedSquare: null,
      validMoves: [],
      gameOver: false,
      winner: null,
      status: "ok",
      pliesSinceCapture: 0,
    };
  }

  private notifyChange(): void {
    this.onStateChange({ ...this.state, validMoves: this.state.validMoves.slice() });
  }

  start(): void {
    this.state = this.createInitialState();
    this.notifyChange();
  }

  // Hydrate from a server snapshot (used on game-start and reconnect).
  hydrate(serializedBoard: string, currentTurn: Color, pliesSinceCapture: number): void {
    const board = deserializeBoard(serializedBoard);
    this.state = {
      board,
      currentTurn,
      selectedSquare: null,
      validMoves: [],
      gameOver: false,
      winner: null,
      status: statusFor(board, currentTurn),
      pliesSinceCapture,
    };
    this.notifyChange();
  }

  getState(): XiangqiClientState {
    return { ...this.state, validMoves: this.state.validMoves.slice() };
  }

  selectSquare(sq: Square, playerColor: Color): void {
    if (this.state.gameOver) return;
    if (this.state.currentTurn !== playerColor) return;
    const piece = this.state.board[sq.file]?.[sq.rank];
    if (!piece || piece.color !== playerColor) return;
    this.state.selectedSquare = sq;
    this.state.validMoves = legalMovesFromSquare(this.state.board, sq);
    this.notifyChange();
  }

  clearSelection(): void {
    this.state.selectedSquare = null;
    this.state.validMoves = [];
    this.notifyChange();
  }

  // Apply a local move; caller emits the wire event on success.
  makeMove(to: Square, playerColor: Color): boolean {
    if (this.state.gameOver) return false;
    if (this.state.currentTurn !== playerColor) return false;
    if (!this.state.selectedSquare) return false;
    const from = this.state.selectedSquare;
    const isLegal = this.state.validMoves.some(
      (m) => m.file === to.file && m.rank === to.rank,
    );
    if (!isLegal) return false;

    this.applyAndAdvance({ from, to });
    return true;
  }

  applyOpponentMove(from: Square, to: Square, newTurn: Color): void {
    this.applyAndAdvance({ from, to }, newTurn);
  }

  private applyAndAdvance(move: Move, forcedTurn?: Color): void {
    const wasCapture = isCaptureMove(this.state.board, move);
    this.state.board = applyMove(this.state.board, move);
    this.state.pliesSinceCapture = wasCapture ? 0 : this.state.pliesSinceCapture + 1;
    this.state.currentTurn = forcedTurn ?? (this.state.currentTurn === "red" ? "black" : "red");
    this.state.selectedSquare = null;
    this.state.validMoves = [];

    const status = statusFor(this.state.board, this.state.currentTurn);
    this.state.status = status;
    if (status === "checkmate" || status === "stalemate") {
      this.state.gameOver = true;
      this.state.winner = this.state.currentTurn === "red" ? "black" : "red";
    } else if (this.state.pliesSinceCapture >= NO_CAPTURE_DRAW_PLIES) {
      this.state.gameOver = true;
      this.state.winner = "draw";
    }

    this.notifyChange();
  }

  // External terminal event (timeout / resign / disconnect / draw).
  forceEnd(winner: Color | "draw" | null): void {
    this.state.gameOver = true;
    this.state.winner = winner;
    this.state.selectedSquare = null;
    this.state.validMoves = [];
    this.notifyChange();
  }

  isOwnGeneralInCheck(playerColor: Color): boolean {
    return isInCheck(this.state.board, playerColor);
  }
}
