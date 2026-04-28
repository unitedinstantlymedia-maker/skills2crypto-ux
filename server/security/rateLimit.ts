// Three tiers of rate limiting backed by Upstash Redis. Falls back to
// allowing the request on Redis errors so a transient blip doesn't
// take matchmaking offline.

import rateLimit, {
  type IncrementResponse,
  type Options as RateLimitOptions,
  type RateLimitRequestHandler,
  type Store,
} from "express-rate-limit";
import { redis } from "../redis";

interface UpstashStoreOptions {
  prefix: string;
  windowMs: number;
}

class UpstashRedisStore implements Store {
  prefix: string;
  windowMs: number;
  windowSec: number;

  constructor(opts: UpstashStoreOptions) {
    this.prefix = opts.prefix;
    this.windowMs = opts.windowMs;
    this.windowSec = Math.max(1, Math.ceil(opts.windowMs / 1000));
  }

  init(opts: RateLimitOptions) {
    this.windowMs = opts.windowMs;
    this.windowSec = Math.max(1, Math.ceil(opts.windowMs / 1000));
  }

  async increment(key: string): Promise<IncrementResponse> {
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
    store: new UpstashRedisStore({ prefix: opts.prefix, windowMs: opts.windowMs }),
    message: { error: "rate_limited", message: opts.message },
    skip: (req) => req.method === "OPTIONS",
    // Use req.ip only — it honors `app.set("trust proxy", 1)`. Do not
    // read X-Forwarded-For directly (clients can spoof it).
    keyGenerator: (req) => req.ip || "unknown",
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
