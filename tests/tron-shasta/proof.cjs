#!/usr/bin/env node
"use strict";

// Opt-in test runner: no dotenv, project keys, app imports or configurable RPC.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { TronWeb } = require("tronweb");
const {
  HOST, CHAIN_ID, compile,
} = require("./support.cjs");
const mode = process.argv[2];
const dir = process.argv[3] && path.resolve(process.argv[3]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const client = (key) => new TronWeb({ fullHost: HOST, ...(key ? { privateKey: key } : {}) });
const save = (name, data) => fs.writeFileSync(path.join(dir, name),
  JSON.stringify(data, null, 2), { mode: 0o600 });

function validateDir() {
  assert(dir && path.dirname(dir) === os.tmpdir() &&
    path.basename(dir).startsWith("skills2crypto-shasta-"), "Use the --prepare directory");
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Refuse non-directory/symlink");
  assert.equal(stat.mode & 0o077, 0, "Wallet directory must be private");
}

async function assertShasta() {
  const response = await fetch(HOST + "/jsonrpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
    signal: AbortSignal.timeout(20_000),
  });
  assert(response.ok, "Chain-ID request failed");
  assert.equal(Number((await response.json()).result), CHAIN_ID, "Refuse non-Shasta network");
}

async function main() {
  assert(["--compile", "--prepare", "--status", "--run"].includes(mode),
    "Use --compile, --prepare, --status DIR, or --run DIR");
  if (mode === "--compile") {
    const compiled = compile();
    for (const name of ["ProofToken", "ProofEscrow"])
      console.log(`${name}: compiled ${compiled[name].evm.bytecode.object.length / 2} bytes`);
    console.log("TEST FIXTURES ONLY; compiler " + require("solc").version());
    return;
  }
  await assertShasta();
  if (mode === "--prepare") {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "skills2crypto-shasta-"));
    fs.chmodSync(temp, 0o700);
    const keys = {};
    for (const role of ["sponsor", "playerA", "playerB", "platform", "resourceTreasury"]) {
      const account = await TronWeb.createAccount();
      keys[role] = { address: account.address.base58, privateKey: account.privateKey };
    }
    fs.writeFileSync(path.join(temp, "wallets.private.json"), JSON.stringify(keys), { mode: 0o600, flag: "wx" });
    const manifest = {
      host: HOST, chainId: CHAIN_ID, created: new Date().toISOString(),
      addresses: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.address])),
      warning: "SHASTA ONLY. No value. Never send mainnet funds.",
    };
    fs.writeFileSync(path.join(temp, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ directory: temp, ...manifest }, null, 2));
    return;
  }
  validateDir();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.host, HOST);
  assert.equal(manifest.chainId, CHAIN_ID);
  const reader = client();
  const balances = {};
  for (const [role, address] of Object.entries(manifest.addresses)) {
    assert(TronWeb.isAddress(address), "Invalid manifest address");
    balances[role] = { address, balanceSun: await reader.trx.getBalance(address) };
    await sleep(400);
  }
  const block = await reader.trx.getCurrentBlock();
  const status = { host: HOST, block: block.block_header.raw_data.number, balances };
  save("status.json", status);
  console.log(JSON.stringify(status, null, 2));
  if (mode === "--status") return;
  assert(balances.sponsor.balanceSun >= 1_800_000_000,
    "FUNDING_REQUIRED: sponsor needs 1,800 test TRX (request 2,000); never fund the players.");
  assert.equal(balances.playerA.balanceSun, 0, "Player A must start at zero TRX");
  assert.equal(balances.playerB.balanceSun, 0, "Player B must start at zero TRX");
  const privateFile = path.join(dir, "wallets.private.json");
  const stat = fs.lstatSync(privateFile);
  assert(stat.isFile() && !stat.isSymbolicLink(), "Invalid private wallet file");
  assert.equal(stat.mode & 0o077, 0, "Wallet file must be private");
  const keys = JSON.parse(fs.readFileSync(privateFile, "utf8"));
  for (const [role, key] of Object.entries(keys))
    assert.equal(TronWeb.address.fromPrivateKey(key.privateKey), manifest.addresses[role]);
  const compiled = compile();
  // An interrupted run is NOT retried automatically. Reconcile every journalled txID.
  fs.writeFileSync(path.join(dir, "execution-started.json"),
    JSON.stringify({ started: new Date().toISOString(), host: HOST }),
    { mode: 0o600, flag: "wx" });
  await require("./run-flow.cjs").runFlow({ keys, manifest, compiled, dir });
}
main().catch((error) => {
  // Do not dump SDK error objects, signed transactions, or private test-wallet state.
  const message = error instanceof assert.AssertionError ? error.message :
    error?.code === "EEXIST" ? "Prior execution exists. Reconcile receipts; do not replay." :
    "Test setup/RPC failed. Inspect public status and receipts; private SDK errors are suppressed.";
  console.error(message);
  process.exitCode = 1;
});
