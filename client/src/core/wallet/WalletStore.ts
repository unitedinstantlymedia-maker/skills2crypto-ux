import { Asset, WalletState } from "@/core/types";
import { INITIAL_BALANCES } from "@/config/economy";

type Listener = (state: WalletState) => void;

interface RealWalletData {
  connected: boolean;
  address: string | null;
  balances: Record<Asset, number>;
  nickname: string | null;
}

export class WalletStore {
  private state: WalletState = {
    connected: false,
    address: null,
    balances: { USDT: 0, ETH: 0, BNB: 0, TON: 0 },
    nickname: null,
  };

  private realBalances: Record<Asset, number> = { USDT: 0, ETH: 0, BNB: 0, TON: 0 };
  private gameBalances: Record<Asset, number> = { USDT: 0, ETH: 0, BNB: 0, TON: 0 };
  private listeners: Set<Listener> = new Set();
  private static instance: WalletStore;

  private constructor() {
    const stored = localStorage.getItem('wallet_state');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.balances) {
        parsed.balances = { USDT: 0, ETH: 0, BNB: 0, TON: 0, ...parsed.balances };
      }
      this.state = { nickname: null, ...parsed };
      if ('tronAddress' in this.state) delete (this.state as any).tronAddress;
      this.gameBalances = { ...this.state.balances };
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

  getRealBalances(): Record<Asset, number> {
    return { ...this.realBalances };
  }

  getGameBalances(): Record<Asset, number> {
    return { ...this.gameBalances };
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

  syncRealWallet(data: RealWalletData) {
    this.realBalances = { ...data.balances };
    this.state = {
      connected: data.connected,
      address: data.address,
      balances: { ...this.realBalances },
      nickname: data.nickname,
    };
    if (!this.escrowActive) {
      this.gameBalances = { ...this.realBalances };
    }
    this.notify();
  }

  setEscrowActive(active: boolean) {
    this.escrowActive = active;
    if (!active) {
      this.gameBalances = { ...this.realBalances };
    }
  }

  private escrowActive = false;

  setNickname(nickname: string) {
    this.state.nickname = nickname;
    this.notify();
  }

  async connect(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 500));

    if (!this.state.connected) {
      const stored = localStorage.getItem('wallet_state');
      let address = '0x' + Math.random().toString(36).substring(2, 10).toUpperCase();
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.address) address = parsed.address;
      }

      this.state = {
        connected: true,
        address,
        balances: { ...INITIAL_BALANCES },
        nickname: null,
      };
      this.gameBalances = { ...INITIAL_BALANCES };
      this.notify();
    }
  }

  disconnect() {
    this.state = {
      connected: false,
      address: null,
      balances: { USDT: 0, ETH: 0, BNB: 0, TON: 0 },
      nickname: null,
    };
    this.realBalances = { USDT: 0, ETH: 0, BNB: 0, TON: 0 };
    this.gameBalances = { USDT: 0, ETH: 0, BNB: 0, TON: 0 };
    this.notify();
  }

  deduct(asset: Asset, amount: number): boolean {
    const currentBalance = this.state.balances[asset];
    if (currentBalance < amount) {
      return false;
    }

    this.state.balances = {
      ...this.state.balances,
      [asset]: currentBalance - amount,
    };
    this.gameBalances[asset] = this.state.balances[asset];
    this.notify();
    return true;
  }

  credit(asset: Asset, amount: number): void {
    const currentBalance = this.state.balances[asset];
    this.state.balances = {
      ...this.state.balances,
      [asset]: currentBalance + amount,
    };
    this.gameBalances[asset] = this.state.balances[asset];
    this.notify();
  }
}

export const walletStore = WalletStore.getInstance();
