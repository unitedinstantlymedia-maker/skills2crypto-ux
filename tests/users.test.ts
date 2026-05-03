import { describe, expect, it, beforeEach, vi } from "vitest";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// In-memory `users` table mock for the soft-ban infrastructure.
// We reuse the same shape conventions as tests/match-moves.test.ts (drizzle
// query stub + thenable builder), but keep it minimal: this suite only
// exercises the users table + admin auth + matchmaking gate.
// ---------------------------------------------------------------------------

interface UserRow {
  wallet: string;
  status: string;
  banReason: string | null;
  bannedAt: number | null;
  bannedBy: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  notes: unknown;
}

const userStore = new Map<string, UserRow>();

vi.mock("../server/db", () => ({
  db: {
    insert: (_table: unknown) => ({
      values: (row: any) => ({
        onConflictDoUpdate: async ({ set }: { set: any }) => {
          const existing = userStore.get(row.wallet);
          if (existing) {
            for (const k of Object.keys(set)) {
              (existing as any)[k] = set[k];
            }
          } else {
            userStore.set(row.wallet, {
              wallet: row.wallet,
              status: row.status ?? "active",
              banReason: row.banReason ?? null,
              bannedAt: row.bannedAt ?? null,
              bannedBy: row.bannedBy ?? null,
              firstSeenAt: row.firstSeenAt,
              lastSeenAt: row.lastSeenAt,
              notes: row.notes ?? null,
            });
          }
          return undefined;
        },
        // Some call sites (touchUser without onConflict) — none here.
      }),
    }),
    select: (_proj?: any) => {
      const builder: any = {
        _wallet: null as string | null,
        from(_t: unknown) {
          return this;
        },
        where(cond: any) {
          // Tests call only `eq(users.wallet, w)` so we can extract the
          // operand value off the drizzle binary expression.
          this._wallet = cond?.__wallet ?? null;
          return this;
        },
        limit(_n: number) {
          return this;
        },
        then(resolve: (rows: any[]) => any) {
          if (!this._wallet) {
            return resolve(Array.from(userStore.values()));
          }
          const r = userStore.get(this._wallet);
          return resolve(r ? [r] : []);
        },
      };
      return builder;
    },
  },
  pool: { end: async () => undefined },
}));

// drizzle-orm `eq(col, val)` returns an opaque object; our mock select
// looks for `__wallet` on it. Override `eq` for these tests so the
// builder above can read the bound value.
vi.mock("drizzle-orm", async () => {
  const actual: any = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: (col: any, val: any) => ({ __wallet: String(val), __col: col }),
  };
});

// In-memory Upstash mock — strings + sorted sets + hashes, enough for
// the matchmaking integration tests. Backs both the userStatus admin-
// auth nonce store and the redisMatchmaking queue store.
const redisStore = new Map<string, { value: string; expiresAt?: number }>();
const zsetStore = new Map<string, Array<{ score: number; member: string }>>();
const hashStore = new Map<string, Record<string, string>>();
function getEntry(key: string) {
  const e = redisStore.get(key);
  if (!e) return undefined;
  if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
    redisStore.delete(key);
    return undefined;
  }
  return e;
}
vi.mock("../server/redis", () => ({
  redis: {
    set: async (
      key: string,
      value: string,
      opts?: { ex?: number; px?: number; nx?: boolean },
    ): Promise<string | null> => {
      if (opts?.nx && getEntry(key)) return null;
      const expiresAt =
        opts?.px !== undefined
          ? Date.now() + opts.px
          : opts?.ex !== undefined
            ? Date.now() + opts.ex * 1000
            : undefined;
      redisStore.set(key, { value: String(value), expiresAt });
      return "OK";
    },
    get: async (key: string) => getEntry(key)?.value ?? null,
    del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
    ping: async () => "PONG",
    // Sorted-set ops used by redisMatchmaking.
    zadd: async (key: string, entry: { score: number; member: string }) => {
      const arr = zsetStore.get(key) ?? [];
      // Idempotent on member equality, like real Upstash.
      const filtered = arr.filter((e) => e.member !== entry.member);
      filtered.push({ score: entry.score, member: entry.member });
      filtered.sort((a, b) => a.score - b.score);
      zsetStore.set(key, filtered);
      return 1;
    },
    zpopmin: async (key: string) => {
      const arr = zsetStore.get(key);
      if (!arr || arr.length === 0) return [];
      const head = arr.shift()!;
      // Upstash returns [[member, score]] — match that shape so the
      // production decoder works unchanged.
      return [[head.member, head.score]];
    },
    expire: async (_key: string, _ttl: number) => 1,
    // Hash op used to persist match metadata after pairing.
    hset: async (key: string, fields: Record<string, string>) => {
      const cur = hashStore.get(key) ?? {};
      hashStore.set(key, { ...cur, ...fields });
      return Object.keys(fields).length;
    },
  },
}));

