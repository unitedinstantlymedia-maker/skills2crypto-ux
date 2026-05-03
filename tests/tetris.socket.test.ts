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

vi.mock("../server/oracle", () => ({
  settleMatch: async () => undefined,
  settleMatchOnChain: async () => undefined,
}));
vi.mock("../server/oracle.evm", () => ({}));
vi.mock("../server/oracle.tron", () => ({}));
vi.mock("../server/oracle.ton", () => ({}));

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
    sock.once(name, handler);
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

async function expectNoEvent(sock: ClientSocket, name: string, ms = 200): Promise<void> {
  sock.removeAllListeners(name);
  await flush();
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

const BOARD_W = 10;
const BOARD_H = 20;

function emptyBoard(): (string | null)[][] {
  return Array.from({ length: BOARD_H }, () => Array<string | null>(BOARD_W).fill(null));
}

function topFilledBoard(): (string | null)[][] {
  // Plausibly-game-over board: top 4 rows fully populated.
  const b = emptyBoard();
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < BOARD_W; x++) b[y][x] = "#888";
  }
  return b;
}

async function startMatch(): Promise<{
  matchId: string;
  a: ClientSocket;
  b: ClientSocket;
  aId: string;
  bId: string;
}> {
  const matchId = `test-tetris-${Math.random().toString(36).slice(2, 10)}`;
  const a = await connectClient();
  const b = await connectClient();
  const aId = `pa-${Math.random().toString(36).slice(2, 8)}`;
  const bId = `pb-${Math.random().toString(36).slice(2, 8)}`;

  a.emit("join-tetris-match", { matchId, playerId: aId });
  b.emit("join-tetris-match", { matchId, playerId: bId });

  const aStart = waitFor(a, "tetris-game-start", 2000);
  const bStart = waitFor(b, "tetris-game-start", 2000);
  markMatchFunded(matchId);
  await Promise.all([aStart, bStart]);
  return { matchId, a, b, aId, bId };
}

