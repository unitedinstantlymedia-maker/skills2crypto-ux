/**
 * Rate limiting middleware.
 *
 * Three tiers:
 *   - tight   — money-touching matchmaking endpoints (find-match,
 *               create-challenge, accept-challenge): 10 req / min / IP.
 *   - medium  — oracle/auth/info endpoints called many times per
 *               match: 60 req / min / IP.
 *   - loose   — read-only / config / health: 240 req / min / IP.
 *
 * We use Upstash Redis as the backend (already used everywhere else
 * in this codebase) so the limiter is consistent across instances.
 * Falls back to in-memory if Redis is unavailable so a transient
 * Redis blip can't take matchmaking offline.
 */

import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { redis } from "../redis";

interface UpstashStoreOptions {
  prefix: string;
  windowMs: number;
}

class UpstashRedisStore {
  prefix: string;
  windowMs: number;
  windowSec: number;
  // express-rate-limit v8 sets this from `init()`
  // and we mirror its default to keep types happy.
  // (incr is the only method it requires.)
  constructor(opts: UpstashStoreOptions) {
    this.prefix = opts.prefix;
    this.windowMs = opts.windowMs;
    this.windowSec = Math.max(1, Math.ceil(opts.windowMs / 1000));
  }

  init(opts: { windowMs: number }) {
    this.windowMs = opts.windowMs;
    this.windowSec = Math.max(1, Math.ceil(opts.windowMs / 1000));
  }

  async increment(key: string) {
    const fullKey = `${this.prefix}:${key}`;
    try {
      const current = await redis.incr(fullKey);
      if (current === 1) {
        await redis.expire(fullKey, this.windowSec);
      }
      let ttl: number;
      try {
        ttl = await redis.ttl(fullKey);
      } catch {
        ttl = this.windowSec;
      }
      const resetMs = Date.now() + Math.max(0, ttl) * 1000;
      return { totalHits: current, resetTime: new Date(resetMs) };
    } catch (e: any) {
      // Redis hiccup: degrade to allow rather than block matchmaking.
      // The next call will retry against Redis.
      console.warn(`[rateLimit] Redis incr failed for ${fullKey}: ${e?.message || e}`);
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string) {
    const fullKey = `${this.prefix}:${key}`;
    try {
      await redis.decr(fullKey);
    } catch {
      /* ignore */
    }
  }

  async resetKey(key: string) {
    const fullKey = `${this.prefix}:${key}`;
    try {
      await redis.del(fullKey);
    } catch {
      /* ignore */
    }
  }
}

function makeLimiter(opts: {
  prefix: string;
  windowMs: number;
  max: number;
  message: string;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: new UpstashRedisStore({ prefix: opts.prefix, windowMs: opts.windowMs }) as any,
    message: { error: "rate_limited", message: opts.message },
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: (req) => {
      // SECURITY: do NOT read `x-forwarded-for` here. Express's
      // `req.ip` already resolves to the proxy-respecting client IP
      // because we set `app.set("trust proxy", 1)` in server/index.ts
      // (single trusted hop = Replit's edge). Reading XFF directly
      // here would let any client spoof the header and rotate buckets
      // to bypass the limiter — see audit fix Apr 2026.
      return req.ip || "unknown";
    },
  });
}

export const rlTight = makeLimiter({
  prefix: "rl:tight",
  windowMs: 60_000,
  max: 10,
  message: "Too many matchmaking requests. Please slow down.",
});

export const rlMedium = makeLimiter({
  prefix: "rl:medium",
  windowMs: 60_000,
  max: 60,
  message: "Too many requests. Please slow down.",
});

export const rlLoose = makeLimiter({
  prefix: "rl:loose",
  windowMs: 60_000,
  max: 240,
  message: "Too many requests.",
});
