// Periodic DB ↔ on-chain reconciliation. Scans the last N hours of
// matches rows and verifies each chain's escrow status === Settled.
// Read-only, idempotent. Discrepancies are logged and fire an ops alert.
// Summary cached for /api/health/oracles.

import { db } from "../db";
import { matches, type Match } from "../../shared/schema";
import { gte } from "drizzle-orm";
import { fireOpsAlert } from "./opsAlert";

const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 10 * 60_000);
const RECONCILE_LOOKBACK_HOURS = Number(process.env.RECONCILE_LOOKBACK_HOURS ?? 24);

const STATUS_LABELS: Record<number, string> = {
  0: "None",
  1: "Authorized",
  2: "Active",
  3: "Settled",
  4: "Refunded",
};

interface ReconcileSummary {
  ranAt: number | null;
  durationMs: number | null;
  scannedRows: number;
  ok: number;
  notFoundOnChain: number;
  pendingOnChain: number;
  divergent: number;
  errors: number;
  details: Array<{
    matchId: string;
    asset: string;
    issue: "not_found" | "pending_on_chain" | "divergent" | "error";
    onChainStatus?: number;
    onChainStatusLabel?: string;
    error?: string;
  }>;
}

let _last: ReconcileSummary = {
  ranAt: null,
  durationMs: null,
  scannedRows: 0,
  ok: 0,
  notFoundOnChain: 0,
  pendingOnChain: 0,
  divergent: 0,
  errors: 0,
  details: [],
};
let _started = false;

export function getReconciliationStatus(): ReconcileSummary {
  return _last;
}

async function checkEvm(asset: "BNB" | "ETH", matchId: string): Promise<{
  status: number;
  found: boolean;
}> {
  const { createEvmOracle } = await import("../oracle/evmOracle");
  const o = createEvmOracle(asset === "ETH" ? "ETH" : "BSC");
  const m = await o.getMatchOnChain(matchId);
  // EVM oracle returns { status, ... } where status === 0 means the
  // contract has no record for that matchId.
  return { status: m.status, found: m.status !== 0 };
}

async function checkTron(matchId: string): Promise<{ status: number; found: boolean }> {
  const { createTronOracle } = await import("../oracle/tronOracle");
  const o = createTronOracle();
  const m = await o.getMatchOnChain(matchId);
  return { status: m.status, found: m.status !== 0 };
}

async function checkTon(matchId: string): Promise<{ status: number; found: boolean }> {
  const { createTonOracle } = await import("../oracle/tonOracle");
  const o = createTonOracle();
  // TON's getMatchOnChain returns null when no match exists for the
  // matchId hash (the get-method exits cleanly). Treat that as
  // "not found" without raising.
  const m = await o.getMatchOnChain(matchId);
  if (!m) return { status: 0, found: false };
  return { status: m.status, found: m.status !== 0 };
}

async function checkOne(row: Match): Promise<{
  issue: "ok" | "not_found" | "pending_on_chain" | "divergent" | "error";
  status?: number;
  error?: string;
}> {
  const asset = String(row.asset);
  try {
    let res: { status: number; found: boolean };
    if (asset === "BNB" || asset === "ETH") {
      res = await checkEvm(asset, row.matchId);
    } else if (asset === "USDT") {
      res = await checkTron(row.matchId);
    } else if (asset === "TON") {
      res = await checkTon(row.matchId);
    } else {
      return { issue: "error", error: `unknown asset ${asset}` };
    }
    if (!res.found) {
      // DB has a settled match but contract has no record. This can
      // only happen for "never_started" / disconnect-without-deposit
      // matches where storeGameResult intentionally writes a 0-payout
      // row. Treat as "not_found" rather than divergent — the ops
      // person can decide.
      return { issue: "not_found" };
    }
    if (res.status === 3 || res.status === 4) {
      return { issue: "ok", status: res.status };
    }
    if (res.status === 1 || res.status === 2) {
      return { issue: "pending_on_chain", status: res.status };
    }
    return { issue: "divergent", status: res.status };
  } catch (e: any) {
    return { issue: "error", error: e?.message || String(e) };
  }
}

