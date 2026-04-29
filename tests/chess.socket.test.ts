// Server-level integration tests for the server-authoritative chess
// pipeline (Task #40). These tests spin up the real Socket.IO server
// from `setupSocket`, connect two `socket.io-client` instances, and
// drive them through the same wire protocol the browser uses.
//
// `./db` and `./redis` are stubbed at the module-loader level so the
// tests don't need a Postgres or an Upstash instance:
//   - `db.insert(matches).values(...)` becomes a no-op.
//   - `redis.set` enforces NX semantics in-memory (so `storeGameResult`
//     can still detect dupes via its dedup lock).
//   - `redis.hgetall` returns `{}`, which short-circuits the DB-write
//     branch in `storeGameResult` (it requires `stake/asset/addr*`),
//     keeping the test focused on the socket flow rather than payments.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

vi.mock("../server/db", () => ({
  db: {
    insert: () => ({ values: async () => undefined }),
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

// Some peripheral modules pulled in by ./socket talk to chains on
// import; stub them so the tests don't dial out to BSC / ETH / Tron / TON.
vi.mock("../server/oracle", () => ({
  settleMatch: async () => undefined,
  settleMatchOnChain: async () => undefined,
}));
vi.mock("../server/oracle.evm", () => ({}));
vi.mock("../server/oracle.tron", () => ({}));
vi.mock("../server/oracle.ton", () => ({}));

// Imports below MUST come after the vi.mock() calls so vitest hoists
// the mocks in front of the module graph.
import { setupSocket, markMatchFunded } from "../server/socket";
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

// Wait for either the next event of `name`, or fail after `ms`. Returns
// the payload (or `undefined` if the test is verifying NON-occurrence).
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

// Asserts that NO event of `name` arrives within `ms`.
function expectNoEvent(sock: ClientSocket, name: string, ms = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (payload: unknown) => {
      sock.off(name, handler);
      reject(new Error(`unexpected '${name}' received: ${JSON.stringify(payload)}`));
    };
    sock.on(name, handler);
    setTimeout(() => {
      sock.off(name, handler);
      resolve();
    }, ms);
  });
}

// Counts how many `name` events arrive within `ms` (used to prove the
// "exactly once" terminal-broadcast property).
function countEvents(sock: ClientSocket, name: string, ms = 600): Promise<number> {
  return new Promise((resolve) => {
    let n = 0;
    const handler = () => {
      n += 1;
    };
    sock.on(name, handler);
    setTimeout(() => {
      sock.off(name, handler);
      resolve(n);
    }, ms);
  });
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
});

// Helper: connect two clients, join a fresh match, mark funded so the
// server emits the authoritative `game-start`, and resolve once both
// sides know their colour and have the start payload.
async function startMatch(): Promise<{
  matchId: string;
  white: ClientSocket;
  black: ClientSocket;
  whiteId: string;
  blackId: string;
}> {
  const matchId = `test-match-${Math.random().toString(36).slice(2, 10)}`;
  const a = await connectClient();
  const b = await connectClient();

  // join-match assigns colors first-join-wins (white, then black). To
  // avoid a race we serialise the joins.
  const whiteId = `player-w-${Math.random().toString(36).slice(2, 8)}`;
  const blackId = `player-b-${Math.random().toString(36).slice(2, 8)}`;

  const aColor = waitFor<{ color: "white" | "black" }>(a, "color-assigned");
  a.emit("join-match", { matchId, playerId: whiteId });
  await aColor;

  const bColor = waitFor<{ color: "white" | "black" }>(b, "color-assigned");
  b.emit("join-match", { matchId, playerId: blackId });
  await bColor;

  // Both rooms know about both players now — release the funding gate.
  const aStart = waitFor(a, "game-start", 2000);
  const bStart = waitFor(b, "game-start", 2000);
  markMatchFunded(matchId);
  await Promise.all([aStart, bStart]);

  return { matchId, white: a, black: b, whiteId, blackId };
}

describe("chess socket integration — server authority", () => {
  it("rejects an illegal chess-move with no broadcast and no clock corruption", async () => {
    const { matchId, white, black } = await startMatch();
    try {
      // White attempts a piece-illegal move (king to e7). The server
      // must NOT broadcast `opponent-move` to either client.
      const noWhite = expectNoEvent(white, "opponent-move", 300);
      const noBlack = expectNoEvent(black, "opponent-move", 300);
      white.emit("chess-move", { matchId, from: "e1", to: "e7" });
      await Promise.all([noWhite, noBlack]);

      // Sanity: a subsequent LEGAL move from white still goes through
      // (proves the rejection was clean, not state-poisoning).
      const legal = waitFor<{ fen: string; san: string }>(black, "opponent-move", 1500);
      white.emit("chess-move", { matchId, from: "e2", to: "e4" });
      const payload = await legal;
      expect(payload.san).toBe("e4");
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });

  it("rejects an out-of-turn move (black trying to move first)", async () => {
    const { matchId, white, black } = await startMatch();
    try {
      const noWhite = expectNoEvent(white, "opponent-move", 300);
      const noBlack = expectNoEvent(black, "opponent-move", 300);
      black.emit("chess-move", { matchId, from: "e7", to: "e5" });
      await Promise.all([noWhite, noBlack]);
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });

  it("ignores client-supplied FEN/SAN/clock fields and broadcasts only server truth", async () => {
    const { matchId, white, black } = await startMatch();
    try {
      const wait = waitFor<{
        fen: string;
        san: string;
        whiteTime: number;
        blackTime: number;
      }>(black, "opponent-move", 1500);
      // Sneak in spoofed values — the server must ignore all of them.
      white.emit("chess-move", {
        matchId,
        from: "e2",
        to: "e4",
        promotion: "q",
        fen: "fake/forged/fen",
        san: "FORGED!!",
        whiteTime: 9_999_999,
        blackTime: 1,
      } as unknown as { matchId: string; from: string; to: string });
      const payload = await wait;
      // Server-computed SAN must be the real "e4", not the forged value.
      expect(payload.san).toBe("e4");
      // Server-computed FEN must reflect the real position after 1.e4.
      expect(payload.fen).toContain(" b ");
      expect(payload.fen).not.toContain("forged");
      // Clocks must be near INITIAL_TIME_MS minus a small drain — not
      // the forged 9.99M ms.
      expect(payload.whiteTime).toBeLessThanOrEqual(30 * 60 * 1000);
      expect(payload.whiteTime).toBeGreaterThan(29 * 60 * 1000);
      expect(payload.blackTime).toBeLessThanOrEqual(30 * 60 * 1000);
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });

  it("detects checkmate (Fool's mate) server-side and emits exactly one game-result with the right winner", async () => {
    const { matchId, white, black, whiteId, blackId } = await startMatch();
    try {
      // Drive Fool's mate move-by-move, awaiting each server echo so
      // chess.js stays in lockstep with the client-side intent stream.
      const send = async (
        from: string,
        to: string,
        as: ClientSocket,
        listener: ClientSocket
      ) => {
        const w = waitFor<{ san: string }>(listener, "opponent-move", 1500);
        as.emit("chess-move", { matchId, from, to });
        return w;
      };

      await send("f2", "f3", white, black);
      await send("e7", "e5", black, white);
      await send("g2", "g4", white, black);

      // The mating move is the last chess-move; both clients should
      // receive exactly ONE `game-result` (broadcast once per room).
      const wResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        white,
        "game-result",
        2000
      );
      const bResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        black,
        "game-result",
        2000
      );
      // Also count to assert exactly-one delivery per client.
      const wCount = countEvents(white, "game-result", 800);
      const bCount = countEvents(black, "game-result", 800);

      black.emit("chess-move", { matchId, from: "d8", to: "h4" });

      const [whitePayload, blackPayload, wN, bN] = await Promise.all([
        wResult,
        bResult,
        wCount,
        bCount,
      ]);

      expect(whitePayload.reason).toBe("checkmate");
      expect(blackPayload.reason).toBe("checkmate");
      // Black mated white → black is the winner, white the loser.
      expect(whitePayload.winnerId).toBe(blackId);
      expect(whitePayload.loserId).toBe(whiteId);
      expect(blackPayload.winnerId).toBe(blackId);
      expect(blackPayload.loserId).toBe(whiteId);
      // Exactly-once delivery to both clients.
      expect(wN).toBe(1);
      expect(bN).toBe(1);
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });

  it("settles via chess-resign (winner is the opponent) — natural settle path", async () => {
    const { matchId, white, black, whiteId, blackId } = await startMatch();
    try {
      const wResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        white,
        "game-result",
        2000
      );
      const bResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        black,
        "game-result",
        2000
      );
      const wCount = countEvents(white, "game-result", 800);
      const bCount = countEvents(black, "game-result", 800);

      // White resigns. Server's resign handler authenticates the sender
      // by socket → playerId mapping, computes opponent-wins, and goes
      // through the same `storeGameResult` path as natural terminals.
      white.emit("chess-resign", { matchId, color: "white" });

      const [w, b, wN, bN] = await Promise.all([wResult, bResult, wCount, bCount]);
      expect(w.reason).toBe("resignation");
      expect(b.reason).toBe("resignation");
      expect(w.winnerId).toBe(blackId);
      expect(w.loserId).toBe(whiteId);
      expect(b.winnerId).toBe(blackId);
      expect(b.loserId).toBe(whiteId);
      expect(wN).toBe(1);
      expect(bN).toBe(1);
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });

  it("ignores any forged `game-end` event (handler removed)", async () => {
    const { matchId, white, black, whiteId } = await startMatch();
    try {
      // Pre-Task-40 the server trusted whatever the client claimed in
      // `game-end` and would broadcast a winning result. The handler is
      // gone now — sending the event must produce nothing.
      const noWhite = expectNoEvent(white, "game-result", 400);
      const noBlack = expectNoEvent(black, "game-result", 400);
      const noMatchEnded = expectNoEvent(white, "match-ended", 400);
      white.emit("game-end", {
        matchId,
        result: "win",
        winner: "white",
        winnerId: whiteId,
        loserId: "anyone",
      });
      await Promise.all([noWhite, noBlack, noMatchEnded]);
    } finally {
      white.disconnect();
      black.disconnect();
    }
  });
});
