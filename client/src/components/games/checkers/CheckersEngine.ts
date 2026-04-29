// Thin client-side helper. The server is the source of truth for the
// board, turn, clocks, and continuation jumps; this class only owns
// transient UI bits — selected square, the legal-move highlights for
// that selection, and a flag for "you must capture" hints.
//
// Hydration: callers MUST invoke `hydrateFromServer(...)` whenever the
// server sends an authoritative snapshot (game-start, opponent-move,
// reconnect). Selection helpers consult the SHARED engine to compute
// highlights, so they always reflect the latest hydrated board.

import {
  applyMove as sharedApplyMove,
  BOARD_SIZE,
  colorHasAnyJump,
  deserializeBoard as sharedDeserializeBoard,
  getJumpsFromSquare,
  initialBoard as sharedInitialBoard,
  INITIAL_TIME_MS,
  legalMovesFromSquare as sharedLegalMovesFromSquare,
  type Board as SharedBoard,
  type Piece as SharedPiece,
  type PieceColor as SharedPieceColor,
  type PieceType as SharedPieceType,
  type Position as SharedPosition,
} from '../../../../../shared/games/checkers';

export type PieceColor = SharedPieceColor;
export type PieceType = SharedPieceType;
export type Piece = SharedPiece;
export type Position = SharedPosition;

export interface Move {
  from: Position;
  to: Position;
  captures?: Position[];
}

export type Board = SharedBoard;

export interface GameState {
  board: Board;
  currentTurn: PieceColor;
  redTime: number;
  blackTime: number;
  winner: PieceColor | null;
  gameOver: boolean;
  selectedPiece: Position | null;
  validMoves: Move[];
  mustCapture: boolean;
  // Square that owes a continuation jump after a multi-jump (mirrors
  // the server's pendingJumpAt for the side currently on the clock).
  continuingCapture: Position | null;
}

export class CheckersEngine {
  private state: GameState;
  private onStateChange: (state: GameState) => void;

  constructor(onStateChange: (state: GameState) => void) {
    this.onStateChange = onStateChange;
    this.state = this.createInitialState();
  }

  private createInitialState(): GameState {
    return {
      board: sharedInitialBoard(),
      currentTurn: 'red',
      redTime: INITIAL_TIME_MS,
      blackTime: INITIAL_TIME_MS,
      winner: null,
      gameOver: false,
      selectedPiece: null,
      validMoves: [],
      mustCapture: false,
      continuingCapture: null,
    };
  }

  hydrateFromServer(snapshot: {
    board: string;
    currentTurn: PieceColor;
    redTime: number;
    blackTime: number;
    pendingJumpAt: Position | null;
  }): void {
    this.state.board = sharedDeserializeBoard(snapshot.board);
    this.state.currentTurn = snapshot.currentTurn;
    this.state.redTime = snapshot.redTime;
    this.state.blackTime = snapshot.blackTime;
    this.state.continuingCapture = snapshot.pendingJumpAt;
    this.state.selectedPiece = null;
    this.state.validMoves = [];
    this.state.mustCapture = colorHasAnyJump(this.state.board, this.state.currentTurn);
    this.notifyChange();
  }

  selectPiece(pos: Position, playerColor: PieceColor): void {
    if (this.state.gameOver) return;
    if (this.state.currentTurn !== playerColor) return;

    const piece = this.state.board[pos.row]?.[pos.col];
    if (!piece || piece.color !== playerColor) return;

    // During a continuation jump the player can ONLY move the same piece.
    if (this.state.continuingCapture) {
      if (
        pos.row !== this.state.continuingCapture.row ||
        pos.col !== this.state.continuingCapture.col
      ) {
        return;
      }
      this.state.selectedPiece = pos;
      this.state.validMoves = getJumpsFromSquare(this.state.board, pos);
      this.state.mustCapture = true;
      this.notifyChange();
      return;
    }

    this.state.selectedPiece = pos;
    this.state.validMoves = sharedLegalMovesFromSquare(this.state.board, pos, playerColor);
    this.state.mustCapture = colorHasAnyJump(this.state.board, playerColor);
    this.notifyChange();
  }

  clearSelection(): void {
    if (this.state.continuingCapture) return;
    this.state.selectedPiece = null;
    this.state.validMoves = [];
    this.notifyChange();
  }

  setGameOver(winner: PieceColor | null): void {
    this.state.winner = winner;
    this.state.gameOver = true;
    this.notifyChange();
  }

  getState(): GameState {
    return { ...this.state };
  }

  private notifyChange(): void {
    this.onStateChange({ ...this.state });
  }
}

export const BOARD_SIZE_CONST = BOARD_SIZE;
export const INITIAL_TIME_CONST = INITIAL_TIME_MS;
