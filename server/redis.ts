import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// test connection
(async () => {
  try {
    await redis.ping();
    console.log("[redis] Upstash connected");
  } catch (e) {
    console.error("[redis] Upstash error", e);
  }
})();
