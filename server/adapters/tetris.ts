import type { GameAdapter, GameResult } from "./types";

type TetrominoType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
type Cell = TetrominoType | null;

interface Position {
  row: number;
  col: number;
}

interface Tetromino {
  type: TetrominoType;
  position: Position;
  rotation: number;
}

export interface TetrisState {
  board: Cell[][];
  currentPiece: Tetromino | null;
  nextPiece: TetrominoType;
  score: number;
  lines: number;
  level: number;
  gameOver: boolean;
  winnerId?: string;
  resigned?: boolean;
  resignedBy?: string;
}

export interface TetrisMove {
  action: "move_left" | "move_right" | "rotate" | "drop" | "soft_drop" | "resign";
  playerId?: string;
}

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;

const TETROMINO_SHAPES: Record<TetrominoType, number[][][]> = {
  I: [
    [[0,0,0,0], [1,1,1,1], [0,0,0,0], [0,0,0,0]],
    [[0,0,1,0], [0,0,1,0], [0,0,1,0], [0,0,1,0]],
    [[0,0,0,0], [0,0,0,0], [1,1,1,1], [0,0,0,0]],
    [[0,1,0,0], [0,1,0,0], [0,1,0,0], [0,1,0,0]],
  ],
  O: [
    [[1,1], [1,1]],
    [[1,1], [1,1]],
    [[1,1], [1,1]],
    [[1,1], [1,1]],
  ],
  T: [
    [[0,1,0], [1,1,1], [0,0,0]],
    [[0,1,0], [0,1,1], [0,1,0]],
    [[0,0,0], [1,1,1], [0,1,0]],
    [[0,1,0], [1,1,0], [0,1,0]],
  ],
  S: [
    [[0,1,1], [1,1,0], [0,0,0]],
    [[0,1,0], [0,1,1], [0,0,1]],
    [[0,0,0], [0,1,1], [1,1,0]],
    [[1,0,0], [1,1,0], [0,1,0]],
  ],
  Z: [
    [[1,1,0], [0,1,1], [0,0,0]],
    [[0,0,1], [0,1,1], [0,1,0]],
    [[0,0,0], [1,1,0], [0,1,1]],
    [[0,1,0], [1,1,0], [1,0,0]],
  ],
  J: [
    [[1,0,0], [1,1,1], [0,0,0]],
    [[0,1,1], [0,1,0], [0,1,0]],
    [[0,0,0], [1,1,1], [0,0,1]],
    [[0,1,0], [0,1,0], [1,1,0]],
  ],
  L: [
    [[0,0,1], [1,1,1], [0,0,0]],
    [[0,1,0], [0,1,0], [0,1,1]],
    [[0,0,0], [1,1,1], [1,0,0]],
    [[1,1,0], [0,1,0], [0,1,0]],
  ],
};

const TETROMINO_TYPES: TetrominoType[] = ["I", "O", "T", "S", "Z", "J", "L"];

function createEmptyBoard(): Cell[][] {
  return Array(BOARD_HEIGHT).fill(null).map(() => Array(BOARD_WIDTH).fill(null));
}

function getRandomTetromino(): TetrominoType {
  return TETROMINO_TYPES[Math.floor(Math.random() * TETROMINO_TYPES.length)];
}

function getTetrominoShape(type: TetrominoType, rotation: number): number[][] {
  return TETROMINO_SHAPES[type][rotation % 4];
}

function canPlacePiece(board: Cell[][], piece: Tetromino): boolean {
  const shape = getTetrominoShape(piece.type, piece.rotation);
  
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) {
        const boardRow = piece.position.row + r;
        const boardCol = piece.position.col + c;
        
        if (boardRow < 0 || boardRow >= BOARD_HEIGHT || 
            boardCol < 0 || boardCol >= BOARD_WIDTH) {
          return false;
        }
        
        if (board[boardRow][boardCol] !== null) {
          return false;
        }
      }
    }
  }
  
  return true;
}

function placePieceOnBoard(board: Cell[][], piece: Tetromino): Cell[][] {
  const newBoard = board.map(row => [...row]);
  const shape = getTetrominoShape(piece.type, piece.rotation);
  
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) {
        const boardRow = piece.position.row + r;
        const boardCol = piece.position.col + c;
        newBoard[boardRow][boardCol] = piece.type;
      }
    }
  }
  
  return newBoard;
}

function clearLines(board: Cell[][]): { board: Cell[][]; linesCleared: number } {
  const newBoard: Cell[][] = [];
  let linesCleared = 0;
  
  for (let row = 0; row < BOARD_HEIGHT; row++) {
    if (board[row].every(cell => cell !== null)) {
      linesCleared++;
    } else {
      newBoard.push([...board[row]]);
    }
  }
  
  while (newBoard.length < BOARD_HEIGHT) {
    newBoard.unshift(Array(BOARD_WIDTH).fill(null));
  }
  
  return { board: newBoard, linesCleared };
}

