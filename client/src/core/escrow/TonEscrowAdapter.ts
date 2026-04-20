import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 100;

interface TonDepositInfo {
  matchId: string;
  escrowAddress: string;
  amountNano: string;
  payloadBoc: string;
  validUntilSec: number;
}

interface TonMatchStatus {
  status: number; // 0 none, 1 pending, 2 active, 3 settled
  p1Funded: boolean;
  p2Funded: boolean;
}

interface TonSettleAuth {
  matchId: string;
  chain: "TON";
  winner: string;
  reason: number;
  payloadBoc: string;
  signatureHex: string;
  escrowAddress: string;
}

async function fetchDepositInfo(matchId: string): Promise<TonDepositInfo> {
  const r = await fetch("/api/ton/deposit-info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `deposit-info HTTP ${r.status}`);
  return data as TonDepositInfo;
}

async function fetchMatchStatus(matchId: string): Promise<TonMatchStatus> {
  const r = await fetch(`/api/ton/match-status/${encodeURIComponent(matchId)}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `ton-match-status HTTP ${r.status}`);
  return data as TonMatchStatus;
}

async function fetchSettleAuth(matchId: string): Promise<TonSettleAuth | null> {
  const r = await fetch(`/api/escrow/settle-auth/${encodeURIComponent(matchId)}`);
  const data = await r.json().catch(() => ({}));
  if (r.status === 404 && data?.error === "settle_auth_pending") return null;
  if (!r.ok) throw new Error(data?.error || `settle-auth HTTP ${r.status}`);
  return data as TonSettleAuth;
}

async function notifyDeposit(matchId: string, txInfo: any): Promise<void> {
  try {
    await fetch("/api/ton/notify-deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId, txInfo }),
    });
  } catch (e) {
    console.warn("[TonEscrow] notify-deposit failed (non-fatal):", e);
  }
}

export async function ensureTonReadyForStake(stakeTon: number): Promise<void> {
  const tc = (window as any).__TON_CONNECT_UI__;
  if (!tc || !tc.connected || !tc.account?.address) {
    throw new Error("TonConnect wallet is not connected");
  }
  const r = await fetch(
    `/api/ton/readiness?wallet=${encodeURIComponent(tc.account.address)}&stake=${encodeURIComponent(String(stakeTon))}`
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || "TON readiness check failed");
  if (!data.ready) {
    throw new Error(data?.message || `Insufficient TON balance (need ≥ ${data?.requiredTon} TON)`);
  }
}

export class TonEscrowAdapter {
  getEstimatedNetworkFee(asset: Asset): number {
    const price = ASSET_PRICES_USD[asset];
    if (!price || NETWORK_FEE_USD_PER_PLAYER === 0) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  /**
   * V2 deposit: contract auto-creates the match on first deposit, transitions
   * to ACTIVE on the second. Player attaches the Deposit BOC via TonConnect.
   */
  async lockFunds(matchId: string, asset: Asset, _stake: number): Promise<boolean> {
    if (asset !== "TON") {
      console.warn(`[TonEscrow] lockFunds called for non-TON asset ${asset} — ignoring`);
      return false;
    }
    const tc = (window as any).__TON_CONNECT_UI__;
    if (!tc || !tc.connected) {
      console.error("[TonEscrow] TonConnect not connected");
      return false;
    }

    let info: TonDepositInfo;
    try {
      info = await fetchDepositInfo(matchId);
    } catch (e: any) {
      console.error("[TonEscrow] deposit-info failed:", e?.message || e);
      return false;
    }

    try {
      console.log(`[TonEscrow] Prompting TonConnect: ${Number(info.amountNano) / 1e9} TON → ${info.escrowAddress}`);
      const result = await tc.sendTransaction({
        validUntil: info.validUntilSec,
        messages: [
          {
            address: info.escrowAddress,
            amount: info.amountNano,
            payload: info.payloadBoc,
          },
        ],
      });
      await notifyDeposit(matchId, { boc: result?.boc || null });
    } catch (e: any) {
      console.error("[TonEscrow] sendTransaction failed:", e?.message || e);
      return false;
    }

    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      try {
        const s = await fetchMatchStatus(matchId);
        if (s.status === 2) return true;
        if (s.status === 3) {
          console.warn(`[TonEscrow] match ${matchId} already settled`);
          return false;
        }
      } catch (e: any) {
        console.warn(`[TonEscrow] match-status poll ${i + 1} failed:`, e?.message || e);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.warn(`[TonEscrow] match ${matchId} did not become Active within timeout`);
    return false;
  }

  /**
   * Player-side on-chain settle. Sends the oracle-signed Settle BOC to the
   * escrow via TonConnect. ~0.05 TON gas covers compute + winner payout fwd.
   */
  async claimSettlementWithRetry(matchId: string): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
      const ok = await this.claimSettlement(matchId);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.warn(`[TonEscrow] settle-auth never became ready for ${matchId}`);
    return false;
  }

  async claimSettlement(matchId: string): Promise<boolean> {
    let auth: TonSettleAuth | null;
    try {
      auth = await fetchSettleAuth(matchId);
    } catch (e: any) {
      console.error(`[TonEscrow] settle-auth fetch failed:`, e?.message || e);
      return false;
    }
    if (!auth) {
      console.log(`[TonEscrow] settle-auth not ready for ${matchId}`);
      return false;
    }

    const tc = (window as any).__TON_CONNECT_UI__;
    if (!tc || !tc.connected) {
      console.warn(`[TonEscrow] TonConnect not connected — cannot claim`);
      return false;
    }

    try {
      const validUntilSec = Math.floor(Date.now() / 1000) + 5 * 60;
      // 0.05 TON gas — contract refunds excess; winner payout is forwarded
      // from the contract balance, not from this attached value.
      await tc.sendTransaction({
        validUntil: validUntilSec,
        messages: [
          {
            address: auth.escrowAddress,
            amount: "50000000",
            payload: auth.payloadBoc,
          },
        ],
      });
      console.log(`[TonEscrow] settle BOC sent for ${matchId}`);
      return true;
    } catch (e: any) {
      console.error(`[TonEscrow] settle send failed:`, e?.message || e);
      return false;
    }
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

    if (result === 'win' || result === 'draw') {
      this.claimSettlementWithRetry(matchId).catch((e) =>
        console.warn(`[TonEscrow] claimSettlement (${matchId}) background error:`, e?.message || e)
      );
    }

    console.log(`[TonEscrow] Match ${matchId} result: ${result}, est payout=${payout}`);
    return { payout, fee };
  }
}

export const tonEscrowAdapter = new TonEscrowAdapter();
