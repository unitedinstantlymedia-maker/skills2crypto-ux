import type { Express, Request, Response } from "express";
import type { Server } from "http";
import { createMatch, getMatch, getOrCreateMatch, submitMove, resignMatch } from "./services/matchEngine";
import { findMatch, getMatchById, getQueueStats, type Asset as MatchAsset } from "./services/matchmaking";
import { setupSocketIO, initializeMatch } from "./services/socketio";
import type { Asset, ChessMove } from "@shared/protocol";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupSocketIO(httpServer);

  app.post("/api/find-match", (req: Request, res: Response) => {
    const { game, asset, amount, playerId } = req.body;

    if (!game || typeof game !== "string") {
      res.status(400).json({ error: "Invalid game. Must be a non-empty string." });
      return;
    }

    if (!["USDT", "ETH", "TON"].includes(asset)) {
      res.status(400).json({ error: "Invalid asset. Must be USDT, ETH, or TON." });
      return;
    }

    if (typeof amount !== "number" || amount <= 0) {
      res.status(400).json({ error: "Invalid amount. Must be a positive number." });
      return;
    }

    if (!playerId || typeof playerId !== "string") {
      res.status(400).json({ error: "Invalid playerId. Must be a non-empty string." });
      return;
    }

    const result = findMatch(game, asset as MatchAsset, amount, playerId);
    
    if (result.status === "matched") {
      res.json({ status: "matched", matchId: result.matchId });
    } else {
      res.json({ status: "waiting" });
    }
  });

  app.get("/api/matchmaking/match/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const match = getMatchById(id);

    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    res.json({
      id: match.id,
      game: match.game,
      asset: match.asset,
      amount: match.amount,
      players: match.players,
      status: match.status,
    });
  });

  app.get("/api/matchmaking/stats", (_req: Request, res: Response) => {
    const stats = getQueueStats();
    res.json(stats);
  });

  app.post("/api/matches", (req: Request, res: Response) => {
    const { game, asset, stake, whiteId, blackId } = req.body;

    if (game !== "chess") {
      res.status(400).json({ error: "Invalid game type. Only 'chess' is supported." });
      return;
    }

    if (!["USDT", "ETH", "TON"].includes(asset)) {
      res.status(400).json({ error: "Invalid asset. Must be USDT, ETH, or TON." });
      return;
    }

    if (typeof stake !== "number" || stake <= 0) {
      res.status(400).json({ error: "Invalid stake. Must be a positive number." });
      return;
    }

    if (!whiteId || typeof whiteId !== "string") {
      res.status(400).json({ error: "Invalid whiteId. Must be a non-empty string." });
      return;
    }

    if (!blackId || typeof blackId !== "string") {
      res.status(400).json({ error: "Invalid blackId. Must be a non-empty string." });
      return;
    }

    const result = createMatch({
      game,
      stake,
      asset: asset as Asset,
      whiteId,
      blackId,
    });

    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(201).json(result);
  });

  app.get("/api/matches/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    
    const match = getOrCreateMatch(id);
    res.json(match);
  });

  app.post("/api/matches/:id/move", (req: Request, res: Response) => {
    const { id } = req.params;
    const { playerId, move } = req.body;

    if (!playerId || typeof playerId !== "string") {
      res.status(400).json({ error: "Invalid playerId. Must be a non-empty string." });
      return;
    }

    if (!move || typeof move.from !== "string" || typeof move.to !== "string") {
      res.status(400).json({ error: "Invalid move. Must have 'from' and 'to' fields." });
      return;
    }

    const chessMove: ChessMove = {
      from: move.from,
      to: move.to,
      promotion: move.promotion,
    };

    const result = submitMove(id, playerId, chessMove);

    if (!result.success) {
      if (result.error === "Match not found") {
        res.status(404).json({ error: result.error });
        return;
      }
      res.status(409).json({ error: result.error });
      return;
    }

    res.json(result.match);
  });

  app.post("/api/matches/:id/resign", (req: Request, res: Response) => {
    const { id } = req.params;
    const { playerId } = req.body;

    if (!playerId || typeof playerId !== "string") {
      res.status(400).json({ error: "Invalid playerId. Must be a non-empty string." });
      return;
    }

    const result = resignMatch(id, playerId);

    if (!result.success) {
      if (result.error === "Match not found") {
        res.status(404).json({ error: result.error });
        return;
      }
      res.status(409).json({ error: result.error });
      return;
    }

    res.json(result.match);
  });

  return httpServer;
}
