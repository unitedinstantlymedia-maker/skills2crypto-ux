export type CellState = 'empty' | 'ship' | 'hit' | 'miss' | 'sunk';

export interface Ship {
  id: string;
  name: string;
  size: number;
  cells: { row: number; col: number }[];
  hits: number;
  sunk: boolean;
}

export interface ShipPlacement {
  shipId: string;
  row: number;
  col: number;
  horizontal: boolean;
}

export interface AttackResult {
  row: number;
  col: number;
  hit: boolean;
  sunkShip: Ship | null;
  gameOver: boolean;
}

export interface BattleshipState {
  phase: 'setup' | 'battle' | 'ended';
  myBoard: CellState[][];
  enemyBoard: CellState[][];
  myShips: Ship[];
  enemyShipsRemaining: number;
  currentTurn: 'player1' | 'player2';
  winner: 'player1' | 'player2' | null;
}

const GRID_SIZE = 10;

const SHIP_CONFIGS = [
  { id: 'carrier', name: 'Carrier', size: 5 },
  { id: 'battleship', name: 'Battleship', size: 4 },
  { id: 'cruiser', name: 'Cruiser', size: 3 },
  { id: 'submarine', name: 'Submarine', size: 3 },
  { id: 'destroyer', name: 'Destroyer', size: 2 },
];

export class BattleshipEngine {
  private state: BattleshipState;
  private onStateChange: (state: BattleshipState) => void;
  private playerRole: 'player1' | 'player2';
  private placedShips: Map<string, Ship> = new Map();
  private enemyShips: Ship[] = [];

  constructor(
    onStateChange: (state: BattleshipState) => void,
    playerRole: 'player1' | 'player2'
  ) {
    this.onStateChange = onStateChange;
    this.playerRole = playerRole;
    this.state = this.createInitialState();
  }

  private createInitialState(): BattleshipState {
    return {
      phase: 'setup',
      myBoard: this.createEmptyGrid(),
      enemyBoard: this.createEmptyGrid(),
      myShips: [],
      enemyShipsRemaining: 5,
      currentTurn: 'player1',
      winner: null,
    };
  }

