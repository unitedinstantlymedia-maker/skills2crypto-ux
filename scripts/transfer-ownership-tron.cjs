/* eslint-disable no-console */
/**
 * Transfer ownership of the live Tron Skills2CryptoEscrowTron contract.
 *
 * USAGE
 *   TRON_ESCROW_CONTRACT=<base58> NEW_OWNER=<base58> \
 *     ORACLE_PRIVATE_KEY=<owner-key-hex> CONFIRM=YES \
 *     node scripts/transfer-ownership-tron.cjs
 *
 * Tron note: the "owner" of the contract is whoever called the
 * constructor at deploy time — usually `DEPLOYER_PRIVATE_KEY`. Set
 * that key in the env (or override via OWNER_PRIVATE_KEY) so the
 * sender of the transferOwnership tx == the current owner. The script
 * derives + checks before broadcasting.
 *
 * Tron does not have a Safe equivalent; the recommended replacement is
 * a Tron multi-sig wallet (https://shasta.tronscan.org/#/wallet/multisign)
 * or a smart-contract proxy you control. Verify the new owner address
 * exists on Tronscan before running with CONFIRM=YES.
 */

const TronWeb = require("tronweb");

async function main() {
  const escrowBase58 = process.env.TRON_ESCROW_CONTRACT;
  const newOwner = process.env.NEW_OWNER;
  const confirm = process.env.CONFIRM === "YES";
  const fullHost = process.env.TRON_RPC_URL || "https://api.trongrid.io";
  const ownerKey =
    process.env.OWNER_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.ORACLE_PRIVATE_KEY;

  if (!escrowBase58) throw new Error("TRON_ESCROW_CONTRACT is required");
  if (!newOwner) throw new Error("NEW_OWNER is required");
  if (!ownerKey) throw new Error("OWNER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is required");

  const tronWeb = new TronWeb({
    fullHost,
    privateKey: ownerKey.replace(/^0x/, ""),
    headers: process.env.TRON_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRON_API_KEY } : {},
  });

  const signerBase58 = tronWeb.address.fromPrivateKey(ownerKey.replace(/^0x/, ""));
  if (!signerBase58) throw new Error("Failed to derive signer address from owner key");

  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(newOwner)) {
    throw new Error("NEW_OWNER must be a Tron base58 address (T...)");
  }

  // Read current owner via a constant view call.
  const triggerView = async (method) => {
    const r = await tronWeb.transactionBuilder.triggerConstantContract(
      escrowBase58,
      method + "()",
      {},
      [],
      signerBase58
    );
    const raw = r?.constant_result?.[0];
    if (!raw) throw new Error(`view call ${method} returned empty`);
    return tronWeb.address.fromHex("41" + raw.slice(-40));
  };

  const [currentOwner, oracle, platformWallet] = await Promise.all([
    triggerView("owner"),
    triggerView("oracle"),
    triggerView("platformWallet"),
  ]);

  console.log("====================================================");
  console.log(" Tron Skills2CryptoEscrowTron — transferOwnership");
  console.log("====================================================");
  console.log("FullHost        :", fullHost);
  console.log("Escrow          :", escrowBase58);
  console.log("Signer          :", signerBase58);
  console.log("Current owner   :", currentOwner);
  console.log("Current oracle  :", oracle);
  console.log("Platform wallet :", platformWallet);
  console.log("New owner       :", newOwner);
  console.log("====================================================");

  if (currentOwner !== signerBase58) {
    throw new Error("Signer is NOT the current owner — aborting.");
  }
  if (newOwner === currentOwner) {
    throw new Error("NEW_OWNER == current owner; nothing to do.");
  }
  if (newOwner === oracle || newOwner === platformWallet) {
    throw new Error("NEW_OWNER matches oracle or platform wallet — refusing.");
  }

  if (!confirm) {
    console.log("DRY-RUN: set CONFIRM=YES to broadcast the transferOwnership tx.");
    process.exit(0);
  }

  console.log("Submitting transferOwnership(...) — this is IRREVERSIBLE.");
  const newOwnerHex = "0x" + tronWeb.address.toHex(newOwner).slice(2);
  const tx = await tronWeb.transactionBuilder.triggerSmartContract(
    escrowBase58,
    "transferOwnership(address)",
    { feeLimit: 100 * 1_000_000, callValue: 0 },
    [{ type: "address", value: newOwnerHex }],
    signerBase58
  );
  if (!tx?.result?.result) {
    throw new Error(`triggerSmartContract failed: ${tx?.result?.message || "unknown"}`);
  }
  const signed = await tronWeb.trx.sign(tx.transaction);
  const sent = await tronWeb.trx.sendRawTransaction(signed);
  if (!sent?.result || !sent?.txid) {
    throw new Error(`Broadcast failed: ${JSON.stringify(sent)}`);
  }
  console.log("tx:", sent.txid);
  console.log(`Owner is now ${newOwner}. Verify on Tronscan.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
