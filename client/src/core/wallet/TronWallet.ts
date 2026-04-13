const USDT_TRC20_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

interface TronWeb {
  ready: boolean;
  defaultAddress: { base58: string; hex: string };
  trx: { getBalance: (addr: string) => Promise<number> };
  contract: () => { at: (addr: string) => Promise<any> };
  request: (args: { method: string }) => Promise<any>;
  toDecimal: (val: any) => number;
}

declare global {
  interface Window {
    tronWeb?: TronWeb;
    tronLink?: { request: (args: { method: string }) => Promise<any> };
  }
}

export function isTronLinkAvailable(): boolean {
  return !!(window.tronWeb || window.tronLink);
}

export async function connectTronLink(): Promise<string | null> {
  try {
    if (window.tronLink) {
      await window.tronLink.request({ method: 'tron_requestAccounts' });
    } else if (window.tronWeb && window.tronWeb.request) {
      await window.tronWeb.request({ method: 'tron_requestAccounts' });
    }

    await new Promise((r) => setTimeout(r, 500));

    if (window.tronWeb && window.tronWeb.ready && window.tronWeb.defaultAddress?.base58) {
      return window.tronWeb.defaultAddress.base58;
    }
    return null;
  } catch (e) {
    console.error('[TronWallet] connect failed:', e);
    return null;
  }
}

export function getTronAddress(): string | null {
  if (window.tronWeb && window.tronWeb.ready && window.tronWeb.defaultAddress?.base58) {
    return window.tronWeb.defaultAddress.base58;
  }
  return null;
}

export async function getUsdtTrc20Balance(address: string): Promise<number> {
  try {
    if (!window.tronWeb || !window.tronWeb.ready) return 0;
    const contract = await window.tronWeb.contract().at(USDT_TRC20_ADDRESS);
    const raw = await contract.balanceOf(address).call();
    const val = window.tronWeb.toDecimal(raw);
    return val / 1e6;
  } catch (e) {
    console.error('[TronWallet] getUsdtTrc20Balance failed:', e);
    return 0;
  }
}