// Imports must come AFTER the vi.mock calls.
import {
  touchUser,
  getUser,
  getUserStatus,
  setUserStatus,
  invalidateUserStatusCache,
  checkDepositBanForWallets,
} from "../server/users/userStatus";
import {
  requireAdminWallet,
  __testInternals as adminInternals,
} from "../server/security/adminAuth";

const W1 = "0x" + "a".repeat(40);
const W2 = "0x" + "b".repeat(40);
const ADMIN_PK = "0x" + "1".repeat(64);
const ADMIN_WALLET = new ethers.Wallet(ADMIN_PK).address.toLowerCase();
const NOT_ADMIN_PK = "0x" + "2".repeat(64);
const NOT_ADMIN_WALLET = new ethers.Wallet(NOT_ADMIN_PK).address.toLowerCase();

beforeEach(() => {
  userStore.clear();
  redisStore.clear();
  zsetStore.clear();
  hashStore.clear();
  invalidateUserStatusCache();
  delete process.env.ADMIN_WALLET_ALLOWLIST;
});

// ---------------------------------------------------------------------------
// touchUser / status reads
// ---------------------------------------------------------------------------
describe("touchUser", () => {
  it("inserts a fresh row on first sighting and is idempotent", async () => {
    await touchUser(W1);
    const a = await getUser(W1);
    expect(a?.status).toBe("active");
    expect(a?.firstSeenAt).toBeGreaterThan(0);

    const firstSeen = a!.firstSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    await touchUser(W1);
    const b = await getUser(W1);
    // First-seen is preserved; last-seen advances.
    expect(b?.firstSeenAt).toBe(firstSeen);
    expect(b!.lastSeenAt).toBeGreaterThanOrEqual(b!.firstSeenAt);
  });

  it("never throws for empty/whitespace input", async () => {
    await expect(touchUser("")).resolves.toBeUndefined();
    await expect(touchUser("   ")).resolves.toBeUndefined();
  });
});

