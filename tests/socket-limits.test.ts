import { describe, expect, it, beforeEach, vi } from "vitest";

// In-memory Upstash mock with TTL support so the cooldown / cap helpers
// can be exercised end-to-end without touching real Redis.
const store = new Map<string, { value: string; expiresAt?: number }>();
function nowMs() {
  return Date.now();
}
function getEntry(key: string): { value: string; expiresAt?: number } | undefined {
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
    incr: async (key: string): Promise<number> => {
      const e = getEntry(key);
      const cur = e ? Number(e.value) : 0;
      const next = cur + 1;
      store.set(key, { value: String(next), expiresAt: e?.expiresAt });
      return next;
    },
    decr: async (key: string): Promise<number> => {
      const e = getEntry(key);
      const cur = e ? Number(e.value) : 0;
      const next = cur - 1;
      store.set(key, { value: String(next), expiresAt: e?.expiresAt });
      return next;
    },
    expire: async (key: string, sec: number): Promise<number> => {
      const e = store.get(key);
      if (!e) return 0;
      e.expiresAt = nowMs() + sec * 1000;
      return 1;
    },
    set: async (
      key: string,
      value: string,
      opts?: { ex?: number; px?: number; nx?: boolean }
    ): Promise<string | null> => {
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
    get: async (key: string): Promise<string | null> => {
      return getEntry(key)?.value ?? null;
    },
    del: async (key: string): Promise<number> => (store.delete(key) ? 1 : 0),
    pttl: async (key: string): Promise<number> => {
      const e = getEntry(key);
      if (!e) return -2;
      if (e.expiresAt === undefined) return -1;
      return Math.max(0, e.expiresAt - nowMs());
    },
    ping: async (): Promise<string> => "PONG",
  },
}));

import {
  acquireSocketSlot,
  releaseSocketSlot,
  setMatchmakingCooldown,
  getMatchmakingCooldownRemainingMs,
  getSocketMaxPerIp,
  getMatchmakingCooldownMs,
} from "../server/security/socketLimits";

beforeEach(() => {
  store.clear();
  delete process.env.SOCKET_MAX_PER_IP;
  delete process.env.MATCHMAKING_COOLDOWN_MS;
});

describe("socketLimits — per-IP cap", () => {
  it("allows up to the configured cap and rejects the (cap+1)th connection", async () => {
    process.env.SOCKET_MAX_PER_IP = "3";
    const ip = "1.2.3.4";

    for (let i = 1; i <= 3; i++) {
      const r = await acquireSocketSlot(ip);
      expect(r.ok).toBe(true);
      expect(r.current).toBe(i);
      expect(r.max).toBe(3);
    }

    const reject = await acquireSocketSlot(ip);
    expect(reject.ok).toBe(false);
    expect(reject.max).toBe(3);
  });

  it("rejected connections do NOT permanently consume a slot (rollback)", async () => {
    process.env.SOCKET_MAX_PER_IP = "2";
    const ip = "5.6.7.8";

    expect((await acquireSocketSlot(ip)).ok).toBe(true);
    expect((await acquireSocketSlot(ip)).ok).toBe(true);
    // Three rejections in a row.
    expect((await acquireSocketSlot(ip)).ok).toBe(false);
    expect((await acquireSocketSlot(ip)).ok).toBe(false);
    expect((await acquireSocketSlot(ip)).ok).toBe(false);

    // Release one — the next acquire should succeed.
    await releaseSocketSlot(ip);
    const r = await acquireSocketSlot(ip);
    expect(r.ok).toBe(true);
    expect(r.current).toBe(2);
  });

  it("releaseSocketSlot frees a slot so the same IP can reconnect", async () => {
    process.env.SOCKET_MAX_PER_IP = "1";
    const ip = "9.9.9.9";

    expect((await acquireSocketSlot(ip)).ok).toBe(true);
    expect((await acquireSocketSlot(ip)).ok).toBe(false);

    await releaseSocketSlot(ip);
    expect((await acquireSocketSlot(ip)).ok).toBe(true);
  });

  it("missing-IP fallback: empty IP is always allowed", async () => {
    process.env.SOCKET_MAX_PER_IP = "1";
    for (let i = 0; i < 5; i++) {
      const r = await acquireSocketSlot("");
      expect(r.ok).toBe(true);
    }
  });

  it("cap counters are isolated per IP", async () => {
    process.env.SOCKET_MAX_PER_IP = "2";
    expect((await acquireSocketSlot("a.a.a.a")).ok).toBe(true);
    expect((await acquireSocketSlot("a.a.a.a")).ok).toBe(true);
    // a.a.a.a is full, but b.b.b.b is fresh.
    expect((await acquireSocketSlot("a.a.a.a")).ok).toBe(false);
    expect((await acquireSocketSlot("b.b.b.b")).ok).toBe(true);
    expect((await acquireSocketSlot("b.b.b.b")).ok).toBe(true);
    expect((await acquireSocketSlot("b.b.b.b")).ok).toBe(false);
  });

  it("default cap is 8 when env var unset", () => {
    expect(getSocketMaxPerIp()).toBe(8);
  });

  it("invalid env var falls back to default", () => {
    process.env.SOCKET_MAX_PER_IP = "garbage";
    expect(getSocketMaxPerIp()).toBe(8);
    process.env.SOCKET_MAX_PER_IP = "0";
    expect(getSocketMaxPerIp()).toBe(8);
    process.env.SOCKET_MAX_PER_IP = "-5";
    expect(getSocketMaxPerIp()).toBe(8);
  });
});

