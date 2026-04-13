import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { WagmiProvider, useAccount, useBalance, useConnect, useDisconnect } from 'wagmi';
import { mainnet, bsc } from 'wagmi/chains';
import { wagmiConfig } from '@/config/wagmi';
import { walletStore } from './WalletStore';
import { connectTronLink, getTronAddress, getUsdtTrc20Balance, isTronLinkAvailable } from './TronWallet';
import { ConnectWalletDialog } from '@/components/wallet/ConnectWalletDialog';
import { NicknameDialog } from '@/components/wallet/NicknameDialog';

interface RealWalletContextValue {
  openConnectDialog: () => void;
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
  const { address: evmAddress, isConnected: isEvmConnected } = useAccount();
  const { disconnect: disconnectEvm } = useDisconnect();
  const [tronAddress, setTronAddress] = useState<string | null>(null);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [nicknameDialogOpen, setNicknameDialogOpen] = useState(false);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const hasPromptedNickname = useRef(false);

  const ethBalance = useBalance({
    address: evmAddress,
    chainId: mainnet.id,
    query: { enabled: isEvmConnected },
  });

  const bnbBalance = useBalance({
    address: evmAddress,
    chainId: bsc.id,
    query: { enabled: isEvmConnected },
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

  const handleTronConnect = useCallback(async () => {
    const addr = await connectTronLink();
    if (addr) setTronAddress(addr);
    return addr;
  }, []);

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

  useEffect(() => {
    const handler = () => setConnectDialogOpen(true);
    window.addEventListener('skills2crypto:open-connect-dialog', handler);
    return () => window.removeEventListener('skills2crypto:open-connect-dialog', handler);
  }, []);

  const contextValue: RealWalletContextValue = {
    openConnectDialog: () => setConnectDialogOpen(true),
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
      <ConnectWalletDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
        onTronConnect={handleTronConnect}
        isEvmConnected={isEvmConnected}
        isTronConnected={!!tronAddress}
        evmAddress={evmAddress ?? null}
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
      <WalletSyncer>{children}</WalletSyncer>
    </WagmiProvider>
  );
}
