import { redis } from "../redis";
import type { Server as SocketIOServer } from "socket.io";
import type { ChallengeData, ChallengeHistoryEntry } from "../../shared/schema";

const CLEANUP_INTERVAL = 5 * 60 * 1000;
const EXPIRED_CHALLENGE_TTL = 86400;

async function addChallengeHistory(
  challengeId: string,
  status: "pending" | "accepted" | "expired" | "cancelled" | "completed",
  action: string
): Promise<void> {
  const entry: ChallengeHistoryEntry = {
    timestamp: Date.now(),
    status,
    action,
  };
  await redis.rpush(`challenge:${challengeId}:history`, JSON.stringify(entry));
  await redis.expire(`challenge:${challengeId}:history`, EXPIRED_CHALLENGE_TTL);
}

export function startChallengeCleanup(io: SocketIOServer): void {
  console.log("[challenge-cleanup] starting background job");
  
  async function cleanupExpiredChallenges() {
    try {
      const keys = await redis.keys("challenge:*");
      
      const challengeKeys = keys.filter(k => 
        !k.includes(":history") && 
        k.match(/^challenge:[a-zA-Z0-9_-]+$/)
      );
      
      const now = Date.now();
      let expiredCount = 0;
      
      for (const key of challengeKeys) {
        const data = await redis.get(key);
        if (!data) continue;
        
        const challenge: ChallengeData = typeof data === "string" ? JSON.parse(data) : data;
        
        if (challenge.status !== "pending") continue;
        
        const isExpired = challenge.expiresAt 
          ? now > challenge.expiresAt 
          : now > challenge.createdAt + (3600 * 1000);
        
        if (isExpired) {
          challenge.status = "expired";
          
          await redis.set(key, JSON.stringify(challenge), { ex: EXPIRED_CHALLENGE_TTL });
          await addChallengeHistory(challenge.challengeId, "expired", "challenge_expired");
          
          if (challenge.challengerSocketId) {
            io.to(challenge.challengerSocketId).emit("challenge-expired", {
              challengeId: challenge.challengeId,
              game: challenge.game,
              stake: challenge.stake,
              asset: challenge.asset,
            });
          }
          
          console.log(`[challenge-cleanup] expired challenge ${challenge.challengeId}`);
          expiredCount++;
        }
      }
      
      if (expiredCount > 0) {
        console.log(`[challenge-cleanup] marked ${expiredCount} challenges as expired`);
      }
    } catch (err) {
      console.error("[challenge-cleanup] error:", err);
    }
  }
  
  cleanupExpiredChallenges();
  
  setInterval(cleanupExpiredChallenges, CLEANUP_INTERVAL);
}
