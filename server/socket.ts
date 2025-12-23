import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";

export function setupSocket(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" },           // сузишь на проде
    path: "/socket.io",              // важно: совпадает с клиентом по умолчанию
    transports: ["websocket"],       // быстрый канал
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
}