export type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export interface Position {
  x: number;
  y: number;
}

export interface Piece {
  type: PieceType;
  shape: number[][];
  position: Position;
  color: string;
}

export interface GameState {
  board: (string | null)[][];
  currentPiece: Piece | null;
  nextPiece: PieceType;
  score: number;
  lines: number;
  level: number;
  gameOver: boolean;
}

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;

const PIECE_COLORS: Record<PieceType, string> = {
  I: '#00f5ff',
  O: '#ffd700',
  T: '#a855f7',
  S: '#22c55e',
  Z: '#ef4444',
  J: '#3b82f6',
  L: '#f97316'
};

const PIECE_SHAPES: Record<PieceType, number[][]> = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ],
  O: [
    [1, 1],
    [1, 1]
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0]
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0]
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0]
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0]
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0]
  ]
};

const PIECE_TYPES: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export class TetrisEngine {
  private state: GameState;
  private onStateChange: (state: GameState) => void;
  private dropInterval: ReturnType<typeof setInterval> | null = null;
  private baseSpeed = 1000;

  constructor(onStateChange: (state: GameState) => void) {
    this.onStateChange = onStateChange;
    this.state = this.createInitialState();
  }

  private createInitialState(): GameState {
    return {
      board: Array(BOARD_HEIGHT).fill(null).map(() => Array(BOARD_WIDTH).fill(null)),
      currentPiece: null,
      nextPiece: this.getRandomPieceType(),
      score: 0,
      lines: 0,
      level: 1,
      gameOver: false
    };
  }

  private getRandomPieceType(): PieceType {
    return PIECE_TYPES[Math.floor(Math.random() * PIECE_TYPES.length)];
  }

  private createPiece(type: PieceType): Piece {
    const shape = PIECE_SHAPES[type].map(row => [...row]);
    return {
      type,
      shape,
      position: { x: Math.floor((BOARD_WIDTH - shape[0].length) / 2), y: 0 },
      color: PIECE_COLORS[type]
    };
  }

  private rotatePiece(piece: Piece): number[][] {
    const n = piece.shape.length;
    const rotated: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        rotated[x][n - 1 - y] = piece.shape[y][x];
      }
    }
    return rotated;
  }

  private isValidPosition(shape: number[][], position: Position): boolean {
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x]) {
          const boardX = position.x + x;
          const boardY = position.y + y;
          if (boardX < 0 || boardX >= BOARD_WIDTH || boardY >= BOARD_HEIGHT) {
            return false;
          }
          if (boardY >= 0 && this.state.board[boardY][boardX]) {
            return false;
          }
        }
      }
    }
    return true;
  }

  private lockPiece(): void {
    if (!this.state.currentPiece) return;

    const { shape, position, color } = this.state.currentPiece;
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x]) {
          const boardY = position.y + y;
          const boardX = position.x + x;
          if (boardY >= 0 && boardY < BOARD_HEIGHT && boardX >= 0 && boardX < BOARD_WIDTH) {
            this.state.board[boardY][boardX] = color;
          }
        }
      }
    }

    this.clearLines();
    this.spawnPiece();
  }

  private clearLines(): void {
    let linesCleared = 0;
    
    for (let y = BOARD_HEIGHT - 1; y >= 0; y--) {
      if (this.state.board[y].every(cell => cell !== null)) {
        this.state.board.splice(y, 1);
        this.state.board.unshift(Array(BOARD_WIDTH).fill(null));
        linesCleared++;
        y++;
      }
    }

    if (linesCleared > 0) {
      const points = [0, 100, 300, 500, 800][linesCleared] * this.state.level;
      this.state.score += points;
      this.state.lines += linesCleared;
      this.state.level = Math.floor(this.state.lines / 10) + 1;
      this.updateSpeed();
    }
  }

  private updateSpeed(): void {
    if (this.dropInterval) {
      clearInterval(this.dropInterval);
      this.startDropInterval();
    }
  }

  private getDropSpeed(): number {
    return Math.max(100, this.baseSpeed - (this.state.level - 1) * 80);
  }

  private spawnPiece(): void {
    const piece = this.createPiece(this.state.nextPiece);
    this.state.nextPiece = this.getRandomPieceType();

    if (!this.isValidPosition(piece.shape, piece.position)) {
      this.state.gameOver = true;
      this.stop();
      this.notifyChange();
      return;
    }

    this.state.currentPiece = piece;
  }

  private notifyChange(): void {
    this.onStateChange({ ...this.state });
  }

  private startDropInterval(): void {
    this.dropInterval = setInterval(() => {
      this.moveDown();
    }, this.getDropSpeed());
  }

  start(): void {
    this.state = this.createInitialState();
    this.spawnPiece();
    this.startDropInterval();
    this.notifyChange();
  }

  stop(): void {
    if (this.dropInterval) {
      clearInterval(this.dropInterval);
      this.dropInterval = null;
    }
  }

  moveLeft(): void {
    if (!this.state.currentPiece || this.state.gameOver) return;
    const newPos = { ...this.state.currentPiece.position, x: this.state.currentPiece.position.x - 1 };
    if (this.isValidPosition(this.state.currentPiece.shape, newPos)) {
      this.state.currentPiece.position = newPos;
      this.notifyChange();
    }
  }

  moveRight(): void {
    if (!this.state.currentPiece || this.state.gameOver) return;
    const newPos = { ...this.state.currentPiece.position, x: this.state.currentPiece.position.x + 1 };
    if (this.isValidPosition(this.state.currentPiece.shape, newPos)) {
      this.state.currentPiece.position = newPos;
      this.notifyChange();
    }
  }

  moveDown(): void {
    if (!this.state.currentPiece || this.state.gameOver) return;
    const newPos = { ...this.state.currentPiece.position, y: this.state.currentPiece.position.y + 1 };
    if (this.isValidPosition(this.state.currentPiece.shape, newPos)) {
      this.state.currentPiece.position = newPos;
      this.notifyChange();
    } else {
      this.lockPiece();
      this.notifyChange();
    }
  }

  hardDrop(): void {
    if (!this.state.currentPiece || this.state.gameOver) return;
    while (this.isValidPosition(this.state.currentPiece.shape, {
      ...this.state.currentPiece.position,
      y: this.state.currentPiece.position.y + 1
    })) {
      this.state.currentPiece.position.y++;
      this.state.score += 2;
    }
    this.lockPiece();
    this.notifyChange();
  }

  rotate(): void {
    if (!this.state.currentPiece || this.state.gameOver) return;
    const rotated = this.rotatePiece(this.state.currentPiece);
    
    const kicks = [0, -1, 1, -2, 2];
    for (const kick of kicks) {
      const newPos = { ...this.state.currentPiece.position, x: this.state.currentPiece.position.x + kick };
      if (this.isValidPosition(rotated, newPos)) {
        this.state.currentPiece.shape = rotated;
        this.state.currentPiece.position = newPos;
        this.notifyChange();
        return;
      }
    }
  }

  getState(): GameState {
    return { ...this.state };
  }

  getGhostPosition(): Position | null {
    if (!this.state.currentPiece) return null;
    let ghostY = this.state.currentPiece.position.y;
    while (this.isValidPosition(this.state.currentPiece.shape, {
      x: this.state.currentPiece.position.x,
      y: ghostY + 1
    })) {
      ghostY++;
    }
    return { x: this.state.currentPiece.position.x, y: ghostY };
  }
}

export const BOARD_DIMENSIONS = { width: BOARD_WIDTH, height: BOARD_HEIGHT };
export { PIECE_SHAPES, PIECE_COLORS };
