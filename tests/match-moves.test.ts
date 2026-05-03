import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";

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

// Drizzle query stub for the GET /api/matches/:matchId/moves endpoint:
// the route reads from `matchMoves` (ordered by ply) and from `matches`
// (participants lookup). The fake returns whatever rows we've recorded
// and supports the `gt(matchMoves.ply, n)` afterPly cursor used by the
// pagination contract.
const matchParticipants = new Map<string, { player1Id: string; player2Id: string }>();
let lastMatchMovesQueryAfterPly = 0;
let lastMatchMovesQueryMatchId = "";

vi.mock("../server/db", () => ({
  db: {
    insert: (table: unknown) => ({
      values: async (row: any) => {
        const list = insertedRows.get(table) ?? [];
        list.push(row);
        insertedRows.set(table, list);
      },
    }),
    // Endpoint chain: db.select(...).from(table).where(cond).orderBy(...).limit(n)
    // OR db.select({...}).from(table).where(cond).limit(n). We make the
    // builder a thenable that resolves to filtered rows once awaited.
    select: (_proj?: any) => {
      const builder: any = {
        _table: null,
        _matchId: null as string | null,
        _afterPly: 0,
        _limit: Infinity,
        from(t: unknown) {
          this._table = t;
          return this;
        },
        where(_cond: any) {
          // Capture the matchId / afterPly that the route applied.
          this._matchId = lastMatchMovesQueryMatchId;
          this._afterPly = lastMatchMovesQueryAfterPly;
          return this;
        },
        orderBy(_o: any) {
          return this;
        },
        limit(n: number) {
          this._limit = n;
          return this;
        },
        then(resolve: (rows: any[]) => any, _reject: any) {
          const tableSym = (this._table as any)?.[Symbol.for("drizzle:Name")] || "";
          if (tableSym === "matches" || this._table === MATCHES_TABLE_REF) {
            const part = matchParticipants.get(this._matchId || "");
            return resolve(part ? [part] : []);
          }
          // Default: match_moves rows (filtered by matchId / afterPly).
          const rows = (insertedRows.get(MATCH_MOVES_TABLE_REF) ?? [])
            .filter((r) => r.matchId === this._matchId)
            .filter((r) => r.ply > this._afterPly)
            .sort((a, b) => a.ply - b.ply)
            .slice(0, this._limit);
          return resolve(rows);
        },
      };
      return builder;
    },
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
    incr: async (): Promise<number> => 1,
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

import { matchMoves, matches } from "../shared/schema";
const MATCH_MOVES_TABLE_REF = matchMoves;
const MATCHES_TABLE_REF = matches;

import {
  setupSocket,
  markMatchFunded,
  _resetMatchMoveLogStateForTests,
  __seedBattleshipRoomForTest,
  __seedDominoesRoomForTest,
} from "../server/socket";
import { issueMatchToken } from "../server/security/matchToken";
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
  matchParticipants.clear();
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

  it("records one row per accepted checkers move", async () => {
    const matchId = `mv-checkers-${Math.random().toString(36).slice(2, 10)}`;
    const a = await connectClient();
    const b = await connectClient();
    const aId = `cp-${Math.random().toString(36).slice(2, 8)}`;
    const bId = `cp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const aColor = waitFor<{ color: "red" | "black" }>(a, "checkers-color-assigned");
      a.emit("join-checkers-match", { matchId, playerId: aId });
      const aAssigned = await aColor;
      const bColor = waitFor<{ color: "red" | "black" }>(b, "checkers-color-assigned");
      b.emit("join-checkers-match", { matchId, playerId: bId });
      await bColor;

      const aStart = waitFor(a, "checkers-game-start", 2000);
      const bStart = waitFor(b, "checkers-game-start", 2000);
      markMatchFunded(matchId);
      await Promise.all([aStart, bStart]);

      const red = aAssigned.color === "red" ? a : b;
      const redId = aAssigned.color === "red" ? aId : bId;
      const black = aAssigned.color === "red" ? b : a;

      // Red opens with a standard forward diagonal from row 5 to row 4.
      const oppMove = waitFor(black, "opponent-checkers-move", 1500);
      red.emit("checkers-move", {
        matchId,
        from: { row: 5, col: 2 },
        to: { row: 4, col: 3 },
      });
      await oppMove;
      await sleep(100);

      const rows = rowsFor(matchMoves).filter((r) => r.matchId === matchId);
      expect(rows).toHaveLength(1);
      expect(rows[0].gameType).toBe("checkers");
      expect(rows[0].actorId).toBe(redId);
      expect(rows[0].ply).toBe(1);
      expect(rows[0].payload.from).toEqual({ row: 5, col: 2 });
      expect(rows[0].payload.to).toEqual({ row: 4, col: 3 });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("records one row per accepted xiangqi move", async () => {
    const matchId = `mv-xq-${Math.random().toString(36).slice(2, 10)}`;
    const a = await connectClient();
    const b = await connectClient();
    const aId = `xq-${Math.random().toString(36).slice(2, 8)}`;
    const bId = `xq-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const aColor = waitFor<{ color: "red" | "black" }>(a, "xiangqi-color-assigned");
      a.emit("join-xiangqi-match", { matchId, playerId: aId });
      const aAssigned = await aColor;
      const bColor = waitFor<{ color: "red" | "black" }>(b, "xiangqi-color-assigned");
      b.emit("join-xiangqi-match", { matchId, playerId: bId });
      await bColor;

      const aStart = waitFor(a, "xiangqi-game-start", 2000);
      const bStart = waitFor(b, "xiangqi-game-start", 2000);
      markMatchFunded(matchId);
      await Promise.all([aStart, bStart]);

      const red = aAssigned.color === "red" ? a : b;
      const redId = aAssigned.color === "red" ? aId : bId;
      const black = aAssigned.color === "red" ? b : a;

      // Red soldier at file 0, rank 3 advances to rank 4 — a legal
      // opening move on the standard initial board.
      const oppMove = waitFor(black, "opponent-xiangqi-move", 1500);
      red.emit("xiangqi-move", {
        matchId,
        from: { file: 0, rank: 3 },
        to: { file: 0, rank: 4 },
      });
      await oppMove;
      await sleep(100);

      const rows = rowsFor(matchMoves).filter((r) => r.matchId === matchId);
      expect(rows).toHaveLength(1);
      expect(rows[0].gameType).toBe("xiangqi");
      expect(rows[0].actorId).toBe(redId);
      expect(rows[0].ply).toBe(1);
      expect(rows[0].payload.from).toEqual({ file: 0, rank: 3 });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("records one row per accepted battleship attack (via test seam)", async () => {
    const matchId = `mv-bs-${Math.random().toString(36).slice(2, 10)}`;
    const a = await connectClient();
    const b = await connectClient();
    const aId = `bsp-${Math.random().toString(36).slice(2, 8)}`;
    const bId = `bsp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      a.emit("join-battleship-match", { matchId, playerId: aId });
      const aRole = await waitFor<{ role: "player1" | "player2" }>(a, "battleship-role-assigned");
      b.emit("join-battleship-match", { matchId, playerId: bId });
      await waitFor(b, "battleship-role-assigned");
      // Wait for the post-funding game-start so the room is fully wired
      // before we seed it into the battle phase.
      const aStart = waitFor(a, "battleship-game-start", 2000);
      const bStart = waitFor(b, "battleship-game-start", 2000);
      markMatchFunded(matchId);
      await Promise.all([aStart, bStart]);

      // a is the attacker for this assertion. Make sure the seam picks
      // attacker/defender consistently with the assigned roles.
      const attackerId = aRole.role === "player1" ? aId : bId;
      const defenderId = attackerId === aId ? bId : aId;
      const attackerSock = attackerId === aId ? a : b;
      __seedBattleshipRoomForTest(matchId, attackerId, defenderId);

      const ack = waitFor(attackerSock, "attack-result", 1500);
      attackerSock.emit("battleship-attack", { matchId, row: 0, col: 0 });
      await ack;
      await sleep(100);

      const rows = rowsFor(matchMoves).filter((r) => r.matchId === matchId);
      expect(rows).toHaveLength(1);
      expect(rows[0].gameType).toBe("battleship");
      expect(rows[0].actorId).toBe(attackerId);
      expect(rows[0].ply).toBe(1);
      expect(rows[0].payload.row).toBe(0);
      expect(rows[0].payload.col).toBe(0);
      expect(rows[0].payload.hit).toBe(false);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("records one row per accepted dominoes move (via test seam)", async () => {
    const matchId = `mv-dom-${Math.random().toString(36).slice(2, 10)}`;
    const a = await connectClient();
    const b = await connectClient();
    const aId = `dom-${Math.random().toString(36).slice(2, 8)}`;
    const bId = `dom-${Math.random().toString(36).slice(2, 8)}`;
    try {
      a.emit("join-dominoes-match", { matchId, playerId: aId });
      const aStartP = waitFor<{ role: "p1" | "p2" }>(a, "dominoes-game-start", 2000);
      b.emit("join-dominoes-match", { matchId, playerId: bId });
      const bStartP = waitFor<{ role: "p1" | "p2" }>(b, "dominoes-game-start", 2000);
      markMatchFunded(matchId);
      const [aStart] = await Promise.all([aStartP, bStartP]);

      // Reset the room to a clean "starter holds (6,6)" state so the
      // first move is unambiguous regardless of the random deal.
      const starterIsA = aStart.role === "p1";
      const starterId = starterIsA ? aId : bId;
      const starterSock = starterIsA ? a : b;
      const otherSock = starterIsA ? b : a;
      __seedDominoesRoomForTest(matchId, starterId, { a: 6, b: 6 });

      const opp = waitFor(otherSock, "dominoes-move-played", 1500);
      starterSock.emit("dominoes-move", {
        matchId,
        tileA: 6,
        tileB: 6,
        end: "right",
      });
      await opp;
      await sleep(100);

      const rows = rowsFor(matchMoves).filter((r) => r.matchId === matchId);
      expect(rows).toHaveLength(1);
      expect(rows[0].gameType).toBe("dominoes");
      expect(rows[0].actorId).toBe(starterId);
      expect(rows[0].ply).toBe(1);
      expect(rows[0].payload.type).toBe("place");
      expect(rows[0].payload.tileA).toBe(6);
      expect(rows[0].payload.tileB).toBe(6);
      expect(rows[0].payload.end).toBe("right");
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

// -----------------------------------------------------------------
// Endpoint tests: GET /api/matches/:matchId/moves
// -----------------------------------------------------------------
//
// The endpoint is mounted by registerRoutes on a fresh express app so
// the test exercises the real authz / pagination logic. Drizzle calls
// resolve through the mocked select() builder above; participants are
// seeded into `matchParticipants` so the participant cross-check sees
// them without needing a real DB.

describe("GET /api/matches/:matchId/moves", () => {
  let app: express.Express;
  let endpointServer: http.Server;
  let endpointUrl: string;

  beforeAll(async () => {
    const { registerRoutes } = await import("../server/routes");
    const { Server: SocketIOServer } = await import("socket.io");
    app = express();
    app.use(express.json());
    endpointServer = http.createServer(app);
    const io = new SocketIOServer(endpointServer);
    await registerRoutes(endpointServer, app, io);
    await new Promise<void>((r) => endpointServer.listen(0, () => r()));
    const addr = endpointServer.address() as AddressInfo;
    endpointUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => endpointServer.close(() => r()));
  });

  beforeEach(() => {
    lastMatchMovesQueryAfterPly = 0;
    lastMatchMovesQueryMatchId = "";
  });

  function seedMoves(
    matchId: string,
    p1: string,
    p2: string,
    plies: number[],
  ): void {
    matchParticipants.set(matchId, { player1Id: p1, player2Id: p2 });
    const list = insertedRows.get(MATCH_MOVES_TABLE_REF) ?? [];
    for (const ply of plies) {
      list.push({
        matchId,
        gameType: "chess",
        ply,
        actorId: ply % 2 === 1 ? p1 : p2,
        payload: { from: "e2", to: "e4" },
        serverTimestampMs: Date.now(),
        msSinceLastMove: ply === 1 ? null : 100,
      });
    }
    insertedRows.set(MATCH_MOVES_TABLE_REF, list);
  }

  // The fake select() relies on these globals to know which rows to
  // return. We patch the route's parse step by intercepting the URL.
  async function fetchMoves(
    matchId: string,
    walletAddress: string,
    token: string | null,
    qs: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    lastMatchMovesQueryMatchId = matchId;
    lastMatchMovesQueryAfterPly = qs.afterPly ? Number(qs.afterPly) : 0;
    const params = new URLSearchParams({ walletAddress, ...qs }).toString();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${endpointUrl}/api/matches/${matchId}/moves?${params}`, {
      headers,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it("rejects with 401 when no bearer token is provided", async () => {
    const matchId = "ep-401-no-token";
    seedMoves(matchId, "alice", "bob", [1]);
    const r = await fetchMoves(matchId, "alice", null);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("missing_bearer_token");
  });

  it("rejects with 401 when the bearer token is forged", async () => {
    const matchId = "ep-401-forged";
    seedMoves(matchId, "alice", "bob", [1]);
    const r = await fetchMoves(matchId, "alice", "not-a-real-token-aaaa");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_match_token");
  });

  it("rejects with 403 when the (verified) caller is not a match participant", async () => {
    const matchId = "ep-403-stranger";
    seedMoves(matchId, "alice", "bob", [1]);
    // The token is for `mallory` — verifyMatchToken passes, but the
    // participant cross-check inside the endpoint must still 403 since
    // mallory isn't player1/player2 of this match.
    const r = await fetchMoves(matchId, "mallory", issueMatchToken(matchId, "mallory"));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_a_participant");
  });

  it("returns moves in monotonically increasing ply order", async () => {
    const matchId = "ep-order";
    seedMoves(matchId, "alice", "bob", [3, 1, 2, 5, 4]);
    const r = await fetchMoves(matchId, "alice", issueMatchToken(matchId, "alice"));
    expect(r.status).toBe(200);
    expect(r.body.moves.map((m: any) => m.ply)).toEqual([1, 2, 3, 4, 5]);
    expect(r.body.hasMore).toBe(false);
    expect(r.body.nextAfterPly).toBeNull();
  });

  it("paginates with limit + afterPly cursor instead of silently truncating", async () => {
    const matchId = "ep-paginate";
    const plies = Array.from({ length: 12 }, (_, i) => i + 1);
    seedMoves(matchId, "alice", "bob", plies);
    const token = issueMatchToken(matchId, "alice");

    const page1 = await fetchMoves(matchId, "alice", token, { limit: "5" });
    expect(page1.status).toBe(200);
    expect(page1.body.moves.map((m: any) => m.ply)).toEqual([1, 2, 3, 4, 5]);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.nextAfterPly).toBe(5);

    const page2 = await fetchMoves(matchId, "alice", token, {
      limit: "5",
      afterPly: String(page1.body.nextAfterPly),
    });
    expect(page2.body.moves.map((m: any) => m.ply)).toEqual([6, 7, 8, 9, 10]);
    expect(page2.body.hasMore).toBe(true);
    expect(page2.body.nextAfterPly).toBe(10);

    const page3 = await fetchMoves(matchId, "alice", token, {
      limit: "5",
      afterPly: String(page2.body.nextAfterPly),
    });
    expect(page3.body.moves.map((m: any) => m.ply)).toEqual([11, 12]);
    expect(page3.body.hasMore).toBe(false);
    expect(page3.body.nextAfterPly).toBeNull();
  });
});