function spawnPiece(type: TetrominoType): Tetromino {
  return {
    type,
    position: { row: 0, col: Math.floor((BOARD_WIDTH - 4) / 2) },
    rotation: 0,
  };
}

export const tetrisAdapter: GameAdapter<TetrisState, TetrisMove> = {
  gameType: "tetris",

  initState(): TetrisState {
    const currentType = getRandomTetromino();
    const currentPiece = spawnPiece(currentType);
    
    return {
      board: createEmptyBoard(),
      currentPiece,
      nextPiece: getRandomTetromino(),
      score: 0,
      lines: 0,
      level: 1,
      gameOver: false,
    };
  },

  validateMove(
    state: TetrisState,
    move: TetrisMove,
    playerId: string,
    players: { whiteId: string; blackId: string }
  ): boolean {
    if (state.gameOver || state.resigned) return false;

    if (move.action === "resign") {
      return playerId === players.whiteId || playerId === players.blackId;
    }

    if (playerId !== players.whiteId) return false;

    if (!state.currentPiece) return false;

    return ["move_left", "move_right", "rotate", "drop", "soft_drop"].includes(move.action);
  },

  applyMove(state: TetrisState, move: TetrisMove): TetrisState {
    if (move.action === "resign") {
      return {
        ...state,
        gameOver: true,
        resigned: true,
        resignedBy: move.playerId,
      };
    }

    if (!state.currentPiece) return state;

    const piece = state.currentPiece;
    let newPiece: Tetromino;

    switch (move.action) {
      case "move_left":
        newPiece = { ...piece, position: { ...piece.position, col: piece.position.col - 1 } };
        if (canPlacePiece(state.board, newPiece)) {
          return { ...state, currentPiece: newPiece };
        }
        return state;

      case "move_right":
        newPiece = { ...piece, position: { ...piece.position, col: piece.position.col + 1 } };
        if (canPlacePiece(state.board, newPiece)) {
          return { ...state, currentPiece: newPiece };
        }
        return state;

      case "rotate":
        newPiece = { ...piece, rotation: (piece.rotation + 1) % 4 };
        if (canPlacePiece(state.board, newPiece)) {
          return { ...state, currentPiece: newPiece };
        }
        return state;

      case "soft_drop":
        newPiece = { ...piece, position: { ...piece.position, row: piece.position.row + 1 } };
        if (canPlacePiece(state.board, newPiece)) {
          return { ...state, currentPiece: newPiece, score: state.score + 1 };
        }
        const lockedBoard = placePieceOnBoard(state.board, piece);
        const { board: clearedBoard, linesCleared } = clearLines(lockedBoard);
        const lineScore = [0, 100, 300, 500, 800][linesCleared] || 0;
        
        const nextPiece = spawnPiece(state.nextPiece);
        const gameOver = !canPlacePiece(clearedBoard, nextPiece);
        
        return {
          ...state,
          board: clearedBoard,
          currentPiece: gameOver ? null : nextPiece,
          nextPiece: getRandomTetromino(),
          score: state.score + lineScore,
          lines: state.lines + linesCleared,
          level: Math.floor((state.lines + linesCleared) / 10) + 1,
          gameOver,
        };

      case "drop":
        let dropPiece = { ...piece };
        while (canPlacePiece(state.board, { ...dropPiece, position: { ...dropPiece.position, row: dropPiece.position.row + 1 } })) {
          dropPiece.position.row++;
        }
        
        const droppedBoard = placePieceOnBoard(state.board, dropPiece);
        const { board: finalBoard, linesCleared: dropLines } = clearLines(droppedBoard);
        const dropScore = [0, 100, 300, 500, 800][dropLines] || 0;
        
        const spawnedPiece = spawnPiece(state.nextPiece);
        const isGameOver = !canPlacePiece(finalBoard, spawnedPiece);
        
        return {
          ...state,
          board: finalBoard,
          currentPiece: isGameOver ? null : spawnedPiece,
          nextPiece: getRandomTetromino(),
          score: state.score + dropScore + (dropPiece.position.row - piece.position.row) * 2,
          lines: state.lines + dropLines,
          level: Math.floor((state.lines + dropLines) / 10) + 1,
          gameOver: isGameOver,
        };

      default:
        return state;
    }
  },

  checkResult(
    state: TetrisState,
    players: { whiteId: string; blackId: string }
  ): GameResult {
    if (state.resigned && state.resignedBy) {
      const winnerId = state.resignedBy === players.whiteId ? players.blackId : players.whiteId;
      return { finished: true, winnerId, reason: "resign" };
    }

    if (state.gameOver) {
      return { finished: true, winnerId: players.blackId, reason: "checkmate" };
    }

    return { finished: false };
  },

  getCurrentPlayer(
    _state: TetrisState,
    players: { whiteId: string; blackId: string }
  ): string {
    return players.whiteId;
  },
};
