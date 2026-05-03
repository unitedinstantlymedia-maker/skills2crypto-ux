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

import {
  setupSocket,
  markMatchFunded,
  __setCheckersBoardForTest,
} from "../server/socket";
import { io as ClientIO, type Socket as ClientSocket } from "socket.io-client";
import {
  deserializeBoard,
  initialBoard,
  serializeBoard,
} from "../shared/games/checkers";

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
  // Yield to the event loop so any in-flight socket.io frames are
  // delivered to handlers before we install or remove listeners.
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

async function expectNoEvent(sock: ClientSocket, name: string, ms = 250): Promise<void> {
  // Defensive: clear any stragglers before installing the rejection
  // probe so we only flag events that happen AFTER this point.
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

interface CheckersStartPayload {
  publicState: {
    board: string;
    currentTurn: "red" | "black";
    redTime: number;
    blackTime: number;
    pendingJumpAt: { row: number; col: number } | null;
  };
}

interface CheckersMovePayload {
  from: { row: number; col: number };
  to: { row: number; col: number };
  captures: { row: number; col: number }[];
  newTurn: "red" | "black";
  turnEnded: boolean;
  redTime: number;
  blackTime: number;
  pendingJumpAt: { row: number; col: number } | null;
  board: string;
}

async function startMatch(): Promise<{
  matchId: string;
  red: ClientSocket;
  black: ClientSocket;
  redId: string;
  blackId: string;
}> {
  const matchId = `test-checkers-${Math.random().toString(36).slice(2, 10)}`;
  const a = await connectClient();
  const b = await connectClient();

  const aId = `player-r-${Math.random().toString(36).slice(2, 8)}`;
  const bId = `player-b-${Math.random().toString(36).slice(2, 8)}`;

  const aColor = waitFor<{ color: "red" | "black" }>(a, "checkers-color-assigned");
  a.emit("join-checkers-match", { matchId, playerId: aId });
  const aAssigned = await aColor;

  const bColor = waitFor<{ color: "red" | "black" }>(b, "checkers-color-assigned");
  b.emit("join-checkers-match", { matchId, playerId: bId });
  const bAssigned = await bColor;

  const aStart = waitFor<CheckersStartPayload>(a, "checkers-game-start", 2000);
  const bStart = waitFor<CheckersStartPayload>(b, "checkers-game-start", 2000);
  markMatchFunded(matchId);
  await Promise.all([aStart, bStart]);

  // First-come-first-served: A is red, B is black.
  const red = aAssigned.color === "red" ? a : b;
  const black = aAssigned.color === "red" ? b : a;
  const redId = aAssigned.color === "red" ? aId : bId;
  const blackId = aAssigned.color === "red" ? bId : aId;
  // Reference unused so vi/test doesn't grumble.
  void bAssigned;

  return { matchId, red, black, redId, blackId };
}

describe("checkers socket integration — server authority", () => {
  it("the move broadcast carries the server's canonical 64-char board snapshot", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      const w = waitFor<CheckersMovePayload>(black, "opponent-checkers-move", 1500);
      red.emit("checkers-move", {
        matchId,
        from: { row: 5, col: 2 },
        to: { row: 4, col: 3 },
      });
      const echo = await w;
      // 64 cells, 12 reds, 12 blacks, no kings yet.
      expect(echo.board).toHaveLength(64);
      expect((echo.board.match(/r/g) ?? []).length).toBe(12);
      expect((echo.board.match(/b/g) ?? []).length).toBe(12);
      expect((echo.board.match(/[RB]/g) ?? []).length).toBe(0);
      // Origin empty, landing square is a red man.
      const b = deserializeBoard(echo.board);
      expect(b[5][2]).toBeNull();
      expect(b[4][3]).toEqual({ color: "red", type: "man" });
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("reconnect re-emits checkers-game-start with the authoritative public state", async () => {
    const { matchId, red, black, redId } = await startMatch();
    try {
      // Play one move so server state diverges from initial-board.
      const w1 = waitFor<CheckersMovePayload>(black, "opponent-checkers-move", 1500);
      red.emit("checkers-move", {
        matchId,
        from: { row: 5, col: 2 },
        to: { row: 4, col: 3 },
      });
      await w1;

      // Disconnect red, then reconnect with the same playerId. The
      // server's join-checkers-match reconnect branch must re-emit
      // checkers-game-start with the CURRENT publicState.
      red.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      const newRed = await connectClient();
      const colorPromise = waitFor<{ color: "red" | "black" }>(
        newRed,
        "checkers-color-assigned",
        2000,
      );
      const startPromise = waitFor<CheckersStartPayload>(
        newRed,
        "checkers-game-start",
        2000,
      );
      newRed.emit("join-checkers-match", { matchId, playerId: redId });
      const assigned = await colorPromise;
      const start = await startPromise;
      expect(assigned.color).toBe("red");
      expect(start.publicState.currentTurn).toBe("black");
      // Board reflects red's move (origin empty, landing filled).
      const b = deserializeBoard(start.publicState.board);
      expect(b[5][2]).toBeNull();
      expect(b[4][3]).toEqual({ color: "red", type: "man" });
      // Red's clock was ticked when red moved. Black is now the
      // active side, so checkersPublicState bleeds black's clock by
      // the elapsed time since the turn started. Both clocks must be
      // ≤ 600000 and within the budget.
      expect(start.publicState.redTime).toBeLessThan(600000);
      expect(start.publicState.redTime).toBeGreaterThan(599000);
      expect(start.publicState.blackTime).toBeLessThanOrEqual(600000);
      expect(start.publicState.blackTime).toBeGreaterThan(599000);
      expect(start.publicState.pendingJumpAt).toBeNull();

      newRed.disconnect();
    } finally {
      black.disconnect();
    }
  });

  it("rejects a checkers-move with illegal coordinates and broadcasts nothing", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      const noRed = expectNoEvent(red, "opponent-checkers-move", 300);
      const noBlack = expectNoEvent(black, "opponent-checkers-move", 300);
      // Red tries to move a black piece.
      red.emit("checkers-move", {
        matchId,
        from: { row: 2, col: 1 },
        to: { row: 3, col: 2 },
      });
      await Promise.all([noRed, noBlack]);
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("rejects an out-of-turn move", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      const noRed = expectNoEvent(red, "opponent-checkers-move", 300);
      const noBlack = expectNoEvent(black, "opponent-checkers-move", 300);
      // Red moves first by rule; black tries to move first.
      black.emit("checkers-move", {
        matchId,
        from: { row: 2, col: 1 },
        to: { row: 3, col: 2 },
      });
      await Promise.all([noRed, noBlack]);
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("accepts a legal red move and broadcasts the canonical server board to both sides", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      const wRed = waitFor<CheckersMovePayload>(red, "opponent-checkers-move", 1500);
      const wBlack = waitFor<CheckersMovePayload>(black, "opponent-checkers-move", 1500);
      red.emit("checkers-move", {
        matchId,
        from: { row: 5, col: 0 },
        to: { row: 4, col: 1 },
      });
      const [pr, pb] = await Promise.all([wRed, wBlack]);
      expect(pr.board).toBe(pb.board);
      expect(pr.newTurn).toBe("black");
      expect(pr.turnEnded).toBe(true);
      expect(pr.pendingJumpAt).toBeNull();
      const board = deserializeBoard(pr.board);
      expect(board[5][0]).toBeNull();
      expect(board[4][1]).toEqual({ color: "red", type: "man" });
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("forced-capture: rejects a non-jump simple move when a jump is available", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      // Set up a position where red has a forced jump.
      // Red 5,0 → forced jump 4,1 (black) → 3,2.
      // Achievable from initial position by:
      // 1. Red 5,0 → 4,1 (this advance) — already used; build via a sequence.
      // Instead: do a quick sequence of legal moves to create a jump.

      const send = async (
        from: { row: number; col: number },
        to: { row: number; col: number },
        as: ClientSocket,
        listener: ClientSocket,
      ) => {
        // Wait on BOTH sockets so any in-flight broadcast is fully
        // drained from the previous round before we install the next
        // listener. Otherwise a delayed frame on the listener side can
        // be picked up as if it were the response to this emit.
        const wL = waitFor<CheckersMovePayload>(listener, "opponent-checkers-move", 1500);
        const wS = waitFor<CheckersMovePayload>(as, "opponent-checkers-move", 1500);
        as.emit("checkers-move", { matchId, from, to });
        const [r] = await Promise.all([wL, wS]);
        return r;
      };

      // Red 5,2 → 4,3
      await send({ row: 5, col: 2 }, { row: 4, col: 3 }, red, black);
      // Black 2,1 → 3,2 (positions a black piece adjacent to red 4,3)
      await send({ row: 2, col: 1 }, { row: 3, col: 2 }, black, red);

      // Now red's piece at 4,3 has a jump over 3,2 → 2,1.
      // Try to play a non-jump red move (e.g., 5,4 → 4,3 is occupied; use 5,6 → 4,5).
      const noRed = expectNoEvent(red, "opponent-checkers-move", 300);
      const noBlack = expectNoEvent(black, "opponent-checkers-move", 300);
      red.emit("checkers-move", {
        matchId,
        from: { row: 5, col: 6 },
        to: { row: 4, col: 5 },
      });
      await Promise.all([noRed, noBlack]);

      // The legal jump must succeed.
      const ok = await send({ row: 4, col: 3 }, { row: 2, col: 1 }, red, black);
      expect(ok.captures).toEqual([{ row: 3, col: 2 }]);
      expect(ok.turnEnded).toBe(true);
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("a single jump with no further jumps available ends the turn (pendingJumpAt=null)", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      const send = async (
        from: { row: number; col: number },
        to: { row: number; col: number },
        as: ClientSocket,
        listener: ClientSocket,
      ) => {
        const wL = waitFor<CheckersMovePayload>(listener, "opponent-checkers-move", 1500);
        const wS = waitFor<CheckersMovePayload>(as, "opponent-checkers-move", 1500);
        as.emit("checkers-move", { matchId, from, to });
        const [r] = await Promise.all([wL, wS]);
        return r;
      };

      // Set up a position with exactly ONE red jump available, no
      // continuation possible afterwards.
      // Step 1: red 5,2 → 4,3 (simple, legal — no jumps from initial).
      await send({ row: 5, col: 2 }, { row: 4, col: 3 }, red, black);
      // Step 2: black 2,1 → 3,2 (puts black adjacent to red 4,3 so red
      // has a forced jump 4,3 over 3,2 → 2,1 next turn).
      await send({ row: 2, col: 1 }, { row: 3, col: 2 }, black, red);
      // Step 3: red 4,3 → 2,1 (the jump). No further jumps from (2,1)
      // because (1,0) and (1,2) are empty.
      const echo = await send({ row: 4, col: 3 }, { row: 2, col: 1 }, red, black);
      expect(echo.captures).toEqual([{ row: 3, col: 2 }]);
      expect(echo.turnEnded).toBe(true);
      expect(echo.pendingJumpAt).toBeNull();
      expect(echo.newTurn).toBe("black");
      // Server's serialised board should reflect the capture.
      const board = deserializeBoard(echo.board);
      expect(board[2][1]).toEqual({ color: "red", type: "man" });
      expect(board[3][2]).toBeNull();
      expect(board[4][3]).toBeNull();
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("ignores a forged checkers-game-end payload (event no longer registered)", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      // No game-result should be emitted.
      const noResult = expectNoEvent(red, "game-result", 400);
      const noResultB = expectNoEvent(black, "game-result", 400);
      red.emit("checkers-game-end", {
        matchId,
        winner: "red",
        playerId: "anyone",
      });
      await Promise.all([noResult, noResultB]);
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("natural terminal: a capture that empties the opponent settles game-result with no_pieces", async () => {
    const { matchId, red, black, redId, blackId } = await startMatch();
    try {
      // Seed a near-terminal position: one red man at (3,4) with a
      // jump over the only black piece at (2,3) to (1,2). After the
      // jump, black has zero pieces → terminal reason 'no_pieces'.
      const board = Array.from({ length: 8 }, () =>
        Array.from({ length: 8 }, () => null),
      ) as ReturnType<typeof initialBoard>;
      board[3][4] = { color: "red", type: "man" };
      board[2][3] = { color: "black", type: "man" };
      const seeded = __setCheckersBoardForTest(matchId, board, "red");
      expect(seeded).toBe(true);

      const wResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        red,
        "game-result",
        2000,
      );
      const bResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        black,
        "game-result",
        2000,
      );
      const wCount = countEvents(red, "game-result", 800);
      const bCount = countEvents(black, "game-result", 800);

      red.emit("checkers-move", {
        matchId,
        from: { row: 3, col: 4 },
        to: { row: 1, col: 2 },
      });

      const [rp, bp, wn, bn] = await Promise.all([wResult, bResult, wCount, bCount]);
      expect(rp.reason).toBe("no_pieces");
      expect(bp.reason).toBe("no_pieces");
      expect(rp.winnerId).toBe(redId);
      expect(rp.loserId).toBe(blackId);
      // Exactly one game-result per side — no duplicate settlement.
      expect(wn).toBe(1);
      expect(bn).toBe(1);
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("rejects a checkers-resign with the wrong color", async () => {
    const { matchId, red, black } = await startMatch();
    try {
      const noResult = expectNoEvent(red, "game-result", 300);
      const noResultB = expectNoEvent(black, "game-result", 300);
      // Red claims to resign as black — server must reject.
      red.emit("checkers-resign", { matchId, color: "black" });
      await Promise.all([noResult, noResultB]);
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });

  it("checkers-resign by the correct color emits exactly one game-result", async () => {
    const { matchId, red, black, redId, blackId } = await startMatch();
    try {
      const wResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        red,
        "game-result",
        2000,
      );
      const bResult = waitFor<{ winnerId: string; loserId: string; reason: string }>(
        black,
        "game-result",
        2000,
      );
      const wCount = countEvents(red, "game-result", 800);
      const bCount = countEvents(black, "game-result", 800);

      red.emit("checkers-resign", { matchId, color: "red" });

      const [rp, bp, wn, bn] = await Promise.all([wResult, bResult, wCount, bCount]);
      expect(rp.reason).toBe("resignation");
      expect(bp.reason).toBe("resignation");
      expect(rp.winnerId).toBe(blackId);
      expect(rp.loserId).toBe(redId);
      expect(wn).toBe(1);
      expect(bn).toBe(1);
    } finally {
      red.disconnect();
      black.disconnect();
    }
  });
});
