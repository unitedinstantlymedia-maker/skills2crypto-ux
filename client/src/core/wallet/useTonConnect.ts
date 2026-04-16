import { useState, useEffect, useCallback, useRef } from 'react';
import { Address } from '@ton/core';

const TON_API_URL = 'https://toncenter.com/api/v2/jsonRPC';
const BALANCE_REFRESH_INTERVAL = 30000;

interface TonConnectState {
  isTonConnected: boolean;
  tonAddress: string | null;
  tonBalance: number;
  isConnecting: boolean;
  connectTonWallet: () => void;
  disconnectTonWallet: () => void;
}

async function fetchTonBalance(address: string): Promise<number> {
  try {
    const response = await fetch(TON_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'getAddressBalance',
        params: { address },
      }),
    });
    const data = await response.json();
    if (data.result) {
      return Number(data.result) / 1e9;
    }
    return 0;
  } catch (err) {
    console.error('[TonConnect] Failed to fetch TON balance:', err);
    return 0;
  }
}

function toFriendlyAddress(rawAddr: string): string {
  try {
    return Address.parseRaw(rawAddr).toString({ bounceable: false });
  } catch {
    return rawAddr;
  }
}

export function useTonConnect(): TonConnectState {
  const [isTonConnected, setIsTonConnected] = useState(false);
  const [tonAddress, setTonAddress] = useState<string | null>(null);
  const [tonBalance, setTonBalance] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const balanceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tonConnectUIRef = useRef<any>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const startBalancePolling = useCallback((address: string) => {
    if (balanceIntervalRef.current) {
      clearInterval(balanceIntervalRef.current);
    }
    fetchTonBalance(address).then(setTonBalance);
    balanceIntervalRef.current = setInterval(async () => {
      const bal = await fetchTonBalance(address);
      setTonBalance(bal);
    }, BALANCE_REFRESH_INTERVAL);
  }, []);

  const stopBalancePolling = useCallback(() => {
    if (balanceIntervalRef.current) {
      clearInterval(balanceIntervalRef.current);
      balanceIntervalRef.current = null;
    }
  }, []);

  const handleWalletChange = useCallback((wallet: any) => {
    if (wallet) {
      const addr = wallet.account?.address;
      if (addr) {
        const friendlyAddr = toFriendlyAddress(addr);
        setTonAddress(friendlyAddr);
        setIsTonConnected(true);
        localStorage.setItem('ton_connected', 'true');
        startBalancePolling(friendlyAddr);
      }
    } else {
      setTonAddress(null);
      setIsTonConnected(false);
      setTonBalance(0);
      localStorage.removeItem('ton_connected');
      stopBalancePolling();
    }
    setIsConnecting(false);
  }, [startBalancePolling, stopBalancePolling]);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        const { TonConnectUI } = await import('@tonconnect/ui');
        // Reuse a single instance across hot-reloads / re-mounts. TonConnectUI
        // throws "TonConnectUI is already initialized" if instantiated twice
        // for the same manifest, so we cache it on window.
        let tonConnectUI = (window as any).__TON_CONNECT_UI__;
        if (!tonConnectUI) {
          tonConnectUI = new TonConnectUI({
            manifestUrl: `${window.location.origin}/tonconnect-manifest.json`,
          });
          (window as any).__TON_CONNECT_UI__ = tonConnectUI;
        }
        tonConnectUIRef.current = tonConnectUI;

        const unsub = tonConnectUI.onStatusChange((wallet: any) => {
          if (mounted) handleWalletChange(wallet);
        });
        unsubscribeRef.current = unsub;

        if (tonConnectUI.connected && tonConnectUI.wallet) {
          handleWalletChange(tonConnectUI.wallet);
        }
      } catch (err) {
        console.error('[TonConnect] Init error:', err);
      }
    };

    init();

    return () => {
      mounted = false;
      stopBalancePolling();
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [handleWalletChange, stopBalancePolling]);

  const connectTonWallet = useCallback(() => {
    if (tonConnectUIRef.current) {
      setIsConnecting(true);
      tonConnectUIRef.current.openModal();
    }
  }, []);

  const disconnectTonWallet = useCallback(() => {
    if (tonConnectUIRef.current) {
      tonConnectUIRef.current.disconnect();
    }
    setTonAddress(null);
    setIsTonConnected(false);
    setTonBalance(0);
    localStorage.removeItem('ton_connected');
    stopBalancePolling();
  }, [stopBalancePolling]);

  return {
    isTonConnected,
    tonAddress,
    tonBalance,
    isConnecting,
    connectTonWallet,
    disconnectTonWallet,
  };
}
