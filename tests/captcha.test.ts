import { describe, expect, it, beforeEach, vi } from "vitest";

// In-memory Upstash mock with TTL semantics — same shape as
// tests/socket-limits.test.ts so the captcha helpers can exercise
// generation, verification, fail-counter, and cooldown end-to-end
// without touching real Redis.
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
  generateChallenge,
  verifyChallenge,
  isWalletCaptchaVerified,
  getCaptchaCooldownRemainingMs,
  checkDepositCaptcha,
  checkDepositCaptchaForWallets,
  __testInternals,
} from "../server/security/captcha";

const wallet = "0x" + "a".repeat(40);

beforeEach(() => {
  store.clear();
  delete process.env.CAPTCHA_FAIL_THRESHOLD;
  delete process.env.CAPTCHA_FAIL_COOLDOWN_MS;
  delete process.env.CAPTCHA_TOLERANCE_PX;
});

// Build a plausible-looking human drag: many samples, varied per-step
// velocity (we add small jitter), spanning > 200 ms.
function humanSamples(targetX: number): { t: number; x: number }[] {
  const samples: { t: number; x: number }[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const fraction = i / steps;
    // ease-out + jitter so per-step delta-x changes between samples.
    const eased = 1 - Math.pow(1 - fraction, 2);
    const jitter = Math.sin(i * 1.7) * 0.4;
    samples.push({
      t: i * 22, // total ~264 ms
      x: eased * targetX + jitter,
    });
  }
  return samples;
}

