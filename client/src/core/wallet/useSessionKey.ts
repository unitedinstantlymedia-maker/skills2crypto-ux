import { useState, useEffect, useCallback, useRef } from 'react';
import { useSignTypedData, useAccount } from 'wagmi';
import { parseUnits } from 'viem';

const SESSION_STORAGE_PREFIX = 'sk_session_';
const SESSION_DURATION_DAYS = 365;
const MAX_STAKE_RAW = '1000000';
const MAX_STAKE_UNITS = parseUnits(MAX_STAKE_RAW, 18);

interface StoredSession {
  player: string;
  sessionAddr: string;
  maxStakePerMatch: string;
  expiry: number;
  nonce: number;
  signature: string;
  txHash: string;
  registeredAt: number;
  chainId: number;
}

interface SessionKeyState {
  hasSession: boolean;
  isSigningSession: boolean;
  isRegistering: boolean;
  sessionError: string | null;
  storedSession: StoredSession | null;
  escrowAddress: string | null;
  promptSessionKey: () => Promise<void>;
}

function getStorageKey(address: string, chainId: number): string {
  return `${SESSION_STORAGE_PREFIX}${address.toLowerCase()}_${chainId}`;
}

function loadSession(address: string, chainId: number): StoredSession | null {
  try {
    const raw = localStorage.getItem(getStorageKey(address, chainId));
    if (!raw) return null;
    const session: StoredSession = JSON.parse(raw);
    if (session.expiry * 1000 < Date.now()) {
      localStorage.removeItem(getStorageKey(address, chainId));
      return null;
    }
    if (session.maxStakePerMatch !== MAX_STAKE_UNITS.toString()) {
      console.log('[SessionKey] Cached session has outdated maxStake, clearing');
      localStorage.removeItem(getStorageKey(address, chainId));
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function saveSession(session: StoredSession): void {
  localStorage.setItem(
    getStorageKey(session.player, session.chainId),
    JSON.stringify(session)
  );
}

const ESCROW_CHAIN_ID = Number(import.meta.env.VITE_ESCROW_CHAIN_ID || 56);

export function useSessionKey(): SessionKeyState {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const [storedSession, setStoredSession] = useState<StoredSession | null>(null);
  const [isSigningSession, setIsSigningSession] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [escrowAddr, setEscrowAddr] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (address) {
      const existing = loadSession(address, ESCROW_CHAIN_ID);
      setStoredSession(existing);
    } else {
      setStoredSession(null);
    }
  }, [address]);

  const promptSessionKey = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!address || !isConnected) {
      setSessionError('Wallet not connected');
      return;
    }

    setSessionError(null);
    setIsSigningSession(true);
    inFlightRef.current = true;

    try {
      const nonceRes = await fetch(`/api/session/nonce?player=${address}&chainId=${ESCROW_CHAIN_ID}`);
      if (!nonceRes.ok) {
        const err = await nonceRes.json().catch(() => ({ error: 'Failed to fetch nonce' }));
        throw new Error(err.error || 'Failed to fetch nonce');
      }
      const { nonce, sessionAddr, escrowAddress } = await nonceRes.json();

      if (!escrowAddress || !sessionAddr) {
        throw new Error('Server returned incomplete session configuration');
      }

      setEscrowAddr(escrowAddress);

      const expiry = Math.floor(Date.now() / 1000) + SESSION_DURATION_DAYS * 86400;

      const domain = {
        name: 'Skills2CryptoEscrow',
        version: '1',
        chainId: BigInt(ESCROW_CHAIN_ID),
        verifyingContract: escrowAddress as `0x${string}`,
      } as const;

      const types = {
        SessionKey: [
          { name: 'player', type: 'address' },
          { name: 'sessionAddr', type: 'address' },
          { name: 'maxStakePerMatch', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      } as const;

      const message = {
        player: address as `0x${string}`,
        sessionAddr: sessionAddr as `0x${string}`,
        maxStakePerMatch: MAX_STAKE_UNITS,
        expiry: BigInt(expiry),
        nonce: BigInt(nonce),
      } as const;

      const signature = await signTypedDataAsync({
        domain,
        types,
        primaryType: 'SessionKey',
        message,
      });

      setIsSigningSession(false);
      setIsRegistering(true);

      const registerRes = await fetch('/api/session/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player: address,
          sessionAddr,
          maxStakePerMatch: MAX_STAKE_UNITS.toString(),
          expiry,
          nonce: Number(nonce),
          signature,
          chainId: ESCROW_CHAIN_ID,
        }),
      });

      if (!registerRes.ok) {
        const err = await registerRes.json().catch(() => ({ error: 'Registration failed' }));
        throw new Error(err.error || 'Registration failed');
      }

      const { txHash } = await registerRes.json();

      const session: StoredSession = {
        player: address,
        sessionAddr,
        maxStakePerMatch: MAX_STAKE_UNITS.toString(),
        expiry,
        nonce: Number(nonce),
        signature,
        txHash,
        registeredAt: Date.now(),
        chainId: ESCROW_CHAIN_ID,
      };

      saveSession(session);
      setStoredSession(session);
      console.log(`[SessionKey] Registered on chain ${ESCROW_CHAIN_ID}, tx: ${txHash}`);
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || 'Session key signing failed';
      console.error('[SessionKey] Error:', msg);
      setSessionError(msg);
    } finally {
      setIsSigningSession(false);
      setIsRegistering(false);
      inFlightRef.current = false;
    }
  }, [address, isConnected, signTypedDataAsync]);

  return {
    hasSession: !!storedSession,
    isSigningSession,
    isRegistering,
    sessionError,
    storedSession,
    escrowAddress: escrowAddr,
    promptSessionKey,
  };
}
