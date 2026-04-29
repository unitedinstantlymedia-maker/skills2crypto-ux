// Thin client-side wrapper around the shared/games/xiangqi rules engine.
// Owns reactive state for the React UI: current board, whose turn it is,
// the selected piece, and its highlighted legal destinations. Mirrors the
// CheckersEngine shape (callback-driven onStateChange) so XiangqiGame.tsx
// can subscribe the same way.

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
  // Winning side (or 'draw'). Populated when the engine itself detects a
  // terminal state. Resignation/timeout are reported externally by the
  // socket layer, not by the engine.
  winner: Color | "draw" | null;
  // Distinguish stalemate vs checkmate vs in-check vs ok for UI labels.
  status: Status;
  // Counts plies since the last capture; used for the 60-ply no-capture
  // draw rule. Resets to 0 on every capture.
  pliesSinceCapture: number;
}

const NO_CAPTURE_DRAW_PLIES = 60;

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

  // Hydrate the engine from a server-authoritative snapshot. Used on
  // game-start and on reconnect so the client always lines up with the
  // server's board, current turn, and no-capture counter — without this,
  // a mid-match refresh would leave the player viewing the initial
  // position with red to move regardless of true game state.
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

  // Apply a move LOCALLY initiated by this player. Returns true on
  // success. Caller is responsible for emitting the wire event.
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

  // Apply a move announced by the opponent over the socket. Trusts the
  // server's `newTurn`; we only use it to overwrite our local turn (it
  // should always equal the flipped colour, but the server is authoritative).
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

    // Engine-detected terminal states. Asian-rules stalemate counts as
    // a loss for the side to move (same outcome as checkmate).
    const status = statusFor(this.state.board, this.state.currentTurn);
    this.state.status = status;
    if (status === "checkmate" || status === "stalemate") {
      this.state.gameOver = true;
      this.state.winner = this.state.currentTurn === "red" ? "black" : "red";
    } else if (this.state.pliesSinceCapture >= NO_CAPTURE_DRAW_PLIES) {
      // 60-ply no-capture draw — applies regardless of whose turn it is.
      this.state.gameOver = true;
      this.state.winner = "draw";
    }

    this.notifyChange();
  }

  // External terminal event from the socket layer (timeout / resign /
  // disconnect / draw agreement). Sets gameOver locally so the UI stops
  // accepting input.
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
