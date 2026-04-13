import { http, createConfig, createStorage } from 'wagmi';
import { mainnet, bsc } from 'wagmi/chains';
import { injected, walletConnect } from '@wagmi/connectors';

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

const connectors = WC_PROJECT_ID
  ? [injected(), walletConnect({ projectId: WC_PROJECT_ID })]
  : [injected()];

export const wagmiConfig = createConfig({
  chains: [mainnet, bsc],
  connectors,
  transports: {
    [mainnet.id]: http(),
    [bsc.id]: http(),
  },
  storage: createStorage({ storage: window.localStorage }),
});
