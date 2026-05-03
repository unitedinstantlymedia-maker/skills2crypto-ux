// Per-IP Socket.io connection cap and per-wallet matchmaking cooldown.
//
// Both limits are backed by Upstash Redis so they work across server
// replicas. Helpers are intentionally tiny and dependency-light so the
// unit tests can mock the redis module and exercise the logic directly.
//
// Failure mode: Redis blip → fail OPEN (don't block legitimate users).
// The HTTP rate limiter does the same; matching that behaviour keeps
// matchmaking up during transient Upstash incidents.

import { redis } from "../redis";

const DEFAULT_SOCKET_MAX_PER_IP = 8;
const DEFAULT_MATCHMAKING_COOLDOWN_MS = 10_000;

export function getSocketMaxPerIp(): number {
  const raw = process.env.SOCKET_MAX_PER_IP;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SOCKET_MAX_PER_IP;
}

export function getMatchmakingCooldownMs(): number {
  const raw = process.env.MATCHMAKING_COOLDOWN_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MATCHMAKING_COOLDOWN_MS;
}

const SOCKET_KEY_TTL_SEC = 24 * 60 * 60;

function ipKey(ip: string): string {
  return `sock:ip:${ip}`;
}

function cooldownKey(wallet: string): string {
  return `mm-cooldown:${wallet.toLowerCase()}`;
}

export interface AcquireResult {
  ok: boolean;
  current: number;
  max: number;
}

// Increment the per-IP counter and return whether the connection is
// allowed. The counter has a 24h safety TTL so a crashed process that
// never decrements its sockets eventually frees the slot. The TTL is
// (re)applied on first incr only so concurrent bursts don't keep
// pushing the expiry forward.
export async function acquireSocketSlot(ip: string): Promise<AcquireResult> {
  const max = getSocketMaxPerIp();
  if (!ip) {
    return { ok: true, current: 0, max };
  }
  const key = ipKey(ip);
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      try {
        await redis.expire(key, SOCKET_KEY_TTL_SEC);
      } catch {
        /* non-fatal */
      }
    }
    if (current > max) {
      // Roll back the increment so a rejected handshake doesn't
      // permanently consume a slot.
      try {
        await redis.decr(key);
      } catch {
        /* non-fatal */
      }
      return { ok: false, current: current - 1, max };
    }
    return { ok: true, current, max };
  } catch (e: any) {
    console.warn(`[socketLimits] redis incr failed for ${key}: ${e?.message || e}`);
    // Fail open so a Redis hiccup doesn't take the lobby down.
    return { ok: true, current: 0, max };
  }
}

export async function releaseSocketSlot(ip: string): Promise<void> {
  if (!ip) return;
  const key = ipKey(ip);
  try {
    const after = await redis.decr(key);
    // Defensive: if decrement underflows below zero (e.g. Redis was
    // wiped, or two release-calls fired for the same socket), reset
    // the key to zero so it doesn't stay negative forever.
    if (typeof after === "number" && after < 0) {
      try {
        await redis.del(key);
      } catch {
        /* non-fatal */
      }
    }
  } catch (e: any) {
    console.warn(`[socketLimits] redis decr failed for ${key}: ${e?.message || e}`);
  }
}

// Set the cooldown for a wallet after a match completes. TTL is in
// milliseconds; the underlying Upstash client supports `px`.
export async function setMatchmakingCooldown(wallet: string): Promise<void> {
  if (!wallet) return;
  const ttlMs = getMatchmakingCooldownMs();
  if (ttlMs <= 0) return;
  try {
    await redis.set(cooldownKey(wallet), "1", { px: ttlMs } as any);
  } catch (e: any) {
    console.warn(
      `[socketLimits] redis set cooldown failed for ${wallet}: ${e?.message || e}`
    );
  }
}

// Returns ms remaining if cooldown is active, else 0.
export async function getMatchmakingCooldownRemainingMs(
  wallet: string
): Promise<number> {
  if (!wallet) return 0;
  const key = cooldownKey(wallet);
  try {
    const pttl = await (redis as any).pttl(key);
    if (typeof pttl === "number" && pttl > 0) return pttl;
    return 0;
  } catch {
    // Fall back to a single GET — if the key exists we know cooldown
    // is active even if we can't read remaining ms.
    try {
      const v = await redis.get(key);
      return v ? getMatchmakingCooldownMs() : 0;
    } catch {
      return 0;
    }
  }
}

// Test-only: not exported through index — only imported by tests.
export const __testInternals = {
  ipKey,
  cooldownKey,
};
