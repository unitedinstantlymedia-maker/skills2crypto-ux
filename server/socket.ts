import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";

interface SocketOptions {
  isProd: boolean;
  allowedOrigins: string[];
}

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

    socket.on("join-match", (matchId: string) => {
      socket.join(`match:${matchId}`);
      console.log("[socket] join match", matchId, socket.id);
    });

    socket.on("disconnect", () => {
      console.log("[socket] disconnected", socket.id);
    });
  });

  return io;
}