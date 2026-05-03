import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";
import { getCachedAssetFee, ensureFeeSnapshotLoaded } from "@/core/networkFees";
import { writeContract, waitForTransactionReceipt, getAccount, switchChain, getChainId } from "@wagmi/core";
import { parseAbi } from "viem";
import { wagmiConfig } from "@/config/wagmi";
import { apiUrl } from "@/lib/api";

const ESCROW_ABI = parseAbi([
  "function depositNative(bytes32 matchId, address player1, address player2, uint256 stake, uint256 deadline, bytes oracleSig) payable",
  "function settleMatch(bytes32 matchId, address winner, uint8 reason, bytes oracleSig)",
  "function refundNoShow(bytes32 matchId)",
]);

interface MatchAuth {
  matchId: string;
  matchIdBytes32: `0x${string}`;
  player1: `0x${string}`;
  player2: `0x${string}`;
  stake: string;
  deadline: number;
  oracleSig: `0x${string}`;
  chainId: number;
  escrowAddress: `0x${string}`;
}

interface SettleAuth {
  matchId: string;
  chain: "BSC" | "ETH";
  chainId: number;
  escrowAddress: `0x${string}`;
  matchIdBytes32: `0x${string}`;
  winner: `0x${string}`;
  reason: number;
  oracleSig: `0x${string}`;
}

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60;

