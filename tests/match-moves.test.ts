import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

// Capture inserts so we can assert one row per validated move with the
// right ply / actor / payload shape. The mock keys rows by table-object
// identity so it can distinguish `matches` (final result) from
// `match_moves` (per-move audit) without coupling to the dialect.
const insertedRows = new Map<unknown, any[]>();
function reset(): void {
  insertedRows.clear();
}
function rowsFor(table: unknown): any[] {
  return insertedRows.get(table) ?? [];
}

vi.mock("../server/db", () => ({
  db: {
    insert: (table: unknown) => ({
      values: async (row: any) => {
        const list = insertedRows.get(table) ?? [];
        list.push(row);
        insertedRows.set(table, list);
      },
    }),
  },
  pool: { end: async () => undefined },
}));

const redisStore = new Map<string, string>();
vi.mock("../server/redis", () => ({
  redis: {
    set: async (
      key: string,
      value: string,
      opts?: { ex?: number; nx?: boolean }
    ): Promise<string | null> => {
      if (opts?.nx && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    },
    get: async (key: string): Promise<string | null> => redisStore.get(key) ?? null,
    del: async (key: string): Promise<number> => (redisStore.delete(key) ? 1 : 0),
    hgetall: async (): Promise<Record<string, string>> => ({}),
    hset: async (): Promise<number> => 0,
    hget: async (): Promise<string | null> => null,
    expire: async (): Promise<number> => 0,
    ping: async (): Promise<string> => "PONG",
  },
}));

vi.mock("../server/oracle", () => ({
  settleMatch: async () => undefined,
  settleMatchOnChain: async () => undefined,
}));
vi.mock("../server/oracle.evm", () => ({}));
vi.mock("../server/oracle.tron", () => ({}));
vi.mock("../server/oracle.ton", () => ({}));

import { matchMoves } from "../shared/schema";
import {
  setupSocket,
  markMatchFunded,
  _resetMatchMoveLogStateForTests,
} from "../server/socket";
import { io as ClientIO, type Socket as ClientSocket } from "socket.io-client";

let httpServer: http.Server;
let serverUrl: string;

function connectClient(): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const sock = ClientIO(serverUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    const t = setTimeout(() => reject(new Error("connect timeout")), 5000);
    sock.on("connect", () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.on("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitFor<T = unknown>(sock: ClientSocket, name: string, ms = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off(name, handler);
      reject(new Error(`timeout waiting for '${name}'`));
    }, ms);
    const handler = (payload: T) => {
      clearTimeout(t);
      sock.off(name, handler);
      resolve(payload);
    };
    sock.on(name, handler);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  httpServer = http.createServer();
  setupSocket(httpServer, { isProd: false, allowedOrigins: [] });
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  redisStore.clear();
  reset();
  _resetMatchMoveLogStateForTests();
});

async function startChessMatch(): Promise<{
  matchId: string;
  white: ClientSocket;
  black: ClientSocket;
  whiteId: string;
  blackId: string;
}> {
  const matchId = `mv-match-${Math.random().toString(36).slice(2, 10)}`;
  const a = await connectClient();
  const b = await connectClient();

  const whiteId = `player-w-${Math.random().toString(36).slice(2, 8)}`;
  const blackId = `player-b-${Math.random().toString(36).slice(2, 8)}`;

  const aColor = waitFor<{ color: "white" | "black" }>(a, "color-assigned");
  a.emit("join-match", { matchId, playerId: whiteId });
  await aColor;

  const bColor = waitFor<{ color: "white" | "black" }>(b, "color-assigned");
  b.emit("join-match", { matchId, playerId: blackId });
  await bColor;

  const aStart = waitFor(a, "game-start", 2000);
  const bStart = waitFor(b, "game-start", 2000);
  markMatchFunded(matchId);
  await Promise.all([aStart, bStart]);

  return { matchId, white: a, black: b, whiteId, blackId };
}

