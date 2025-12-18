import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { Server } from "http";
import { log } from "../index";
import { registerPlayer, unregisterPlayer, findMatch, cancelSearch, type Asset } from "./matchmaking";

interface RegisterMessage {
  type: "register";
  playerId: string;
}

interface FindMatchMessage {
  type: "find_match";
  game: string;
  asset: Asset;
  amount: number;
  playerId: string;
}

interface CancelSearchMessage {
  type: "cancel_search";
  playerId: string;
}

type ClientMessage = RegisterMessage | FindMatchMessage | CancelSearchMessage;

const connectedPlayers: Map<WsWebSocket, string> = new Map();

export function setupWebSocket(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WsWebSocket) => {
    log("New WebSocket connection", "websocket");

    ws.on("message", (data: Buffer) => {
      try {
        const message: ClientMessage = JSON.parse(data.toString());
        handleMessage(ws, message);
      } catch (error) {
        log(`Invalid message received: ${error}`, "websocket");
        ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      }
    });

    ws.on("close", () => {
      const playerId = connectedPlayers.get(ws);
      if (playerId) {
        unregisterPlayer(playerId);
        connectedPlayers.delete(ws);
        log(`WebSocket closed for player: ${playerId}`, "websocket");
      } else {
        log("WebSocket closed (unregistered connection)", "websocket");
      }
    });

    ws.on("error", (error) => {
      log(`WebSocket error: ${error.message}`, "websocket");
    });
  });

  log("WebSocket server initialized on /ws", "websocket");
  return wss;
}

function handleMessage(ws: WsWebSocket, message: ClientMessage): void {
  switch (message.type) {
    case "register":
      handleRegister(ws, message);
      break;
    case "find_match":
      handleFindMatch(ws, message);
      break;
    case "cancel_search":
      handleCancelSearch(ws, message);
      break;
    default:
      ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
  }
}

function handleRegister(ws: WsWebSocket, message: RegisterMessage): void {
  if (!message.playerId || typeof message.playerId !== "string") {
    ws.send(JSON.stringify({ type: "error", message: "Invalid playerId" }));
    return;
  }

  connectedPlayers.set(ws, message.playerId);
  registerPlayer(message.playerId, ws);
  
  ws.send(JSON.stringify({ 
    type: "registered", 
    playerId: message.playerId,
    timestamp: Date.now()
  }));
}

function handleFindMatch(ws: WsWebSocket, message: FindMatchMessage): void {
  const { game, asset, amount, playerId } = message;

  if (!game || typeof game !== "string") {
    ws.send(JSON.stringify({ type: "error", message: "Invalid game" }));
    return;
  }

  if (!["USDT", "ETH", "TON"].includes(asset)) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid asset. Must be USDT, ETH, or TON" }));
    return;
  }

  if (typeof amount !== "number" || amount <= 0) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid amount. Must be a positive number" }));
    return;
  }

  if (!playerId || typeof playerId !== "string") {
    ws.send(JSON.stringify({ type: "error", message: "Invalid playerId" }));
    return;
  }

  const result = findMatch(game, asset, amount, playerId);
  
  if (result.status === "waiting") {
    ws.send(JSON.stringify({ 
      type: "queue_joined", 
      game,
      asset,
      amount,
      playerId,
      timestamp: Date.now()
    }));
  }
}

function handleCancelSearch(ws: WsWebSocket, message: CancelSearchMessage): void {
  if (!message.playerId || typeof message.playerId !== "string") {
    ws.send(JSON.stringify({ type: "error", message: "Invalid playerId" }));
    return;
  }

  const cancelled = cancelSearch(message.playerId);
  
  ws.send(JSON.stringify({ 
    type: "search_cancelled", 
    success: cancelled,
    playerId: message.playerId,
    timestamp: Date.now()
  }));
}
