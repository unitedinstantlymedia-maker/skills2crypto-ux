#!/usr/bin/env node
/**
 * TON V2 escrow deploy script.
 *
 * Required env:
 *   TON_DEPLOYER_MNEMONIC      24-word mnemonic of a funded TON wallet (≥3 TON)
 *   TON_ORACLE_MNEMONIC        24-word mnemonic of the oracle wallet
 *                              (its Ed25519 public key is baked into the contract)
 *   TON_PLATFORM_WALLET        Platform fee recipient (bounceable EQ-form)
 *
 * Optional env:
 *   TON_API_KEY                toncenter.com API key (recommended)
 *   TON_RPC_URL                Default https://toncenter.com/api/v2/jsonRPC
 *   TON_DEPOSIT_TIMEOUT_SECS   Default 3600 (1 hour for refundNoShow)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Address, beginCell, toNano, internal } from "@ton/core";
import { TonClient, WalletContractV4 } from "@ton/ton";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const TON_DIR = resolve(PROJECT_ROOT, "contracts/ton");
const BUILD_DIR = resolve(TON_DIR, "build");

function need(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} env var is required`);
  return v.trim();
}

function compile() {
  console.log("[deploy-ton] Compiling Tact contract…");
  const result = spawnSync(
    "npx",
    ["--yes", "tact", "--config", "tact.config.json"],
    { cwd: TON_DIR, stdio: "inherit" }
  );
  if (result.status !== 0) throw new Error("Tact compilation failed");
}

async function loadWrapper() {
  const candidates = [
    resolve(BUILD_DIR, "Skills2CryptoEscrowTON_Skills2CryptoEscrowTON.ts"),
    resolve(BUILD_DIR, "Skills2CryptoEscrowTON.ts"),
    resolve(BUILD_DIR, "skills2crypto_escrow_Skills2CryptoEscrowTON.ts"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Could not find compiled Tact wrapper in ${BUILD_DIR}. ` +
      `Inspect that directory and update scripts/deploy-ton.mjs accordingly.`
    );
  }
  console.log("[deploy-ton] Loading wrapper:", found);
  const mod = await import(`file://${found}`);
  if (!mod.Skills2CryptoEscrowTON) {
    throw new Error("Compiled module does not export Skills2CryptoEscrowTON");
  }
  return mod.Skills2CryptoEscrowTON;
}

async function main() {
  const deployerMnemonic = need("TON_DEPLOYER_MNEMONIC").split(/\s+/);
  const oracleMnemonic = need("TON_ORACLE_MNEMONIC").split(/\s+/);
  const platformWallet = Address.parse(need("TON_PLATFORM_WALLET"));
  const depositTimeout = BigInt(process.env.TON_DEPOSIT_TIMEOUT_SECS || "3600");
  const endpoint = process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC";
  const apiKey = process.env.TON_API_KEY;

  if (deployerMnemonic.length !== 24) throw new Error("TON_DEPLOYER_MNEMONIC must be 24 words");
  if (oracleMnemonic.length !== 24) throw new Error("TON_ORACLE_MNEMONIC must be 24 words");

  compile();
  const Skills2CryptoEscrowTON = await loadWrapper();

  const oracleKey = await mnemonicToPrivateKey(oracleMnemonic);
  const oraclePubkeyBig = BigInt("0x" + Buffer.from(oracleKey.publicKey).toString("hex"));
  console.log("[deploy-ton] Oracle Ed25519 pubkey:", oraclePubkeyBig.toString(16));

  const escrow = await Skills2CryptoEscrowTON.fromInit(
    oraclePubkeyBig,
    platformWallet,
    depositTimeout
  );
  const escrowAddress = escrow.address;
  console.log("[deploy-ton] Computed escrow address:", escrowAddress.toString({ bounceable: true }));

  const client = new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) });

  const deployerKey = await mnemonicToPrivateKey(deployerMnemonic);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: deployerKey.publicKey });
  const walletContract = client.open(wallet);
  const deployerAddress = wallet.address.toString({ bounceable: false });
  console.log("[deploy-ton] Deployer wallet:", deployerAddress);

  const balance = await walletContract.getBalance();
  console.log("[deploy-ton] Deployer balance:", Number(balance) / 1e9, "TON");
  if (balance < toNano("3")) {
    throw new Error(
      `Deployer balance ${Number(balance) / 1e9} TON is too low; fund ${deployerAddress} with ≥3 TON and re-run`
    );
  }

  const existing = await client.getContractState(escrowAddress);
  if (existing.state === "active") {
    console.log("[deploy-ton] Contract is already deployed at", escrowAddress.toString({ bounceable: true }));
    return;
  }

  const seqno = await walletContract.getSeqno();
  console.log("[deploy-ton] Sending deploy message (seqno", seqno + ")…");
  await walletContract.sendTransfer({
    seqno,
    secretKey: deployerKey.secretKey,
    messages: [
      internal({
        to: escrowAddress,
        value: toNano("0.5"),
        init: { code: escrow.init.code, data: escrow.init.data },
        body: beginCell().endCell(),
        bounce: false,
      }),
    ],
  });

  console.log("[deploy-ton] Waiting for contract to become active on-chain…");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await client.getContractState(escrowAddress);
    if (st.state === "active") {
      console.log("\n=== TON DEPLOYMENT SUCCESSFUL ===");
      console.log("Contract address:", escrowAddress.toString({ bounceable: true }));
      console.log("\nSet TON_ESCROW_CONTRACT=" + escrowAddress.toString({ bounceable: true }));
      console.log("=================================\n");
      return;
    }
    process.stdout.write(".");
  }
  throw new Error("Contract did not activate within 120s; check the TON explorer for the deploy tx");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
