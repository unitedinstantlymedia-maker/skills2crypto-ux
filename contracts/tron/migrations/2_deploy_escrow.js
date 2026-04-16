const Skills2CryptoEscrow = artifacts.require("Skills2CryptoEscrow");

// Tron mainnet constants:
//   USDT TRC-20: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t (6 decimals)
//   Platform wallet (Ledger): TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq
const USDT_ADDRESS = process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const PLATFORM_WALLET = process.env.TRON_PLATFORM_WALLET || "TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq";

// Initial gasReserve cost in USDT smallest units per gas unit. Tron uses
// energy/bandwidth rather than gas — set this to a conservative starting value
// that the oracle will update via updateGasPrice() as conditions change.
const INITIAL_GAS_PRICE_USDT = process.env.TRON_INITIAL_GAS_PRICE_USDT || 1;

module.exports = async function (deployer) {
  const oracle = process.env.ORACLE_TRON_ADDRESS;
  if (!oracle) throw new Error("ORACLE_TRON_ADDRESS env var is required");

  console.log("Deploying Skills2CryptoEscrow to Tron with:");
  console.log("  USDT:           ", USDT_ADDRESS);
  console.log("  Platform wallet:", PLATFORM_WALLET);
  console.log("  Oracle:         ", oracle);

  await deployer.deploy(
    Skills2CryptoEscrow,
    USDT_ADDRESS,
    6,
    PLATFORM_WALLET,
    oracle,
    INITIAL_GAS_PRICE_USDT
  );

  const instance = await Skills2CryptoEscrow.deployed();
  console.log("Skills2CryptoEscrow deployed at:", instance.address);

  // Tron deployments do not use the EVM session-key onboarding flow —
  // each per-match deposit signature is sufficient authorization.
  // Disable session validation so depositUSDT* don't revert with
  // "No session key" for Tron players.
  console.log("Disabling sessionRequired (Tron-specific)…");
  await instance.setSessionRequired(false);
  console.log("sessionRequired = false");
};
