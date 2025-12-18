import type { GameAdapter, GameResult } from "./types";

type CellState = "empty" | "ship" | "hit" | "miss";

interface Ship {
  cells: { row: number; col: number }[];
  hits: number;
  sunk: boolean;
}

interface PlayerBoard {
  grid: CellState[][];
  ships: Ship[];
  ready: boolean;
}

export interface BattleshipState {
  player1Board: PlayerBoard;
  player2Board: PlayerBoard;
  phase: "placement" | "battle" | "finished";
  turn: "player1" | "player2";
  gameOver: boolean;
  winnerId?: string;
  resigned?: boolean;
  resignedBy?: string;
}

export interface BattleshipMove {
  action: "place_ship" | "ready" | "fire" | "resign";
  playerId?: string;
  shipCells?: { row: number; col: number }[];
  target?: { row: number; col: number };
}

const GRID_SIZE = 10;
const SHIP_SIZES = [5, 4, 3, 3, 2];

function createEmptyGrid(): CellState[][] {
  return Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill("empty"));
}

function createPlayerBoard(): PlayerBoard {
  return {
    grid: createEmptyGrid(),
    ships: [],
    ready: false,
  };
}

function placeRandomShips(board: PlayerBoard): void {
  for (const size of SHIP_SIZES) {
    let placed = false;
    let attempts = 0;
    
    while (!placed && attempts < 100) {
      attempts++;
      const horizontal = Math.random() > 0.5;
      const row = Math.floor(Math.random() * GRID_SIZE);
      const col = Math.floor(Math.random() * GRID_SIZE);
      
      const cells: { row: number; col: number }[] = [];
      let valid = true;
      
      for (let i = 0; i < size; i++) {
        const r = horizontal ? row : row + i;
        const c = horizontal ? col + i : col;
        
        if (r >= GRID_SIZE || c >= GRID_SIZE || board.grid[r][c] !== "empty") {
          valid = false;
          break;
        }
        cells.push({ row: r, col: c });
      }
      
      if (valid) {
        for (const cell of cells) {
          board.grid[cell.row][cell.col] = "ship";
        }
        board.ships.push({ cells, hits: 0, sunk: false });
        placed = true;
      }
    }
  }
  board.ready = true;
}

function isValidPosition(row: number, col: number): boolean {
  return row >= 0 && row < GRID_SIZE && col >= 0 && col < GRID_SIZE;
}

function allShipsSunk(board: PlayerBoard): boolean {
  return board.ships.every(ship => ship.sunk);
}

export const battleshipAdapter: GameAdapter<BattleshipState, BattleshipMove> = {
  gameType: "battleship",

  initState(): BattleshipState {
    const player1Board = createPlayerBoard();
    const player2Board = createPlayerBoard();
    
    placeRandomShips(player1Board);
    placeRandomShips(player2Board);
    
    return {
      player1Board,
      player2Board,
      phase: "battle",
      turn: "player1",
      gameOver: false,
    };
  },

  validateMove(
    state: BattleshipState,
    move: BattleshipMove,
    playerId: string,
    players: { whiteId: string; blackId: string }
  ): boolean {
    if (state.gameOver || state.resigned) return false;

    if (move.action === "resign") {
      return playerId === players.whiteId || playerId === players.blackId;
    }

    if (move.action !== "fire") return false;
    if (!move.target) return false;

    const expectedPlayer = state.turn === "player1" ? players.whiteId : players.blackId;
    if (playerId !== expectedPlayer) return false;

    const { row, col } = move.target;
    if (!isValidPosition(row, col)) return false;

    const targetBoard = state.turn === "player1" ? state.player2Board : state.player1Board;
    const cell = targetBoard.grid[row][col];
    
    return cell !== "hit" && cell !== "miss";
  },

  applyMove(state: BattleshipState, move: BattleshipMove): BattleshipState {
    if (move.action === "resign") {
      return {
        ...state,
        phase: "finished",
        gameOver: true,
        resigned: true,
        resignedBy: move.playerId,
      };
    }

    if (move.action !== "fire" || !move.target) return state;

    const { row, col } = move.target;
    
    const isPlayer1Turn = state.turn === "player1";
    const targetBoard = isPlayer1Turn 
      ? { ...state.player2Board, grid: state.player2Board.grid.map(r => [...r]), ships: state.player2Board.ships.map(s => ({ ...s, cells: [...s.cells] })) }
      : { ...state.player1Board, grid: state.player1Board.grid.map(r => [...r]), ships: state.player1Board.ships.map(s => ({ ...s, cells: [...s.cells] })) };
    
    const cell = targetBoard.grid[row][col];
    let hit = false;
    
    if (cell === "ship") {
      targetBoard.grid[row][col] = "hit";
      hit = true;
      
      for (const ship of targetBoard.ships) {
        const hitCell = ship.cells.find(c => c.row === row && c.col === col);
        if (hitCell) {
          ship.hits++;
          if (ship.hits >= ship.cells.length) {
            ship.sunk = true;
          }
          break;
        }
      }
    } else {
      targetBoard.grid[row][col] = "miss";
    }
    
    const nextTurn = hit ? state.turn : (state.turn === "player1" ? "player2" : "player1");
    
    const gameOver = allShipsSunk(targetBoard);
    
    return {
      ...state,
      player1Board: isPlayer1Turn ? state.player1Board : targetBoard,
      player2Board: isPlayer1Turn ? targetBoard : state.player2Board,
      turn: gameOver ? state.turn : nextTurn,
      phase: gameOver ? "finished" : "battle",
      gameOver,
      winnerId: gameOver ? (isPlayer1Turn ? "player1" : "player2") : undefined,
    };
  },

  checkResult(
    state: BattleshipState,
    players: { whiteId: string; blackId: string }
  ): GameResult {
    if (state.resigned && state.resignedBy) {
      const winnerId = state.resignedBy === players.whiteId ? players.blackId : players.whiteId;
      return { finished: true, winnerId, reason: "resign" };
    }

    if (allShipsSunk(state.player2Board)) {
      return { finished: true, winnerId: players.whiteId, reason: "checkmate" };
    }
    
    if (allShipsSunk(state.player1Board)) {
      return { finished: true, winnerId: players.blackId, reason: "checkmate" };
    }

    return { finished: false };
  },

  getCurrentPlayer(
    state: BattleshipState,
    players: { whiteId: string; blackId: string }
  ): string {
    return state.turn === "player1" ? players.whiteId : players.blackId;
  },
};
