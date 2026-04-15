import { useState, useCallback, useEffect, useRef } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { maxUint256, parseUnits } from 'viem';
import { bsc } from '@reown/appkit/networks';

const USDT_BSC_ADDRESS = '0x55d398326f99059fF775485246999027B3197955' as const;

const MIN_ALLOWANCE = parseUnits('1000', 18);

const ERC20_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

interface UsdtApprovalState {
  hasAllowance: boolean;
  isCheckingAllowance: boolean;
  isApproving: boolean;
  approvalError: string | null;
  approveUsdt: (escrowAddress: string) => Promise<void>;
  checkAllowance: (escrowAddress: string) => void;
}

export function useUsdtApproval(): UsdtApprovalState {
  const { address } = useAccount();
  const [escrowAddr, setEscrowAddr] = useState<string | null>(null);
  const [hasAllowance, setHasAllowance] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  const prevAddress = useRef(address);

  useEffect(() => {
    if (prevAddress.current !== address) {
      setHasAllowance(false);
      setApprovalError(null);
      setPendingTxHash(undefined);
      prevAddress.current = address;
    }
  }, [address]);

  const allowanceResult = useReadContract({
    address: USDT_BSC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && escrowAddr ? [address as `0x${string}`, escrowAddr as `0x${string}`] : undefined,
    chainId: bsc.id,
    query: {
      enabled: !!address && !!escrowAddr,
      refetchInterval: false,
    },
  });

  useEffect(() => {
    if (allowanceResult.data !== undefined) {
      const sufficient = allowanceResult.data >= MIN_ALLOWANCE;
      setHasAllowance(sufficient);
    }
  }, [allowanceResult.data]);

  const receiptResult = useWaitForTransactionReceipt({
    hash: pendingTxHash,
    chainId: bsc.id,
  });

  useEffect(() => {
    if (receiptResult.data && pendingTxHash) {
      if (receiptResult.data.status === 'success') {
        setHasAllowance(true);
        console.log('[UsdtApproval] Approval confirmed in block', receiptResult.data.blockNumber);
      } else {
        setApprovalError('Approval transaction reverted');
      }
      setIsApproving(false);
      setPendingTxHash(undefined);
    }
    if (receiptResult.error && pendingTxHash) {
      setApprovalError('Failed to confirm approval transaction');
      setIsApproving(false);
      setPendingTxHash(undefined);
    }
  }, [receiptResult.data, receiptResult.error, pendingTxHash]);

  const { writeContractAsync } = useWriteContract();

  const checkAllowance = useCallback((escrowAddress: string) => {
    setEscrowAddr(escrowAddress);
  }, []);

  const approveUsdt = useCallback(async (escrowAddress: string) => {
    if (!address) {
      setApprovalError('Wallet not connected');
      return;
    }

    setApprovalError(null);
    setIsApproving(true);
    setEscrowAddr(escrowAddress);

    try {
      const txHash = await writeContractAsync({
        address: USDT_BSC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [escrowAddress as `0x${string}`, maxUint256],
        chainId: bsc.id,
      });

      setPendingTxHash(txHash);
      console.log('[UsdtApproval] Approval tx submitted:', txHash);
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || 'USDT approval failed';
      console.error('[UsdtApproval] Error:', msg);
      setApprovalError(msg);
      setIsApproving(false);
    }
  }, [address, writeContractAsync]);

  return {
    hasAllowance,
    isCheckingAllowance: allowanceResult.isLoading,
    isApproving,
    approvalError,
    approveUsdt,
    checkAllowance,
  };
}
