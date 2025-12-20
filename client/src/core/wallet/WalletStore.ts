import { Asset, WalletState } from "@/core/types";
import { INITIAL_BALANCES } from "@/config/economy";

// Simple event emitter for state updates
type Listener = (state: WalletState) => void;

export class WalletStore {
  private state: WalletState = {
    connected: false,
    address: null,
    balances: { USDT: 0, ETH: 0, TON: 0 }
  };
  
  private listeners: Set<Listener> = new Set();

  // Singleton instance
  private static instance: WalletStore;

  private constructor() {
    // Restore from localStorage if available (simulate persistence)
    const stored = localStorage.getItem('wallet_state');
    if (stored) {
      this.state = JSON.parse(stored);
    }
  }

  static getInstance(): WalletStore {
    if (!WalletStore.instance) {
      WalletStore.instance = new WalletStore();
    }
    return WalletStore.instance;
  }

  getState(): WalletState {
    return { ...this.state };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    localStorage.setItem('wallet_state', JSON.stringify(this.state));
    this.listeners.forEach(l => l(this.state));
  }

  async connect(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 500)); // Simulate delay
    
    if (!this.state.connected) {
      // Try to recover address from storage or generate new
      const stored = localStorage.getItem('wallet_state');
      let address = '0x' + Math.random().toString(36).substring(2, 10).toUpperCase();
      if (stored) {
         const parsed = JSON.parse(stored);
         if (parsed.address) address = parsed.address;
      }

      this.state = {
        connected: true,
        address,
        balances: { ...INITIAL_BALANCES } 
      };
      this.notify();
    }
  }

  async disconnect(): Promise<void> {
    this.state = {
      connected: false,
      address: null,
      balances: { USDT: 0, ETH: 0, TON: 0 }
    };
    this.notify();
  }

  // Returns true if deducted successfully, false if insufficient funds
  deduct(asset: Asset, amount: number): boolean {
    const currentBalance = this.state.balances[asset];
    if (currentBalance < amount) {
      return false;
    }
    
    this.state.balances = {
      ...this.state.balances,
      [asset]: currentBalance - amount
    };
    this.notify();
    return true;
  }

  credit(asset: Asset, amount: number): void {
    const currentBalance = this.state.balances[asset];
    this.state.balances = {
      ...this.state.balances,
      [asset]: currentBalance + amount
    };
    this.notify();
  }
}

export const walletStore = WalletStore.getInstance();
