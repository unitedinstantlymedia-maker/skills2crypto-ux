import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";
import { writeContract, waitForTransactionReceipt, getAccount, switchChain, getChainId } from "@wagmi/core";
import { parseAbi } from "viem";
import { wagmiConfig } from "@/config/wagmi";

const ESCROW_ABI = parseAbi([
  "function depositNativeAsPlayer(bytes32 matchId, address player1, address player2, uint256 stake, uint256 gasReserve, uint256 deadline, bytes oracleSig) payable",
  "function refundNoShow(bytes32 matchId)",
]);

interface MatchAuth {
  matchId: string;
  matchIdBytes32: `0x${string}`;
  player1: `0x${string}`;
  player2: `0x${string}`;
  stake: string;
  gasReserve: string;
  deadline: number;
  oracleSig: `0x${string}`;
  chainId: number;
  escrowAddress: `0x${string}`;
}

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60; // 3 min

async function fetchMatchAuth(matchId: string): Promise<MatchAuth> {
  const res = await fetch("/api/oracle/match-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId }),
  });
  const data = await res.json().catch(() => ({ error: "Invalid response" }));
  if (!res.ok) throw new Error(data?.error || `match-auth HTTP ${res.status}`);
  return data as MatchAuth;
}

async function fetchMatchStatus(matchId: string): Promise<{ status: number; statusLabel: string }> {
  const res = await fetch(`/api/oracle/match-status/${encodeURIComponent(matchId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `match-status HTTP ${res.status}`);
  return data;
}

export class EvmEscrowAdapter {

  getEstimatedNetworkFee(asset: Asset): number {
    const price = ASSET_PRICES_USD[asset];
    if (!price) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  /**
   * Player-submitted native deposit flow.
   * 1. Fetch oracle-signed MatchAuth from server.
   * 2. Switch wagmi account to the right chain (BNB→56, ETH→1).
   * 3. Send depositNativeAsPlayer with msg.value = stake + gasReserve.
   * 4. Wait for receipt, then poll match-status until both players have deposited.
   */
  async lockFunds(matchId: string, asset: Asset, _stake: number): Promise<boolean> {
    if (asset !== "BNB" && asset !== "ETH") {
      console.warn(`[EvmEscrow] lockFunds called for non-EVM asset ${asset} — ignoring`);
      return false;
    }

    console.log(`[EvmEscrow] lockFunds: requesting match auth for ${matchId} (${asset})`);

    let auth: MatchAuth;
    try {
      auth = await fetchMatchAuth(matchId);
    } catch (e: any) {
      console.error(`[EvmEscrow] match-auth failed:`, e.message);
      return false;
    }

    const account = getAccount(wagmiConfig);
    if (!account.address) {
      console.error(`[EvmEscrow] No connected wallet`);
      return false;
    }

    const me = account.address.toLowerCase();
    if (me !== auth.player1.toLowerCase() && me !== auth.player2.toLowerCase()) {
      console.error(`[EvmEscrow] connected wallet ${me} is not in this match`);
      return false;
    }

    const stakeWei = BigInt(auth.stake);
    const gasReserveWei = BigInt(auth.gasReserve);
    const value = stakeWei + gasReserveWei;

    // Verify the wallet is on the correct EVM chain. If not, ask wagmi to
    // switch — most wallets will prompt the user. We hard-fail if the switch
    // is rejected so writeContract never runs against the wrong chain.
    const currentChainId = getChainId(wagmiConfig);
    if (currentChainId !== auth.chainId) {
      console.log(`[EvmEscrow] wallet on chain ${currentChainId}, switching to ${auth.chainId}`);
      try {
        await switchChain(wagmiConfig, { chainId: auth.chainId });
      } catch (e: any) {
        console.error(`[EvmEscrow] chain switch to ${auth.chainId} rejected:`, e?.shortMessage || e?.message || e);
        return false;
      }
      const after = getChainId(wagmiConfig);
      if (after !== auth.chainId) {
        console.error(`[EvmEscrow] still on chain ${after} after switch attempt — aborting`);
        return false;
      }
    }

    console.log(`[EvmEscrow] sending depositNativeAsPlayer on chain ${auth.chainId}, value=${value.toString()}`);

    let txHash: `0x${string}`;
    try {
      txHash = await writeContract(wagmiConfig, {
        chainId: auth.chainId,
        address: auth.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "depositNativeAsPlayer",
        args: [
          auth.matchIdBytes32,
          auth.player1,
          auth.player2,
          stakeWei,
          gasReserveWei,
          BigInt(auth.deadline),
          auth.oracleSig,
        ],
        value,
      });
      console.log(`[EvmEscrow] deposit tx submitted: ${txHash}`);
    } catch (e: any) {
      // User rejection or revert. Surface a friendly message; don't retry — the
      // user must explicitly try again.
      const msg = e?.shortMessage || e?.message || String(e);
      console.error(`[EvmEscrow] depositNativeAsPlayer failed: ${msg}`);
      return false;
    }

    try {
      const receipt = await waitForTransactionReceipt(wagmiConfig, {
        chainId: auth.chainId,
        hash: txHash,
      });
      if (receipt.status !== "success") {
        console.error(`[EvmEscrow] tx reverted on-chain: ${txHash}`);
        return false;
      }
      console.log(`[EvmEscrow] deposit confirmed in block ${receipt.blockNumber}`);
    } catch (e: any) {
      console.error(`[EvmEscrow] receipt wait failed:`, e?.message || e);
      return false;
    }

    // Poll until both players have deposited (status === 1 / Active).
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      try {
        const s = await fetchMatchStatus(matchId);
        if (s.status === 1) {
          console.log(`[EvmEscrow] match ${matchId} fully funded`);
          return true;
        }
        if (s.status === 2) {
          console.warn(`[EvmEscrow] match ${matchId} already settled`);
          return false;
        }
      } catch (e: any) {
        console.warn(`[EvmEscrow] poll attempt ${i + 1} failed:`, e?.message || e);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    console.warn(`[EvmEscrow] match ${matchId} did not become Active within timeout — opponent may not have deposited`);
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
      const feePodPerUser = totalPlatformFee / 2;
      const blockchainFeePerUser = totalBlockchainFee / 2;
      payout = safeStake - feePodPerUser - blockchainFeePerUser;
      fee = feePodPerUser + blockchainFeePerUser;
    } else {
      payout = 0;
      fee = 0;
    }

    console.log(`[EvmEscrow] Match ${matchId} result: ${result} (settlement handled server-side), estimated payout=${payout}, fee=${fee}`);
    return { payout, fee };
  }
}

export const evmEscrowAdapter = new EvmEscrowAdapter();
