import { useState, useEffect, useCallback, useRef } from 'react';

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_TRC20_DECIMALS = 6;
const BALANCE_REFRESH_INTERVAL = 30000;

declare global {
  interface Window {
    tronWeb?: any;
    tronLink?: {
      ready: boolean;
      request: (args: { method: string }) => Promise<any>;
    };
  }
}

interface TronLinkState {
  isTronLinkInstalled: boolean;
  isTronConnected: boolean;
  tronAddress: string | null;
  usdtTrc20Balance: number;
  isConnecting: boolean;
  connectTronLink: () => Promise<void>;
  disconnectTronLink: () => void;
}

export function useTronLink(): TronLinkState {
  const [isTronLinkInstalled, setIsTronLinkInstalled] = useState(false);
  const [isTronConnected, setIsTronConnected] = useState(false);
  const [tronAddress, setTronAddress] = useState<string | null>(null);
  const [usdtTrc20Balance, setUsdtTrc20Balance] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const balanceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkInstalled = useCallback(() => {
    const installed = !!(window.tronWeb || window.tronLink);
    setIsTronLinkInstalled(installed);
    return installed;
  }, []);

  const fetchUsdtBalance = useCallback(async (address: string) => {
    try {
      if (!window.tronWeb || !window.tronWeb.ready) return;
      const contract = await window.tronWeb.contract().at(USDT_TRC20_CONTRACT);
      const rawBalance = await contract.balanceOf(address).call();
      const balance = Number(rawBalance) / Math.pow(10, USDT_TRC20_DECIMALS);
      setUsdtTrc20Balance(balance);
    } catch (err) {
      console.error('[TronLink] Failed to fetch USDT TRC-20 balance:', err);
    }
  }, []);

  const startBalancePolling = useCallback((address: string) => {
    if (balanceIntervalRef.current) {
      clearInterval(balanceIntervalRef.current);
    }
    fetchUsdtBalance(address);
    balanceIntervalRef.current = setInterval(() => fetchUsdtBalance(address), BALANCE_REFRESH_INTERVAL);
  }, [fetchUsdtBalance]);

  const stopBalancePolling = useCallback(() => {
    if (balanceIntervalRef.current) {
      clearInterval(balanceIntervalRef.current);
      balanceIntervalRef.current = null;
    }
  }, []);

  const checkExistingConnection = useCallback(() => {
    if (window.tronWeb && window.tronWeb.ready && window.tronWeb.defaultAddress?.base58) {
      const addr = window.tronWeb.defaultAddress.base58;
      setTronAddress(addr);
      setIsTronConnected(true);
      startBalancePolling(addr);
      return true;
    }
    return false;
  }, [startBalancePolling]);

  const connectTronLink = useCallback(async () => {
    setIsConnecting(true);
    try {
      if (window.tronLink) {
        const res = await window.tronLink.request({ method: 'tron_requestAccounts' });
        if (res?.code === 200 || res?.code === 4001) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      if (window.tronWeb && window.tronWeb.ready && window.tronWeb.defaultAddress?.base58) {
        const addr = window.tronWeb.defaultAddress.base58;
        setTronAddress(addr);
        setIsTronConnected(true);
        localStorage.setItem('tronlink_connected', 'true');
        startBalancePolling(addr);
      }
    } catch (err) {
      console.error('[TronLink] Connection error:', err);
    } finally {
      setIsConnecting(false);
    }
  }, [startBalancePolling]);

  const disconnectTronLink = useCallback(() => {
    setTronAddress(null);
    setIsTronConnected(false);
    setUsdtTrc20Balance(0);
    localStorage.removeItem('tronlink_connected');
    stopBalancePolling();
  }, [stopBalancePolling]);

  useEffect(() => {
    const detect = () => {
      if (checkInstalled()) {
        const wasConnected = localStorage.getItem('tronlink_connected') === 'true';
        if (wasConnected) {
          checkExistingConnection();
        }
      }
    };

    if (document.readyState === 'complete') {
      setTimeout(detect, 500);
    } else {
      window.addEventListener('load', () => setTimeout(detect, 500));
    }

    const handleMessage = (e: MessageEvent) => {
      if (e.data?.message?.action === 'setAccount') {
        const addr = e.data.message.data?.address;
        if (addr) {
          setTronAddress(addr);
          setIsTronConnected(true);
          startBalancePolling(addr);
        } else {
          disconnectTronLink();
        }
      }
      if (e.data?.message?.action === 'setNode') {
        if (tronAddress) {
          fetchUsdtBalance(tronAddress);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      stopBalancePolling();
    };
  }, [checkInstalled, checkExistingConnection, startBalancePolling, disconnectTronLink, stopBalancePolling, fetchUsdtBalance, tronAddress]);

  return {
    isTronLinkInstalled,
    isTronConnected,
    tronAddress,
    usdtTrc20Balance,
    isConnecting,
    connectTronLink,
    disconnectTronLink,
  };
}
