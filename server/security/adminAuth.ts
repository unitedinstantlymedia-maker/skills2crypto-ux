import type { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import { redis } from "../redis";

// Anti-cheat L1 — admin endpoint auth (Task #46).
//
// Every admin write is signed by the calling wallet. We require:
//   - X-Admin-Wallet:    EVM address (0x..40)
//   - X-Admin-Timestamp: unix-ms, must be within ADMIN_REQUEST_WINDOW_MS
//   - X-Admin-Nonce:     random hex (>=16 chars). Stored in Redis for
//                        ADMIN_NONCE_TTL_MS so a captured request cannot
//                        be replayed inside the timestamp window.
//   - X-Admin-Signature: EVM personal_sign over the canonical string
//                        `S2C-ADMIN|<METHOD>|<PATH>|<BODY-SHA256>|<TS>|<NONCE>`
//
// The wallet must appear in ADMIN_WALLET_ALLOWLIST (comma-separated
// env). Missing/empty allowlist → all admin endpoints are disabled
// (503) so a fresh deploy that forgot to set the env doesn't leave the
// admin surface wide open.

const ADMIN_REQUEST_WINDOW_MS = 60_000;
const ADMIN_NONCE_TTL_MS = 120_000;

function adminAllowlist(): string[] {
  const raw = (process.env.ADMIN_WALLET_ALLOWLIST || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

export function isAdminWallet(wallet: string): boolean {
  const w = (wallet || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w)) return false;
  return adminAllowlist().includes(w);
}

async function sha256Hex(data: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function buildSignedMessage(parts: {
  method: string;
  path: string;
  bodyHash: string;
  timestamp: string;
  nonce: string;
}): string {
  return `S2C-ADMIN|${parts.method}|${parts.path}|${parts.bodyHash}|${parts.timestamp}|${parts.nonce}`;
}

export interface AdminAuthContext {
  wallet: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminAuth?: AdminAuthContext;
    }
  }
}

export async function requireAdminWallet(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const allowlist = adminAllowlist();
  if (allowlist.length === 0) {
    res.status(503).json({
      error: "admin_disabled",
      message: "Admin endpoints are not configured on this deployment.",
    });
    return;
  }

  const wallet = String(req.header("x-admin-wallet") || "").toLowerCase();
  const timestamp = String(req.header("x-admin-timestamp") || "");
  const nonce = String(req.header("x-admin-nonce") || "");
  const signature = String(req.header("x-admin-signature") || "");

  if (!wallet || !timestamp || !nonce || !signature) {
    res.status(401).json({ error: "admin_auth_required", message: "Missing admin auth headers." });
    return;
  }
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    res.status(401).json({ error: "admin_auth_invalid", message: "Bad wallet shape." });
    return;
  }
  if (!allowlist.includes(wallet)) {
    res.status(403).json({ error: "not_admin", message: "This wallet is not authorised." });
    return;
  }
  if (nonce.length < 16) {
    res.status(401).json({ error: "admin_auth_invalid", message: "Nonce too short." });
    return;
  }

  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > ADMIN_REQUEST_WINDOW_MS) {
    res.status(401).json({
      error: "admin_auth_expired",
      message: "Request timestamp outside the allowed window.",
    });
    return;
  }

  // One-shot nonce — refuse a second admin request that reuses it
  // inside the replay window (which is 2× the timestamp window so a
  // captured request can never be replayed even at the boundary).
  const nonceKey = `admin:nonce:${wallet}:${nonce}`;
  const setRes = await redis.set(nonceKey, "1", {
    ex: Math.ceil(ADMIN_NONCE_TTL_MS / 1000),
    nx: true,
  });
  if (setRes === null) {
    res.status(401).json({ error: "admin_auth_replay", message: "Nonce already used." });
    return;
  }

  const rawBody =
    req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : "";
  const bodyHash = await sha256Hex(rawBody);
  const message = buildSignedMessage({
    method: req.method.toUpperCase(),
    path: req.path,
    bodyHash,
    timestamp,
    nonce,
  });

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch (e: any) {
    res.status(401).json({
      error: "admin_auth_invalid",
      message: `Signature verification failed: ${e?.message || e}`,
    });
    return;
  }
  if (recovered !== wallet) {
    res.status(401).json({
      error: "admin_auth_invalid",
      message: "Signature does not match wallet.",
    });
    return;
  }

  req.adminAuth = { wallet };
  next();
}

// Test-only — exposes the canonical message builder so tests can sign
// requests with a deterministic key.
export const __testInternals = {
  buildSignedMessage,
  sha256Hex,
  ADMIN_REQUEST_WINDOW_MS,
  ADMIN_NONCE_TTL_MS,
};
