import { Asset, MatchResult } from "@/core/types";
import { MockEscrowAdapter, mockEscrowAdapter } from './MockEscrowAdapter';
import { EvmEscrowAdapter, evmEscrowAdapter } from './EvmEscrowAdapter';
import { TronEscrowAdapter, tronEscrowAdapter } from './TronEscrowAdapter';
import { TonEscrowAdapter, tonEscrowAdapter } from './TonEscrowAdapter';
import type { IEscrowAdapter } from './EscrowAdapter';

const USE_MOCK = import.meta.env.VITE_USE_MOCK_ESCROW !== 'false';

/**
 * Routes escrow operations to the per-asset adapter:
 *   - BNB / ETH → EvmEscrowAdapter (player-submitted native deposit)
 *   - USDT      → TronEscrowAdapter (TRC-20 with oracle-paid TRX gas)
 *   - TON       → TonEscrowAdapter (TonConnect-prompted PlayerDeposit)
 *
 * When VITE_USE_MOCK_ESCROW is unset/true, all assets fall back to the mock
 * adapter so local dev doesn't require wallets / on-chain state.
 */
class EscrowRouter implements IEscrowAdapter {
  private pick(asset: Asset) {
    if (USE_MOCK) return mockEscrowAdapter;
    if (asset === "BNB" || asset === "ETH") return evmEscrowAdapter;
    if (asset === "USDT") return tronEscrowAdapter;
    if (asset === "TON") return tonEscrowAdapter;
    return mockEscrowAdapter;
  }

  getEstimatedNetworkFee(asset: Asset): number {
    return this.pick(asset).getEstimatedNetworkFee(asset);
  }

  lockFunds(matchId: string, asset: Asset, stake: number): Promise<boolean> {
    return this.pick(asset).lockFunds(matchId, asset, stake);
  }

  settleMatch(matchId: string, asset: Asset, stake: number, result: MatchResult) {
    return this.pick(asset).settleMatch(matchId, asset, stake, result);
  }
}

export const escrowAdapter: IEscrowAdapter = new EscrowRouter();

export { MockEscrowAdapter, mockEscrowAdapter } from './MockEscrowAdapter';
export { EvmEscrowAdapter, evmEscrowAdapter } from './EvmEscrowAdapter';
export { TronEscrowAdapter, tronEscrowAdapter } from './TronEscrowAdapter';
export { TonEscrowAdapter, tonEscrowAdapter } from './TonEscrowAdapter';
