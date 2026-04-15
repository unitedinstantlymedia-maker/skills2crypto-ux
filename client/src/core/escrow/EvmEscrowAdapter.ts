import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";

export class EvmEscrowAdapter {

  getEstimatedNetworkFee(asset: Asset): number {
    const price = ASSET_PRICES_USD[asset];
    if (!price) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  async lockFunds(matchId: string, asset: Asset, stake: number): Promise<boolean> {
    console.log(`[EvmEscrow] lockFunds: submitting deposit for match ${matchId}: ${stake} ${asset}`);

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch('/api/oracle/submit-deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchId }),
        });

        if (res.status === 409) {
          console.log(`[EvmEscrow] Deposit in progress for match ${matchId}, polling...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        const data = await res.json().catch(() => ({ error: 'Invalid response' }));

        if (!res.ok) {
          throw new Error(data.error || `Deposit failed (HTTP ${res.status})`);
        }

        if (data.alreadyDeposited) {
          console.log(`[EvmEscrow] Deposit already confirmed: tx=${data.txHash}`);
          return true;
        }

        if (!data.txHash) {
          throw new Error('Server returned success without txHash');
        }

        console.log(`[EvmEscrow] Deposit submitted: tx=${data.txHash}, block=${data.blockNumber}`);
        return true;
      } catch (e: any) {
        if (attempt === maxRetries) {
          console.error(`[EvmEscrow] lockFunds failed for match ${matchId} after ${maxRetries + 1} attempts:`, e.message);
          return false;
        }
        console.warn(`[EvmEscrow] lockFunds attempt ${attempt + 1} failed, retrying...`, e.message);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
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

    console.log(`[EvmEscrow] Settled match ${matchId}: ${result}, payout=${payout}, fee=${fee}`);
    return { payout, fee };
  }
}

export const evmEscrowAdapter = new EvmEscrowAdapter();