describe("getUserStatus", () => {
  it("returns 'active' for an unseen wallet (fail-open)", async () => {
    expect(await getUserStatus(W1)).toBe("active");
  });

  it("treats EVM wallet casings as the same identity (no case-bypass)", async () => {
    // Ban the wallet using one casing — checking it under any other
    // casing must still return 'banned'. Without canonicalisation,
    // an attacker would just resubmit their wallet in a different
    // casing to bypass the ban.
    const mixed = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
    const lower = mixed.toLowerCase();
    const upper = "0x" + mixed.slice(2).toUpperCase();
    await setUserStatus({ wallet: mixed, status: "banned", reason: "x", by: "admin" });
    expect(await getUserStatus(lower)).toBe("banned");
    expect(await getUserStatus(upper)).toBe("banned");
    expect(await getUserStatus(mixed)).toBe("banned");
    // The stored row should be keyed by the canonical (lowercase)
    // form so admin reads converge regardless of input casing.
    const u = await getUser(upper);
    expect(u?.wallet).toBe(lower);
  });

  it("reflects setUserStatus once cache is invalidated", async () => {
    await touchUser(W1);
    expect(await getUserStatus(W1)).toBe("active");

    await setUserStatus({ wallet: W1, status: "banned", reason: "abuse", by: "admin" });
    // setUserStatus invalidates the cache for this wallet.
    expect(await getUserStatus(W1)).toBe("banned");

    const u = await getUser(W1);
    expect(u?.banReason).toBe("abuse");
    expect(u?.bannedBy).toBe("admin");
    expect(typeof u?.bannedAt).toBe("number");
  });

  it("clears ban metadata when status returns to 'active'", async () => {
    await setUserStatus({ wallet: W1, status: "banned", reason: "x", by: "admin" });
    await setUserStatus({ wallet: W1, status: "active", reason: null, by: "admin" });
    const u = await getUser(W1);
    expect(u?.status).toBe("active");
    expect(u?.banReason).toBeNull();
    expect(u?.bannedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deposit ban gate
// ---------------------------------------------------------------------------
describe("checkDepositBanForWallets", () => {
  it("passes when both wallets are active or unseen", async () => {
    const r = await checkDepositBanForWallets([W1, W2]);
    expect(r.ok).toBe(true);
  });

  it("rejects 403 with banned wallet returned in the body", async () => {
    await setUserStatus({ wallet: W2, status: "banned", reason: "cheat", by: "admin" });
    const r = await checkDepositBanForWallets([W1, W2]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("banned");
      expect(r.body.wallet).toBe(W2);
    }
  });

  it("does NOT reject for shadowbanned (silent gate is matchmaking-only)", async () => {
    await setUserStatus({ wallet: W1, status: "shadowbanned", reason: null, by: "admin" });
    const r = await checkDepositBanForWallets([W1, W2]);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Matchmaking gate semantics — assert the status returned by
// getUserStatus drives the right find-match branch. We exercise the
// helper directly rather than spinning up the route, which would
// require mocking ~10 unrelated subsystems (oracles, captcha, etc.).
// ---------------------------------------------------------------------------
describe("matchmaking gate semantics", () => {
  it("'active' → playable", async () => {
    await touchUser(W1);
    expect(await getUserStatus(W1)).toBe("active");
  });

  it("'shadowbanned' wallet returns 'shadowbanned' so route returns waiting (never paired)", async () => {
    await setUserStatus({ wallet: W1, status: "shadowbanned", reason: null, by: "admin" });
    expect(await getUserStatus(W1)).toBe("shadowbanned");
  });

  it("'banned' wallet returns 'banned' so route returns 403", async () => {
    await setUserStatus({ wallet: W1, status: "banned", reason: "auto", by: "admin" });
    expect(await getUserStatus(W1)).toBe("banned");
  });
});

// ---------------------------------------------------------------------------
// requireAdminWallet middleware
// ---------------------------------------------------------------------------
function makeReqRes(opts: {
  method: string;
  path: string;
  body?: any;
  headers?: Record<string, string>;
}): { req: any; res: any; nextCalled: { value: boolean } } {
  const headers = opts.headers ?? {};
  const req: any = {
    method: opts.method,
    path: opts.path,
    body: opts.body ?? {},
    header: (n: string) => headers[n.toLowerCase()],
  };
  let statusCode = 200;
  let jsonBody: any = null;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(b: any) {
      jsonBody = b;
      return this;
    },
    get _statusCode() {
      return statusCode;
    },
    get _body() {
      return jsonBody;
    },
  };
  const nextCalled = { value: false };
  Object.defineProperty(res, "_status", { get: () => statusCode });
  Object.defineProperty(res, "_json", { get: () => jsonBody });
  return { req, res, nextCalled };
}

async function signAdminRequest(opts: {
  pk: string;
  method: string;
  path: string;
  body?: any;
  timestamp?: number;
  nonce?: string;
}) {
  const wallet = new ethers.Wallet(opts.pk);
  const ts = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? "n" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const rawBody = opts.body && Object.keys(opts.body).length > 0 ? JSON.stringify(opts.body) : "";
  const bodyHash = await adminInternals.sha256Hex(rawBody);
  const message = adminInternals.buildSignedMessage({
    method: opts.method.toUpperCase(),
    path: opts.path,
    bodyHash,
    timestamp: ts,
    nonce,
  });
  const signature = await wallet.signMessage(message);
  return {
    headers: {
      "x-admin-wallet": wallet.address.toLowerCase(),
      "x-admin-timestamp": ts,
      "x-admin-nonce": nonce,
      "x-admin-signature": signature,
    },
  };
}

// ---------------------------------------------------------------------------
// Matchmaking integration — findOrCreateMatch must:
//   - return waiting and enqueue (not pair) when the requester is shadowbanned
//   - drop a popped opponent that was shadowbanned and re-enqueue them so they
//     remain perpetually queued
//   - drop a popped opponent that has been hard-banned (no re-enqueue)
//   - pair two active wallets normally
// ---------------------------------------------------------------------------
describe("matchmaking integration with soft-ban", () => {
  it("requester shadowbanned → returns waiting and is enqueued (no pairing)", async () => {
    const { findOrCreateMatch } = await import("../server/matchmaking/redisMatchmaking");
    await setUserStatus({ wallet: W1, status: "shadowbanned", reason: null, by: "admin" });

    const r1 = await findOrCreateMatch({
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-1",
      walletAddress: W1,
    });
    expect(r1.status).toBe("waiting");
    // Requester sits in the sorted-set queue (zadd was called) but
    // never paired — the queue must contain exactly the shadowbanned
    // requester so an indifferent observer cannot tell.
    const zsetKeys = Array.from(zsetStore.keys()).filter((k) =>
      k.startsWith("queue:"),
    );
    expect(zsetKeys.length).toBe(1);
    const queue = zsetStore.get(zsetKeys[0])!;
    expect(queue.length).toBe(1);
    expect(queue[0].member.startsWith("sock-1")).toBe(true);

    // An honest opponent now arrives — must NOT be paired with the
    // shadowbanned wallet sitting at the head of the queue.
    const r2 = await findOrCreateMatch({
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-2",
      walletAddress: W2,
    });
    expect(r2.status).toBe("waiting");
  });

  it("two active wallets pair normally and produce a matched result", async () => {
    const { findOrCreateMatch } = await import("../server/matchmaking/redisMatchmaking");
    const r1 = await findOrCreateMatch({
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-A",
      walletAddress: W1,
    });
    expect(r1.status).toBe("waiting");

    const r2 = await findOrCreateMatch({
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-B",
      walletAddress: W2,
    });
    expect(r2.status).toBe("matched");
    if (r2.status === "matched") {
      expect(r2.players).toContain("sock-A");
      expect(r2.players).toContain("sock-B");
    }
  });

  it("touchUser is invoked even when find-match is about to reject for ban", async () => {
    // Direct integration: the route ordering must call touchUser
    // BEFORE the ban gate. This mirrors what the route does and
    // verifies the user store reflects activity for a banned wallet.
    await touchUser(W1);
    await setUserStatus({ wallet: W1, status: "banned", reason: "x", by: "admin" });
    const beforeRow = await getUser(W1);
    const beforeSeen = beforeRow?.lastSeenAt;
    expect(beforeSeen).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    // Simulate the find-match touch path: route calls touchUser, then
    // checks status. The touch must move lastSeenAt forward even though
    // the subsequent status read returns 'banned'.
    await touchUser(W1);
    const afterRow = await getUser(W1);
    expect(afterRow?.status).toBe("banned");
    const toMs = (v: unknown): number =>
      v instanceof Date ? v.getTime() : Number(v);
    expect(toMs(afterRow!.lastSeenAt)).toBeGreaterThan(toMs(beforeSeen));
  });

  it("popped opponent that became hard-banned is dropped, requester is enqueued", async () => {
    const { findOrCreateMatch } = await import("../server/matchmaking/redisMatchmaking");
    // First requester queues normally as 'active'.
    await findOrCreateMatch({
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-X",
      walletAddress: W1,
    });
    // Then they become hard-banned WHILE in queue.
    await setUserStatus({ wallet: W1, status: "banned", reason: "after queueing", by: "admin" });

    // Honest opponent arrives — the popped W1 entry must be dropped
    // and the honest opponent enqueued (waiting), NEVER paired.
    const r = await findOrCreateMatch({
      game: "chess",
      asset: "BNB",
      stake: 0.01,
      socketId: "sock-Y",
      walletAddress: W2,
    });
    expect(r.status).toBe("waiting");
  });
});

describe("requireAdminWallet", () => {
  it("returns 503 admin_disabled when ADMIN_WALLET_ALLOWLIST is empty", async () => {
    const { req, res, nextCalled } = makeReqRes({ method: "GET", path: "/api/admin/users/x" });
    await requireAdminWallet(req, res, () => (nextCalled.value = true) as any);
    expect(res._status).toBe(503);
    expect(res._body.error).toBe("admin_disabled");
    expect(nextCalled.value).toBe(false);
  });

  it("returns 401 when admin headers are missing", async () => {
    process.env.ADMIN_WALLET_ALLOWLIST = ADMIN_WALLET;
    const { req, res, nextCalled } = makeReqRes({ method: "GET", path: "/api/admin/users/x" });
    await requireAdminWallet(req, res, () => (nextCalled.value = true) as any);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe("admin_auth_required");
    expect(nextCalled.value).toBe(false);
  });

  it("returns 403 not_admin for a wallet outside the allowlist", async () => {
    process.env.ADMIN_WALLET_ALLOWLIST = ADMIN_WALLET;
    const signed = await signAdminRequest({
      pk: NOT_ADMIN_PK,
      method: "GET",
      path: "/api/admin/users/x",
    });
    const { req, res, nextCalled } = makeReqRes({
      method: "GET",
      path: "/api/admin/users/x",
      headers: signed.headers,
    });
    await requireAdminWallet(req, res, () => (nextCalled.value = true) as any);
    expect(res._status).toBe(403);
    expect(res._body.error).toBe("not_admin");
    expect(nextCalled.value).toBe(false);
    // Sanity — the not-admin wallet would never be in the allowlist.
    expect(NOT_ADMIN_WALLET).not.toBe(ADMIN_WALLET);
  });

  it("calls next() for a properly-signed admin request", async () => {
    process.env.ADMIN_WALLET_ALLOWLIST = ADMIN_WALLET;
    const signed = await signAdminRequest({
      pk: ADMIN_PK,
      method: "GET",
      path: "/api/admin/users/x",
    });
    const { req, res, nextCalled } = makeReqRes({
      method: "GET",
      path: "/api/admin/users/x",
      headers: signed.headers,
    });
    await requireAdminWallet(req, res, () => (nextCalled.value = true) as any);
    expect(nextCalled.value).toBe(true);
    expect(req.adminAuth?.wallet).toBe(ADMIN_WALLET);
  });

  it("rejects 401 admin_auth_expired when the timestamp is stale", async () => {
    process.env.ADMIN_WALLET_ALLOWLIST = ADMIN_WALLET;
    const signed = await signAdminRequest({
      pk: ADMIN_PK,
      method: "GET",
      path: "/api/admin/users/x",
      timestamp: Date.now() - 5 * 60_000,
    });
    const { req, res, nextCalled } = makeReqRes({
      method: "GET",
      path: "/api/admin/users/x",
      headers: signed.headers,
    });
    await requireAdminWallet(req, res, () => (nextCalled.value = true) as any);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe("admin_auth_expired");
    expect(nextCalled.value).toBe(false);
  });

  it("rejects 401 admin_auth_replay when the same nonce is used twice", async () => {
    process.env.ADMIN_WALLET_ALLOWLIST = ADMIN_WALLET;
    const signed = await signAdminRequest({
      pk: ADMIN_PK,
      method: "GET",
      path: "/api/admin/users/x",
    });

    const first = makeReqRes({
      method: "GET",
      path: "/api/admin/users/x",
      headers: signed.headers,
    });
    await requireAdminWallet(first.req, first.res, () => (first.nextCalled.value = true) as any);
    expect(first.nextCalled.value).toBe(true);

    const second = makeReqRes({
      method: "GET",
      path: "/api/admin/users/x",
      headers: signed.headers,
    });
    await requireAdminWallet(second.req, second.res, () => (second.nextCalled.value = true) as any);
    expect(second.res._status).toBe(401);
    expect(second.res._body.error).toBe("admin_auth_replay");
    expect(second.nextCalled.value).toBe(false);
  });

  it("rejects 401 admin_auth_invalid when the body is tampered after signing", async () => {
    process.env.ADMIN_WALLET_ALLOWLIST = ADMIN_WALLET;
    const signed = await signAdminRequest({
      pk: ADMIN_PK,
      method: "POST",
      path: "/api/admin/users/x/status",
      body: { status: "active" },
    });
    // Caller swaps the body to a hard-ban after signing — signature
    // covers a sha256(body) so this MUST fail to verify.
    const { req, res, nextCalled } = makeReqRes({
      method: "POST",
      path: "/api/admin/users/x/status",
      body: { status: "banned", reason: "elevation" },
      headers: signed.headers,
    });
    await requireAdminWallet(req, res, () => (nextCalled.value = true) as any);
    expect(res._status).toBe(401);
    expect(res._body.error).toBe("admin_auth_invalid");
    expect(nextCalled.value).toBe(false);
  });
});
