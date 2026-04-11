// Configuration for the Escrow and Wallet layers

export interface AssetConfig {
  name: string;
  decimals: number;
  usdPrice: number;
  comingSoon?: boolean;
}

export const FEE_ADDRESS = import.meta.env.VITE_FEE_ADDRESS || "0xPLATFORM_COLD_WALLET_123"; // Placeholder, mock only

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
