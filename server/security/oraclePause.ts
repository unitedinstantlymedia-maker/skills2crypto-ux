// Off-chain oracle kill-switch. When set, the oracle refuses to issue
// new deposit authorisations on the named scope (or "all"). Settlement
// is intentionally NOT gated so in-flight matches still resolve.
// Toggle via POST /api/oracle/pause + X-Ops-Token header.

import { redis } from "../redis";
import { fireOpsAlert } from "./opsAlert";

export type PauseScope = "all" | "BNB" | "ETH" | "USDT" | "TON";
const SCOPES: PauseScope[] = ["all", "BNB", "ETH", "USDT", "TON"];

function key(scope: PauseScope): string {
  return `oracle:paused:${scope}`;
}

interface PauseRecord {
  paused: boolean;
  reason: string | null;
  setAt: number | null;
  setBy: string | null;
}

/**
 * Returns the pause state across all scopes. Used by /api/health.
 */
export async function getPauseStatus(): Promise<Record<PauseScope, PauseRecord>> {
  const out = {} as Record<PauseScope, PauseRecord>;
  for (const scope of SCOPES) {
    try {
      const raw = await redis.get(key(scope));
      if (raw && typeof raw === "object") {
        const o = raw as any;
        out[scope] = {
          paused: !!o.paused,
          reason: o.reason ?? null,
          setAt: o.setAt ?? null,
          setBy: o.setBy ?? null,
        };
      } else if (raw && typeof raw === "string") {
        try {
          const o = JSON.parse(raw);
          out[scope] = {
            paused: !!o.paused,
            reason: o.reason ?? null,
            setAt: o.setAt ?? null,
            setBy: o.setBy ?? null,
          };
        } catch {
          out[scope] = { paused: false, reason: null, setAt: null, setBy: null };
        }
      } else {
        out[scope] = { paused: false, reason: null, setAt: null, setBy: null };
      }
    } catch {
      out[scope] = { paused: false, reason: null, setAt: null, setBy: null };
    }
  }
  return out;
}

/**
 * True if oracle signing/dispatch should be refused for the given asset.
 * Checks both the asset-specific scope and the global "all" scope.
 *
 * Designed to fail-OPEN: if Redis is unavailable, we do NOT block the
 * platform. Operators rely on this kill-switch only when the platform
 * itself is otherwise behaving; a Redis outage is its own kind of
 * incident response.
 */
export async function isOraclePaused(asset: string): Promise<{
  paused: boolean;
  reason?: string;
  scope?: PauseScope;
}> {
  try {
    const all = await redis.get(key("all"));
    if (parsePaused(all)) {
      return { paused: true, scope: "all", reason: parseReason(all) };
    }
    const allowed = SCOPES.includes(asset as PauseScope);
    if (allowed && asset !== "all") {
      const a = await redis.get(key(asset as PauseScope));
      if (parsePaused(a)) {
        return { paused: true, scope: asset as PauseScope, reason: parseReason(a) };
      }
    }
  } catch (e: any) {
    console.warn(`[oraclePause] redis check failed (failing open): ${e?.message || e}`);
  }
  return { paused: false };
}

function parsePaused(raw: any): boolean {
  if (!raw) return false;
  if (typeof raw === "object") return !!raw.paused;
  if (typeof raw === "string") {
    try {
      return !!JSON.parse(raw).paused;
    } catch {
      return raw === "1" || raw === "true";
    }
  }
  return false;
}

function parseReason(raw: any): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "object") return raw.reason ?? undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw).reason;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function setPause(
  scope: PauseScope,
  paused: boolean,
  reason: string | null,
  setBy: string
): Promise<PauseRecord> {
  if (!SCOPES.includes(scope)) throw new Error(`invalid scope: ${scope}`);
  const record: PauseRecord = paused
    ? {
        paused: true,
        reason: reason || "manual_kill_switch",
        setAt: Date.now(),
        setBy,
      }
    : { paused: false, reason: null, setAt: null, setBy: null };
  if (paused) {
    await redis.set(key(scope), JSON.stringify(record));
    fireOpsAlert({
      key: `oracle_paused:${scope}`,
      severity: "critical",
      title: `Oracle PAUSED for scope=${scope}`,
      message: `Reason: ${record.reason}. Set by: ${setBy}. New deposits in this scope will be refused. In-flight matches will still settle.`,
      context: { scope, reason: record.reason, setBy },
    });
  } else {
    await redis.del(key(scope));
    fireOpsAlert({
      key: `oracle_unpaused:${scope}`,
      severity: "warn",
      title: `Oracle UNPAUSED for scope=${scope}`,
      message: `Set by: ${setBy}. New deposits accepted again.`,
      context: { scope, setBy },
    });
  }
  return record;
}
