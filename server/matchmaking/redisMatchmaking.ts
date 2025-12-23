import { redis } from "../redis";
import { nanoid } from "nanoid";
import type { Game, Asset, MatchFound } from "../core/types";

type FindMatchArgs = {
  game: Game;
  asset: Asset;
  stake: number;
  socketId: string;
};

function queueKey(game: Game, asset: Asset, stake: number) {
  return `queue:${game}:${asset}:${stake}`;
}

export async function findOrCreateMatch(
  params: FindMatchArgs
): Promise<{ status: "waiting" } | ({ status: "matched" } & MatchFound)> {
  const { game, asset, stake, socketId } = params;
  const key = queueKey(game, asset, stake);

  // Пытаемся достать соперника
  const popped = await redis.zpopmin(key); // returns [member, score] | []
  let opponentSocketId: string | null = null;

  if (Array.isArray(popped) && popped.length >= 1) {
    // В некоторых клиентах это может быть строка, в некоторых — [member, score]
    opponentSocketId = Array.isArray(popped[0]) ? String(popped[0][0]) : String(popped[0]);
  }

  // Если вытащили самого себя — вернем обратно и считаем, что соперника нет
  if (opponentSocketId === socketId) {
    if (opponentSocketId) {
      await redis.zadd(key, { score: Date.now(), member: opponentSocketId });
      await redis.expire(key, 60 * 5);
    }
    opponentSocketId = null;
  }

  if (opponentSocketId) {
    // Нашлась пара → создаем матч
    const matchId = nanoid();

    // Сохраняем минимальные поля матча (как строки)
    await redis.hset(`match:${matchId}`, {
      game,
      asset,
      stake: String(stake),
      p1: opponentSocketId,
      p2: socketId,
      createdAt: String(Date.now()),
      status: "matched",
    });
    await redis.expire(`match:${matchId}`, 60 * 10);

    return {
      status: "matched",
      matchId,
      players: [opponentSocketId, socketId],
    };
  }

  // Соперника нет → ставим в очередь
  await redis.zadd(key, { score: Date.now(), member: socketId });
  await redis.expire(key, 60 * 5);

  return { status: "waiting" };
}