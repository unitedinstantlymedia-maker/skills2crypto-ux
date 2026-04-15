import { Asset } from "@/core/types";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";

export class EvmEscrowAdapter {

  getEstimatedNetworkFee(asset: Asset): number {
    const price = ASSET_PRICES_USD[asset];
    if (!price) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  async lockFunds(matchId: string, asset: Asset, stake: number): Promise<boolean> {
    console.log(`[EvmEscrow] lockFunds called for match ${matchId}: ${stake} ${asset}`);
    return true;
  }

  async submitDeposit(
    matchId: string,
    asset: Asset,
    stake: number,
    player1: string,
    player2: string,
    sig1: string,
    sig2: string
  ): Promise<{ txHash: string }> {
    const isNative = asset === 'BNB' || asset === 'ETH';
    const assetType = isNative ? 'native' : 'usdt';

    const decimals = asset === 'USDT' ? 18 : 18;
    const stakeWei = BigInt(Math.round(stake * 10 ** decimals)).toString();

    const res = await fetch('/api/oracle/submit-deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchId,
        stake: stakeWei,
        assetType,
        player1,
        player2,
        sig1,
        sig2,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Deposit submission failed' }));
      throw new Error(err.error || 'Deposit submission failed');
    }

    const result = await res.json();
    console.log(`[EvmEscrow] Deposit submitted: tx=${result.txHash}`);
    return result;
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
