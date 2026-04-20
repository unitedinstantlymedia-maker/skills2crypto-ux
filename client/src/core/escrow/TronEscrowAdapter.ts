import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 80;
const USDT_TRC20_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const APPROVE_TRX_REQUIRED = 30; // safe upper bound for USDT approve energy.

interface TronDepositAuth {
  matchId: string;
  matchIdBytes32: string;
  player1: string;
  player2: string;
  player1EvmHex: string;
  player2EvmHex: string;
  stake: string;
  nonce1: string;
  nonce2: string;
  escrowAddressEvmHex: string;
  escrowAddressBase58: string;
  chainId: number;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, Array<{ name: string; type: string }>>;
}

async function fetchDepositAuth(matchId: string): Promise<TronDepositAuth> {
  const res = await fetch("/api/tron/deposit-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId }),
  });
  const data = await res.json().catch(() => ({ error: "Invalid response" }));
  if (!res.ok) throw new Error(data?.error || `deposit-auth HTTP ${res.status}`);
  return data as TronDepositAuth;
}

async function submitDepositSig(matchId: string, signature: string): Promise<{ status: number }> {
  const res = await fetch("/api/tron/deposit-sig", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId, signature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `deposit-sig HTTP ${res.status}`);
  return data;
}

async function fetchTronMatchStatus(matchId: string): Promise<{ status: number }> {
  const res = await fetch(`/api/tron/match-status/${encodeURIComponent(matchId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `tron-match-status HTTP ${res.status}`);
  return data;
}

/**
 * V2: the player pays their own TRX for the one-time approve(escrow, MAX).
 * Settlement and per-match deposits are gasless (oracle covers them, funded
 * by the contract's 0.5% gas-fund + on-chain SunSwap auto-swap).
 */
async function ensureUsdtApproval(escrowBase58: string, requiredUnits: bigint): Promise<boolean> {
  const tw = (window as any).tronWeb;
  if (!tw || !tw.ready || !tw.defaultAddress?.base58) {
    throw new Error("TronLink is not connected");
  }

  const usdt = await tw.contract().at(USDT_TRC20_BASE58);
  const owner = tw.defaultAddress.base58;
  const allowanceRaw = await usdt.allowance(owner, escrowBase58).call();
  const allowance = BigInt(allowanceRaw.toString());
  if (allowance >= requiredUnits) return true;

  const balanceSun: number = await tw.trx.getBalance(owner);
  const balanceTrx = balanceSun / 1_000_000;
  if (balanceTrx < APPROVE_TRX_REQUIRED) {
    throw new Error(
      `Need ~${APPROVE_TRX_REQUIRED} TRX for the one-time USDT approve. Wallet has ${balanceTrx.toFixed(2)} TRX.`
    );
  }

  console.log(`[TronEscrow] Sending approve(escrow, MAX)`);
  const MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  await usdt.approve(escrowBase58, MAX).send({ feeLimit: 100_000_000 });
  return true;
}

async function fetchTronEscrowAddress(): Promise<string> {
  const r = await fetch("/api/tron/config");
  if (!r.ok) throw new Error("Could not load Tron escrow address");
  const data = await r.json();
  (window as any).__TRON_ESCROW_ADDRESS__ = data.escrowBase58;
  return data.escrowBase58;
}

/**
 * Pre-flight readiness ensure for the SEARCH path. V2 only needs allowance
 * ≥ stake (no gasReserve buffer).
 */
export async function ensureTronUsdtReadyForStake(stakeUsdt: number): Promise<void> {
  const tw = (window as any).tronWeb;
  if (!tw || !tw.ready || !tw.defaultAddress?.base58) {
    throw new Error("TronLink is not connected");
  }
  const owner = tw.defaultAddress.base58;
  const r = await fetch(
    `/api/tron/readiness?wallet=${encodeURIComponent(owner)}&stake=${encodeURIComponent(String(stakeUsdt))}`
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || "readiness check failed");
  if (data.approveReady) return;
  if (!data.trxReady) {
    throw new Error(
      data?.message ||
        `Wallet needs ~${data?.approveTrxCostEstimate ?? APPROVE_TRX_REQUIRED} TRX for the one-time USDT approve.`
    );
  }

  const escrowBase58 = (window as any).__TRON_ESCROW_ADDRESS__ || (await fetchTronEscrowAddress());
  // V2 onboarding: we must trigger a real `approve(escrow, MAX)`, not a
  // single-stake approve. Server matchmaking gates on `allowance >= 2^255`
  // and would reject a stake-only approval. Passing MAX_HALF here forces
  // ensureUsdtApproval to send the MAX approve (since allowance < MAX_HALF
  // is true for any stake-only approval).
  const MAX_HALF = 1n << 255n;
  await ensureUsdtApproval(escrowBase58, MAX_HALF);
}

export class TronEscrowAdapter {
  getEstimatedNetworkFee(asset: Asset): number {
    const price = ASSET_PRICES_USD[asset];
    if (!price) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  /**
   * V2 player flow:
   * 1. Fetch oracle-built EIP-712 Deposit auth.
   * 2. Ensure USDT approval ≥ stake (player pays own TRX once).
   * 3. Sign typed-data via TronLink and POST to server.
   * 4. Server bundles both sigs and broadcasts depositUSDT (oracle pays TRX,
   *    auto-recouped via 0.5% gas-fund + SunSwap).
   * 5. Poll until on-chain status === Active.
   */
  async lockFunds(matchId: string, asset: Asset, _stake: number): Promise<boolean> {
    if (asset !== "USDT") {
      console.warn(`[TronEscrow] lockFunds called for non-USDT asset ${asset} — ignoring`);
      return false;
    }
    const tw = (window as any).tronWeb;
    if (!tw || !tw.ready || !tw.defaultAddress?.base58) {
      console.error(`[TronEscrow] TronLink not connected`);
      return false;
    }
    const me = tw.defaultAddress.base58;

    let auth: TronDepositAuth;
    try {
      auth = await fetchDepositAuth(matchId);
    } catch (e: any) {
      console.error(`[TronEscrow] deposit-auth failed:`, e?.message || e);
      return false;
    }
    if (me !== auth.player1 && me !== auth.player2) {
      console.error(`[TronEscrow] connected wallet ${me} is not in this match`);
      return false;
    }

    try {
      // Per-deposit gate also requires the MAX approve to be in place — the
      // contract pulls only `stake`, but the server pre-flight checks
      // `allowance >= 2^255` so that the approval can't deplete mid-session.
      const MAX_HALF = 1n << 255n;
      await ensureUsdtApproval(auth.escrowAddressBase58, MAX_HALF);
    } catch (e: any) {
      console.error(`[TronEscrow] USDT approval failed:`, e?.message || e);
      return false;
    }

    const myNonce = me === auth.player1 ? auth.nonce1 : auth.nonce2;
    const value = {
      matchId: auth.matchIdBytes32,
      stake: auth.stake,
      nonce: myNonce,
    };

    let signature: string;
    try {
      signature = await tw.trx._signTypedData(auth.domain, auth.types, value);
    } catch (_e1) {
      try {
        signature = await tw.trx.signTypedData(auth.domain, auth.types, value);
      } catch (e2: any) {
        console.error(`[TronEscrow] sign typed-data failed:`, e2?.message || e2);
        return false;
      }
    }

    try {
      await submitDepositSig(matchId, signature);
    } catch (e: any) {
      console.error(`[TronEscrow] deposit-sig submit failed:`, e?.message || e);
      return false;
    }

    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      try {
        const s = await fetchTronMatchStatus(matchId);
        if (s.status === 1) return true;
        if (s.status === 2) {
          console.warn(`[TronEscrow] match ${matchId} already settled`);
          return false;
        }
      } catch (e: any) {
        console.warn(`[TronEscrow] poll ${i + 1} failed:`, e?.message || e);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.warn(`[TronEscrow] match ${matchId} did not become Active within timeout`);
    return false;
  }

  async settleMatch(
    matchId: string,
    asset: Asset,
    stake: number,
    result: 'win' | 'loss' | 'draw'
  ): Promise<{ payout: number; fee: number }> {
    // Tron USDT settlement is fully oracle-driven (gasless for players).
    const safeStake = Number(stake);
    const pot = safeStake * 2;
    const blockchainFeePerPlayer = this.getEstimatedNetworkFee(asset);
    const totalBlockchainFee = blockchainFeePerPlayer * 2;
    const totalPlatformFee = pot * FEE_RATE;

    let payout = 0;
    let fee = 0;
    if (result === 'win') {
      payout = pot - totalPlatformFee - totalBlockchainFee;
      fee = totalPlatformFee + totalBlockchainFee;
    } else if (result === 'draw') {
      payout = safeStake - totalPlatformFee / 2 - totalBlockchainFee / 2;
      fee = totalPlatformFee / 2 + totalBlockchainFee / 2;
    }
    console.log(`[TronEscrow] Match ${matchId} result: ${result} (server-settled)`);
    return { payout, fee };
  }
}

export const tronEscrowAdapter = new TronEscrowAdapter();
