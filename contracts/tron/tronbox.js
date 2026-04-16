/**
 * TronBox config for deploying Skills2CryptoEscrow on Tron.
 *
 * Run from contracts/tron/:
 *   tronbox migrate --network shasta   # testnet
 *   tronbox migrate --network mainnet  # production (Ledger-funded deployer)
 *
 * Required env vars:
 *   TRON_DEPLOYER_PRIVATE_KEY  Deployer key (must hold TRX for energy/bandwidth)
 *   TRON_RPC_URL               Optional override (default: TronGrid mainnet)
 */
require("dotenv").config({ path: "../../.env" });

module.exports = {
  networks: {
    mainnet: {
      privateKey: process.env.TRON_DEPLOYER_PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1_000_000_000, // 1000 TRX
      fullHost: process.env.TRON_RPC_URL || "https://api.trongrid.io",
      network_id: "1",
    },
    shasta: {
      privateKey: process.env.TRON_DEPLOYER_PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1_000_000_000,
      fullHost: "https://api.shasta.trongrid.io",
      network_id: "2",
    },
    nile: {
      privateKey: process.env.TRON_DEPLOYER_PRIVATE_KEY,
      userFeePercentage: 100,
      feeLimit: 1_000_000_000,
      fullHost: "https://nile.trongrid.io",
      network_id: "3",
    },
  },
  compilers: {
    solc: {
      version: "0.8.24",
      settings: {
        optimizer: { enabled: true, runs: 200 },
      },
    },
  },
  contracts_directory: "../evm",
  contracts_build_directory: "./build",
  migrations_directory: "./migrations",
};
