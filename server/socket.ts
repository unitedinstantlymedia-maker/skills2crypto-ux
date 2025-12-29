import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server as HttpServer } from "http";

interface SocketOptions {
  isProd: boolean;
  allowedOrigins: string[];
}

interface ChessMove {
  matchId: string;
  from: string;
  to: string;
  promotion?: string;
  fen: string;
  san: string;
  whiteTime: number;
  blackTime: number;
}

interface PlayerInfo {
  socketId: string;
  color: 'white' | 'black';
}

interface MatchRoom {
  players: Map<string, PlayerInfo>;
  fen: string;
  whiteTime: number;
  blackTime: number;
}

const matchRooms = new Map<string, MatchRoom>();
const socketToPlayer = new Map<string, { matchId: string; playerId: string; gameType?: string }>();
const playerToSocket = new Map<string, string>(); // playerId -> socketId (for reconnect tracking)
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>(); // playerId -> timeout

interface GameResult {
  matchId: string;
  gameType: string;
  winnerId: string | null;
  loserId: string | null;
  result: 'win' | 'loss' | 'draw';
  reason: string;
  timestamp: number;
}

const gameResults = new Map<string, GameResult>();

function storeGameResult(
  matchId: string,
  gameType: string,
  winnerId: string | null,
  loserId: string | null,
  reason: string
): GameResult {
  let resultType: 'win' | 'loss' | 'draw';
  if (winnerId && loserId) {
    resultType = 'win';
  } else if (!winnerId && !loserId) {
    resultType = 'draw';
  } else {
    resultType = 'win';
  }
  
  const result: GameResult = {
    matchId,
    gameType,
    winnerId,
    loserId,
    result: resultType,
    reason,
    timestamp: Date.now()
  };
  gameResults.set(matchId, result);
  console.log("[socket] game result stored:", result);
  return result;
}

interface TetrisRoom {
  players: Map<string, string>;
  started: boolean;
}

const tetrisRooms = new Map<string, TetrisRoom>();

interface CheckersPlayerInfo {
  socketId: string;
  color: 'red' | 'black';
}

interface CheckersRoom {
  players: Map<string, CheckersPlayerInfo>;
  started: boolean;
}

const checkersRooms = new Map<string, CheckersRoom>();

interface ShipPlacement {
  shipId: string;
  row: number;
  col: number;
  horizontal: boolean;
}

interface BattleshipShip {
  id: string;
  name: string;
  size: number;
  cells: { row: number; col: number }[];
  hits: number;
  sunk: boolean;
}

interface BattleshipPlayerInfo {
  socketId: string;
  role: 'player1' | 'player2';
  ready: boolean;
  ships: BattleshipShip[];
}

interface BattleshipRoom {
  players: Map<string, BattleshipPlayerInfo>;
  started: boolean;
  battlePhase: boolean;
  currentTurn: 'player1' | 'player2';
  attackHistory: Map<string, Set<string>>; // playerId -> set of "row,col" strings
}

const battleshipRooms = new Map<string, BattleshipRoom>();

const GRID_SIZE = 10;

function validateShipPlacements(placements: ShipPlacement[]): { valid: boolean; error?: string } {
  if (placements.length !== 5) {
    return { valid: false, error: 'Must place exactly 5 ships' };
  }

  const requiredShips = new Set(['carrier', 'battleship', 'cruiser', 'submarine', 'destroyer']);
  const placedShips = new Set(placements.map(p => p.shipId));
  
  for (const ship of requiredShips) {
    if (!placedShips.has(ship)) {
      return { valid: false, error: `Missing ship: ${ship}` };
    }
  }

  const occupiedCells = new Set<string>();

  for (const placement of placements) {
    const config = SHIP_CONFIGS.find(s => s.id === placement.shipId);
    if (!config) {
      return { valid: false, error: `Invalid ship: ${placement.shipId}` };
    }

    for (let i = 0; i < config.size; i++) {
      const row = placement.horizontal ? placement.row : placement.row + i;
      const col = placement.horizontal ? placement.col + i : placement.col;

      if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) {
        return { valid: false, error: `Ship ${placement.shipId} out of bounds` };
      }

      const cellKey = `${row},${col}`;
      if (occupiedCells.has(cellKey)) {
        return { valid: false, error: `Ships overlap at ${row},${col}` };
      }
      occupiedCells.add(cellKey);
    }
  }

  return { valid: true };
}

