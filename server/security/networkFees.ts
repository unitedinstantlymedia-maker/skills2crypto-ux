/**
 * Live network-fee estimator for the four supported chains.
 *
 * Why: the client used to display NETWORK_FEE_USD_PER_PLAYER = 0 in
 * the wager-confirmation UI, which was a lie — players ALWAYS pay
 * gas (even Tron's "gasless" deposit costs the player ~25-50 TRX
 * for the one-time approve). This module surfaces real numbers per
 * chain so the UI can show the player what they'll actually pay.
 *
 * For each chain we estimate the SETTLE-side gas (the deposit-side
 * gas is shown elsewhere via /api/tron/readiness for Tron, and is
 * paid implicitly by the wallet for EVM). Settle is the relevant
 * number for the payout breakdown the user sees.
 *
 * Cache: 60s. Concurrent callers share the same in-flight promise.
 *
 * Wired to: /api/network-fees (loose rate-limited, public).
 */

import { ethers } from "ethers";

interface ChainFeeEstimate {
  asset: string;
  chain: string;
  // Estimated gas/energy cost denominated in the chain's NATIVE coin
  // (BNB / ETH / TRX / TON). UI converts to USD using the per-asset
  // price oracle the user is already holding for the wager.
  nativeFee: number;
  // Free-form note shown on hover ("approx settle gas at 5 gwei").
  note: string;
  // If estimation failed, we surface a conservative upper bound
  // tagged `estimatedAt: null` so the UI can mark it as "approximate"
  // rather than display a fake live number.
  estimatedAt: number | null;
  error?: string;
}

interface FeeSnapshot {
  fees: Record<string, ChainFeeEstimate>;
  pricesUsd: Record<string, number>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
let _cache: FeeSnapshot | null = null;
let _inflight: Promise<FeeSnapshot> | null = null;

// Conservative settle-side gas budgets per chain. Real estimation
// happens at runtime; these are the fallbacks if the RPC is down.
const FALLBACK_SETTLE_GAS_EVM = 120_000n;
const FALLBACK_GAS_PRICE_BSC_GWEI = 3n;
const FALLBACK_GAS_PRICE_ETH_GWEI = 25n;
const FALLBACK_TRON_SETTLE_TRX = 30; // Oracle-paid; surfaced for transparency.
const FALLBACK_TON_FEE = 0.05; // ~0.05 TON observed for settleMatch in V2.

// Hard-coded minimal price source so the UI works even if no external
// price oracle is configured. The numbers are intentionally
// conservative (rounded down in the user's favor) — replace with a
// real CoinGecko/Chainlink fetch in a follow-up. Each fee is shown
// alongside the asset price so the user can sanity-check.
async function fetchPricesUsd(): Promise<Record<string, number>> {
  return {
    BNB: Number(process.env.PRICE_BNB_USD ?? 600),
    ETH: Number(process.env.PRICE_ETH_USD ?? 3000),
    TRX: Number(process.env.PRICE_TRX_USD ?? 0.12),
    TON: Number(process.env.PRICE_TON_USD ?? 5),
    USDT: 1,
  };
}

async function estimateEvm(chain: "BSC" | "ETH"): Promise<ChainFeeEstimate> {
  const asset = chain === "BSC" ? "BNB" : "ETH";
  try {
    const rpc =
      chain === "BSC"
        ? process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org"
        : process.env.ETH_RPC_URL || "https://ethereum.publicnode.com";
    const provider = new ethers.JsonRpcProvider(rpc);
    const feeData = await provider.getFeeData();
    // viem-equivalent: prefer maxFeePerGas (EIP-1559) when present, else gasPrice.
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    if (gasPrice === 0n) {
      throw new Error("RPC returned zero gas price");
    }
    const gasUnits = FALLBACK_SETTLE_GAS_EVM;
    const weiCost = gasUnits * gasPrice;
    const nativeFee = Number(ethers.formatEther(weiCost));
    return {
      asset,
      chain,
      nativeFee,
      note: `~${gasUnits.toString()} gas × ${ethers.formatUnits(gasPrice, "gwei")} gwei (live)`,
      estimatedAt: Date.now(),
    };
  } catch (e: any) {
    const fallbackGwei =
      chain === "BSC" ? FALLBACK_GAS_PRICE_BSC_GWEI : FALLBACK_GAS_PRICE_ETH_GWEI;
    const wei = FALLBACK_SETTLE_GAS_EVM * fallbackGwei * 10n ** 9n;
    return {
      asset,
      chain,
      nativeFee: Number(ethers.formatEther(wei)),
      note: `Fallback: ${FALLBACK_SETTLE_GAS_EVM.toString()} gas × ${fallbackGwei} gwei`,
      estimatedAt: null,
      error: String(e?.message || e),
    };
  }
}

async function estimateTron(): Promise<ChainFeeEstimate> {
  // Tron settlement is paid by the oracle (not the player) — but the
  // player pays a one-time approve(). We surface BOTH numbers so the
  // wager UI can be truthful: "Gas paid: 25-50 TRX (one-time approve;
  // settles are paid by the platform)."
  try {
    const { createTronOracle } = await import("../oracle/tronOracle");
    const oracle = createTronOracle();
    // Use the oracle wallet itself as the dummy approver — its balance
    // is irrelevant for triggerConstantContract. This gives a real
    // chain-priced estimate even when no specific player wallet is in
    // scope.
    const est = await oracle.estimateApproveTrxCost(oracle.oracleAddress);
    return {
      asset: "USDT",
      chain: "TRON",
      nativeFee: est.trx,
      note: `One-time approve(): ~${est.energy} energy × current rate. Settles paid by platform.`,
      estimatedAt: Date.now(),
    };
  } catch (e: any) {
    return {
      asset: "USDT",
      chain: "TRON",
      nativeFee: FALLBACK_TRON_SETTLE_TRX,
      note: "Fallback: ~30 TRX one-time approve. Settles paid by platform.",
      estimatedAt: null,
      error: String(e?.message || e),
    };
  }
}

async function estimateTon(): Promise<ChainFeeEstimate> {
  // TON's settleMatch consistently costs ~0.05 TON (network gas + storage
  // delta) in V2. There's no cheap way to live-estimate this from off-chain
  // — TVM execution cost depends on the actual cell tree at runtime. We
  // expose the empirically-observed value with `estimatedAt: null` so the
  // UI tags it as "approximate".
  return {
    asset: "TON",
    chain: "TON",
    nativeFee: FALLBACK_TON_FEE,
    note: "~0.05 TON (empirical settleMatch cost in V2)",
    estimatedAt: null,
  };
}

async function buildSnapshot(): Promise<FeeSnapshot> {
  const [bsc, eth, tron, ton, prices] = await Promise.all([
    estimateEvm("BSC"),
    estimateEvm("ETH"),
    estimateTron(),
    estimateTon(),
    fetchPricesUsd(),
  ]);
  return {
    fees: { BNB: bsc, ETH: eth, USDT: tron, TON: ton },
    pricesUsd: prices,
    fetchedAt: Date.now(),
  };
}

export async function getNetworkFees(): Promise<FeeSnapshot> {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = buildSnapshot()
    .then((s) => {
      _cache = s;
      return s;
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}
