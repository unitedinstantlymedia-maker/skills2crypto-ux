import { redis } from "../redis";
import { nanoid } from "nanoid";
import type { Game, Asset, MatchFound } from "../core/types";
import { walletAddressesEqual } from "../security/systemAddresses";
import { getUserStatus } from "../users/userStatus";

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

  // Anti-cheat L1 (Task #46) — shadowban honoring at the matcher.
  //
  // The HTTP layer (find-match in server/routes.ts) already converts
  // `banned` into a 403, so a banned wallet should never reach here.
  // Shadowban, by contrast, is the matcher's responsibility: the user
  // MUST appear to queue normally (so they can't probe whether they
  // were banned by comparing to honest behaviour) but MUST never be
  // paired. Strategy:
  //   1. If the requester is shadowbanned, enqueue them and return
  //      waiting WITHOUT popping an opponent. This keeps them in the
  //      queue indefinitely and prevents them from ever pulling an
  //      honest player out of the queue.
  //   2. If we pop an opponent and discover that opponent is
  //      shadowbanned, push them back and enqueue the requester (also
  //      returning waiting). The shadowbanned opponent will be re-popped
  //      and re-rejected by the next honest requester forever.
  // We re-check status server-side at the moment of pairing (instead of
  // trusting the queue) so a wallet shadowbanned WHILE already queued
  // is still skipped.
  const requesterStatus = await getUserStatus(walletAddress);
  if (requesterStatus === "shadowbanned") {
    // Re-add the requester so the queue length reflects what an honest
    // user would see. zadd is idempotent on member equality, so a
    // shadowbanned user spamming find-match doesn't multiply rows.
    await redis.zadd(key, { score: Date.now(), member: myMember });
    await redis.expire(key, 60 * 5);
    return { status: "waiting" };
  }

  const popped = await redis.zpopmin(key);
  let opponentRaw: string | null = null;

  if (Array.isArray(popped) && popped.length >= 1) {
    opponentRaw = Array.isArray(popped[0]) ? String(popped[0][0]) : String(popped[0]);
  }

  if (opponentRaw) {
    const opponent = decodeQueueMember(opponentRaw);

    // Refuse to pair the requester with themselves. Two ways this can
    // happen:
    //   1. Same socket id (legacy reconnect / duplicate request).
    //   2. Different socket ids but the same wallet address — e.g. the
    //      same wallet connected from two browsers/devices. The on-chain
    //      contract would later reject this with `require(player1 != player2)`,
    //      but only AFTER both deposits, wasting gas. Catch it here.
    const sameSocket = opponent.socketId === socketId;
    const sameWallet =
      !!walletAddress &&
      !!opponent.walletAddress &&
      (await walletAddressesEqual(asset, opponent.walletAddress, walletAddress));

    if (sameSocket || sameWallet) {
      await redis.zadd(key, { score: Date.now(), member: opponentRaw });
      await redis.expire(key, 60 * 5);
      opponentRaw = null;
    }

    // Shadowban / banned opponent gate. We check status at pop-time
    // because the popped opponent could have been queued long before
    // their ban took effect (matchmaker side; HTTP-layer ban gate
    // wouldn't have caught a stale queue entry).
    if (opponentRaw && opponent.walletAddress) {
      const oppStatus = await getUserStatus(opponent.walletAddress);
      if (oppStatus === "shadowbanned") {
        // Push the shadowbanned opponent back so they stay perpetually
        // queued, and queue the requester for the NEXT honest opponent.
        await redis.zadd(key, { score: Date.now(), member: opponentRaw });
        await redis.zadd(key, { score: Date.now(), member: myMember });
        await redis.expire(key, 60 * 5);
        return { status: "waiting" };
      }
      if (oppStatus === "banned") {
        // Drop the banned member from the queue entirely (do not push
        // back) and queue the requester. A banned player should never
        // sit in matchmaking — the HTTP gate prevents new entries, but
        // pre-existing entries get cleaned out lazily here.
        await redis.zadd(key, { score: Date.now(), member: myMember });
        await redis.expire(key, 60 * 5);
        return { status: "waiting" };
      }
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