describe("match_moves audit log", () => {
  it("records one row per accepted chess move with monotonic ply and actor identity", async () => {
    const { matchId, white, black, whiteId, blackId } = await startChessMatch();
    try {
      const moves: { from: string; to: string; by: ClientSocket; listen: ClientSocket }[] = [
        { from: "e2", to: "e4", by: white, listen: black },
        { from: "e7", to: "e5", by: black, listen: white },
        { from: "g1", to: "f3", by: white, listen: black },
      ];

      for (const m of moves) {
        const wait = waitFor(m.listen, "opponent-move", 1500);
        m.by.emit("chess-move", { matchId, from: m.from, to: m.to });
        await wait;
      }

      // Insert is fire-and-forget via setImmediate; let the queue drain.
      await sleep(100);

      const rows = rowsFor(matchMoves).filter((r) => r.matchId === matchId);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.ply)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.actorId)).toEqual([whiteId, blackId, whiteId]);
      for (const r of rows) {
        expect(r.gameType).toBe("chess");
        expect(typeof r.serverTimestampMs).toBe("number");
        expect(r.payload.from).toBeDefined();
        expect(r.payload.to).toBeDefined();
      }
      // First row has no prior, subsequent rows have a non-negative gap.
      expect(rows[0].msSinceLastMove).toBeNull();
      expect(rows[1].msSinceLastMove).toBeGreaterThanOrEqual(0);
      expect(rows[2].msSinceLastMove).toBeGreaterThanOrEqual(0);
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });

  it("does not record a row for an illegal move", async () => {
    const { matchId, white, black } = await startChessMatch();
    try {
      // White tries a clearly illegal move (king to e7 from start).
      white.emit("chess-move", { matchId, from: "e1", to: "e7" });
      await sleep(100);

      const rows = rowsFor(matchMoves).filter((r) => r.matchId === matchId);
      expect(rows).toHaveLength(0);
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });

  it("records one row per accepted tetris snapshot", async () => {
    const matchId = `mv-tetris-${Math.random().toString(36).slice(2, 10)}`;
    const a = await connectClient();
    const b = await connectClient();
    const aId = `tp-${Math.random().toString(36).slice(2, 8)}`;
    const bId = `tp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      a.emit("join-tetris-match", { matchId, playerId: aId });
      b.emit("join-tetris-match", { matchId, playerId: bId });
      const aStart = waitFor(a, "tetris-game-start", 2000);
      const bStart = waitFor(b, "tetris-game-start", 2000);
      markMatchFunded(matchId);
      await Promise.all([aStart, bStart]);

      const emptyBoard = Array.from({ length: 20 }, () =>
        Array.from({ length: 10 }, () => null as string | null),
      );

      const oppA = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard,
        score: 100,
        lines: 1,
        level: 1,
        gameOver: false,
      });
      await oppA;
      const oppB = waitFor(a, "opponent-tetris-state", 1500);
      b.emit("tetris-state", {
        matchId,
        board: emptyBoard,
        score: 200,
        lines: 2,
        level: 1,
        gameOver: false,
      });
      await oppB;

      await sleep(100);
      const rows = rowsFor(matchMoves).filter((r) => r.matchId === matchId);
      expect(rows).toHaveLength(2);
      expect(rows[0].gameType).toBe("tetris");
      expect(rows[0].actorId).toBe(aId);
      expect(rows[0].payload.score).toBe(100);
      expect(rows[1].actorId).toBe(bId);
      expect(rows[1].payload.score).toBe(200);
      expect(rows.map((r) => r.ply)).toEqual([1, 2]);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("does not block the chess broadcast even if the audit insert throws", async () => {
    // Re-mock just for this test: make insert reject every time.
    const { db } = await import("../server/db");
    const original = (db as any).insert;
    (db as any).insert = (_table: unknown) => ({
      values: async () => {
        throw new Error("simulated db outage");
      },
    });

    const { matchId, white, black } = await startChessMatch();
    try {
      const broadcast = waitFor<{ san: string }>(black, "opponent-move", 1500);
      white.emit("chess-move", { matchId, from: "e2", to: "e4" });
      // The opponent must still receive the broadcast — the audit
      // failure is fully decoupled from the socket hot path.
      const payload = await broadcast;
      expect(payload.san).toBe("e4");
    } finally {
      (db as any).insert = original;
      white.disconnect();
      black.disconnect();
    }
  });
});
