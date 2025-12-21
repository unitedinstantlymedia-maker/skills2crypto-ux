import { Server } from "socket.io";
import type { Server as HttpServer } from "http";

export function setupSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    path: "/ws",
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