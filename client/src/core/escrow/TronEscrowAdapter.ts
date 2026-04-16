import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 80;

interface TronDepositAuth {
  matchId: string;
  matchIdBytes32: string;
  player1: string; // Tron base58
  player2: string;
  player1EvmHex: string;
  player2EvmHex: string;
  stake: string;
  nonce1: string;
  nonce2: string;
  escrowAddressEvmHex: string;
  escrowAddressBase58: string;
  chainId: number;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
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
 * Ensure the player has approved the escrow contract to spend USDT TRC-20.
 * Approves max uint256 once so subsequent matches require no further approvals.
 * Returns true if allowance is sufficient (or just became sufficient).
 */
async function ensureUsdtApproval(escrowBase58: string, requiredUnits: bigint): Promise<boolean> {
  const tw = (window as any).tronWeb;
  if (!tw || !tw.ready || !tw.defaultAddress?.base58) {
    throw new Error("TronLink is not connected");
  }

  const usdt = await tw.contract().at("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  const owner = tw.defaultAddress.base58;
  const allowanceRaw = await usdt.allowance(owner, escrowBase58).call();
  const allowance = BigInt(allowanceRaw.toString());

  if (allowance >= requiredUnits) {
    return true;
  }

  console.log(`[TronEscrow] Allowance insufficient — sending approve()`);
  // Max uint256
  const MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  await usdt.approve(escrowBase58, MAX).send({ feeLimit: 100_000_000 });
  return true;
}

export class TronEscrowAdapter {
  getEstimatedNetworkFee(asset: Asset): number {
    const price = ASSET_PRICES_USD[asset];
    if (!price) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  /**
   * Player-side flow for USDT TRC-20:
   * 1. Fetch oracle-built EIP-712 Deposit auth.
   * 2. Ensure USDT allowance to escrow (one-time approve, paid by player in TRX).
   * 3. Sign the Deposit typed-data via TronLink.
   * 4. POST signature to server. Once both players have submitted, server
   *    bundles them and calls depositUSDT on-chain (oracle pays TRX gas).
   * 5. Poll match-status until on-chain status === Active.
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

    // Stake + gas reserve estimate. Approve max so this never blocks future matches.
    try {
      await ensureUsdtApproval(auth.escrowAddressBase58, BigInt(auth.stake) * 2n);
    } catch (e: any) {
      console.error(`[TronEscrow] USDT approval failed:`, e?.message || e);
      return false;
    }

    const myNonce = me === auth.player1 ? auth.nonce1 : auth.nonce2;

    const value = {
      matchId: auth.matchIdBytes32,
      stake: auth.stake,
      assetType: 0,
      nonce: myNonce,
    };

    let signature: string;
    try {
      // TronLink TIP-712 signing — accepts the same EIP-712 shape used by EvmEscrowAdapter.
      signature = await tw.trx._signTypedData(auth.domain, auth.types, value);
    } catch (e: any) {
      // Fallback: some TronLink versions use signTypedData
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

    // Poll until both players have submitted and the oracle has called depositUSDT.
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      try {
        const s = await fetchTronMatchStatus(matchId);
        if (s.status === 1) {
          console.log(`[TronEscrow] match ${matchId} fully funded (Active)`);
          return true;
        }
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

    console.log(`[TronEscrow] Match ${matchId} result: ${result} (settlement handled server-side)`);
    return { payout, fee };
  }
}

export const tronEscrowAdapter = new TronEscrowAdapter();
