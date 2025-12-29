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
const socketToPlayer = new Map<string, { matchId: string; playerId: string }>();

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

      socketToPlayer.set(socket.id, { matchId, playerId });

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
      socket.to(`match:${data.matchId}`).emit('opponent-resigned', {
        color: data.color
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
      socket.to(`match:${data.matchId}`).emit('opponent-timeout', {
        color: data.color
      });
      matchRooms.delete(data.matchId);
    });

    socket.on("game-end", (data: { matchId: string; result: string; winner: string }) => {
      const socketInfo = socketToPlayer.get(socket.id);
      if (!socketInfo || socketInfo.matchId !== data.matchId) {
        return;
      }

      console.log("[socket] game-end", data.matchId, data.result, data.winner);
      io.to(`match:${data.matchId}`).emit('match-ended', data);
      matchRooms.delete(data.matchId);
    });

    socket.on("join-tetris-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`tetris:${matchId}`);
      console.log("[socket] join tetris match", matchId, socket.id, playerId);

      socketToPlayer.set(socket.id, { matchId, playerId });

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
      socket.to(`tetris:${data.matchId}`).emit('opponent-tetris-game-over');
      tetrisRooms.delete(data.matchId);
    });

    socket.on("join-checkers-match", (data: { matchId: string; playerId: string }) => {
      const { matchId, playerId } = data;
      socket.join(`checkers:${matchId}`);
      console.log("[socket] join checkers match", matchId, socket.id, playerId);

      socketToPlayer.set(socket.id, { matchId, playerId });

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
      socket.to(`checkers:${data.matchId}`).emit('opponent-checkers-timeout');
      checkersRooms.delete(data.matchId);
    });

    socket.on("disconnect", () => {
      console.log("[socket] disconnected", socket.id);
      socketToPlayer.delete(socket.id);
    });
  });

  return io;
}
