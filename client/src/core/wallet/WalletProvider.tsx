import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { mainnet, bsc } from '@reown/appkit/networks';
import { useAppKit, useAppKitAccount, useAppKitNetwork, useDisconnect as useAppKitDisconnect } from '@reown/appkit/react';
import { useBalance } from 'wagmi';
import { wagmiConfig, appKit } from '@/config/wagmi';
import { queryClient } from '@/lib/queryClient';
import { walletStore } from './WalletStore';
import { NicknameDialog } from '@/components/wallet/NicknameDialog';
import { useTronLink } from './useTronLink';
import { useTonConnect } from './useTonConnect';
import type { Asset } from '@/core/types';

export const REQUIRED_CHAIN: Record<'BNB' | 'ETH', { chainId: number; name: string }> = {
  BNB: { chainId: 56, name: 'BNB Smart Chain' },
  ETH: { chainId: 1, name: 'Ethereum' },
};

interface RealWalletContextValue {
  openConnectDialog: () => void;
  disconnectAll: () => void;
  evmAddress: string | null;
  isEvmConnected: boolean;
  nickname: string | null;
  setNickname: (name: string) => void;
  currentChainId: number | null;
  currentChainName: string | null;
  switchToChain: (chainId: number) => Promise<void>;
  isCorrectChainForAsset: (asset: Asset) => boolean;
  isSwitchingChain: boolean;
  isTronLinkInstalled: boolean;
  isTronConnected: boolean;
  tronAddress: string | null;
  usdtTrc20Balance: number;
  isTronConnecting: boolean;
  connectTronLink: () => Promise<void>;
  disconnectTronLink: () => void;
  isTonConnected: boolean;
  tonAddress: string | null;
  tonBalance: number;
  isTonConnecting: boolean;
  connectTonWallet: () => void;
  disconnectTonWallet: () => void;
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
  const { chainId: currentChainId, switchNetwork } = useAppKitNetwork();
  const [nicknameDialogOpen, setNicknameDialogOpen] = useState(false);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const [isSwitchingChain, setIsSwitchingChain] = useState(false);
  const hasPromptedNickname = useRef(false);

  const {
    isTronLinkInstalled,
    isTronConnected,
    tronAddress,
    usdtTrc20Balance,
    isConnecting: isTronConnecting,
    connectTronLink,
    disconnectTronLink,
  } = useTronLink();

  const {
    isTonConnected,
    tonAddress,
    tonBalance,
    isConnecting: isTonConnecting,
    connectTonWallet,
    disconnectTonWallet,
  } = useTonConnect();

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

  const isAnyConnected = isEvmConnected || isTronConnected || isTonConnected;
  const primaryAddress = evmAddress ?? tronAddress ?? tonAddress ?? null;

  useEffect(() => {
    if (primaryAddress && isAnyConnected) {
      const storedNick = localStorage.getItem(`nickname_${primaryAddress}`);
      setNicknameState(storedNick);
    }

    walletStore.syncRealWallet({
      connected: isAnyConnected,
      address: primaryAddress,
      balances: {
        ETH: ethBalance.data ? parseFloat(ethBalance.data.formatted) : 0,
        BNB: bnbBalance.data ? parseFloat(bnbBalance.data.formatted) : 0,
        USDT: usdtTrc20Balance,
        TON: tonBalance,
      },
      nickname: primaryAddress ? localStorage.getItem(`nickname_${primaryAddress}`) : null,
    });
  }, [evmAddress, isEvmConnected, ethBalance.data, bnbBalance.data, isTronConnected, tronAddress, usdtTrc20Balance, primaryAddress, isAnyConnected, isTonConnected, tonAddress, tonBalance]);

  useEffect(() => {
    if (isAnyConnected && primaryAddress && !hasPromptedNickname.current) {
      const storedNick = localStorage.getItem(`nickname_${primaryAddress}`);
      hasPromptedNickname.current = true;
      if (!storedNick) {
        setTimeout(() => setNicknameDialogOpen(true), 600);
      } else {
        // nickname already set; no further onboarding needed
      }
    }
  }, [primaryAddress, isAnyConnected]);

  const disconnectAll = useCallback(() => {
    if (isEvmConnected) disconnectEvm();
    if (isTronConnected) disconnectTronLink();
    if (isTonConnected) disconnectTonWallet();
    hasPromptedNickname.current = false;
    walletStore.disconnect();
  }, [disconnectEvm, isEvmConnected, isTronConnected, disconnectTronLink, isTonConnected, disconnectTonWallet]);

  const setNickname = useCallback((name: string) => {
    if (primaryAddress) {
      localStorage.setItem(`nickname_${primaryAddress}`, name);
      setNicknameState(name);
      walletStore.setNickname(name);
    }
  }, [primaryAddress]);

  const openConnectDialog = useCallback(() => {
    open({ view: 'Connect' });
  }, [open]);

  const switchToChain = useCallback(async (targetChainId: number) => {
    setIsSwitchingChain(true);
    try {
      const network = targetChainId === 56 ? bsc : mainnet;
      switchNetwork(network);
    } catch (err) {
      console.error('[WalletProvider] switchNetwork error:', err);
    } finally {
      setTimeout(() => setIsSwitchingChain(false), 1500);
    }
  }, [switchNetwork]);

  const isCorrectChainForAsset = useCallback((asset: Asset) => {
    if (asset === 'TON') return isTonConnected;
    if (asset === 'USDT') return isTronConnected;
    if (!currentChainId) return false;
    if (asset === 'BNB' || asset === 'ETH') {
      return Number(currentChainId) === REQUIRED_CHAIN[asset].chainId;
    }
    return false;
  }, [currentChainId, isTronConnected, isTonConnected]);

  useEffect(() => {
    const handler = () => openConnectDialog();
    window.addEventListener('skills2crypto:open-connect-dialog', handler);
    return () => window.removeEventListener('skills2crypto:open-connect-dialog', handler);
  }, [openConnectDialog]);

  const chainNames: Record<number, string> = { 1: 'Ethereum', 56: 'BNB Smart Chain' };

  const contextValue: RealWalletContextValue = {
    openConnectDialog,
    disconnectAll,
    evmAddress: evmAddress ?? null,
    isEvmConnected,
    nickname,
    setNickname,
    currentChainId: currentChainId ? Number(currentChainId) : null,
    currentChainName: currentChainId ? (chainNames[Number(currentChainId)] ?? `Chain ${currentChainId}`) : null,
    switchToChain,
    isCorrectChainForAsset,
    isSwitchingChain,
    isTronLinkInstalled,
    isTronConnected,
    tronAddress,
    usdtTrc20Balance,
    isTronConnecting,
    connectTronLink,
    disconnectTronLink,
    isTonConnected,
    tonAddress,
    tonBalance,
    isTonConnecting,
    connectTonWallet,
    disconnectTonWallet,
  };

  return (
    <RealWalletContext.Provider value={contextValue}>
      {children}
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
