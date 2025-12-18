import type { Asset } from "@shared/protocol";

export interface EscrowConfig {
  feeBps: number;
  feeRecipient: string;
}

export interface LockReceipt {
  matchId: string;
  playerId: string;
  asset: Asset;
  amount: number;
  lockedAt: number;
}

export interface PayoutReceipt {
  matchId: string;
  winnerId: string;
  asset: Asset;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  feeRecipient: string;
  createdAt: number;
}

export interface EscrowService {
  lock(matchId: string, playerId: string, asset: Asset, amount: number): LockReceipt;
  release(matchId: string, winnerId: string, asset: Asset, pot: number): PayoutReceipt;
  refund(matchId: string, playerId: string, asset: Asset, amount: number): void;
  refundAll(matchId: string, asset: Asset, stake: number): void;
}

const DEFAULT_CONFIG: EscrowConfig = {
  feeBps: 300,
  feeRecipient: "PLATFORM_FEE_ADDRESS",
};

class MockEscrowService implements EscrowService {
  private config: EscrowConfig;
  private locks: LockReceipt[] = [];
  private payouts: PayoutReceipt[] = [];

  constructor(config: Partial<EscrowConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  lock(matchId: string, playerId: string, asset: Asset, amount: number): LockReceipt {
    const receipt: LockReceipt = {
      matchId,
      playerId,
      asset,
      amount,
      lockedAt: Date.now(),
    };
    this.locks.push(receipt);
    console.log(`[Escrow] Locked ${amount} ${asset} from ${playerId} for match ${matchId}`);
    return receipt;
  }

  release(matchId: string, winnerId: string, asset: Asset, pot: number): PayoutReceipt {
    const feeAmount = (pot * this.config.feeBps) / 10000;
    const netAmount = pot - feeAmount;

    const receipt: PayoutReceipt = {
      matchId,
      winnerId,
      asset,
      grossAmount: pot,
      feeAmount,
      netAmount,
      feeRecipient: this.config.feeRecipient,
      createdAt: Date.now(),
    };

    this.payouts.push(receipt);
    console.log(`[Escrow] Released ${netAmount} ${asset} to ${winnerId} (fee: ${feeAmount} to ${this.config.feeRecipient})`);
    return receipt;
  }

  refund(matchId: string, playerId: string, asset: Asset, amount: number): void {
    const matchLocks = this.locks.filter(l => l.matchId === matchId && l.playerId === playerId);
    console.log(`[Escrow] Refunded ${amount} ${asset} to ${playerId} for match ${matchId}`);
  }

  refundAll(matchId: string, asset: Asset, stake: number): void {
    console.log(`[Escrow] Refunded all locked funds for match ${matchId}`);
  }

  getLocks(): LockReceipt[] {
    return [...this.locks];
  }

  getPayouts(): PayoutReceipt[] {
    return [...this.payouts];
  }
}

export const escrowService = new MockEscrowService();
