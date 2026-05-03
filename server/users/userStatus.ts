import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, UserStatusEnum, type User, type UserStatus } from "../../shared/schema";

const CACHE_TTL_MS = 60_000;
type CacheEntry = { status: UserStatus; expiresAt: number };
const statusCache = new Map<string, CacheEntry>();

// Canonicalise wallet keys for the users table. EVM addresses are
// case-insensitive at the protocol level (the checksum is purely a
// human-readable error-detection layer), but a Postgres TEXT primary
// key compares verbatim — without canonicalisation, a wallet banned as
// `0xAbC…` would still pass `getUserStatus('0xabc…')` and silently
// bypass every gate. Tron base58 and TON friendly forms ARE
// case-sensitive, so we MUST NOT lowercase those. Strategy: detect EVM
// shape and lowercase it; leave everything else verbatim.
function normalize(wallet: string): string {
  const trimmed = (wallet || "").trim();
  if (!trimmed) return "";
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

export function invalidateUserStatusCache(wallet?: string): void {
  if (!wallet) {
    statusCache.clear();
    return;
  }
  statusCache.delete(normalize(wallet));
}

// Fire-and-forget upsert. Called from every entry point that sees a
// wallet (matchmaking, deposit endpoints, captcha verify, match
// settlement) so first/last-seen timestamps stay current and no
// downstream code needs to manually create a row before reading.
export async function touchUser(wallet: string): Promise<void> {
  const w = normalize(wallet);
  if (!w) return;
  const now = Date.now();
  try {
    await db
      .insert(users)
      .values({
        wallet: w,
        status: "active",
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: users.wallet,
        set: { lastSeenAt: now },
      });
  } catch (e: any) {
    console.warn(`[users] touchUser(${w}) failed: ${e?.message || e}`);
  }
}

export async function getUserStatus(wallet: string): Promise<UserStatus> {
  const w = normalize(wallet);
  if (!w) return "active";
  const cached = statusCache.get(w);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  let status: UserStatus = "active";
  try {
    const rows = await db.select().from(users).where(eq(users.wallet, w)).limit(1);
    if (rows.length > 0) {
      const parsed = UserStatusEnum.safeParse(rows[0].status);
      status = parsed.success ? parsed.data : "active";
    }
  } catch (e: any) {
    // Fail OPEN for status reads — a DB blip should not block honest
    // users from playing. Bans are advisory anti-cheat, not auth: if
    // the DB is unreachable, allow play and rely on retries to catch
    // up later. This is the symmetric choice to captcha's fail-closed
    // (captcha protects deposits; soft-ban protects pairing).
    console.warn(`[users] getUserStatus(${w}) failed, treating as active: ${e?.message || e}`);
    status = "active";
  }
  statusCache.set(w, { status, expiresAt: Date.now() + CACHE_TTL_MS });
  return status;
}

export async function getUser(wallet: string): Promise<User | null> {
  const w = normalize(wallet);
  if (!w) return null;
  try {
    const rows = await db.select().from(users).where(eq(users.wallet, w)).limit(1);
    return rows[0] ?? null;
  } catch (e: any) {
    console.warn(`[users] getUser(${w}) failed: ${e?.message || e}`);
    return null;
  }
}

export interface SetUserStatusParams {
  wallet: string;
  status: UserStatus;
  reason?: string | null;
  by: string;
}

// Idempotent admin write. Inserts a row if the wallet is brand new.
// Cache is invalidated synchronously so the very next getUserStatus
// (e.g. the find-match handler one second later) sees the change.
export async function setUserStatus(params: SetUserStatusParams): Promise<User> {
  const w = normalize(params.wallet);
  if (!w) throw new Error("setUserStatus: wallet required");
  const parsed = UserStatusEnum.safeParse(params.status);
  if (!parsed.success) throw new Error(`setUserStatus: invalid status ${params.status}`);
  const status = parsed.data;
  const now = Date.now();
  const isBan = status !== "active";
  const reason = params.reason ?? null;

  await db
    .insert(users)
    .values({
      wallet: w,
      status,
      banReason: isBan ? reason : null,
      bannedAt: isBan ? now : null,
      bannedBy: isBan ? params.by : null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: users.wallet,
      set: {
        status,
        banReason: isBan ? reason : null,
        bannedAt: isBan ? now : null,
        bannedBy: isBan ? params.by : null,
        lastSeenAt: now,
      },
    });
  invalidateUserStatusCache(w);
  const updated = await getUser(w);
  if (!updated) throw new Error(`setUserStatus: row for ${w} disappeared`);
  return updated;
}

// Helper for the deposit endpoints. Returns a {ok:false, status, body}
// shape that mirrors checkDepositCaptchaForWallets so the call sites
// stay symmetrical. A hard-banned participant fails the deposit auth
// for the whole match — we don't want a banned player's opponent to
// stake real money into a match that the banned account can never
// reach matchmaking for again.
export async function checkDepositBanForWallets(
  wallets: Array<string | null | undefined>,
): Promise<
  | { ok: true }
  | { ok: false; status: number; body: { error: string; message: string; wallet: string } }
> {
  for (const w of wallets) {
    if (!w) continue;
    const status = await getUserStatus(String(w));
    if (status === "banned") {
      return {
        ok: false,
        status: 403,
        body: {
          error: "banned",
          message:
            "This match cannot be funded because one of the participants has been suspended.",
          wallet: String(w),
        },
      };
    }
  }
  return { ok: true };
}

// Test-only — drops the in-process cache so each test starts clean.
export const __testInternals = {
  cache: statusCache,
  CACHE_TTL_MS,
};
