import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet, bsc } from '@reown/appkit/networks';
import { createAppKit } from '@reown/appkit/react';
import { http } from 'wagmi';

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID || '';

const metadata = {
  name: 'Skills2Crypto',
  description: '1v1 Crypto Skill Games — Chess, Tetris, Checkers, Battleship',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://skills2crypto.com',
  icons: [],
};

const networks = [mainnet, bsc];

export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks,
  transports: {
    [mainnet.id]: http(),
    [bsc.id]: http(),
  },
});

export const appKit = createAppKit({
  adapters: [wagmiAdapter],
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

export const wagmiConfig = wagmiAdapter.wagmiConfig;
