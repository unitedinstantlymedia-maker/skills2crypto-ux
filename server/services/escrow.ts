import type { Asset } from "@shared/protocol";
import { log } from "../index";

export interface Payout {
  playerId: string;
  amount: number;
}

export interface SettleResult {
  payouts: Payout[];
  fee: number;
}

export interface SettleParams {
  matchId: string;
  asset: Asset;
  amount: number;
  winner?: string;
  draw?: boolean;
}

export interface EscrowEngine {
  lock(matchId: string, asset: Asset, amount: number, players: string[]): void;
  settle(params: SettleParams): SettleResult;
  isLocked(matchId: string): boolean;
}

interface LockedMatch {
  matchId: string;
  asset: Asset;
  amount: number;
  players: string[];
  locked: boolean;
}

const PLATFORM_FEE_PERCENTAGE = 0.03;

class MockEscrowEngine implements EscrowEngine {
  private lockedMatches: Map<string, LockedMatch> = new Map();

  lock(matchId: string, asset: Asset, amount: number, players: string[]): void {
    if (this.lockedMatches.has(matchId)) {
      log(`Escrow already locked for match ${matchId}`, "escrow");
      return;
    }

    const lockedMatch: LockedMatch = {
      matchId,
      asset,
      amount,
      players,
      locked: true,
    };

    this.lockedMatches.set(matchId, lockedMatch);
    log(`Escrow locked for match ${matchId}: ${amount} ${asset} from ${players.length} players`, "escrow");
  }

  settle(params: SettleParams): SettleResult {
    const { matchId, amount, winner, draw } = params;

    const lockedMatch = this.lockedMatches.get(matchId);
    if (!lockedMatch) {
      log(`No locked escrow found for match ${matchId}`, "escrow");
      return { payouts: [], fee: 0 };
    }

    const totalPot = amount * 2;

    if (draw) {
      const refundAmount = amount;
      const payouts: Payout[] = lockedMatch.players.map((playerId) => ({
        playerId,
        amount: refundAmount,
      }));

      log(`Escrow settled for match ${matchId}: DRAW - refunding ${refundAmount} to each player`, "escrow");
      
      this.lockedMatches.delete(matchId);
      
      return {
        payouts,
        fee: 0,
      };
    }

    if (winner) {
      const fee = totalPot * PLATFORM_FEE_PERCENTAGE;
      const winnerPayout = totalPot - fee;

      const payouts: Payout[] = [
        { playerId: winner, amount: winnerPayout },
      ];

      for (const playerId of lockedMatch.players) {
        if (playerId !== winner) {
          payouts.push({ playerId, amount: 0 });
        }
      }

      log(`Escrow settled for match ${matchId}: winner=${winner} gets ${winnerPayout}, fee=${fee}`, "escrow");

      this.lockedMatches.delete(matchId);

      return {
        payouts,
        fee,
      };
    }

    log(`Escrow settle called for match ${matchId} with no winner or draw`, "escrow");
    return { payouts: [], fee: 0 };
  }

  isLocked(matchId: string): boolean {
    return this.lockedMatches.has(matchId);
  }
}

export const escrowEngine: EscrowEngine = new MockEscrowEngine();

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

class LegacyEscrowService implements EscrowService {
  lock(matchId: string, playerId: string, asset: Asset, amount: number): LockReceipt {
    const receipt: LockReceipt = {
      matchId,
      playerId,
      asset,
      amount,
      lockedAt: Date.now(),
    };
    log(`[Legacy Escrow] Locked ${amount} ${asset} from ${playerId} for match ${matchId}`, "escrow");
    return receipt;
  }

  release(matchId: string, winnerId: string, asset: Asset, pot: number): PayoutReceipt {
    const feeAmount = pot * PLATFORM_FEE_PERCENTAGE;
    const netAmount = pot - feeAmount;

    const receipt: PayoutReceipt = {
      matchId,
      winnerId,
      asset,
      grossAmount: pot,
      feeAmount,
      netAmount,
      feeRecipient: "PLATFORM_FEE_ADDRESS",
      createdAt: Date.now(),
    };

    log(`[Legacy Escrow] Released ${netAmount} ${asset} to ${winnerId} (fee: ${feeAmount})`, "escrow");
    return receipt;
  }

  refund(matchId: string, playerId: string, asset: Asset, amount: number): void {
    log(`[Legacy Escrow] Refunded ${amount} ${asset} to ${playerId} for match ${matchId}`, "escrow");
  }

  refundAll(matchId: string, asset: Asset, stake: number): void {
    log(`[Legacy Escrow] Refunded all locked funds for match ${matchId}`, "escrow");
  }
}

export const escrowService: EscrowService = new LegacyEscrowService();
