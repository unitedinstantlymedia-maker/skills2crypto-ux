import { Asset, MatchResult } from "@/core/types";

export interface IEscrowAdapter {
  getEstimatedNetworkFee(asset: Asset): number;
  lockFunds(matchId: string, asset: Asset, stake: number): Promise<boolean>;
  settleMatch(matchId: string, asset: Asset, stake: number, result: MatchResult): Promise<{ payout: number; fee: number }>;
}
