const { ethers } = require("hardhat");

const DEFAULT_PLATFORM_WALLET = "0x7F8Bc18A773f101194071aA559d15d2a59bf6832";
const DEFAULT_ORACLE_ADDRESS = "0x2ad7345E4ad7Fff0Ec5cB41B96e69035f96DFCB8";
const MIN_DEPLOY_BALANCE_ETH = process.env.ETH_MIN_DEPLOY_BALANCE || "0.05";

async function main() {
  const PLATFORM_WALLET = process.env.ETH_PLATFORM_WALLET || DEFAULT_PLATFORM_WALLET;
  const ORACLE_ADDRESS = process.env.ETH_ORACLE_ADDRESS || DEFAULT_ORACLE_ADDRESS;

  if (!ethers.isAddress(PLATFORM_WALLET)) throw new Error(`Invalid platform wallet: ${PLATFORM_WALLET}`);
  if (!ethers.isAddress(ORACLE_ADDRESS)) throw new Error(`Invalid oracle address: ${ORACLE_ADDRESS}`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer — set DEPLOYER_PRIVATE_KEY");
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");
  const minBalance = ethers.parseEther(MIN_DEPLOY_BALANCE_ETH);
  if (balance < minBalance) {
    throw new Error(
      `Deployer balance ${ethers.formatEther(balance)} ETH is below required ${MIN_DEPLOY_BALANCE_ETH} ETH. ` +
      `Fund ${deployer.address} on Ethereum mainnet and re-run.`
    );
  }

  const Factory = await ethers.getContractFactory("Skills2CryptoEscrow");

  console.log("Deploying Skills2CryptoEscrow V2 to Ethereum mainnet...");
  console.log("  Platform wallet:", PLATFORM_WALLET);
  console.log("  Oracle:         ", ORACLE_ADDRESS);

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
