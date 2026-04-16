import { redis } from "../redis";
import { nanoid } from "nanoid";
import type { Game, Asset, MatchFound } from "../core/types";

type FindMatchArgs = {
  game: Game;
  asset: Asset;
  stake: number;
  socketId: string;
  walletAddress: string;
};

function queueKey(game: Game, asset: Asset, stake: number) {
  return `queue:${game}:${asset}:${stake}`;
}

function encodeQueueMember(socketId: string, walletAddress: string): string {
  return `${socketId}|${walletAddress}`;
}

function decodeQueueMember(member: string): { socketId: string; walletAddress: string } {
  const idx = member.indexOf("|");
  if (idx === -1) return { socketId: member, walletAddress: "" };
  return { socketId: member.slice(0, idx), walletAddress: member.slice(idx + 1) };
}

export async function findOrCreateMatch(
  params: FindMatchArgs
): Promise<{ status: "waiting" } | ({ status: "matched" } & MatchFound)> {
  const { game, asset, stake, socketId, walletAddress } = params;
  const key = queueKey(game, asset, stake);
  const myMember = encodeQueueMember(socketId, walletAddress);

  const popped = await redis.zpopmin(key);
  let opponentRaw: string | null = null;

  if (Array.isArray(popped) && popped.length >= 1) {
    opponentRaw = Array.isArray(popped[0]) ? String(popped[0][0]) : String(popped[0]);
  }

  if (opponentRaw) {
    const opponent = decodeQueueMember(opponentRaw);

    if (opponent.socketId === socketId) {
      await redis.zadd(key, { score: Date.now(), member: opponentRaw });
      await redis.expire(key, 60 * 5);
      opponentRaw = null;
    }

    if (opponentRaw) {
      const matchId = nanoid();

      await redis.hset(`match:${matchId}`, {
        game,
        asset,
        stake: String(stake),
        p1: opponent.socketId,
        p2: socketId,
        addr1: opponent.walletAddress,
        addr2: walletAddress,
        createdAt: String(Date.now()),
        status: "matched",
      });
      await redis.expire(`match:${matchId}`, 60 * 120);

      return {
        status: "matched",
        matchId,
        players: [opponent.socketId, socketId],
      };
    }
  }

  await redis.zadd(key, { score: Date.now(), member: myMember });
  await redis.expire(key, 60 * 5);

  return { status: "waiting" };
}
