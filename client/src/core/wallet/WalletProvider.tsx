import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { mainnet, bsc } from '@reown/appkit/networks';
import { useAppKit, useAppKitAccount, useDisconnect as useAppKitDisconnect } from '@reown/appkit/react';
import { useBalance } from 'wagmi';
import { wagmiConfig, appKit } from '@/config/wagmi';
import { queryClient } from '@/lib/queryClient';
import { walletStore } from './WalletStore';
import { connectTronLink, getTronAddress, getUsdtTrc20Balance, isTronLinkAvailable } from './TronWallet';
import { NicknameDialog } from '@/components/wallet/NicknameDialog';
import { TronConnectDialog } from '@/components/wallet/TronConnectDialog';
import { useToast } from '@/hooks/use-toast';

interface RealWalletContextValue {
  openConnectDialog: () => void;
  openTronDialog: () => void;
  disconnectAll: () => void;
  evmAddress: string | null;
  tronAddress: string | null;
  isEvmConnected: boolean;
  isTronConnected: boolean;
  nickname: string | null;
  setNickname: (name: string) => void;
}

const RealWalletContext = createContext<RealWalletContextValue | undefined>(undefined);

export function useRealWallet() {
  const ctx = useContext(RealWalletContext);
  if (!ctx) throw new Error('useRealWallet must be used within WalletProvider');
  return ctx;
}

function WalletSyncer({ children }: { children: React.ReactNode }) {
  const { open } = useAppKit();
  const { address: evmAddress, isConnected: isEvmConnected } = useAppKitAccount();
  const { disconnect: disconnectEvm } = useAppKitDisconnect();
  const { toast } = useToast();
  const [tronAddress, setTronAddress] = useState<string | null>(null);
  const [tronDialogOpen, setTronDialogOpen] = useState(false);
  const [nicknameDialogOpen, setNicknameDialogOpen] = useState(false);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const hasPromptedNickname = useRef(false);

  const evmAddr = (isEvmConnected && evmAddress) ? evmAddress as `0x${string}` : undefined;

  const ethBalance = useBalance({
    address: evmAddr,
    chainId: mainnet.id,
    query: { enabled: !!evmAddr },
  });

  const bnbBalance = useBalance({
    address: evmAddr,
    chainId: bsc.id,
    query: { enabled: !!evmAddr },
  });

  const [usdtBalance, setUsdtBalance] = useState(0);

  useEffect(() => {
    if (!tronAddress) { setUsdtBalance(0); return; }
    let cancelled = false;
    const poll = async () => {
      const bal = await getUsdtTrc20Balance(tronAddress);
      if (!cancelled) setUsdtBalance(bal);
    };
    poll();
    const iv = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [tronAddress]);

  useEffect(() => {
    const existing = getTronAddress();
    if (existing) setTronAddress(existing);
  }, []);

  useEffect(() => {
    const primaryAddress = evmAddress || tronAddress || null;
    const connected = isEvmConnected || !!tronAddress;

    if (primaryAddress && connected) {
      const storedNick = localStorage.getItem(`nickname_${primaryAddress}`);
      setNicknameState(storedNick);
    }

    walletStore.syncRealWallet({
      connected,
      address: primaryAddress ?? null,
      tronAddress: tronAddress ?? null,
      balances: {
        ETH: ethBalance.data ? parseFloat(ethBalance.data.formatted) : 0,
        BNB: bnbBalance.data ? parseFloat(bnbBalance.data.formatted) : 0,
        USDT: usdtBalance,
      },
      nickname: primaryAddress ? localStorage.getItem(`nickname_${primaryAddress}`) : null,
    });
  }, [evmAddress, isEvmConnected, tronAddress, ethBalance.data, bnbBalance.data, usdtBalance]);

  useEffect(() => {
    const primaryAddress = evmAddress || tronAddress || null;
    const connected = isEvmConnected || !!tronAddress;
    if (connected && primaryAddress && !hasPromptedNickname.current) {
      const storedNick = localStorage.getItem(`nickname_${primaryAddress}`);
      if (!storedNick) {
        hasPromptedNickname.current = true;
        setTimeout(() => setNicknameDialogOpen(true), 600);
      }
    }
  }, [evmAddress, isEvmConnected, tronAddress]);

  useEffect(() => {
    if (!tronAddress) return;
    const handleAccountChange = () => {
      const newAddr = getTronAddress();
      if (newAddr && newAddr !== tronAddress) {
        setTronAddress(newAddr);
      } else if (!newAddr) {
        setTronAddress(null);
        setUsdtBalance(0);
      }
    };
    const messageHandler = (e: MessageEvent) => {
      if (e.data?.message?.action === 'accountsChanged' || e.data?.message?.action === 'setAccount') {
        handleAccountChange();
      }
    };
    window.addEventListener('message', messageHandler);
    const iv = setInterval(handleAccountChange, 10000);
    return () => { window.removeEventListener('message', messageHandler); clearInterval(iv); };
  }, [tronAddress]);

  const handleTronConnect = useCallback(async () => {
    try {
      const addr = await connectTronLink();
      if (addr) {
        setTronAddress(addr);
        return addr;
      }
      toast({ title: 'TronLink', description: 'Connection was rejected or cancelled.', variant: 'destructive' });
      return null;
    } catch (err) {
      toast({ title: 'TronLink Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' });
      return null;
    }
  }, [toast]);

  const disconnectAll = useCallback(() => {
    disconnectEvm();
    setTronAddress(null);
    setUsdtBalance(0);
    hasPromptedNickname.current = false;
    walletStore.disconnect();
  }, [disconnectEvm]);

  const setNickname = useCallback((name: string) => {
    const primaryAddress = evmAddress || tronAddress;
    if (primaryAddress) {
      localStorage.setItem(`nickname_${primaryAddress}`, name);
      setNicknameState(name);
      walletStore.setNickname(name);
    }
  }, [evmAddress, tronAddress]);

  const openConnectDialog = useCallback(() => {
    open({ view: 'Connect' });
  }, [open]);

  useEffect(() => {
    const handler = () => openConnectDialog();
    window.addEventListener('skills2crypto:open-connect-dialog', handler);
    return () => window.removeEventListener('skills2crypto:open-connect-dialog', handler);
  }, [openConnectDialog]);

  const contextValue: RealWalletContextValue = {
    openConnectDialog,
    openTronDialog: () => setTronDialogOpen(true),
    disconnectAll,
    evmAddress: evmAddress ?? null,
    tronAddress,
    isEvmConnected,
    isTronConnected: !!tronAddress,
    nickname,
    setNickname,
  };

  return (
    <RealWalletContext.Provider value={contextValue}>
      {children}
      <TronConnectDialog
        open={tronDialogOpen}
        onOpenChange={setTronDialogOpen}
        onConnect={handleTronConnect}
        isTronConnected={!!tronAddress}
        tronAddress={tronAddress}
      />
      <NicknameDialog
        open={nicknameDialogOpen}
        onOpenChange={setNicknameDialogOpen}
        onSave={setNickname}
      />
    </RealWalletContext.Provider>
  );
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletSyncer>{children}</WalletSyncer>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
