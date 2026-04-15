const { ethers } = require("hardhat");

async function main() {
  const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
  const USDT_DECIMALS = 6;
  const PLATFORM_WALLET = "0x7F8Bc18A773f101194071aA559d15d2a59bf6832";
  const ORACLE_ADDRESS = "0x2ad7345E4ad7Fff0Ec5cB41B96e69035f96DFCB8";
  const INITIAL_GAS_PRICE = 1;

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "BNB");

  const Factory = await ethers.getContractFactory("Skills2CryptoEscrow");

  console.log("Deploying Skills2CryptoEscrow...");
  console.log("  USDT:", USDT_ADDRESS);
  console.log("  USDT decimals:", USDT_DECIMALS);
  console.log("  Platform wallet:", PLATFORM_WALLET);
  console.log("  Oracle:", ORACLE_ADDRESS);
  console.log("  Initial gas price:", INITIAL_GAS_PRICE);

  const contract = await Factory.deploy(
    USDT_ADDRESS,
    USDT_DECIMALS,
    PLATFORM_WALLET,
    ORACLE_ADDRESS,
    INITIAL_GAS_PRICE
  );

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\n=== DEPLOYMENT SUCCESSFUL ===");
  console.log("Contract address:", address);
  console.log("Transaction hash:", contract.deploymentTransaction()?.hash);
  console.log("============================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
