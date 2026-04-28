/**
 * Client-side cache of /api/network-fees.
 *
 * Why a singleton, not a context: the existing
 * `getEstimatedNetworkFee(asset)` API on every adapter is SYNCHRONOUS
 * and called from many hot paths (Lobby, GameContext.startMatch,
 * settlement payout calc). Rewriting all of them to await would be a
 * gigantic blast radius and is overkill — a 60s server-cached snapshot
 * loaded once on app boot is plenty fresh for a wager-confirmation UI.
 *
 * Behavior:
 *   - First call to ensureFeeSnapshotLoaded() fetches /api/network-fees
 *     and caches it. Subsequent calls within REFRESH_TTL_MS are no-ops.
 *   - getCachedAssetFee(asset) returns the live native fee in coin
 *     units (BNB / ETH / TRX / TON), or `null` if the snapshot hasn't
 *     loaded yet — callers fall back to the legacy hard-coded value
 *     so the UI never goes blank during the first ~200ms of boot.
 *   - subscribeFeeSnapshot(cb) lets components re-render after the
 *     first load completes, so the wager UI updates from "$0.25 (est)"
 *     to the real number without requiring a route change.
 */

import { apiUrl } from "@/lib/api";

interface ChainFeeEstimate {
  asset: string;
  chain: string;
  nativeFee: number;
  note: string;
  estimatedAt: number | null;
  error?: string;
}

interface FeeSnapshot {
  fees: Record<string, ChainFeeEstimate>;
  pricesUsd: Record<string, number>;
  fetchedAt: number;
}

const REFRESH_TTL_MS = 60_000;
let snapshot: FeeSnapshot | null = null;
let inflight: Promise<FeeSnapshot | null> | null = null;
let lastAttemptAt = 0;
const subscribers = new Set<() => void>();

async function fetchOnce(): Promise<FeeSnapshot | null> {
  try {
    const res = await fetch(apiUrl("/api/network-fees"));
    if (!res.ok) return null;
    const data = (await res.json()) as FeeSnapshot;
    snapshot = data;
    subscribers.forEach((cb) => cb());
    return data;
  } catch {
    return null;
  }
}

export async function ensureFeeSnapshotLoaded(): Promise<FeeSnapshot | null> {
  const now = Date.now();
  if (snapshot && now - snapshot.fetchedAt < REFRESH_TTL_MS) return snapshot;
  if (inflight) return inflight;
  // Throttle failed-retry storms.
  if (!snapshot && now - lastAttemptAt < 5_000) return null;
  lastAttemptAt = now;
  inflight = fetchOnce().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function getCachedSnapshot(): FeeSnapshot | null {
  return snapshot;
}

export function getCachedAssetFee(asset: string): number | null {
  if (!snapshot) return null;
  const f = snapshot.fees[asset];
  return f && Number.isFinite(f.nativeFee) ? f.nativeFee : null;
}

export function getCachedAssetPriceUsd(asset: string): number | null {
  if (!snapshot) return null;
  const p = snapshot.pricesUsd[asset];
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

export function subscribeFeeSnapshot(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