describe("socketLimits — matchmaking cooldown", () => {
  it("setMatchmakingCooldown sets a TTL the cooldown reader returns", async () => {
    process.env.MATCHMAKING_COOLDOWN_MS = "5000";
    const wallet = "0xabcDEF";

    expect(await getMatchmakingCooldownRemainingMs(wallet)).toBe(0);
    await setMatchmakingCooldown(wallet);
    const ms = await getMatchmakingCooldownRemainingMs(wallet);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("cooldown is case-insensitive — wallet checks match wallet writes", async () => {
    process.env.MATCHMAKING_COOLDOWN_MS = "5000";
    await setMatchmakingCooldown("0xABCDEF");
    expect(await getMatchmakingCooldownRemainingMs("0xabcdef")).toBeGreaterThan(0);
  });

  it("cooldown expires after the configured TTL", async () => {
    process.env.MATCHMAKING_COOLDOWN_MS = "30";
    await setMatchmakingCooldown("0xshort");
    expect(await getMatchmakingCooldownRemainingMs("0xshort")).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(await getMatchmakingCooldownRemainingMs("0xshort")).toBe(0);
  });

  it("default cooldown is 10000ms when env var unset", () => {
    expect(getMatchmakingCooldownMs()).toBe(10_000);
  });

  it("zero cooldown env var disables the cooldown entirely", async () => {
    process.env.MATCHMAKING_COOLDOWN_MS = "0";
    await setMatchmakingCooldown("0xnozero");
    expect(await getMatchmakingCooldownRemainingMs("0xnozero")).toBe(0);
  });

  it("legitimate single-wallet flow without prior match has no cooldown", async () => {
    process.env.MATCHMAKING_COOLDOWN_MS = "10000";
    expect(await getMatchmakingCooldownRemainingMs("0xfreshUser")).toBe(0);
  });

  it("cooldowns are isolated per wallet", async () => {
    process.env.MATCHMAKING_COOLDOWN_MS = "5000";
    await setMatchmakingCooldown("0xWalletA");
    expect(await getMatchmakingCooldownRemainingMs("0xWalletA")).toBeGreaterThan(0);
    expect(await getMatchmakingCooldownRemainingMs("0xWalletB")).toBe(0);
  });
});
