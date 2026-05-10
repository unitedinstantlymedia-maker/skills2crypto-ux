import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, bsc } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { http, createConfig } from 'wagmi';

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID || '';

const metadata = {
  name: 'Skills2Crypto',
  description: '1v1 Crypto Skill Games — Chess, Tetris, Checkers, Battleship',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://skills2crypto.com',
  icons: [],
};

const networks = [mainnet, bsc];

// Module-level init can throw on mobile WebViews when AppKit / WalletConnect
// internals try to use IndexedDB or storage APIs that are restricted. If that
// happens we MUST NOT let the entire app go down — wallet features become
// unavailable but Landing/Rules/About/etc must still render. The error gets
// surfaced via the RootErrorBoundary if it bubbles, but a fallback wagmi
// config keeps WagmiProvider happy regardless.

let _wagmiAdapter: WagmiAdapter | null = null;
let _appKit: ReturnType<typeof createAppKit> | null = null;
let _wagmiConfig: ReturnType<typeof createConfig> | null = null;
let _initError: Error | null = null;

try {
  _wagmiAdapter = new WagmiAdapter({
    projectId,
    networks,
    transports: {
      [mainnet.id]: http(),
      [bsc.id]: http(),
    },
  });

  _appKit = createAppKit({
    adapters: [_wagmiAdapter],
    networks: [mainnet, bsc],
    projectId,
    metadata,
    themeMode: 'dark',
    themeVariables: {
      '--w3m-accent': '#10b981',
      '--w3m-border-radius-master': '2px',
      '--w3m-font-family': '"Rajdhani", system-ui, sans-serif',
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
    },
    featuredWalletIds: [
      'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
      '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0',
      '0b415a746fb9ee99cce155c2ceca0c6f6061b1dbca2d722b3ba16381d0562150',
      'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e18e4a8e0866d24ec',
    ],
    allWallets: 'SHOW',
  });

  _wagmiConfig = _wagmiAdapter.wagmiConfig as ReturnType<typeof createConfig>;
} catch (err) {
  _initError = err instanceof Error ? err : new Error(String(err));
  console.error('[wagmi] AppKit init failed; falling back to no-op config:', _initError);

  // Build a minimal valid wagmi config so <WagmiProvider> still mounts and
  // the rest of the app renders. Wallet connect attempts will then surface
  // a clean error rather than crashing module load.
  try {
    _wagmiConfig = createConfig({
      chains: [mainnet, bsc],
      transports: {
        [mainnet.id]: http(),
        [bsc.id]: http(),
      },
    });
  } catch (fallbackErr) {
    console.error('[wagmi] fallback createConfig also failed:', fallbackErr);
  }
}

export const wagmiAdapter = _wagmiAdapter;
export const appKit = _appKit;
// May be null if BOTH primary AppKit init AND the fallback createConfig threw.
// Consumers must guard via isWagmiReady (or null-check wagmiConfig) before
// passing it to <WagmiProvider>.
export const wagmiConfig = _wagmiConfig;
export const wagmiInitError = _initError;
export const isWagmiReady = _initError === null && _appKit !== null;

/**
 * Returns wagmiConfig or throws if init failed. Use from code paths that are
 * only reachable AFTER a successful wallet connect (e.g. escrow adapters),
 * where a null config means a programming error rather than a runtime fallback.
 */
export function requireWagmiConfig() {
  if (!_wagmiConfig) {
    throw new Error(
      `Wallet subsystem unavailable: ${_initError?.message || 'wagmi config is null'}`,
    );
  }
  return _wagmiConfig;
}