describe("captcha challenge generation", () => {
  it("is deterministic for the same seed", async () => {
    const a = await generateChallenge({ wallet, seed: 42 });
    store.clear();
    const b = await generateChallenge({ wallet, seed: 42 });
    expect(a.backgroundImageDataUrl).toBe(b.backgroundImageDataUrl);
    expect(a.pieceImageDataUrl).toBe(b.pieceImageDataUrl);
    expect(a.pieceY).toBe(b.pieceY);
  });

  it("differs for different seeds", async () => {
    const a = await generateChallenge({ wallet, seed: 1 });
    store.clear();
    const b = await generateChallenge({ wallet, seed: 2 });
    expect(a.backgroundImageDataUrl).not.toBe(b.backgroundImageDataUrl);
  });

  it("returns track + piece dimensions the client needs", async () => {
    const c = await generateChallenge({ wallet, seed: 7 });
    expect(c.trackWidth).toBeGreaterThan(0);
    expect(c.trackHeight).toBeGreaterThan(0);
    expect(c.pieceSize).toBeGreaterThan(0);
    expect(c.pieceY).toBeGreaterThanOrEqual(0);
    expect(c.pieceY).toBeLessThanOrEqual(c.trackHeight - c.pieceSize);
    expect(c.backgroundImageDataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("payload stays well under 80 KB", async () => {
    const c = await generateChallenge({ wallet, seed: 99 });
    const total = c.backgroundImageDataUrl.length + c.pieceImageDataUrl.length;
    expect(total).toBeLessThan(80 * 1024);
  });
});

describe("captcha verification", () => {
  it("accepts a correct slot with realistic motion", async () => {
    const c = await generateChallenge({ wallet, seed: 123 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const result = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: humanSamples(stored.gapX),
    });
    expect(result.ok).toBe(true);
    expect(await isWalletCaptchaVerified(wallet)).toBe(true);
  });

  it("accepts within tolerance (±4 px default)", async () => {
    const c = await generateChallenge({ wallet, seed: 11 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX + 3,
      motionSamples: humanSamples(stored.gapX + 3),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a wrong slot beyond tolerance", async () => {
    const c = await generateChallenge({ wallet, seed: 22 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX + 30,
      motionSamples: humanSamples(stored.gapX + 30),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("slot_mismatch");
    expect(await isWalletCaptchaVerified(wallet)).toBe(false);
  });

  it("rejects an instant submission (<150ms)", async () => {
    const c = await generateChallenge({ wallet, seed: 33 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const samples = Array.from({ length: 8 }, (_, i) => ({
      t: i * 5, // 0..35 ms total — far too fast
      x: (i / 7) * stored.gapX,
    }));
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: samples,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("motion_too_fast");
  });

  it("rejects a perfectly-linear trajectory", async () => {
    const c = await generateChallenge({ wallet, seed: 44 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const samples = Array.from({ length: 10 }, (_, i) => ({
      t: i * 25,
      x: (i / 9) * stored.gapX,
    }));
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: samples,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("motion_perfectly_linear");
  });

  it("rejects too-few samples", async () => {
    const c = await generateChallenge({ wallet, seed: 55 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: [
        { t: 0, x: 0 },
        { t: 200, x: stored.gapX },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("motion_too_few_samples");
  });

  it("rejects an unknown / replayed challengeId", async () => {
    const r = await verifyChallenge({
      challengeId: "doesnotexist",
      slotX: 100,
      motionSamples: humanSamples(100),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("challenge_not_found");
  });

  it("is one-shot: same challengeId can't be replayed after success", async () => {
    const c = await generateChallenge({ wallet, seed: 66 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const ok1 = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: humanSamples(stored.gapX),
    });
    expect(ok1.ok).toBe(true);
    const ok2 = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: humanSamples(stored.gapX),
    });
    expect(ok2.ok).toBe(false);
  });
});

describe("failure cooldown", () => {
  it("triggers cooldown after N failures and clears on next success window", async () => {
    process.env.CAPTCHA_FAIL_THRESHOLD = "3";
    process.env.CAPTCHA_FAIL_COOLDOWN_MS = "300";
    for (let i = 0; i < 3; i++) {
      const c = await generateChallenge({ wallet, seed: 100 + i });
      await verifyChallenge({
        challengeId: c.challengeId,
        slotX: 99999, // wrong
        motionSamples: humanSamples(99999),
      });
    }
    const cooldown = await getCaptchaCooldownRemainingMs(wallet);
    expect(cooldown).toBeGreaterThan(0);

    // Deposit gate should report 429 cooldown.
    const gate = await checkDepositCaptcha(wallet);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.status).toBe(429);
      expect(gate.body.error).toBe("captcha_cooldown");
    }

    // Wait for the TTL to elapse.
    await new Promise((r) => setTimeout(r, 360));
    expect(await getCaptchaCooldownRemainingMs(wallet)).toBe(0);
  });
});

describe("deposit gate", () => {
  it("blocks an unverified wallet with 412 captcha_required", async () => {
    const r = await checkDepositCaptcha(wallet);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(412);
      expect(r.body.error).toBe("captcha_required");
    }
  });

  it("allows a verified wallet through", async () => {
    const c = await generateChallenge({ wallet, seed: 7 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: humanSamples(stored.gapX),
    });
    expect(r.ok).toBe(true);
    const gate = await checkDepositCaptcha(wallet);
    expect(gate.ok).toBe(true);
  });

  it("rejects a missing wallet", async () => {
    const r = await checkDepositCaptcha("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body.error).toBe("captcha_required");
  });

  // Regression test for the spoofing bypass flagged in code review:
  // the deposit-initiation routes derive the depositor wallets from
  // TRUSTED match data (addr1/addr2), not from req.body.walletAddress.
  // So if a scripted client tries to "use" some other already-verified
  // wallet to slip past the gate while the actual match players are
  // unverified, the gate must still refuse.
  it("can't be spoofed by passing some unrelated verified wallet", async () => {
    const verified = "0x" + "b".repeat(40);
    const unverified1 = "0x" + "c".repeat(40);
    const unverified2 = "0x" + "d".repeat(40);
    // Verify `verified` for real.
    const c = await generateChallenge({ wallet: verified, seed: 13 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: humanSamples(stored.gapX),
    });
    expect(r.ok).toBe(true);
    // Sanity: `verified` would pass on its own.
    expect((await checkDepositCaptchaForWallets([verified])).ok).toBe(true);
    // The route passes the TRUSTED wallets (addr1, addr2) — the spoofed
    // verified wallet is NOT one of them, so the gate must block.
    const spoofed = await checkDepositCaptchaForWallets([unverified1, unverified2]);
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.body.error).toBe("captcha_required");
    // One verified + one unverified — still blocked, since BOTH players
    // must prove humanity before either can fund.
    const mixed = await checkDepositCaptchaForWallets([verified, unverified1]);
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.body.error).toBe("captcha_required");
  });

  // Fail-CLOSED behaviour: a Redis read failure during deposit gating
  // must NOT let the deposit through (that would be the exact bypass
  // captcha is designed to prevent). The gate returns a typed 503
  // captcha_unavailable so the client backs off briefly.
  it("fails CLOSED on Redis read errors with a 503 captcha_unavailable", async () => {
    const { redis } = await import("../server/redis");
    const realGet = redis.get.bind(redis);
    const realPttl = (redis as any).pttl.bind(redis);
    (redis as any).get = async () => {
      throw new Error("redis offline");
    };
    (redis as any).pttl = async () => {
      throw new Error("redis offline");
    };
    try {
      const r = await checkDepositCaptchaForWallets(["0x" + "e".repeat(40)]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(503);
        expect(r.body.error).toBe("captcha_unavailable");
        expect(r.body.retryAfterSec).toBeGreaterThan(0);
      }
    } finally {
      (redis as any).get = realGet;
      (redis as any).pttl = realPttl;
    }
  });

  it("treats checksummed and lowercased addresses as the same wallet", async () => {
    const checksummed = "0xAaAaaaAaAAaAaaaaAaaaaaaAaAaaAaAaaAAaaaAa";
    const c = await generateChallenge({ wallet: checksummed, seed: 88 });
    const stored = JSON.parse(
      (await getStoredChallenge(c.challengeId)) as string
    );
    const r = await verifyChallenge({
      challengeId: c.challengeId,
      slotX: stored.gapX,
      motionSamples: humanSamples(stored.gapX),
    });
    expect(r.ok).toBe(true);
    const gate = await checkDepositCaptcha(checksummed.toLowerCase());
    expect(gate.ok).toBe(true);
  });
});

// Helper to peek at the truth row written by generateChallenge — only
// the test reads this to assert behaviour.
async function getStoredChallenge(id: string): Promise<string | null> {
  const e = store.get(__testInternals.challengeKey(id));
  return e ? e.value : null;
}
