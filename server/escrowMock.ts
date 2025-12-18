import type { Asset } from "@shared/protocol";

export interface PayoutReceipt {
  matchId: string;
  winnerId: string;
  asset: Asset;
  amount: number;
  feeAmount: number;
  createdAt: number;
}

const ledger: PayoutReceipt[] = [];

const DEFAULT_FEE_BPS = 300;

export function payout({
  matchId,
  winnerId,
  asset,
  pot,
  feeBps = DEFAULT_FEE_BPS,
}: {
  matchId: string;
  winnerId: string;
  asset: Asset;
  pot: number;
  feeBps?: number;
}): PayoutReceipt {
  const feeAmount = (pot * feeBps) / 10000;
  const amount = pot - feeAmount;

  const receipt: PayoutReceipt = {
    matchId,
    winnerId,
    asset,
    amount,
    feeAmount,
    createdAt: Date.now(),
  };

  ledger.push(receipt);
  return receipt;
}

export function getLedger(): PayoutReceipt[] {
  return [...ledger];
}
