import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

// In-memory Upstash mock with TTL semantics so the cooldown TTL
// actually expires during the test.
const store = new Map<string, { value: string; expiresAt?: number }>();
function nowMs() {
  return Date.now();
}
function getEntry(key: string) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.expiresAt !== undefined && e.expiresAt <= nowMs()) {
    store.delete(key);
    return undefined;
  }
  return e;
}
vi.mock("../server/redis", () => ({
  redis: {
    incr: async () => 1,
    decr: async () => 0,
    expire: async () => 1,
    set: async (
      key: string,
      value: string,
      opts?: { ex?: number; px?: number; nx?: boolean }
    ) => {
      if (opts?.nx && getEntry(key)) return null;
      const expiresAt =
        opts?.px !== undefined
          ? nowMs() + opts.px
          : opts?.ex !== undefined
            ? nowMs() + opts.ex * 1000
            : undefined;
      store.set(key, { value: String(value), expiresAt });
      return "OK";
    },
    get: async (key: string) => getEntry(key)?.value ?? null,
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    pttl: async (key: string) => {
      const e = getEntry(key);
      if (!e) return -2;
      if (e.expiresAt === undefined) return -1;
      return Math.max(0, e.expiresAt - nowMs());
    },
    hgetall: async () => ({}),
    hset: async () => 1,
    hget: async () => null,
    rpush: async () => 1,
    sadd: async () => 1,
    ping: async () => "PONG",
  },
}));

// Stub heavy / chain-touching deps so /api/find-match reaches the
// cooldown branch without requiring real chains, oracle, DB, etc.
vi.mock("../server/db", () => ({
  db: { insert: () => ({ values: async () => undefined }) },
  pool: { end: async () => undefined },
}));
vi.mock("../server/matchmaking/redisMatchmaking", () => ({
  findOrCreateMatch: async () => ({ status: "queued" }),
}));
vi.mock("../server/security/systemAddresses", () => ({
  checkSystemAddress: async () => ({ ok: true }),
  getSystemAddressesStatus: () => ({}),
}));
vi.mock("../server/security/oraclePause", () => ({
  isOraclePaused: async () => ({ paused: false }),
  setPause: async () => undefined,
  getPauseStatus: async () => ({}),
}));
vi.mock("../server/oracle", () => ({
  settleMatch: async () => undefined,
  settleMatchOnChain: async () => undefined,
}));
vi.mock("../server/oracle.evm", () => ({}));
vi.mock("../server/oracle.tron", () => ({}));
vi.mock("../server/oracle.ton", () => ({}));

import { registerRoutes } from "../server/routes";
import { setMatchmakingCooldown } from "../server/security/socketLimits";

let app: express.Express;
let httpServer: http.Server;
let baseUrl: string;

async function postJson(path: string, body: unknown): Promise<{
  status: number;
  body: any;
}> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  process.env.MATCHMAKING_COOLDOWN_MS = "200";
  app = express();
  app.use(express.json());
  httpServer = http.createServer(app);
  const fakeIo = { to: () => ({ emit: () => undefined }) } as unknown as
    Parameters<typeof registerRoutes>[2];
  await registerRoutes(httpServer, app, fakeIo);
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  delete process.env.MATCHMAKING_COOLDOWN_MS;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  store.clear();
});

describe("/api/find-match — matchmaking cooldown", () => {
  // Use an EVM-shaped wallet so the per-asset wallet validator the
  // route runs after the cooldown gate doesn't 400 us first.
  const wallet = "0x" + "a".repeat(40);

  it("returns 429 with retryAfterSec while the wallet's cooldown is active", async () => {
    await setMatchmakingCooldown(wallet);

    const res = await postJson("/api/find-match", {
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-1",
      walletAddress: wallet,
    });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("matchmaking_cooldown");
    expect(res.body.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    expect(typeof res.body.message).toBe("string");
  });

  it("allows the same wallet through after the cooldown TTL expires", async () => {
    await setMatchmakingCooldown(wallet);
    // Wait for the 200ms TTL to elapse with a small safety margin.
    await new Promise((r) => setTimeout(r, 260));

    const res = await postJson("/api/find-match", {
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-2",
      walletAddress: wallet,
    });

    // No cooldown → request reaches our stubbed findOrCreateMatch and
    // returns 200 with the queued status.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
  });

  it("does not block a wallet that has no prior cooldown stamp", async () => {
    const fresh = "0x" + "b".repeat(40);
    const res = await postJson("/api/find-match", {
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-3",
      walletAddress: fresh,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
  });
});