async function fetchMatchAuth(matchId: string, walletAddress: string): Promise<MatchAuth> {
  const res = await fetch(apiUrl("/api/oracle/match-auth"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // walletAddress is required by the anti-cheat L1 captcha gate.
    body: JSON.stringify({ matchId, walletAddress }),
  });
  const data = await res.json().catch(() => ({ error: "Invalid response" }));
  if (!res.ok) {
    const err: any = new Error(data?.error || `match-auth HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as MatchAuth;
}

async function fetchMatchStatus(matchId: string): Promise<{ status: number; statusLabel: string }> {
  const res = await fetch(apiUrl(`/api/oracle/match-status/${encodeURIComponent(matchId)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `match-status HTTP ${res.status}`);
  return data;
}

async function fetchSettleAuth(matchId: string): Promise<SettleAuth | null> {
  const res = await fetch(apiUrl(`/api/escrow/settle-auth/${encodeURIComponent(matchId)}`));
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && data?.error === "settle_auth_pending") return null;
  if (!res.ok) throw new Error(data?.error || `settle-auth HTTP ${res.status}`);
  return data as SettleAuth;
}

async function ensureChain(targetChainId: number): Promise<boolean> {
  const current = getChainId(wagmiConfig);
  if (current === targetChainId) return true;
  try {
    await switchChain(wagmiConfig, { chainId: targetChainId });
    return getChainId(wagmiConfig) === targetChainId;
  } catch (e: any) {
    console.error(`[EvmEscrow] chain switch to ${targetChainId} rejected:`, e?.shortMessage || e?.message || e);
    return false;
  }
}

export class EvmEscrowAdapter {
  getEstimatedNetworkFee(asset: Asset): number {
    // Prefer the live server-cached estimate (fetched once at app boot
    // by /api/network-fees). Falls back to the legacy hard-coded
    // USD/coin conversion ONLY during the brief window before the
    // first fetch resolves.
    void ensureFeeSnapshotLoaded();
    const live = getCachedAssetFee(asset);
    if (typeof live === "number" && live >= 0) return live;
    const price = ASSET_PRICES_USD[asset];
    if (!price) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  /**
   * Player-submitted native deposit (V2 — no gasReserve, msg.value = stake).
   */
  async lockFunds(matchId: string, asset: Asset, _stake: number): Promise<boolean> {
    if (asset !== "BNB" && asset !== "ETH") {
      console.warn(`[EvmEscrow] lockFunds called for non-EVM asset ${asset} — ignoring`);
      return false;
    }

    const account = getAccount(wagmiConfig);
    if (!account.address) {
      console.error(`[EvmEscrow] No connected wallet`);
      return false;
    }
    let auth: MatchAuth;
    try {
      auth = await fetchMatchAuth(matchId, account.address);
    } catch (e: any) {
      console.error(`[EvmEscrow] match-auth failed:`, e.message);
      return false;
    }

    const me = account.address.toLowerCase();
    if (me !== auth.player1.toLowerCase() && me !== auth.player2.toLowerCase()) {
      console.error(`[EvmEscrow] connected wallet ${me} is not in this match`);
      return false;
    }

    if (!(await ensureChain(auth.chainId))) return false;

    const value = BigInt(auth.stake);
    let txHash: `0x${string}`;
    try {
      txHash = await writeContract(wagmiConfig, {
        chainId: auth.chainId,
        address: auth.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "depositNative",
        args: [
          auth.matchIdBytes32,
          auth.player1,
          auth.player2,
          BigInt(auth.stake),
          BigInt(auth.deadline),
          auth.oracleSig,
        ],
        value,
      });
    } catch (e: any) {
      console.error(`[EvmEscrow] depositNative failed: ${e?.shortMessage || e?.message || e}`);
      return false;
    }

    try {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: auth.chainId, hash: txHash });
      if (receipt.status !== "success") {
        console.error(`[EvmEscrow] tx reverted on-chain: ${txHash}`);
        return false;
      }
    } catch (e: any) {
      console.error(`[EvmEscrow] receipt wait failed:`, e?.message || e);
      return false;
    }

    // Poll until both players have deposited (compat status === 1 / Active).
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      try {
        const s = await fetchMatchStatus(matchId);
        if (s.status === 1) return true;
        if (s.status === 2) {
          console.warn(`[EvmEscrow] match ${matchId} already settled`);
          return false;
        }
      } catch (e: any) {
        console.warn(`[EvmEscrow] poll attempt ${i + 1} failed:`, e?.message || e);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.warn(`[EvmEscrow] match ${matchId} did not become Active within timeout`);
    return false;
  }

  /**
   * Winner-callable on-chain settlement (V2). Anyone in the match can call
   * this; the contract enforces who actually receives the funds based on
   * the oracle-signed reason. We never throw — failures return null and the
   * UI keeps the existing optimistic payout estimate.
   */
  async claimSettlement(matchId: string): Promise<{ txHash: `0x${string}` } | null> {
    // The server signs the outcome asynchronously after the game ends, so the
    // first fetch may legitimately race the signer. Poll for up to ~30s
    // (10 × 3s) before giving up. The /api/escrow/settle-auth endpoint is
    // idempotent so polling is safe.
    let auth: SettleAuth | null = null;
    for (let i = 0; i < 10; i++) {
      try {
        auth = await fetchSettleAuth(matchId);
        if (auth) break;
      } catch (e: any) {
        console.warn(`[EvmEscrow] settle-auth attempt ${i + 1} failed:`, e?.message || e);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!auth) {
      console.warn(`[EvmEscrow] settle-auth never became ready for ${matchId} — user can retry from match history`);
      return null;
    }

    const account = getAccount(wagmiConfig);
    if (!account.address) {
      console.warn(`[EvmEscrow] no connected wallet — cannot claim`);
      return null;
    }
    if (!(await ensureChain(auth.chainId))) return null;

    try {
      const txHash = await writeContract(wagmiConfig, {
        chainId: auth.chainId,
        address: auth.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "settleMatch",
        args: [auth.matchIdBytes32, auth.winner, auth.reason, auth.oracleSig],
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: auth.chainId, hash: txHash });
      if (receipt.status !== "success") {
        console.error(`[EvmEscrow] settleMatch reverted: ${txHash}`);
        return null;
      }
      console.log(`[EvmEscrow] settleMatch confirmed: ${txHash}`);
      return { txHash };
    } catch (e: any) {
      // The other player may have already called settleMatch — treat as success.
      const msg = e?.shortMessage || e?.message || String(e);
      if (/AlreadySettled|already settled/i.test(msg)) {
        console.log(`[EvmEscrow] settleMatch already executed by opponent — ${matchId}`);
        return null;
      }
      console.error(`[EvmEscrow] settleMatch failed:`, msg);
      return null;
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

    // Fire-and-forget — winner / either player triggers on-chain settle.
    if (result === 'win' || result === 'draw') {
      this.claimSettlement(matchId).catch((e) =>
        console.warn(`[EvmEscrow] claimSettlement (${matchId}) background error:`, e?.message || e)
      );
    }

    console.log(`[EvmEscrow] Match ${matchId} result: ${result}, est payout=${payout}, fee=${fee}`);
    return { payout, fee };
  }
}

export const evmEscrowAdapter = new EvmEscrowAdapter();
