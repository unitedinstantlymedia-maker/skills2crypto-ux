/**
 * Per-asset wallet-address shape validation.
 *
 * This used to live as inline regex inside server/routes.ts (find-match
 * + create-challenge + accept-challenge). Pulled out so:
 *   - The same logic is enforced at every entry point.
 *   - It can be unit-tested in vitest without booting the express app.
 *   - The client can re-use it later (e.g. to disable the "Find Match"
 *     button before the request even fires).
 *
 * Note: TON addresses come in EQ/UQ/raw and several testnet variants;
 * we only check non-empty here and let the TON SDK do canonical
 * parsing inside the deposit-info path. This matches the historical
 * behaviour exactly.
 */

export type SupportedAsset = "BNB" | "ETH" | "USDT" | "TON";

export function isValidWalletShape(asset: string, address: string): boolean {
  if (typeof address !== "string" || address.length === 0) return false;
  if (asset === "BNB" || asset === "ETH") {
    return /^0x[0-9a-fA-F]{40}$/.test(address);
  }
  if (asset === "USDT") {
    // Tron base58 mainnet addresses always start with T and are 34 chars total.
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  }
  if (asset === "TON") {
    // Bare presence check — full canonicalisation happens downstream.
    return address.trim().length > 0;
  }
  return false;
}