const SHIP_CONFIGS: { id: string; name: string; size: number }[] = [
  { id: 'carrier', name: 'Carrier', size: 5 },
  { id: 'battleship', name: 'Battleship', size: 4 },
  { id: 'cruiser', name: 'Cruiser', size: 3 },
  { id: 'submarine', name: 'Submarine', size: 3 },
  { id: 'destroyer', name: 'Destroyer', size: 2 },
];

export function setupSocket(httpServer: HttpServer, opts: SocketOptions): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: "/socket.io",
    transports: ["websocket"],
    cors: {
      origin: opts.isProd ? opts.allowedOrigins : true,
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  io.on("connection", (socket) => {
    console.log("[socket] connected", socket.id);

    socket.on("join-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`match:${matchId}`);
      console.log("[socket] join match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }
      
      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
      }

      let room = matchRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          whiteTime: 30 * 60 * 1000,
          blackTime: 30 * 60 * 1000
        };
        matchRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('color-assigned', { color: existingPlayer.color });
        console.log("[socket] reconnect, color preserved:", existingPlayer.color);
        
        if (room.players.size === 2) {
          socket.emit('game-start', {
            fen: room.fen,
            whiteTime: room.whiteTime,
            blackTime: room.blackTime
          });
        }
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingColors = Array.from(room.players.values()).map(p => p.color);
      const assignedColor: 'white' | 'black' = existingColors.includes('white') ? 'black' : 'white';
      
      room.players.set(playerId, { socketId: socket.id, color: assignedColor });

      socket.emit('color-assigned', { color: assignedColor });
      console.log("[socket] color assigned", matchId, playerId, assignedColor);

      if (room.players.size === 2) {
        io.to(`match:${matchId}`).emit('game-start', {
          fen: room.fen,
          whiteTime: room.whiteTime,
          blackTime: room.blackTime
        });
        console.log("[socket] game-start", matchId);
      }
    });

    socket.on("chess-move", (move: ChessMove) => {
      const { matchId, from, to, promotion, fen, san, whiteTime, blackTime } = move;
      
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== matchId) {
        console.log("[socket] chess-move rejected - unauthorized socket");
        return;
      }

      const room = matchRooms.get(matchId);
      if (!room) {
        console.log("[socket] chess-move rejected - no room");
        return;
      }

      const player = room.players.get(socketInfo.playerId);
      if (!player) {
        console.log("[socket] chess-move rejected - player not in room");
        return;
      }

      console.log("[socket] chess-move", matchId, from, to, san, "by", player.color);
      
      room.fen = fen;
      room.whiteTime = whiteTime;
      room.blackTime = blackTime;

      socket.to(`match:${matchId}`).emit('opponent-move', {
        from,
        to,
        promotion,
        fen,
        san,
        whiteTime,
        blackTime
      });
    });

    socket.on("chess-resign", (data: { matchId: string; color: 'white' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] chess-resign rejected - unauthorized");
        return;
      }

      const room = matchRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] chess-resign rejected - color mismatch");
        return;
      }

      console.log("[socket] chess-resign", data.matchId, data.color);
      
      const winnerId = data.color === 'white' 
        ? Array.from(room.players.entries()).find(([_, p]) => p.color === 'black')?.[0]
        : Array.from(room.players.entries()).find(([_, p]) => p.color === 'white')?.[0];
      const loserId = socketInfo.playerId;
      
      storeGameResult(data.matchId, 'chess', winnerId || null, loserId, 'resignation');
      
      socket.to(`match:${data.matchId}`).emit('opponent-resigned', {
        color: data.color
      });
      
      io.to(`match:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'resignation'
      });
      
      matchRooms.delete(data.matchId);
    });

    socket.on("chess-timeout", (data: { matchId: string; color: 'white' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] chess-timeout rejected - unauthorized");
        return;
      }

      const room = matchRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] chess-timeout rejected - color mismatch");
        return;
      }

      console.log("[socket] chess-timeout", data.matchId, data.color);
      
      const winnerId = data.color === 'white' 
        ? Array.from(room.players.entries()).find(([_, p]) => p.color === 'black')?.[0]
        : Array.from(room.players.entries()).find(([_, p]) => p.color === 'white')?.[0];
      const loserId = socketInfo.playerId;
      
      storeGameResult(data.matchId, 'chess', winnerId || null, loserId, 'timeout');
      
      socket.to(`match:${data.matchId}`).emit('opponent-timeout', {
        color: data.color
      });
      
      io.to(`match:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'timeout'
      });
      
      matchRooms.delete(data.matchId);
    });

    socket.on("game-end", (data: { matchId: string; result: string; winner: string; winnerId?: string; loserId?: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        return;
      }

      console.log("[socket] game-end", data.matchId, data.result, data.winner);
      
      storeGameResult(data.matchId, 'chess', data.winnerId || null, data.loserId || null, data.result);
      
      io.to(`match:${data.matchId}`).emit('match-ended', data);
      io.to(`match:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId: data.winnerId,
        loserId: data.loserId,
        reason: data.result
      });
      
      matchRooms.delete(data.matchId);
    });

    socket.on("join-tetris-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`tetris:${matchId}`);
      console.log("[socket] join tetris match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }
      
      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
      }

      let room = tetrisRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false
        };
        tetrisRooms.set(matchId, room);
      }

      if (!room.players.has(playerId)) {
        room.players.set(playerId, socket.id);
      } else {
        room.players.set(playerId, socket.id);
      }

      if (room.players.size === 2 && !room.started) {
        room.started = true;
        io.to(`tetris:${matchId}`).emit('tetris-game-start');
        console.log("[socket] tetris-game-start", matchId);
      }
    });

    socket.on("tetris-state", (data: { 
      matchId: string; 
      board: (string | null)[][]; 
      score: number; 
      lines: number; 
      level: number;
      gameOver: boolean;
    }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      socket.to(`tetris:${data.matchId}`).emit('opponent-tetris-state', {
        board: data.board,
        score: data.score,
        lines: data.lines,
        level: data.level,
        gameOver: data.gameOver
      });
    });

    socket.on("tetris-game-over", (data: { matchId: string; playerId: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) return;

      console.log("[socket] tetris-game-over", data.matchId, data.playerId);
      
      const room = tetrisRooms.get(data.matchId);
      const winnerId = room ? Array.from(room.players.keys()).find(id => id !== data.playerId) : null;
      const loserId = data.playerId;
      
      storeGameResult(data.matchId, 'tetris', winnerId || null, loserId, 'board_filled');
      
      socket.to(`tetris:${data.matchId}`).emit('opponent-tetris-game-over');
      
      io.to(`tetris:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'board_filled'
      });
      
      tetrisRooms.delete(data.matchId);
    });

    socket.on("join-checkers-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`checkers:${matchId}`);
      console.log("[socket] join checkers match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }
      
      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
      }

      let room = checkersRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false
        };
        checkersRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('checkers-color-assigned', { color: existingPlayer.color });
        console.log("[socket] checkers reconnect, color preserved:", existingPlayer.color);
        
        if (room.players.size === 2 && room.started) {
          socket.emit('checkers-game-start');
        }
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] checkers match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingColors = Array.from(room.players.values()).map(p => p.color);
      const assignedColor: 'red' | 'black' = existingColors.includes('red') ? 'black' : 'red';
      
      room.players.set(playerId, { socketId: socket.id, color: assignedColor });

      socket.emit('checkers-color-assigned', { color: assignedColor });
      console.log("[socket] checkers color assigned", matchId, playerId, assignedColor);

      if (room.players.size === 2 && !room.started) {
        room.started = true;
        io.to(`checkers:${matchId}`).emit('checkers-game-start');
        console.log("[socket] checkers-game-start", matchId);
      }
    });

    socket.on("checkers-move", (data: {
      matchId: string;
      from: { row: number; col: number };
      to: { row: number; col: number };
      captures: { row: number; col: number }[];
      newTurn: 'red' | 'black';
      turnEnded: boolean;
      redTime: number;
      blackTime: number;
    }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-move rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) {
        console.log("[socket] checkers-move rejected - player not in room");
        return;
      }

      console.log("[socket] checkers-move", data.matchId, data.from, data.to, "by", player.color, "turnEnded:", data.turnEnded);

      socket.to(`checkers:${data.matchId}`).emit('opponent-checkers-move', {
        from: data.from,
        to: data.to,
        captures: data.captures,
        newTurn: data.newTurn,
        turnEnded: data.turnEnded,
        redTime: data.redTime,
        blackTime: data.blackTime
      });
    });

    socket.on("checkers-timeout", (data: { matchId: string; color: 'red' | 'black' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-timeout rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.color !== data.color) {
        console.log("[socket] checkers-timeout rejected - color mismatch");
        return;
      }

      console.log("[socket] checkers-timeout", data.matchId, data.color);
      
      const winnerId = data.color === 'red' 
        ? Array.from(room.players.entries()).find(([_, p]) => p.color === 'black')?.[0]
        : Array.from(room.players.entries()).find(([_, p]) => p.color === 'red')?.[0];
      const loserId = socketInfo.playerId;
      
      storeGameResult(data.matchId, 'checkers', winnerId || null, loserId, 'timeout');
      
      socket.to(`checkers:${data.matchId}`).emit('opponent-checkers-timeout');
      
      io.to(`checkers:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'timeout'
      });
      
      checkersRooms.delete(data.matchId);
    });

    socket.on("checkers-game-end", (data: { matchId: string; winner: 'red' | 'black'; playerId: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] checkers-game-end rejected - unauthorized");
        return;
      }

      const room = checkersRooms.get(data.matchId);
      if (!room) return;

      console.log("[socket] checkers-game-end", data.matchId, data.winner);
      
      const winnerId = Array.from(room.players.entries()).find(([_, p]) => p.color === data.winner)?.[0];
      const loserId = Array.from(room.players.entries()).find(([_, p]) => p.color !== data.winner)?.[0];
      
      storeGameResult(data.matchId, 'checkers', winnerId || null, loserId || null, 'game_complete');
      
      io.to(`checkers:${data.matchId}`).emit('game-result', {
        matchId: data.matchId,
        winnerId,
        loserId,
        reason: 'game_complete'
      });
      
      checkersRooms.delete(data.matchId);
    });

    socket.on("join-battleship-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`battleship:${matchId}`);
      console.log("[socket] join battleship match", matchId, socket.id, playerId);

      const oldSocketId = playerToSocket.get(playerId);
      if (oldSocketId && oldSocketId !== socket.id) {
        socketToPlayer.delete(oldSocketId);
      }
      
      socketToPlayer.set(socket.id, { matchId, playerId });
      playerToSocket.set(playerId, socket.id);
      
      const pendingTimeout = pendingDisconnects.get(playerId);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDisconnects.delete(playerId);
        console.log("[socket] player reconnected, cancelled forfeit:", playerId);
      }

      let room = battleshipRooms.get(matchId);
      if (!room) {
        room = {
          players: new Map(),
          started: false,
          battlePhase: false,
          currentTurn: 'player1',
          attackHistory: new Map()
        };
        battleshipRooms.set(matchId, room);
      }

      const existingPlayer = room.players.get(playerId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.emit('battleship-role-assigned', { role: existingPlayer.role });
        console.log("[socket] battleship reconnect, role preserved:", existingPlayer.role);
        
        if (room.players.size === 2 && room.started) {
          socket.emit('battleship-game-start');
          if (room.battlePhase) {
            socket.emit('battle-phase-start', { firstTurn: room.currentTurn });
          }
        }
        return;
      }

      if (room.players.size >= 2) {
        console.log("[socket] battleship match full, rejecting player", playerId);
        socket.emit('match-full');
        return;
      }

      const existingRoles = Array.from(room.players.values()).map(p => p.role);
      const assignedRole: 'player1' | 'player2' = existingRoles.includes('player1') ? 'player2' : 'player1';
      
      room.players.set(playerId, { 
        socketId: socket.id, 
        role: assignedRole,
        ready: false,
        ships: []
      });

      socket.emit('battleship-role-assigned', { role: assignedRole });
      console.log("[socket] battleship role assigned", matchId, playerId, assignedRole);

      if (room.players.size === 2 && !room.started) {
        room.started = true;
        io.to(`battleship:${matchId}`).emit('battleship-game-start');
        console.log("[socket] battleship-game-start", matchId);
      }
    });

    socket.on("battleship-ready", (data: { matchId: string; placements: ShipPlacement[] }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] battleship-ready rejected - unauthorized");
        return;
      }

      const room = battleshipRooms.get(data.matchId);
      if (!room) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player) return;

      if (player.ready) {
        console.log("[socket] battleship-ready rejected - already ready");
        return;
      }

      const validation = validateShipPlacements(data.placements);
      if (!validation.valid) {
        console.log("[socket] battleship-ready rejected - invalid placements:", validation.error);
        socket.emit('placement-error', { error: validation.error });
        return;
      }

      const ships: BattleshipShip[] = data.placements.map(p => {
        const config = SHIP_CONFIGS.find(s => s.id === p.shipId)!;
        const cells: { row: number; col: number }[] = [];
        
        for (let i = 0; i < config.size; i++) {
          cells.push({
            row: p.horizontal ? p.row : p.row + i,
            col: p.horizontal ? p.col + i : p.col
          });
        }

        return {
          id: p.shipId,
          name: config.name,
          size: config.size,
          cells,
          hits: 0,
          sunk: false
        };
      });

      player.ships = ships;
      player.ready = true;

      console.log("[socket] battleship player ready", data.matchId, player.role);

      socket.to(`battleship:${data.matchId}`).emit('opponent-ready');

      const allReady = Array.from(room.players.values()).every(p => p.ready);
      if (allReady && !room.battlePhase) {
        room.battlePhase = true;
        room.currentTurn = 'player1';
        io.to(`battleship:${data.matchId}`).emit('battle-phase-start', { firstTurn: 'player1' });
        console.log("[socket] battleship battle phase start", data.matchId);
      }
    });

    socket.on("battleship-attack", (data: { matchId: string; row: number; col: number }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] battleship-attack rejected - unauthorized");
        return;
      }

      const room = battleshipRooms.get(data.matchId);
      if (!room || !room.battlePhase) return;

      const attacker = room.players.get(socketInfo.playerId);
      if (!attacker || attacker.role !== room.currentTurn) {
        console.log("[socket] battleship-attack rejected - not your turn");
        return;
      }

      if (data.row < 0 || data.row >= GRID_SIZE || data.col < 0 || data.col >= GRID_SIZE) {
        console.log("[socket] battleship-attack rejected - out of bounds");
        return;
      }

      let attackerHistory = room.attackHistory.get(socketInfo.playerId);
      if (!attackerHistory) {
        attackerHistory = new Set();
        room.attackHistory.set(socketInfo.playerId, attackerHistory);
      }

      const attackKey = `${data.row},${data.col}`;
      if (attackerHistory.has(attackKey)) {
        console.log("[socket] battleship-attack rejected - already attacked this cell");
        return;
      }
      attackerHistory.add(attackKey);

      const defenderId = Array.from(room.players.entries()).find(([_, p]) => p.role !== attacker.role)?.[0];
      if (!defenderId) return;

      const defender = room.players.get(defenderId)!;

      let hit = false;
      let sunkShip: BattleshipShip | null = null;

      for (const ship of defender.ships) {
        const hitCell = ship.cells.find(c => c.row === data.row && c.col === data.col);
        if (hitCell) {
          hit = true;
          ship.hits++;
          if (ship.hits >= ship.size) {
            ship.sunk = true;
            sunkShip = ship;
          }
          break;
        }
      }

      const allSunk = defender.ships.every(s => s.sunk);
      const nextTurn = attacker.role === 'player1' ? 'player2' : 'player1';

      if (!allSunk) {
        room.currentTurn = nextTurn;
      }

      console.log("[socket] battleship-attack", data.matchId, data.row, data.col, hit ? "HIT" : "MISS", sunkShip?.name || "");

      socket.emit('attack-result', {
        row: data.row,
        col: data.col,
        hit,
        sunkShip,
        gameOver: allSunk,
        nextTurn
      });

      const defenderSocket = io.sockets.sockets.get(defender.socketId);
      if (defenderSocket) {
        defenderSocket.emit('opponent-attack', {
          row: data.row,
          col: data.col,
          hit,
          sunkShipCells: sunkShip?.cells,
          sunkShipName: sunkShip?.name,
          gameOver: allSunk
        });
      }

      if (allSunk) {
        storeGameResult(data.matchId, 'battleship', socketInfo.playerId, defenderId, 'all_ships_sunk');
        
        io.to(`battleship:${data.matchId}`).emit('game-result', {
          matchId: data.matchId,
          winnerId: socketInfo.playerId,
          loserId: defenderId,
          reason: 'all_ships_sunk'
        });
        
        battleshipRooms.delete(data.matchId);
      }
    });

    socket.on("battleship-timeout", (data: { matchId: string; role: 'player1' | 'player2' }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        console.log("[socket] battleship-timeout rejected - unauthorized");
        return;
      }

      const room = battleshipRooms.get(data.matchId);
      if (!room || !room.battlePhase) return;

      const player = room.players.get(socketInfo.playerId);
      if (!player || player.role !== data.role || room.currentTurn !== data.role) {
        console.log("[socket] battleship-timeout rejected - role mismatch");
        return;
      }

      const nextTurn = data.role === 'player1' ? 'player2' : 'player1';
      room.currentTurn = nextTurn;

      console.log("[socket] battleship-timeout (turn skipped)", data.matchId, data.role);
      io.to(`battleship:${data.matchId}`).emit('turn-skipped', { skippedPlayer: data.role });
    });

    socket.on("disconnect", () => {
      console.log("[socket] disconnected", socket.id);
      const socketInfo = socketToPlayer.get(socket.id);
      
      if (socketInfo) {
        const { matchId, playerId } = socketInfo;
        
        const timeout = setTimeout(() => {
          const currentSocketId = playerToSocket.get(playerId);
          if (currentSocketId && currentSocketId !== socket.id) {
            console.log("[socket] player has reconnected, skipping forfeit:", playerId);
            return;
          }
          
          pendingDisconnects.delete(playerId);
          playerToSocket.delete(playerId);
          
          const chessRoom = matchRooms.get(matchId);
          if (chessRoom) {
            const player = chessRoom.players.get(playerId);
            if (player) {
              const winnerId = Array.from(chessRoom.players.entries()).find(([id, _]) => id !== playerId)?.[0];
              
              if (winnerId) {
                storeGameResult(matchId, 'chess', winnerId, playerId, 'disconnect');
                io.to(`match:${matchId}`).emit('opponent-disconnected', { forfeit: true });
                io.to(`match:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect'
                });
              }
              matchRooms.delete(matchId);
            }
          }
          
          const tetrisRoom = tetrisRooms.get(matchId);
          if (tetrisRoom) {
            const winnerId = Array.from(tetrisRoom.players.keys()).find(id => id !== playerId);
            if (winnerId) {
              storeGameResult(matchId, 'tetris', winnerId, playerId, 'disconnect');
              io.to(`tetris:${matchId}`).emit('opponent-disconnected', { forfeit: true });
              io.to(`tetris:${matchId}`).emit('game-result', {
                matchId,
                winnerId,
                loserId: playerId,
                reason: 'disconnect'
              });
            }
            tetrisRooms.delete(matchId);
          }
          
          const checkersRoom = checkersRooms.get(matchId);
          if (checkersRoom) {
            const player = checkersRoom.players.get(playerId);
            if (player) {
              const winnerId = Array.from(checkersRoom.players.entries()).find(([id, _]) => id !== playerId)?.[0];
              if (winnerId) {
                storeGameResult(matchId, 'checkers', winnerId, playerId, 'disconnect');
                io.to(`checkers:${matchId}`).emit('opponent-disconnected', { forfeit: true });
                io.to(`checkers:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect'
                });
              }
              checkersRooms.delete(matchId);
            }
          }
          
          const battleshipRoom = battleshipRooms.get(matchId);
          if (battleshipRoom && battleshipRoom.battlePhase) {
            const player = battleshipRoom.players.get(playerId);
            if (player) {
              const winnerId = Array.from(battleshipRoom.players.entries()).find(([id, _]) => id !== playerId)?.[0];
              if (winnerId) {
                storeGameResult(matchId, 'battleship', winnerId, playerId, 'disconnect');
                io.to(`battleship:${matchId}`).emit('opponent-disconnected', { forfeit: true });
                io.to(`battleship:${matchId}`).emit('game-result', {
                  matchId,
                  winnerId,
                  loserId: playerId,
                  reason: 'disconnect'
                });
              }
              battleshipRooms.delete(matchId);
            }
          }
        }, 30000);
        
        pendingDisconnects.set(playerId, timeout);
      }
      
      socketToPlayer.delete(socket.id);
    });
  });

  return io;
}
