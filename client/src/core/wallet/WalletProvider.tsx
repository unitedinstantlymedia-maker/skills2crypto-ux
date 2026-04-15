import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { mainnet, bsc } from '@reown/appkit/networks';
import { useAppKit, useAppKitAccount, useAppKitNetwork, useDisconnect as useAppKitDisconnect } from '@reown/appkit/react';
import { useBalance, useReadContract } from 'wagmi';
import { wagmiConfig, appKit } from '@/config/wagmi';
import { queryClient } from '@/lib/queryClient';
import { walletStore } from './WalletStore';
import { NicknameDialog } from '@/components/wallet/NicknameDialog';
import { SessionKeyDialog } from '@/components/wallet/SessionKeyDialog';
import { useSessionKey } from './useSessionKey';
import { useUsdtApproval } from './useUsdtApproval';
import { formatUnits } from 'viem';
import { useTronLink } from './useTronLink';
import { useTonConnect } from './useTonConnect';
import type { Asset } from '@/core/types';

type OnboardingStep = 'ready' | 'signing' | 'registering' | 'approving' | 'done';

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

export const REQUIRED_CHAIN: Record<Exclude<Asset, 'TON'>, { chainId: number; name: string }> = {
  USDT: { chainId: 56, name: 'BNB Smart Chain' },
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
  usdtBscBalance: number;
  isTonConnected: boolean;
  tonAddress: string | null;
  tonBalance: number;
  isTonConnecting: boolean;
  connectTonWallet: () => void;
  disconnectTonWallet: () => void;
  hasSessionKey: boolean;
  promptSessionKey: () => Promise<void>;
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
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [nickname, setNicknameState] = useState<string | null>(null);
  const [isSwitchingChain, setIsSwitchingChain] = useState(false);
  const hasPromptedNickname = useRef(false);
  const [nicknameFlowDone, setNicknameFlowDone] = useState(false);
  const [pendingSessionPrompt, setPendingSessionPrompt] = useState(false);
  const wasEvmConnected = useRef(isEvmConnected);

  const {
    hasSession: hasSessionKey,
    isSigningSession,
    isRegistering,
    sessionError,
    escrowAddress: sessionEscrowAddress,
    promptSessionKey: doPromptSessionKey,
  } = useSessionKey();

  const {
    hasAllowance: hasUsdtAllowance,
    isApproving: isApprovingUsdt,
    approvalError,
    approveUsdt,
    checkAllowance,
  } = useUsdtApproval();

  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('ready');

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

  const usdtBscResult = useReadContract({
    address: USDT_BSC_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: evmAddr ? [evmAddr] : undefined,
    chainId: bsc.id,
    query: { enabled: !!evmAddr, refetchInterval: 30000 },
  });

  const usdtBsc = usdtBscResult.data ? parseFloat(formatUnits(usdtBscResult.data, 18)) : 0;
  const usdtTotal = usdtBsc + usdtTrc20Balance;

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
        USDT: usdtTotal,
        TON: tonBalance,
      },
      nickname: primaryAddress ? localStorage.getItem(`nickname_${primaryAddress}`) : null,
    });
  }, [evmAddress, isEvmConnected, ethBalance.data, bnbBalance.data, usdtTotal, isTronConnected, tronAddress, usdtTrc20Balance, primaryAddress, isAnyConnected, isTonConnected, tonAddress, tonBalance]);

  useEffect(() => {
    if (isAnyConnected && primaryAddress && !hasPromptedNickname.current) {
      const storedNick = localStorage.getItem(`nickname_${primaryAddress}`);
      hasPromptedNickname.current = true;
      if (!storedNick) {
        setTimeout(() => setNicknameDialogOpen(true), 600);
      } else {
        setNicknameFlowDone(true);
      }
    }
  }, [primaryAddress, isAnyConnected]);

  useEffect(() => {
    if (!nicknameDialogOpen && hasPromptedNickname.current) {
      setNicknameFlowDone(true);
    }
  }, [nicknameDialogOpen]);

  useEffect(() => {
    const justConnected = isEvmConnected && !wasEvmConnected.current;
    wasEvmConnected.current = isEvmConnected;
    if (justConnected && evmAddress && !hasSessionKey) {
      setPendingSessionPrompt(true);
    }
  }, [isEvmConnected, evmAddress, hasSessionKey]);

  useEffect(() => {
    if (
      pendingSessionPrompt &&
      nicknameFlowDone &&
      isEvmConnected &&
      evmAddress &&
      !hasSessionKey &&
      !sessionDialogOpen
    ) {
      const timer = setTimeout(() => {
        setSessionDialogOpen(true);
        setPendingSessionPrompt(false);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [pendingSessionPrompt, nicknameFlowDone, isEvmConnected, evmAddress, hasSessionKey, sessionDialogOpen]);

  useEffect(() => {
    if (isSigningSession) setOnboardingStep('signing');
    else if (isRegistering) setOnboardingStep('registering');
    else if (isApprovingUsdt) setOnboardingStep('approving');
    else if (hasSessionKey && hasUsdtAllowance && sessionDialogOpen) {
      setOnboardingStep('done');
      setSessionDialogOpen(false);
    } else if (!isSigningSession && !isRegistering && !isApprovingUsdt && onboardingStep !== 'done') {
      setOnboardingStep('ready');
    }
  }, [isSigningSession, isRegistering, isApprovingUsdt, hasSessionKey, hasUsdtAllowance, sessionDialogOpen]);

  const approvalTriggered = useRef(false);

  useEffect(() => {
    if (hasSessionKey && sessionEscrowAddress && !hasUsdtAllowance && sessionDialogOpen && !isApprovingUsdt && !approvalError && !approvalTriggered.current) {
      approvalTriggered.current = true;
      setOnboardingStep('approving');
      approveUsdt(sessionEscrowAddress);
    }
  }, [hasSessionKey, sessionEscrowAddress, hasUsdtAllowance, sessionDialogOpen, isApprovingUsdt, approvalError, approveUsdt]);

  useEffect(() => {
    if (!sessionDialogOpen) {
      approvalTriggered.current = false;
    }
  }, [sessionDialogOpen]);

  useEffect(() => {
    if (hasSessionKey && hasUsdtAllowance && sessionDialogOpen) {
      const timer = setTimeout(() => setSessionDialogOpen(false), 500);
      return () => clearTimeout(timer);
    }
  }, [hasSessionKey, hasUsdtAllowance, sessionDialogOpen]);

  useEffect(() => {
    if (sessionEscrowAddress) {
      checkAllowance(sessionEscrowAddress);
    }
  }, [sessionEscrowAddress, checkAllowance]);

  const disconnectAll = useCallback(() => {
    if (isEvmConnected) disconnectEvm();
    if (isTronConnected) disconnectTronLink();
    if (isTonConnected) disconnectTonWallet();
    hasPromptedNickname.current = false;
    setNicknameFlowDone(false);
    setPendingSessionPrompt(false);
    setOnboardingStep('ready');
    wasEvmConnected.current = false;
    walletStore.disconnect();
  }, [disconnectEvm, isEvmConnected, isTronConnected, disconnectTronLink, isTonConnected, disconnectTonWallet]);

  const promptSessionKey = useCallback(async () => {
    setSessionDialogOpen(true);
  }, []);

  const handleSessionSign = useCallback(async () => {
    await doPromptSessionKey();
  }, [doPromptSessionKey]);

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
    if (asset === 'USDT' && isTronConnected) return true;
    if (!currentChainId) return false;
    const required = REQUIRED_CHAIN[asset];
    return Number(currentChainId) === required.chainId;
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
    usdtBscBalance: usdtBsc,
    isTonConnected,
    tonAddress,
    tonBalance,
    isTonConnecting,
    connectTonWallet,
    disconnectTonWallet,
    hasSessionKey,
    promptSessionKey,
  };

  return (
    <RealWalletContext.Provider value={contextValue}>
      {children}
      <NicknameDialog
        open={nicknameDialogOpen}
        onOpenChange={setNicknameDialogOpen}
        onSave={setNickname}
      />
      <SessionKeyDialog
        open={sessionDialogOpen}
        onOpenChange={setSessionDialogOpen}
        onSign={handleSessionSign}
        step={onboardingStep}
        error={sessionError || approvalError}
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
