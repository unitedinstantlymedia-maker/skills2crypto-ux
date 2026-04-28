/* eslint-disable no-console */
/**
 * Transfer ownership of the live Ethereum Skills2CryptoEscrow contract.
 * See scripts/transfer-ownership-bsc.cjs for the full safety doc — this
 * is the same script with ETH-specific defaults.
 *
 * USAGE
 *   ETH_ESCROW_ADDRESS=<addr> NEW_OWNER=<safe-addr> CONFIRM=YES \
 *     npx hardhat run scripts/transfer-ownership-eth.cjs --network ethMainnet
 *
 * Verify the Safe exists at https://app.safe.global/eth:<addr> before
 * running with CONFIRM=YES.
 */

const { ethers } = require("hardhat");

async function main() {
  const escrowAddr = process.env.ETH_ESCROW_ADDRESS;
  const newOwner = process.env.NEW_OWNER;
  const confirm = process.env.CONFIRM === "YES";

  if (!escrowAddr) throw new Error("ETH_ESCROW_ADDRESS is required");
  if (!newOwner) throw new Error("NEW_OWNER is required");
  if (!ethers.isAddress(newOwner)) throw new Error("NEW_OWNER is not a valid EVM address");
  if (newOwner === ethers.ZeroAddress) throw new Error("NEW_OWNER cannot be the zero address");

  const [signer] = await ethers.getSigners();
  const Escrow = await ethers.getContractFactory("Skills2CryptoEscrow");
  const escrow = Escrow.attach(escrowAddr).connect(signer);

  const [currentOwner, oracle, platformWallet] = await Promise.all([
    escrow.owner(),
    escrow.oracle(),
    escrow.platformWallet(),
  ]);

  console.log("====================================================");
  console.log(" ETH Skills2CryptoEscrow — transferOwnership");
  console.log("====================================================");
  console.log("Network         :", (await ethers.provider.getNetwork()).name || "(unknown)");
  console.log("Escrow          :", escrowAddr);
  console.log("Signer          :", await signer.getAddress());
  console.log("Current owner   :", currentOwner);
  console.log("Current oracle  :", oracle);
  console.log("Platform wallet :", platformWallet);
  console.log("New owner       :", newOwner);
  console.log("====================================================");

  if (currentOwner.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error("Signer is NOT the current owner — aborting.");
  }
  if (newOwner.toLowerCase() === currentOwner.toLowerCase()) {
    throw new Error("NEW_OWNER == current owner; nothing to do.");
  }
  if (
    newOwner.toLowerCase() === oracle.toLowerCase() ||
    newOwner.toLowerCase() === platformWallet.toLowerCase()
  ) {
    throw new Error("NEW_OWNER matches oracle or platform wallet — refusing.");
  }

  if (!confirm) {
    console.log("DRY-RUN: set CONFIRM=YES to broadcast the transferOwnership tx.");
    process.exit(0);
  }

  console.log("Submitting transferOwnership(...) — this is IRREVERSIBLE.");
  const tx = await escrow.transferOwnership(newOwner);
  console.log("tx:", tx.hash);
  const rc = await tx.wait();
  console.log(`Mined in block ${rc.blockNumber}. New owner is now ${newOwner}.`);
  console.log("Verify with: cast call", escrowAddr, "'owner()' --rpc-url <eth-rpc>");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
