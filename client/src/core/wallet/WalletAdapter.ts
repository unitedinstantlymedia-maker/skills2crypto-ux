import { Asset } from "@/core/types";
import { walletStore } from "./WalletStore";

export interface IWalletAdapter {
  connect(): Promise<{ address: string }>;
  isConnected(): boolean;
  getAddress(): string | null;
  getBalances(): Record<Asset, number>;
  canAfford(asset: Asset, amount: number): boolean;
  debit(asset: Asset, amount: number): void;
  credit(asset: Asset, amount: number): void;
}

export class MockWalletAdapter implements IWalletAdapter {
  async connect(): Promise<{ address: string }> {
    await walletStore.connect();
    const state = walletStore.getState();
    if (!state.address) throw new Error("Failed to connect");
    return { address: state.address };
  }

  isConnected(): boolean {
    return walletStore.getState().connected;
  }

  getAddress(): string | null {
    return walletStore.getState().address;
  }

  getBalances(): Record<Asset, number> {
    return walletStore.getState().balances;
  }

  canAfford(asset: Asset, amount: number): boolean {
    const balances = this.getBalances();
    return (balances[asset] || 0) >= amount;
  }

  debit(asset: Asset, amount: number): void {
    const success = walletStore.deduct(asset, amount);
    if (!success) {
      throw new Error(`Insufficient ${asset} balance`);
    }
  }

  credit(asset: Asset, amount: number): void {
    walletStore.credit(asset, amount);
  }
}

export const walletAdapter = new MockWalletAdapter();
