import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 100; // ~5 min — wallet UX needs more grace than Tron

interface TonDepositInfo {
  matchId: string;
  escrowAddress: string;     // bounceable EQ… form
  amountNano: string;        // stake + gasReserve, in nanotons
  payloadBoc: string;        // base64 BOC for PlayerDeposit message body
  validUntilSec: number;
}

interface TonMatchStatus {
  status: number; // 0 none, 1 pending, 2 active, 3 settled, 4 cancelled
  p1Funded: boolean;
  p2Funded: boolean;
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

async function notifyDeposit(matchId: string, txInfo: any): Promise<void> {
  try {
    await fetch("/api/ton/notify-deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId, txInfo }),
    });
  } catch (e) {
    // Non-fatal — server polls match-status anyway.
    console.warn("[TonEscrow] notify-deposit failed (non-fatal):", e);
  }
}

/**
 * Pre-flight readiness ensure for the SEARCH path. Confirms the player has a
 * connected TonConnect wallet and at least `stake + gasReserve + buffer` TON.
 * Throws with a user-readable error so the GameContext can surface it.
 */
export async function ensureTonReadyForStake(stakeTon: number): Promise<void> {
  const { TonConnectUI } = await import("@tonconnect/ui");
  // Reuse any existing instance (set by useTonConnect hook).
  const tc = (window as any).__TON_CONNECT_UI__ as InstanceType<typeof TonConnectUI> | undefined;
  if (!tc || !tc.connected || !tc.account?.address) {
    throw new Error("TonConnect wallet is not connected");
  }
  // Server-side balance check via /api/ton/readiness — wallet may have
  // pending TX that lowers spendable balance below what the cached UI shows.
  const r = await fetch(
    `/api/ton/readiness?wallet=${encodeURIComponent(tc.account.address)}&stake=${encodeURIComponent(String(stakeTon))}`
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || "TON readiness check failed");
  if (!data.ready) {
    throw new Error(
      data?.message || `Insufficient TON balance (need ≥ ${data?.requiredTon} TON)`
    );
  }
}

export class TonEscrowAdapter {
  getEstimatedNetworkFee(asset: Asset): number {
    // Match the Tron adapter's pattern — convert the per-player USD
    // network-fee budget into the asset unit, falling back to 0.05 TON if no
    // price is configured.
    const price = ASSET_PRICES_USD[asset];
    if (!price || NETWORK_FEE_USD_PER_PLAYER === 0) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  /**
   * Player-side flow for native TON:
   *  1. POST /api/ton/deposit-info — server returns escrow address, exact
   *     amount, and the PlayerDeposit BOC payload (server has already called
   *     PrepareMatch on-chain).
   *  2. Prompt TonConnect to send the transaction (player signs in their
   *     wallet — Tonkeeper / MyTonWallet / etc.).
   *  3. Poll /api/ton/match-status until status === ACTIVE (= both players
   *     have funded).
   */
  async lockFunds(matchId: string, asset: Asset, _stake: number): Promise<boolean> {
    if (asset !== "TON") {
      console.warn(`[TonEscrow] lockFunds called for non-TON asset ${asset} — ignoring`);
      return false;
    }

    const tc = (window as any).__TON_CONNECT_UI__ as any;
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
            amount: info.amountNano, // nanotons as decimal string
            payload: info.payloadBoc,
          },
        ],
      });
      console.log(`[TonEscrow] TonConnect tx sent — boc returned`, result?.boc ? "yes" : "no");
      // Tell the server we sent the TX so it can start polling on-chain
      // sooner (also lets the server log the boc for debugging).
      await notifyDeposit(matchId, { boc: result?.boc || null });
    } catch (e: any) {
      console.error("[TonEscrow] sendTransaction failed:", e?.message || e);
      return false;
    }

    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      try {
        const s = await fetchMatchStatus(matchId);
        if (s.status === 2) {
          console.log(`[TonEscrow] match ${matchId} is ACTIVE — both players funded`);
          return true;
        }
        if (s.status === 3 || s.status === 4) {
          console.warn(`[TonEscrow] match ${matchId} ended before active (status=${s.status})`);
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
    console.log(`[TonEscrow] Match ${matchId} result: ${result} (settlement handled server-side)`);
    return { payout, fee };
  }
}

export const tonEscrowAdapter = new TonEscrowAdapter();
