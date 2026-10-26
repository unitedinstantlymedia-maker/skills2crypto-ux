"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, verifyTypedData, keccak256, toUtf8Bytes } = require("ethers");
const crypto = require("node:crypto");
const { deriveRoles, publicAddresses, ROLES } = require("./wallets.cjs");
const {
  CHAIN_ID, DEPOSIT_TYPES, compile, requiredEnergy,
  assertResources, assertReceipt, expectedDeltas,
  assertSetupCheckpoint, stakeForResources,
} = require("./support.cjs");

test("both test fixtures compile with the existing TRON-scoped dependencies", () => {
  const contracts = compile();
  for (const name of ["ProofToken", "ProofEscrow"]) {
    assert(contracts[name].evm.bytecode.object.length > 0);
    assert(contracts[name].abi.length > 0);
  }
  const methods = contracts.ProofEscrow.abi.filter((v) => v.type === "function").map((v) => v.name);
  assert(methods.includes("depositUSDTGasless"));
  assert(!methods.some((v) => /swap|accumulated/i.test(v)));
});

test("Energy budgeting adds a margin and rejects missing or invalid estimates", () => {
  assert.equal(requiredEnergy(100), 125);
  assert.equal(requiredEnergy(101), 127);
  for (const v of [undefined, NaN, -1, 0, "invalid", Infinity, 1.5])
    assert.throws(() => requiredEnergy(v));
});

test("Bandwidth must be wholly covered by one resource source, not summed", () => {
  assertResources({ EnergyLimit: 125, freeNetLimit: 600 }, 125, 500);
  assertResources({ EnergyLimit: 125, NetLimit: 1000, freeNetLimit: 0 }, 125, 900);
  assert.throws(() => assertResources({ EnergyLimit: 124, NetLimit: 1000 }, 125, 500));
  assert.throws(() => assertResources({ EnergyLimit: 125, NetLimit: 300, freeNetLimit: 300 }, 125, 500));
});

test("measured receipts reject reverts, missing measurements and any resource burn", () => {
  const good = { id: "public-tx-id", receipt: { result: "SUCCESS", energy_usage_total: 100 } };
  assertReceipt(good, true);
  assert.throws(() => assertReceipt({}, true));
  assert.throws(() => assertReceipt({ ...good, receipt: { result: "REVERT" } }, true));
  assert.throws(() => assertReceipt({ ...good, receipt: {} }, true));
  for (const k of ["energy_fee", "net_fee"])
    assert.throws(() => assertReceipt({ ...good, receipt: { ...good.receipt, [k]: 1 } }, true));
  assert.throws(() => assertReceipt({ ...good, fee: 1 }, true));
});

test("normal, draw and disconnect conserve tokens with the fixture's 1% resource fee", () => {
  for (const reason of [0, 1, 2]) {
    const deltas = expectedDeltas(reason);
    assert.equal(deltas.reduce((a, b) => a + b, 0n), 0n);
    assert.equal(deltas[3], 100_000n);
  }
});

test("deposit signatures bind the player to chain, escrow, match, stake and nonce", async () => {
  const wallet = Wallet.createRandom(); // Disposable, never logged or persisted.
  const domain = {
    name: "Skills2CryptoEscrow", version: "2", chainId: CHAIN_ID,
    verifyingContract: "0x1111111111111111111111111111111111111111",
  };
  const value = { matchId: keccak256(toUtf8Bytes("fixture")), stake: 5_000_000, nonce: 0 };
  const signature = await wallet.signTypedData(domain, DEPOSIT_TYPES, value);
  assert.equal(verifyTypedData(domain, DEPOSIT_TYPES, value, signature), wallet.address);
  for (const change of [{ stake: 6_000_000 }, { nonce: 1 }, { matchId: keccak256(toUtf8Bytes("other")) }])
    assert.notEqual(verifyTypedData(domain, DEPOSIT_TYPES, { ...value, ...change }, signature), wallet.address);
  assert.notEqual(verifyTypedData({ ...domain, chainId: 728126428 }, DEPOSIT_TYPES, value, signature), wallet.address);
  assert.notEqual(verifyTypedData({ ...domain, verifyingContract: "0x2222222222222222222222222222222222222222" },
    DEPOSIT_TYPES, value, signature), wallet.address);
});

test("test wallets reconstruct from the secure root and public run ID without a private file", () => {
  const secret = crypto.randomBytes(32).toString("hex"); // Unfunded unit-test key; never logged.
  const a = deriveRoles(secret, "run-a");
  const restored = deriveRoles(secret, "run-a");
  const other = deriveRoles(secret, "run-b");
  assert.deepEqual(publicAddresses(a), publicAddresses(restored));
  assert.equal(publicAddresses(a).sponsor, publicAddresses(other).sponsor);
  for (const role of ROLES.filter((v) => v !== "sponsor"))
    assert.notEqual(a[role].address, other[role].address);
  assert.equal(new Set(Object.values(publicAddresses(a))).size, ROLES.length);
  for (const value of Object.values(publicAddresses(a)))
    assert(!value.includes(secret));
  assert.throws(() => deriveRoles(undefined, "run-a"));
  assert.throws(() => deriveRoles("bad-key", "run-a"));
  assert.throws(() => deriveRoles(secret, "../escape"));
});

test("resource stake estimates use live weights, round up and reject invalid inputs", () => {
  assert.equal(stakeForResources(28_000, 12_810_815_163, 180_000_000_000),
    2_033_000_000);
  assert.throws(() => stakeForResources(0, 10, 100));
  assert.throws(() => stakeForResources(10, 0, 100));
  assert.throws(() => stakeForResources(10, 100, NaN));
});

test("setup continuation refuses partial contract work, changed wallets and unexpected transactions", () => {
  const manifest = { runId: "unit-test" };
  const labels = [
    "activate playerA", "activate playerB", "activate platform", "activate resourceTreasury",
    "stake Energy", "stake Bandwidth", "delegate Energy playerA", "delegate Bandwidth playerA",
    "delegate Energy playerB", "delegate Bandwidth playerB",
  ];
  const setup = { manifest, measurements: [],
    transactions: labels.map((label) => ({ label, txID: "a".repeat(64) })) };
  assertSetupCheckpoint(setup, manifest);
  assert.throws(() => assertSetupCheckpoint({ ...setup, contracts: { token: "unexpected" } }, manifest));
  assert.throws(() => assertSetupCheckpoint({ ...setup, completed: true }, manifest));
  assert.throws(() => assertSetupCheckpoint({ ...setup, measurements: [{}] }, manifest));
  assert.throws(() => assertSetupCheckpoint({ ...setup, transactions: setup.transactions.slice(1) }, manifest));
  assert.throws(() => assertSetupCheckpoint(setup, { runId: "different" }));
});