  private createEmptyGrid(): CellState[][] {
    return Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill('empty'));
  }

  getState(): BattleshipState {
    return { ...this.state };
  }

  getShipConfigs() {
    return SHIP_CONFIGS;
  }

  getPlacedShipIds(): string[] {
    return Array.from(this.placedShips.keys());
  }

  isAllShipsPlaced(): boolean {
    return this.placedShips.size === SHIP_CONFIGS.length;
  }

  canPlaceShip(shipId: string, row: number, col: number, horizontal: boolean): boolean {
    const config = SHIP_CONFIGS.find(s => s.id === shipId);
    if (!config) return false;

    if (this.placedShips.has(shipId)) return false;

    const cells = this.getShipCells(row, col, config.size, horizontal);
    if (!cells) return false;

    for (const cell of cells) {
      if (this.state.myBoard[cell.row][cell.col] !== 'empty') {
        return false;
      }
    }

    return true;
  }

  private getShipCells(row: number, col: number, size: number, horizontal: boolean): { row: number; col: number }[] | null {
    const cells: { row: number; col: number }[] = [];

    for (let i = 0; i < size; i++) {
      const r = horizontal ? row : row + i;
      const c = horizontal ? col + i : col;

      if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) {
        return null;
      }

      cells.push({ row: r, col: c });
    }

    return cells;
  }

  placeShip(shipId: string, row: number, col: number, horizontal: boolean): boolean {
    if (!this.canPlaceShip(shipId, row, col, horizontal)) {
      return false;
    }

    const config = SHIP_CONFIGS.find(s => s.id === shipId)!;
    const cells = this.getShipCells(row, col, config.size, horizontal)!;

    const ship: Ship = {
      id: shipId,
      name: config.name,
      size: config.size,
      cells,
      hits: 0,
      sunk: false,
    };

    this.placedShips.set(shipId, ship);

    for (const cell of cells) {
      this.state.myBoard[cell.row][cell.col] = 'ship';
    }

    this.state.myShips = Array.from(this.placedShips.values());
    this.notifyChange();

    return true;
  }

  removeShip(shipId: string): boolean {
    const ship = this.placedShips.get(shipId);
    if (!ship) return false;

    for (const cell of ship.cells) {
      this.state.myBoard[cell.row][cell.col] = 'empty';
    }

    this.placedShips.delete(shipId);
    this.state.myShips = Array.from(this.placedShips.values());
    this.notifyChange();

    return true;
  }

  getShipPlacements(): ShipPlacement[] {
    const placements: ShipPlacement[] = [];

    for (const ship of this.placedShips.values()) {
      const firstCell = ship.cells[0];
      const horizontal = ship.cells.length > 1 && ship.cells[1].col !== firstCell.col;

      placements.push({
        shipId: ship.id,
        row: firstCell.row,
        col: firstCell.col,
        horizontal,
      });
    }

    return placements;
  }

  startBattle(): void {
    if (this.state.phase !== 'setup') return;
    this.state.phase = 'battle';
    this.notifyChange();
  }

  setEnemyShips(count: number): void {
    this.state.enemyShipsRemaining = count;
    this.enemyShips = [];
    for (let i = 0; i < count; i++) {
      this.enemyShips.push({
        id: `enemy-${i}`,
        name: `Enemy Ship ${i + 1}`,
        size: 0,
        cells: [],
        hits: 0,
        sunk: false,
      });
    }
    this.notifyChange();
  }

  canAttack(row: number, col: number): boolean {
    if (this.state.phase !== 'battle') return false;
    if (this.state.currentTurn !== this.playerRole) return false;
    const cell = this.state.enemyBoard[row][col];
    return cell === 'empty';
  }

  recordMyAttack(row: number, col: number, hit: boolean, sunkShip: Ship | null, gameOver: boolean): void {
    this.state.enemyBoard[row][col] = hit ? 'hit' : 'miss';

    if (sunkShip) {
      for (const cell of sunkShip.cells) {
        this.state.enemyBoard[cell.row][cell.col] = 'sunk';
      }
      this.state.enemyShipsRemaining--;
    }

    if (gameOver) {
      this.state.phase = 'ended';
      this.state.winner = this.playerRole;
    } else {
      this.state.currentTurn = this.playerRole === 'player1' ? 'player2' : 'player1';
    }

    this.notifyChange();
  }

  receiveAttack(row: number, col: number): AttackResult {
    const cellState = this.state.myBoard[row][col];
    const hit = cellState === 'ship';

    this.state.myBoard[row][col] = hit ? 'hit' : 'miss';

    let sunkShip: Ship | null = null;

    if (hit) {
      for (const ship of this.placedShips.values()) {
        const hitCell = ship.cells.find(c => c.row === row && c.col === col);
        if (hitCell) {
          ship.hits++;
          if (ship.hits >= ship.size) {
            ship.sunk = true;
            sunkShip = ship;
            for (const cell of ship.cells) {
              this.state.myBoard[cell.row][cell.col] = 'sunk';
            }
          }
          break;
        }
      }
    }

    const allSunk = Array.from(this.placedShips.values()).every(s => s.sunk);
    const gameOver = allSunk;

    if (gameOver) {
      this.state.phase = 'ended';
      this.state.winner = this.playerRole === 'player1' ? 'player2' : 'player1';
    } else {
      this.state.currentTurn = this.playerRole;
    }

    this.state.myShips = Array.from(this.placedShips.values());
    this.notifyChange();

    return {
      row,
      col,
      hit,
      sunkShip,
      gameOver,
    };
  }

  recordOpponentAttack(row: number, col: number, hit: boolean, sunkShipCells?: { row: number; col: number }[]): void {
    this.state.myBoard[row][col] = hit ? 'hit' : 'miss';

    if (sunkShipCells) {
      for (const cell of sunkShipCells) {
        this.state.myBoard[cell.row][cell.col] = 'sunk';
      }
    }

    this.state.currentTurn = this.playerRole;
    this.notifyChange();
  }

  setTurn(turn: 'player1' | 'player2'): void {
    this.state.currentTurn = turn;
    this.notifyChange();
  }

  setGameOver(winner: 'player1' | 'player2'): void {
    this.state.phase = 'ended';
    this.state.winner = winner;
    this.notifyChange();
  }

  isMyTurn(): boolean {
    return this.state.currentTurn === this.playerRole;
  }

  private notifyChange(): void {
    this.onStateChange(this.getState());
  }
}
