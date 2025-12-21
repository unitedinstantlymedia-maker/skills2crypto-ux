import { Asset, MatchResult } from "@/core/types";
import { walletAdapter } from "@/core/wallet/WalletAdapter";
import { FEE_RATE, NETWORK_FEE_USD_PER_PLAYER, ASSET_PRICES_USD } from "@/config/economy";

export class MockEscrowAdapter {
  
  getEstimatedNetworkFee(asset: Asset): number {
    const price = ASSET_PRICES_USD[asset];
    if (!price) return 0;
    return NETWORK_FEE_USD_PER_PLAYER / price;
  }

  // Called when a match is successfully formed/active
  async lockFunds(matchId: string, asset: Asset, stake: number): Promise<boolean> {
    const networkFee = this.getEstimatedNetworkFee(asset);
    const totalRequired = stake + networkFee;
    
    try {
      // Attempt deduction via WalletAdapter
      walletAdapter.debit(asset, totalRequired);
      console.log(`[Escrow] Locked funds for match ${matchId}: ${stake} stake + ${networkFee} fee (${asset})`);
      return true;
    } catch (e) {
      console.error(`[Escrow] Failed to lock funds for match ${matchId}. Insufficient balance.`);
      return false;
    }
  }

  async settleMatch(matchId: string, asset: Asset, stake: number, result: MatchResult): Promise<{ payout: number, fee: number }> {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate tx

    // Ensure stake is treated as number
    const safeStake = Number(stake);
    const pot = safeStake * 2;
    const blockchainFeePerPlayer = this.getEstimatedNetworkFee(asset);
    const totalBlockchainFee = blockchainFeePerPlayer * 2;
    const totalPlatformFee = pot * FEE_RATE;
    
    let payout = 0;
    let fee = 0;

    console.log(`[Escrow] Settling match ${matchId} for stake: ${safeStake} (${asset})`);
    console.log(`[Escrow] Calculation: Pot = ${pot}, Platform Fee = ${totalPlatformFee}, Blockchain Fee Total = ${totalBlockchainFee}`);

    if (result === 'win') {
      // Winner: pot - all platform fees - all blockchain fees
      payout = pot - totalPlatformFee - totalBlockchainFee;
      fee = totalPlatformFee + totalBlockchainFee;
      console.log(`[Escrow] Win: Payout = ${payout}, Fee = ${fee}`);
      walletAdapter.credit(asset, payout);
    } else if (result === 'draw') {
      // Draw: each player gets stake - (platform fee / 2) - (blockchain fee / 2)
      const feePodPerUser = totalPlatformFee / 2;
      const blockchainFeePerUser = totalBlockchainFee / 2;
      payout = safeStake - feePodPerUser - blockchainFeePerUser;
      fee = feePodPerUser + blockchainFeePerUser;
      console.log(`[Escrow] Draw: Payout = ${payout}, Fee = ${fee} (Platform = ${feePodPerUser}, Blockchain = ${blockchainFeePerUser})`);
      walletAdapter.credit(asset, payout);
    } else {
      // Loss: loser gets nothing
      payout = 0;
      fee = 0;
      console.log(`[Escrow] Loss: Payout = 0, Fee = 0`);
    }
    
    console.log(`[Escrow] Settled match ${matchId}: Result ${result}, Payout ${payout}, Fee ${fee}`);

    return { payout, fee };
  }
}

export const mockEscrowAdapter = new MockEscrowAdapter();
