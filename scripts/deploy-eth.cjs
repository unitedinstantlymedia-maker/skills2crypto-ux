const { ethers } = require("hardhat");

async function main() {
  const PLATFORM_WALLET = "0x7F8Bc18A773f101194071aA559d15d2a59bf6832";
  const ORACLE_ADDRESS = "0x2ad7345E4ad7Fff0Ec5cB41B96e69035f96DFCB8";

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  const Factory = await ethers.getContractFactory("Skills2CryptoEscrow");

  console.log("Deploying Skills2CryptoEscrow V2 to Ethereum mainnet...");
  console.log("  Platform wallet:", PLATFORM_WALLET);
  console.log("  Oracle:", ORACLE_ADDRESS);

  const contract = await Factory.deploy(PLATFORM_WALLET, ORACLE_ADDRESS);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\n=== ETH MAINNET DEPLOYMENT SUCCESSFUL ===");
  console.log("Contract address:", address);
  console.log("Transaction hash:", contract.deploymentTransaction()?.hash);
  console.log("\nSet ETH_ESCROW_ADDRESS=" + address);
  console.log("=========================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
