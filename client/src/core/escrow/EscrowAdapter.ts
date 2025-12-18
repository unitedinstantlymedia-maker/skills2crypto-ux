import { Asset } from "@/core/types";

// Keep this as a stub for the interface and EVM implementation
export interface IEscrowAdapter {
    // defined by usage in MockEscrowAdapter for now, or we can formalize
}

export class EvmEscrowAdapter {
  constructor(private contractAddress: string, private chainId: number) {}

  getEstimatedNetworkFee(asset: Asset): number {
     throw new Error("Not implemented");
  }

  async lockFunds(matchId: string, asset: Asset, stake: number): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async settleMatch(matchId: string, asset: Asset, stake: number, result: any): Promise<any> {
    throw new Error("Not implemented");
  }
}
