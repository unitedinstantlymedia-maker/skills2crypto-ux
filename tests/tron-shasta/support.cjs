"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");
const { TronWeb } = require("tronweb");

const HOST = "https://api.shasta.trongrid.io";
const CHAIN_ID = 2494104990;
const SOURCE = path.join(__dirname, "Fixtures.sol");
const DEPOSIT_TYPES = { Deposit: [
  { name: "matchId", type: "bytes32" }, { name: "stake", type: "uint256" },
  { name: "nonce", type: "uint256" },
] };
const OUTCOME_TYPES = { MatchOutcome: [
  { name: "matchId", type: "bytes32" }, { name: "winner", type: "address" },
  { name: "reason", type: "uint8" },
] };

function compile() {
  const input = {
    language: "Solidity",
    sources: { "Fixtures.sol": { content: fs.readFileSync(SOURCE, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (name) => {
      if (!name.startsWith("@openzeppelin/contracts/") || name.includes(".."))
        return { error: "Import not allowed" };
      // Use the TRON project's existing OZ 5.0.2, not root OZ 5.6's Cancun-only MCOPY.
      const scoped = path.resolve(__dirname, "../../contracts/tron/node_modules", name);
      assert(fs.existsSync(scoped), "Missing TRON-scoped dependency; do not silently change compiler inputs");
      return { contents: fs.readFileSync(scoped, "utf8") };
    },
  }));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  assert.equal(errors.length, 0, errors.map((e) => e.formattedMessage).join("\n"));
  return output.contracts["Fixtures.sol"];
}

function requiredEnergy(estimate) {
  const value = Number(estimate);
  assert(Number.isSafeInteger(value) && value > 0, "Invalid Energy estimate");
  return Math.ceil(value * 1.25);
}

function assertResources(resources, energy, bandwidth) {
  const available = Number(resources.EnergyLimit || 0) - Number(resources.EnergyUsed || 0);
  assert(available >= energy, `Insufficient Energy: ${available} < ${energy}`);
  const net = Number(resources.NetLimit || 0) - Number(resources.NetUsed || 0);
  const free = Number(resources.freeNetLimit || 0) - Number(resources.freeNetUsed || 0);
  // For an ordinary transaction, a single Bandwidth source must cover its full size.
  assert(Math.max(net, free) >= bandwidth, "Insufficient Bandwidth");
}

function assertReceipt(info, measured) {
  assert(info && info.id, "Missing receipt");
  assert.equal(info.receipt?.result || "SUCCESS", "SUCCESS", "Transaction reverted");
  assert(!info.resMessage, "Transaction returned a failure message");
  if (measured) {
    assert(info.receipt && Number(info.receipt.energy_usage_total) > 0, "Missing Energy measurement");
    assert.equal(Number(info.receipt.energy_fee || 0), 0, "Energy burned TRX");
    assert.equal(Number(info.receipt.net_fee || 0), 0, "Bandwidth burned TRX");
    assert.equal(Number(info.fee || 0), 0, "Unexpected transaction fee");
  }
}

const evm = (address) => "0x" + TronWeb.address.toHex(address).slice(2);
const expectedDeltas = (reason) => [
  [4_600_000n, -5_000_000n, 300_000n, 100_000n],
  [-200_000n, -200_000n, 300_000n, 100_000n],
  [-50_000n, -50_000n, 0n, 100_000n],
][reason];

module.exports = {
  HOST, CHAIN_ID, SOURCE, DEPOSIT_TYPES, OUTCOME_TYPES, compile,
  requiredEnergy, assertResources, assertReceipt, evm, expectedDeltas,
};
