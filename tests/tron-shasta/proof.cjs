#!/usr/bin/env node
"use strict";

// Opt-in test runner: only a dedicated Shasta test secret, never project/mainnet keys.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { TronWeb } = require("tronweb");
const { deriveRoles, publicAddresses } = require("./wallets.cjs");
const {
  HOST, CHAIN_ID, compile,
} = require("./support.cjs");
const mode = process.argv[2];
const dir = process.argv[3] && path.resolve(process.argv[3]);
const SESSIONS = path.join(__dirname, "sessions");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const client = (key) => new TronWeb({ fullHost: HOST, ...(key ? { privateKey: key } : {}) });
const save = (name, data) => fs.writeFileSync(path.join(dir, name),
  JSON.stringify(data, null, 2), { mode: 0o600 });

function validateDir() {
  assert(dir && path.dirname(dir) === SESSIONS &&
    /^[a-zA-Z0-9-]{1,80}$/.test(path.basename(dir)), "Use the public session directory from --prepare");
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Refuse non-directory/symlink");
  assert.equal(fs.realpathSync(dir), path.join(fs.realpathSync(SESSIONS), path.basename(dir)),
    "Refuse escaped session directory");
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
    const runId = crypto.randomUUID();
    // Fail before creating a session if the persistent test secret is unavailable.
    const keys = deriveRoles(process.env.SHASTA_TEST_SPONSOR_PRIVATE_KEY, runId);
    const manifest = {
      storageVersion: 2, runId, host: HOST, chainId: CHAIN_ID, created: new Date().toISOString(),
      addresses: publicAddresses(keys),
      warning: "SHASTA ONLY. No value. Never send mainnet funds.",
    };
    fs.mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
    assert(!fs.lstatSync(SESSIONS).isSymbolicLink(), "Refuse symlink session root");
    const session = path.join(SESSIONS, runId);
    fs.mkdirSync(session, { mode: 0o700 });
    fs.writeFileSync(path.join(session, "manifest.json"), JSON.stringify(manifest, null, 2),
      { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ directory: session, ...manifest }, null, 2));
    return;
  }
  validateDir();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.storageVersion, 2, "Legacy temporary-key sessions cannot be resumed");
  assert.equal(manifest.runId, path.basename(dir), "Session/run ID mismatch");
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
  const keys = deriveRoles(process.env.SHASTA_TEST_SPONSOR_PRIVATE_KEY, manifest.runId);
  assert.deepEqual(publicAddresses(keys), manifest.addresses, "Test secret does not match this session");
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
