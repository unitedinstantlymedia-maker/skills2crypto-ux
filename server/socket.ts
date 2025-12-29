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

interface GameEnd {
  matchId: string;
  result: 'checkmate' | 'stalemate' | 'draw' | 'timeout' | 'resignation';
  winner: 'white' | 'black' | 'draw';
}

interface MatchRoom {
  players: Map<string, { socketId: string; color: 'white' | 'black' }>;
  fen: string;
  whiteTime: number;
  blackTime: number;
}

const matchRooms = new Map<string, MatchRoom>();

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
      console.log("[socket] chess-move", matchId, from, to, san);

      const room = matchRooms.get(matchId);
      if (room) {
        room.fen = fen;
        room.whiteTime = whiteTime;
        room.blackTime = blackTime;
      }

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
      console.log("[socket] chess-resign", data.matchId, data.color);
      socket.to(`match:${data.matchId}`).emit('opponent-resigned', {
        color: data.color
      });
      matchRooms.delete(data.matchId);
    });

    socket.on("chess-timeout", (data: { matchId: string; color: 'white' | 'black' }) => {
      console.log("[socket] chess-timeout", data.matchId, data.color);
      socket.to(`match:${data.matchId}`).emit('opponent-timeout', {
        color: data.color
      });
      matchRooms.delete(data.matchId);
    });

    socket.on("game-end", (data: GameEnd) => {
      console.log("[socket] game-end", data.matchId, data.result, data.winner);
      io.to(`match:${data.matchId}`).emit('match-ended', data);
      matchRooms.delete(data.matchId);
    });

    socket.on("disconnect", () => {
      console.log("[socket] disconnected", socket.id);
    });
  });

  return io;
}