describe("tetris socket — anti-cheat L1", () => {
  it("legitimate monotonic state updates are relayed to the opponent", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      const recv = waitFor<{ score: number; lines: number }>(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard(),
        score: 100,
        lines: 1,
        level: 1,
        gameOver: false,
      });
      const got = await recv;
      expect(got.score).toBe(100);
      expect(got.lines).toBe(1);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-game-over identity comes from socket, not payload (client-supplied playerId is ignored)", async () => {
    const { matchId, a, b, aId, bId } = await startMatch();
    try {
      // Submit a plausibly-game-over snapshot so the top-out gate accepts.
      const ack = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: topFilledBoard(),
        score: 100,
        lines: 1,
        level: 1,
        gameOver: true,
      });
      await ack;

      // A claims B is the loser. Server must IGNORE that and treat A
      // (the sender) as the loser.
      const result = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        a,
        "game-result",
        1500
      );
      a.emit("tetris-game-over", { matchId, playerId: bId });
      const r = await result;
      expect(r.loserId).toBe(aId);
      expect(r.winnerId).toBe(bId);
      expect(r.reason).toBe("board_filled");
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("legitimate top-out at score=0 / lines=0 is accepted as a real loss", async () => {
    // A real Tetris top-out can happen before any line is ever cleared,
    // so the gate must rely on board-plausibility, not score/lines.
    const { matchId, a, b, aId, bId } = await startMatch();
    try {
      const ack = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: topFilledBoard(),
        score: 0,
        lines: 0,
        level: 1,
        gameOver: true,
      });
      await ack;

      const result = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        a,
        "game-result",
        1500
      );
      a.emit("tetris-game-over", { matchId });
      const r = await result;
      expect(r.loserId).toBe(aId);
      expect(r.winnerId).toBe(bId);
      expect(r.reason).toBe("board_filled");
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-game-over with a non-congested last board is rejected (no game-result)", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      // Establish gameplay with an empty-top board.
      const ack = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard(),
        score: 100,
        lines: 1,
        level: 1,
        gameOver: false,
      });
      await ack;

      // Now claim game-over even though the last accepted board is empty up top.
      const noResult = expectNoEvent(a, "game-result", 300);
      a.emit("tetris-game-over", { matchId });
      await noResult;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-game-over before any gameplay is rejected as a violation (no game-result emitted)", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      const noResult = expectNoEvent(a, "game-result", 300);
      a.emit("tetris-game-over", { matchId });
      await noResult;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-state with decreasing score is dropped (no opponent broadcast)", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      // Establish a baseline.
      const recv = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard(),
        score: 500,
        lines: 2,
        level: 1,
        gameOver: false,
      });
      await recv;

      // Now send a snapshot with a LOWER score — must be rejected.
      const noRelay = expectNoEvent(b, "opponent-tetris-state", 300);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard(),
        score: 400,
        lines: 2,
        level: 1,
        gameOver: false,
      });
      await noRelay;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-state with implausible score-rate is dropped", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      // First update establishes a 100-point baseline at t=now.
      const r1 = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard(),
        score: 100,
        lines: 1,
        level: 1,
        gameOver: false,
      });
      await r1;

      // Immediately claim 10,000,000 points (well above the 20k/sec
      // ceiling even with the 1-second floor).
      const noRelay = expectNoEvent(b, "opponent-tetris-state", 300);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard(),
        score: 10_000_000,
        lines: 2,
        level: 1,
        gameOver: false,
      });
      await noRelay;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-state claiming gameOver on a near-empty board is dropped", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      const noRelay = expectNoEvent(b, "opponent-tetris-state", 300);
      a.emit("tetris-state", {
        matchId,
        board: emptyBoard(), // top is empty → not plausible
        score: 100,
        lines: 1,
        level: 1,
        gameOver: true,
      });
      await noRelay;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("gameOver claim with a plausibly-full top of the board is accepted (relayed)", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      const recv = waitFor<{ gameOver: boolean }>(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", {
        matchId,
        board: topFilledBoard(),
        score: 1000,
        lines: 4,
        level: 1,
        gameOver: true,
      });
      const got = await recv;
      expect(got.gameOver).toBe(true);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-state with decreasing lines is dropped", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      const r1 = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", { matchId, board: emptyBoard(), score: 100, lines: 3, level: 1, gameOver: false });
      await r1;
      const noRelay = expectNoEvent(b, "opponent-tetris-state", 250);
      a.emit("tetris-state", { matchId, board: emptyBoard(), score: 100, lines: 2, level: 1, gameOver: false });
      await noRelay;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-state with decreasing level is dropped", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      const r1 = waitFor(b, "opponent-tetris-state", 1500);
      a.emit("tetris-state", { matchId, board: emptyBoard(), score: 100, lines: 10, level: 2, gameOver: false });
      await r1;
      const noRelay = expectNoEvent(b, "opponent-tetris-state", 250);
      a.emit("tetris-state", { matchId, board: emptyBoard(), score: 100, lines: 10, level: 1, gameOver: false });
      await noRelay;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-state with implausible level for current lines count is dropped", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      // 1 line cleared can support up to level 2 (floor(1/10)+2 = 2). Claiming level 9 must reject.
      const noRelay = expectNoEvent(b, "opponent-tetris-state", 250);
      a.emit("tetris-state", { matchId, board: emptyBoard(), score: 100, lines: 1, level: 9, gameOver: false });
      await noRelay;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("tetris-state with malformed board (wrong width / non-string cells) is dropped", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      // Wrong width.
      const wrongBoard = Array.from({ length: BOARD_H }, () => Array<string | null>(5).fill(null));
      let noRelay = expectNoEvent(b, "opponent-tetris-state", 200);
      a.emit("tetris-state", { matchId, board: wrongBoard as unknown, score: 0, lines: 0, level: 1, gameOver: false });
      await noRelay;

      // Cell that isn't null or a string.
      const badCellBoard = emptyBoard();
      (badCellBoard[10] as unknown[])[3] = { malicious: "object" };
      noRelay = expectNoEvent(b, "opponent-tetris-state", 200);
      a.emit("tetris-state", { matchId, board: badCellBoard as unknown, score: 0, lines: 0, level: 1, gameOver: false });
      await noRelay;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("violation counter decays on clean updates so two valid packets between bad ones never trip the threshold", async () => {
    const { matchId, a, b } = await startMatch();
    try {
      // Pattern: bad, good, bad, good, bad, good — 3 violations total
      // but each is followed by a clean update that decays the counter,
      // so we must NEVER cross the threshold.
      const noResult = expectNoEvent(a, "game-result", 600);
      let score = 0;
      for (let i = 0; i < 3; i++) {
        // Bad: score decreased.
        a.emit("tetris-state", { matchId, board: emptyBoard(), score: -1, lines: 0, level: 1, gameOver: false });
        await flush();
        // Good: legitimate increment.
        score += 100;
        const ok = waitFor(b, "opponent-tetris-state", 1000);
        a.emit("tetris-state", { matchId, board: emptyBoard(), score, lines: 0, level: 1, gameOver: false });
        await ok;
      }
      await noResult;
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it("after 3 violations the offender is auto-forfeited via game-result(reason='tetris_anticheat_violation')", async () => {
    const { matchId, a, b, aId, bId } = await startMatch();
    try {
      const result = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        b,
        "game-result",
        2000
      );

      // Three malformed payloads in a row → exceeds threshold.
      for (let i = 0; i < 3; i++) {
        a.emit("tetris-state", {
          matchId,
          board: emptyBoard(),
          score: -1, // negative → malformed_payload
          lines: 0,
          level: 1,
          gameOver: false,
        });
        await flush();
      }

      const r = await result;
      expect(r.loserId).toBe(aId);
      expect(r.winnerId).toBe(bId);
      expect(r.reason).toBe("tetris_anticheat_violation");
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});
