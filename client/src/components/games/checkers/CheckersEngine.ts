export type PieceColor = 'red' | 'black';
export type PieceType = 'man' | 'king';

export interface Piece {
  color: PieceColor;
  type: PieceType;
}

export interface Position {
  row: number;
  col: number;
}

export interface Move {
  from: Position;
  to: Position;
  captures?: Position[];
}

export type Board = (Piece | null)[][];

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
  continuingCapture: Position | null;
}

const BOARD_SIZE = 8;
const INITIAL_TIME = 10 * 60 * 1000;

export class CheckersEngine {
  private state: GameState;
  private onStateChange: (state: GameState) => void;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(onStateChange: (state: GameState) => void) {
    this.onStateChange = onStateChange;
    this.state = this.createInitialState();
  }

  private createInitialState(): GameState {
    const board: Board = Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(null));
    
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = { color: 'black', type: 'man' };
        }
      }
    }
    
    for (let row = 5; row < 8; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if ((row + col) % 2 === 1) {
          board[row][col] = { color: 'red', type: 'man' };
        }
      }
    }

    return {
      board,
      currentTurn: 'red',
      redTime: INITIAL_TIME,
      blackTime: INITIAL_TIME,
      winner: null,
      gameOver: false,
      selectedPiece: null,
      validMoves: [],
      mustCapture: false,
      continuingCapture: null
    };
  }

  private getCaptureMoves(pos: Position, piece: Piece): Move[] {
    const moves: Move[] = [];
    const directions = piece.type === 'king' 
      ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
      : piece.color === 'red' 
        ? [[-1, -1], [-1, 1]]
        : [[1, -1], [1, 1]];

    for (const [dr, dc] of directions) {
      const jumpRow = pos.row + dr;
      const jumpCol = pos.col + dc;
      const landRow = pos.row + dr * 2;
      const landCol = pos.col + dc * 2;

      if (landRow >= 0 && landRow < BOARD_SIZE && landCol >= 0 && landCol < BOARD_SIZE) {
        const jumpPiece = this.state.board[jumpRow]?.[jumpCol];
        const landSquare = this.state.board[landRow]?.[landCol];

        if (jumpPiece && jumpPiece.color !== piece.color && landSquare === null) {
          moves.push({
            from: pos,
            to: { row: landRow, col: landCol },
            captures: [{ row: jumpRow, col: jumpCol }]
          });
        }
      }
    }

    return moves;
  }

  private getSimpleMoves(pos: Position, piece: Piece): Move[] {
    const moves: Move[] = [];
    const directions = piece.type === 'king'
      ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
      : piece.color === 'red'
        ? [[-1, -1], [-1, 1]]
        : [[1, -1], [1, 1]];

    for (const [dr, dc] of directions) {
      const newRow = pos.row + dr;
      const newCol = pos.col + dc;

      if (newRow >= 0 && newRow < BOARD_SIZE && newCol >= 0 && newCol < BOARD_SIZE) {
        if (this.state.board[newRow][newCol] === null) {
          moves.push({
            from: pos,
            to: { row: newRow, col: newCol }
          });
        }
      }
    }

    return moves;
  }

  private getAllMovesForColor(color: PieceColor): { captures: Move[]; simple: Move[] } {
    const captures: Move[] = [];
    const simple: Move[] = [];

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = this.state.board[row][col];
        if (piece && piece.color === color) {
          const pos = { row, col };
          captures.push(...this.getCaptureMoves(pos, piece));
          simple.push(...this.getSimpleMoves(pos, piece));
        }
      }
    }

    return { captures, simple };
  }

  private checkForMultiJump(pos: Position): Move[] {
    const piece = this.state.board[pos.row][pos.col];
    if (!piece) return [];
    return this.getCaptureMoves(pos, piece);
  }

  private promoteIfNeeded(row: number, col: number): void {
    const piece = this.state.board[row][col];
    if (!piece) return;

    if (piece.color === 'red' && row === 0 && piece.type === 'man') {
      this.state.board[row][col] = { ...piece, type: 'king' };
    } else if (piece.color === 'black' && row === 7 && piece.type === 'man') {
      this.state.board[row][col] = { ...piece, type: 'king' };
    }
  }

  private checkWinCondition(): void {
    const redMoves = this.getAllMovesForColor('red');
    const blackMoves = this.getAllMovesForColor('black');

    const redHasMoves = redMoves.captures.length > 0 || redMoves.simple.length > 0;
    const blackHasMoves = blackMoves.captures.length > 0 || blackMoves.simple.length > 0;

    let redPieces = 0;
    let blackPieces = 0;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = this.state.board[row][col];
        if (piece) {
          if (piece.color === 'red') redPieces++;
          else blackPieces++;
        }
      }
    }

    if (redPieces === 0 || (!redHasMoves && this.state.currentTurn === 'red')) {
      this.state.winner = 'black';
      this.state.gameOver = true;
    } else if (blackPieces === 0 || (!blackHasMoves && this.state.currentTurn === 'black')) {
      this.state.winner = 'red';
      this.state.gameOver = true;
    }
  }

  selectPiece(pos: Position, playerColor: PieceColor): void {
    if (this.state.gameOver) return;
    if (this.state.currentTurn !== playerColor) return;

    const piece = this.state.board[pos.row][pos.col];
    if (!piece || piece.color !== playerColor) return;

    if (this.state.continuingCapture) {
      if (pos.row !== this.state.continuingCapture.row || pos.col !== this.state.continuingCapture.col) {
        return;
      }
    }

    const allMoves = this.getAllMovesForColor(playerColor);
    const mustCapture = allMoves.captures.length > 0;

    let validMoves: Move[];
    if (this.state.continuingCapture) {
      validMoves = this.checkForMultiJump(pos);
    } else if (mustCapture) {
      validMoves = this.getCaptureMoves(pos, piece);
    } else {
      validMoves = [...this.getCaptureMoves(pos, piece), ...this.getSimpleMoves(pos, piece)];
    }

    this.state.selectedPiece = pos;
    this.state.validMoves = validMoves;
    this.state.mustCapture = mustCapture;
    this.notifyChange();
  }

  makeMove(to: Position, playerColor: PieceColor): boolean {
    if (this.state.gameOver) return false;
    if (this.state.currentTurn !== playerColor) return false;
    if (!this.state.selectedPiece) return false;

    const move = this.state.validMoves.find(m => m.to.row === to.row && m.to.col === to.col);
    if (!move) return false;

    const from = this.state.selectedPiece;
    const piece = this.state.board[from.row][from.col];
    if (!piece) return false;

    this.state.board[from.row][from.col] = null;
    this.state.board[to.row][to.col] = piece;

    if (move.captures) {
      for (const cap of move.captures) {
        this.state.board[cap.row][cap.col] = null;
      }
    }

    this.promoteIfNeeded(to.row, to.col);

    if (move.captures && move.captures.length > 0) {
      const multiJumps = this.checkForMultiJump(to);
      if (multiJumps.length > 0) {
        this.state.continuingCapture = to;
        this.state.selectedPiece = to;
        this.state.validMoves = multiJumps;
        this.notifyChange();
        return true;
      }
    }

    this.state.continuingCapture = null;
    this.state.selectedPiece = null;
    this.state.validMoves = [];
    this.state.currentTurn = this.state.currentTurn === 'red' ? 'black' : 'red';

    this.checkWinCondition();
    this.notifyChange();
    return true;
  }

  applyOpponentMove(from: Position, to: Position, captures: Position[]): void {
    const piece = this.state.board[from.row][from.col];
    if (!piece) return;

    this.state.board[from.row][from.col] = null;
    this.state.board[to.row][to.col] = piece;

    for (const cap of captures) {
      this.state.board[cap.row][cap.col] = null;
    }

    this.promoteIfNeeded(to.row, to.col);
  }

  switchTurn(): void {
    this.state.currentTurn = this.state.currentTurn === 'red' ? 'black' : 'red';
    this.state.continuingCapture = null;
    this.state.selectedPiece = null;
    this.state.validMoves = [];
    this.checkWinCondition();
    this.notifyChange();
  }

  updateTimers(redTime: number, blackTime: number): void {
    this.state.redTime = redTime;
    this.state.blackTime = blackTime;
  }

  handleTimeout(color: PieceColor): void {
    this.state.winner = color === 'red' ? 'black' : 'red';
    this.state.gameOver = true;
    this.stop();
    this.notifyChange();
  }

  start(): void {
    this.state = this.createInitialState();
    this.notifyChange();
  }

  stop(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  getState(): GameState {
    return { ...this.state };
  }

  private notifyChange(): void {
    this.onStateChange({ ...this.state });
  }

  clearSelection(): void {
    if (this.state.continuingCapture) return;
    this.state.selectedPiece = null;
    this.state.validMoves = [];
    this.notifyChange();
  }
}

export const BOARD_SIZE_CONST = BOARD_SIZE;
export const INITIAL_TIME_CONST = INITIAL_TIME;
