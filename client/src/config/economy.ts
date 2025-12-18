// Economy configuration

export const FEE_RATE = 0.03; // 3% platform fee
export const NETWORK_FEE_USD_PER_PLAYER = 0; // No network fee for now

// Mock exchange rates for fee calculation
export const ASSET_PRICES_USD: Record<string, number> = {
  USDT: 1.0,
  ETH: 3000.0,
  TON: 5.0
};

export const STAKE_PRESETS = [5, 20, 50, 100];

export const INITIAL_BALANCES = {
  USDT: 1000,
  ETH: 1.5,
  TON: 100
};
