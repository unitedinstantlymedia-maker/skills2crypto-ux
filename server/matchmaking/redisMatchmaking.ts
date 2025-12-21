import { redis } from "../redis";
import { nanoid } from "nanoid";

type MatchParams = {
  game: string;
  asset: string;
  stake: number;
  socketId: string;
};

function queueKey(game: string, asset: string, stake: number) {
  return `queue:${game}:${asset}:${stake}`;
}

export async function findOrCreateMatch(params: MatchParams) {
  const { game, asset, stake, socketId } = params;
  const key = queueKey(game, asset, stake);

  // try to pop opponent
  const opponent = await redis.zpopmin(key);

  if (opponent && opponent.length > 0) {
    const opponentSocketId = opponent[0];
    const matchId = nanoid();

    await redis.hset(`match:${matchId}`, {
      game,
      asset,
      stake,
      p1: opponentSocketId,
      p2: socketId,
      status: "matched",
    });

    await redis.expire(`match:${matchId}`, 60 * 10);

    return {
      status: "matched",
      matchId,
      players: [opponentSocketId, socketId],
    };
  }

  // no opponent → enqueue
  await redis.zadd(key, { score: Date.now(), member: socketId });
  await redis.expire(key, 60 * 5);

  return {
    status: "waiting",
  };
}