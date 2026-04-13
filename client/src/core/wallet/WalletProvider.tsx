import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { mainnet, bsc } from '@reown/appkit/networks';
import { useAppKit, useAppKitAccount, useDisconnect as useAppKitDisconnect } from '@reown/appkit/react';
import { useBalance, useReadContract } from 'wagmi';
import { wagmiConfig, appKit } from '@/config/wagmi';
import { queryClient } from '@/lib/queryClient';
import { walletStore } from './WalletStore';
import { NicknameDialog } from '@/components/wallet/NicknameDialog';
import { formatUnits } from 'viem';

const USDT_BSC_ADDRESS = '0x55d398326f99059fF775485246999027B3197955' as const;
const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

interface RealWalletContextValue {
  openConnectDialog: () => void;
  disconnectAll: () => void;
  evmAddress: string | null;
  isEvmConnected: boolean;
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

  const usdtBscBalance = useReadContract({
    address: USDT_BSC_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: evmAddr ? [evmAddr] : undefined,
    chainId: bsc.id,
    query: { enabled: !!evmAddr, refetchInterval: 30000 },
  });

  const usdtBalance = usdtBscBalance.data ? parseFloat(formatUnits(usdtBscBalance.data, 18)) : 0;

  useEffect(() => {
    if (evmAddress && isEvmConnected) {
      const storedNick = localStorage.getItem(`nickname_${evmAddress}`);
      setNicknameState(storedNick);
    }

    walletStore.syncRealWallet({
      connected: isEvmConnected,
      address: evmAddress ?? null,
      balances: {
        ETH: ethBalance.data ? parseFloat(ethBalance.data.formatted) : 0,
        BNB: bnbBalance.data ? parseFloat(bnbBalance.data.formatted) : 0,
        USDT: usdtBalance,
      },
      nickname: evmAddress ? localStorage.getItem(`nickname_${evmAddress}`) : null,
    });
  }, [evmAddress, isEvmConnected, ethBalance.data, bnbBalance.data, usdtBalance]);

  useEffect(() => {
    if (isEvmConnected && evmAddress && !hasPromptedNickname.current) {
      const storedNick = localStorage.getItem(`nickname_${evmAddress}`);
      if (!storedNick) {
        hasPromptedNickname.current = true;
        setTimeout(() => setNicknameDialogOpen(true), 600);
      }
    }
  }, [evmAddress, isEvmConnected]);

  const disconnectAll = useCallback(() => {
    disconnectEvm();
    hasPromptedNickname.current = false;
    walletStore.disconnect();
  }, [disconnectEvm]);

  const setNickname = useCallback((name: string) => {
    if (evmAddress) {
      localStorage.setItem(`nickname_${evmAddress}`, name);
      setNicknameState(name);
      walletStore.setNickname(name);
    }
  }, [evmAddress]);

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
    disconnectAll,
    evmAddress: evmAddress ?? null,
    isEvmConnected,
    nickname,
    setNickname,
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
