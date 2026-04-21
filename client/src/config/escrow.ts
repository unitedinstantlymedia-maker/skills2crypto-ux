// Configuration for the Escrow and Wallet layers

export interface AssetConfig {
  name: string;
  decimals: number;
  usdPrice: number;
  comingSoon?: boolean;
}

// Platform fee recipient. In production set VITE_FEE_ADDRESS to your real
// cold wallet via the Netlify build env. Falls back to the zero address so
// any accidental on-chain use fails loudly instead of silently routing funds
// somewhere unexpected.
export const FEE_ADDRESS =
  import.meta.env.VITE_FEE_ADDRESS || "0x0000000000000000000000000000000000000000";

export const SUPPORTED_ASSETS: Record<string, AssetConfig> = {
  USDT: {
    name: 'USDT',
    decimals: 6,
    // Mock conversion rate for network fee calculation (1 USDT = 1 USD)
    usdPrice: 1.0
  },
  ETH: {
    name: 'ETH',
    decimals: 18,
    // Mock conversion rate for network fee (1 ETH = 3000 USD)
    usdPrice: 3000.0
  },
  BNB: {
    name: 'BNB',
    decimals: 18,
    usdPrice: 600.0
  }
};

export const NETWORK_FEE_USD_PER_PLAYER = 0.25;

export const ESCROW_CONTRACT_ADDRESS = "0xMockEscrowContractAddress";
export const CHAIN_ID = 1; // Mainnet placeholder