export async function runReconciliationOnce(): Promise<ReconcileSummary> {
  const t0 = Date.now();
  const cutoff = t0 - RECONCILE_LOOKBACK_HOURS * 3600_000;

  const summary: ReconcileSummary = {
    ranAt: t0,
    durationMs: null,
    scannedRows: 0,
    ok: 0,
    notFoundOnChain: 0,
    pendingOnChain: 0,
    divergent: 0,
    errors: 0,
    details: [],
  };

  let rows: Match[] = [];
  try {
    rows = await db.select().from(matches).where(gte(matches.timestamp, cutoff));
  } catch (e: any) {
    summary.errors += 1;
    summary.durationMs = Date.now() - t0;
    summary.details.push({
      matchId: "(scan)",
      asset: "(scan)",
      issue: "error",
      error: `DB scan failed: ${e?.message || e}`,
    });
    fireOpsAlert({
      key: "reconcile:db_scan_failed",
      severity: "warn",
      title: "Reconciliation: DB scan failed",
      message: e?.message || String(e),
    });
    _last = summary;
    return summary;
  }
  summary.scannedRows = rows.length;

  // Bound concurrency to avoid hammering RPCs.
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];
      // Skip rows that recorded a 0 payout AND have a 'never_started' /
      // 'disconnect' reason — these are accounting-only rows where no
      // on-chain match was ever created.
      const skipReasons = new Set([
        "never_started",
        "double_disconnect",
        "no_deposit",
      ]);
      if (
        Number(row.payout) === 0 &&
        Number(row.pot) === 0 &&
        skipReasons.has(String(row.reason || ""))
      ) {
        continue;
      }
      const r = await checkOne(row);
      if (r.issue === "ok") {
        summary.ok += 1;
      } else if (r.issue === "not_found") {
        summary.notFoundOnChain += 1;
        summary.details.push({
          matchId: row.matchId,
          asset: row.asset,
          issue: "not_found",
        });
      } else if (r.issue === "pending_on_chain") {
        summary.pendingOnChain += 1;
        summary.details.push({
          matchId: row.matchId,
          asset: row.asset,
          issue: "pending_on_chain",
          onChainStatus: r.status,
          onChainStatusLabel: STATUS_LABELS[r.status!] || String(r.status),
        });
      } else if (r.issue === "divergent") {
        summary.divergent += 1;
        summary.details.push({
          matchId: row.matchId,
          asset: row.asset,
          issue: "divergent",
          onChainStatus: r.status,
          onChainStatusLabel: STATUS_LABELS[r.status!] || String(r.status),
        });
      } else {
        summary.errors += 1;
        summary.details.push({
          matchId: row.matchId,
          asset: row.asset,
          issue: "error",
          error: r.error,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  summary.durationMs = Date.now() - t0;

  if (summary.divergent > 0) {
    fireOpsAlert({
      key: "reconcile:divergent",
      severity: "critical",
      title: `Reconciliation: ${summary.divergent} divergent matches`,
      message: `Found ${summary.divergent} match(es) where DB says settled but on-chain status is unexpected. Inspect /api/health/oracles for details.`,
      context: {
        divergent: summary.divergent,
        firstFew: summary.details.filter((d) => d.issue === "divergent").slice(0, 5),
      },
    });
  }
  if (summary.errors >= 5) {
    fireOpsAlert({
      key: "reconcile:errors",
      severity: "warn",
      title: `Reconciliation: ${summary.errors} errors`,
      message: "Reconciliation produced multiple per-row errors — check RPC health.",
    });
  }
  console.log(
    `[reconcile] scanned=${summary.scannedRows} ok=${summary.ok} not_found=${summary.notFoundOnChain} pending=${summary.pendingOnChain} divergent=${summary.divergent} errors=${summary.errors} took=${summary.durationMs}ms`
  );
  _last = summary;
  return summary;
}

export function startReconciliation(): void {
  if (_started) return;
  _started = true;
  // Don't block startup; first run after a short delay.
  setTimeout(() => {
    runReconciliationOnce().catch((e) =>
      console.warn(`[reconcile] first run failed: ${e?.message || e}`)
    );
  }, 30_000);
  const t = setInterval(() => {
    runReconciliationOnce().catch((e) =>
      console.warn(`[reconcile] periodic run failed: ${e?.message || e}`)
    );
  }, RECONCILE_INTERVAL_MS);
  if (typeof t.unref === "function") t.unref();
  console.log(
    `[reconcile] scheduled every ${RECONCILE_INTERVAL_MS}ms over ${RECONCILE_LOOKBACK_HOURS}h window`
  );
}
