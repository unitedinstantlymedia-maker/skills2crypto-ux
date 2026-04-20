const Skills2CryptoEscrowTron = artifacts.require("Skills2CryptoEscrowTron");

// Tron mainnet constants:
//   USDT TRC-20:  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t (6 decimals)
//   Platform:     TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq (Ledger)
//   Oracle gas:   TBDdWCw89Z28LG6c9s7vC8bQiACVe57XNy
//   SunSwap V2:   TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax
//   WTRX:         TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR
const USDT_ADDRESS = process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const PLATFORM_WALLET = process.env.TRON_PLATFORM_WALLET || "TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq";
const ORACLE_GAS_FUND = process.env.TRON_ORACLE_GAS_FUND || "TBDdWCw89Z28LG6c9s7vC8bQiACVe57XNy";
const SUNSWAP_ROUTER = process.env.TRON_SUNSWAP_ROUTER || "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax";
const WTRX = process.env.TRON_WTRX || "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";

// Trigger SunSwap auto-swap once the gas-fund accumulator passes 50 USDT.
const SWAP_THRESHOLD_UNITS = process.env.TRON_SWAP_THRESHOLD_USDT
  ? Math.round(Number(process.env.TRON_SWAP_THRESHOLD_USDT) * 1_000_000)
  : 50 * 1_000_000;

module.exports = async function (deployer) {
  const oracle = process.env.ORACLE_TRON_ADDRESS;
  if (!oracle) throw new Error("ORACLE_TRON_ADDRESS env var is required");

  console.log("Deploying Skills2CryptoEscrowTron V2 to Tron with:");
  console.log("  USDT:           ", USDT_ADDRESS);
  console.log("  Platform wallet:", PLATFORM_WALLET);
  console.log("  Oracle:         ", oracle);
  console.log("  Oracle gas fund:", ORACLE_GAS_FUND);
  console.log("  SunSwap router: ", SUNSWAP_ROUTER);
  console.log("  WTRX:           ", WTRX);
  console.log("  Swap threshold: ", SWAP_THRESHOLD_UNITS, "(USDT smallest units)");

  await deployer.deploy(
    Skills2CryptoEscrowTron,
    USDT_ADDRESS,
    PLATFORM_WALLET,
    oracle,
    ORACLE_GAS_FUND,
    SUNSWAP_ROUTER,
    WTRX,
    SWAP_THRESHOLD_UNITS
  );

  const instance = await Skills2CryptoEscrowTron.deployed();
  console.log("Skills2CryptoEscrowTron deployed at:", instance.address);
};
