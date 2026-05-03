import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

// In-memory Upstash mock with TTL semantics, mirroring tests/socket-limits.test.ts
// so the real socket.io middleware in server/socket.ts can talk to a "Redis"
// during the integration test below.
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
    incr: async (key: string) => {
      const e = getEntry(key);
      const cur = e ? Number(e.value) : 0;
      const next = cur + 1;
      store.set(key, { value: String(next), expiresAt: e?.expiresAt });
      return next;
    },
    decr: async (key: string) => {
      const e = getEntry(key);
      const cur = e ? Number(e.value) : 0;
      const next = cur - 1;
      store.set(key, { value: String(next), expiresAt: e?.expiresAt });
      return next;
    },
    expire: async (key: string, sec: number) => {
      const e = store.get(key);
      if (!e) return 0;
      e.expiresAt = nowMs() + sec * 1000;
      return 1;
    },
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
    ping: async () => "PONG",
  },
}));

vi.mock("../server/db", () => ({
  db: { insert: () => ({ values: async () => undefined }) },
  pool: { end: async () => undefined },
}));
vi.mock("../server/oracle", () => ({
  settleMatch: async () => undefined,
  settleMatchOnChain: async () => undefined,
}));
vi.mock("../server/oracle.evm", () => ({}));
vi.mock("../server/oracle.tron", () => ({}));
vi.mock("../server/oracle.ton", () => ({}));

import { setupSocket } from "../server/socket";
import { io as ClientIO, type Socket as ClientSocket } from "socket.io-client";

let httpServer: http.Server;
let serverUrl: string;

beforeAll(async () => {
  process.env.SOCKET_MAX_PER_IP = "2";
  httpServer = http.createServer();
  setupSocket(httpServer, { isProd: false, allowedOrigins: [] });
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  delete process.env.SOCKET_MAX_PER_IP;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  store.clear();
});

function tryConnect(): Promise<{
  ok: boolean;
  sock: ClientSocket;
  err?: Error;
}> {
  return new Promise((resolve) => {
    const sock = ClientIO(serverUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      timeout: 1500,
    });
    const t = setTimeout(() => {
      resolve({ ok: false, sock, err: new Error("connect timeout") });
    }, 2500);
    sock.on("connect", () => {
      clearTimeout(t);
      resolve({ ok: true, sock });
    });
    sock.on("connect_error", (err: Error) => {
      clearTimeout(t);
      resolve({ ok: false, sock, err });
    });
  });
}

describe("Socket.io middleware — per-IP cap (integration)", () => {
  it("rejects the handshake once the cap is exceeded and re-opens a slot on disconnect", async () => {
    // SOCKET_MAX_PER_IP=2: two simultaneous connections allowed, third rejected.
    const a = await tryConnect();
    const b = await tryConnect();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const c = await tryConnect();
    expect(c.ok).toBe(false);
    expect(c.err?.message || "").toMatch(/too_many_connections/);

    // Disconnect one open socket and wait for the server-side disconnect
    // handler to release its slot.
    await new Promise<void>((resolve) => {
      a.sock.on("disconnect", () => resolve());
      a.sock.disconnect();
    });
    // Give the async releaseSocketSlot a tick to land in our redis mock.
    await new Promise((r) => setTimeout(r, 50));

    const d = await tryConnect();
    expect(d.ok).toBe(true);

    b.sock.disconnect();
    d.sock.disconnect();
  });
});
