import { useState, useCallback, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useSignTypedData } from 'wagmi';
import { maxUint256 } from 'viem';
import { bsc } from '@reown/appkit/networks';

const USDT_BSC_ADDRESS = '0x55d398326f99059fF775485246999027B3197955' as const;
const ESCROW_CHAIN_ID = Number(import.meta.env.VITE_ESCROW_CHAIN_ID || 56);
const PERMIT_STORAGE_PREFIX = 'usdt_permit_';

const PERMIT_DEADLINE = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935');

const ERC20_NONCES_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'nonces',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

interface StoredPermit {
  deadline: string;
  v: number;
  r: string;
  s: string;
  nonce: string;
  owner: string;
  spender: string;
}

interface UsdtPermitState {
  hasPermit: boolean;
  isSigning: boolean;
  permitError: string | null;
  signPermit: (escrowAddress: string) => Promise<void>;
}

function loadStoredPermit(address: string, spender: string): StoredPermit | null {
  try {
    const key = `${PERMIT_STORAGE_PREFIX}${address.toLowerCase()}_${spender.toLowerCase()}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function savePermit(permit: StoredPermit): void {
  const key = `${PERMIT_STORAGE_PREFIX}${permit.owner.toLowerCase()}_${permit.spender.toLowerCase()}`;
  localStorage.setItem(key, JSON.stringify(permit));
}

export function useUsdtPermit(): UsdtPermitState {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [hasPermit, setHasPermit] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  const [permitError, setPermitError] = useState<string | null>(null);
  const prevAddress = useRef(address);

  useEffect(() => {
    if (prevAddress.current !== address) {
      setHasPermit(false);
      setPermitError(null);
      prevAddress.current = address;
    }
  }, [address]);

  const signPermit = useCallback(async (escrowAddress: string) => {
    if (!address) {
      setPermitError('Wallet not connected');
      return;
    }

    setPermitError(null);
    setIsSigning(true);

    try {
      const existing = loadStoredPermit(address, escrowAddress);
      if (existing) {
        setHasPermit(true);
        setIsSigning(false);
        return;
      }

      const nonceRes = await fetch(`/api/session/permit-nonce?owner=${address}&token=${USDT_BSC_ADDRESS}`);
      if (!nonceRes.ok) {
        const err = await nonceRes.json().catch(() => ({ error: 'Failed to fetch permit nonce' }));
        throw new Error(err.error || 'Failed to fetch permit nonce');
      }
      const { nonce, tokenName } = await nonceRes.json();

      const domain = {
        name: tokenName || 'Tether USD',
        version: '1',
        chainId: ESCROW_CHAIN_ID,
        verifyingContract: USDT_BSC_ADDRESS,
      } as const;

      const types = {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      } as const;

      const message = {
        owner: address as `0x${string}`,
        spender: escrowAddress as `0x${string}`,
        value: maxUint256,
        nonce: BigInt(nonce),
        deadline: PERMIT_DEADLINE,
      };

      const signature = await signTypedDataAsync({
        domain,
        types,
        primaryType: 'Permit',
        message,
      });

      const r = `0x${signature.slice(2, 66)}`;
      const s = `0x${signature.slice(66, 130)}`;
      const v = parseInt(signature.slice(130, 132), 16);

      const permit: StoredPermit = {
        deadline: PERMIT_DEADLINE.toString(),
        v,
        r,
        s,
        nonce: nonce.toString(),
        owner: address,
        spender: escrowAddress,
      };

      const storeRes = await fetch('/api/session/permit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(permit),
      });

      if (!storeRes.ok) {
        const err = await storeRes.json().catch(() => ({ error: 'Failed to store permit on server' }));
        throw new Error(err.error || 'Failed to store permit on server');
      }

      savePermit(permit);
      setHasPermit(true);
      console.log('[UsdtPermit] Permit signed and stored for escrow:', escrowAddress);
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || 'USDT permit signing failed';
      console.error('[UsdtPermit] Error:', msg);
      setPermitError(msg);
    } finally {
      setIsSigning(false);
    }
  }, [address, signTypedDataAsync]);

  useEffect(() => {
    if (address) {
      const escrow = import.meta.env.VITE_BSC_ESCROW_ADDRESS;
      if (escrow) {
        const existing = loadStoredPermit(address, escrow);
        if (existing) {
          setHasPermit(true);
        }
      }
    }
  }, [address]);

  return {
    hasPermit,
    isSigning,
    permitError,
    signPermit,
  };
}
