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

    socket.on("disconnect", () => {
      console.log("[socket] disconnected", socket.id);
      socketToPlayer.delete(socket.id);
    });
  });

  return io;
}
