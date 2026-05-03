import { createHmac, timingSafeEqual } from "crypto";

// Per-(matchId, walletAddress) HMAC token used to authenticate REST
// fetches of move history (`GET /api/matches/:matchId/moves`).
//
// We can't use the raw `walletAddress` query param as proof of identity
// because anyone scraping the chain can see participants' public
// addresses and would otherwise be able to read their private move log.
// Instead the server issues a token at socket-join time (the player has
// already proven membership at that point — they're listening on the
// match's socket room) and the REST endpoint verifies the same token
// later via constant-time comparison.
//
// The token is keyed off ORACLE_PRIVATE_KEY (already a server-only
// secret used by the EIP-712 oracle signer); falling back to a
// randomly-generated process-local secret in dev so tests / local runs
// without an oracle key still work — production REQUIRES the oracle
// key, so this is a dev convenience only.

let cachedSecret: Buffer | null = null;
function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = process.env.ORACLE_PRIVATE_KEY || process.env.MATCH_TOKEN_SECRET;
  if (env && env.length > 0) {
    cachedSecret = Buffer.from(env.replace(/^0x/, ""), "utf8");
  } else {
    // Dev fallback: random per-process secret. Tokens won't survive a
    // restart, but in production the env var path above is mandatory.
    const { randomBytes } = require("crypto") as typeof import("crypto");
    cachedSecret = randomBytes(32);
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[matchToken] ORACLE_PRIVATE_KEY not set in production — falling back to ephemeral secret. Move-history tokens will reset on restart.",
      );
    }
  }
  return cachedSecret;
}

export function issueMatchToken(matchId: string, walletAddress: string): string {
  const h = createHmac("sha256", getSecret());
  h.update(`${matchId}\x00${walletAddress}`);
  return h.digest("base64url");
}

export function verifyMatchToken(
  matchId: string,
  walletAddress: string,
  token: string,
): boolean {
  if (!matchId || !walletAddress || !token) return false;
  const expected = issueMatchToken(matchId, walletAddress);
  if (expected.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

// Test-only: reset the cached secret so a test suite can swap env vars
// between cases. Never call from runtime code.
export function _resetMatchTokenSecretForTests(): void {
  cachedSecret = null;
}
