"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { TronWeb } = require("tronweb");
const { Wallet, keccak256, toUtf8Bytes, ZeroAddress, MaxUint256 } = require("ethers");
const {
  HOST, CHAIN_ID, SOURCE, DEPOSIT_TYPES, OUTCOME_TYPES,
  requiredEnergy, assertResources, assertReceipt, evm, expectedDeltas,
  assertSetupCheckpoint, stakeForResources,
} = require("./support.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parameter = (type, value) => ({ type, value });
const ROLES = ["playerA", "playerB", "platform", "resourceTreasury"];

async function runFlow({ keys, manifest, compiled, dir, resumeSetup = false }) {
  const tw = new TronWeb({ fullHost: HOST, privateKey: keys.sponsor.privateKey });
  const results = resumeSetup ? JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8")) : {
    host: HOST, chainId: CHAIN_ID, compiler: require("solc").version(), evmTarget: "paris",
    openzeppelin: require("../../contracts/tron/node_modules/@openzeppelin/contracts/package.json").version,
    fixtureSha256: crypto.createHash("sha256").update(fs.readFileSync(SOURCE)).digest("hex"),
    manifest,
    caveats: [
      "Mock token and test escrow, NOT mainnet USDT or final production escrow costs.",
      "Test sponsor delegates resources, NOT TronZap.",
      "CLI signing does not prove TronLink/mobile wallet compatibility.",
      "No provider recharge or self-sustaining funding loop is demonstrated.",
    ], transactions: [], measurements: [],
  };
  const save = () => fs.writeFileSync(path.join(dir, "results.json"),
    JSON.stringify(results, null, 2), { mode: 0o600 });
  if (resumeSetup) {
    assertSetupCheckpoint(results, manifest);
    assert.equal(results.fixtureSha256,
      crypto.createHash("sha256").update(fs.readFileSync(SOURCE)).digest("hex"),
      "Fixture source changed; manual review required");
    // No setup transactions are replayed. Reconcile every journalled transaction
    // against solidified state before making the first new transaction.
    for (const entry of results.transactions) {
      let info;
      for (let attempt = 0; attempt < 90; attempt++) {
        info = await tw.fullNode.request("walletsolidity/gettransactioninfobyid",
          { value: entry.txID }, "post");
        if (info?.id) break;
        await sleep(2000);
      }
      assertReceipt(info, false);
      entry.info = info; entry.solidifiedInfo = info; entry.state = "solidified";
      await sleep(200);
    }
    results.continuedAt = new Date().toISOString();
    results.continuationPolicy = "Setup deployments and minting may spend sponsor test TRX; measured approvals, deposits and settlements must not burn TRX.";
    console.log(`Reconciled all ${results.transactions.length} existing receipts; no transactions will be replayed.`);
  }
  save();

  async function confirm(entry, measured) {
    for (let i = 0; i < 60; i++) {
      const info = await tw.trx.getUnconfirmedTransactionInfo(entry.txID);
      if (info?.id) {
        entry.info = info; entry.state = "included"; save();
        assertReceipt(info, measured);
        // Inclusion alone is not final proof. Wait for the SolidityNode receipt.
        for (let j = 0; j < 90; j++) {
          const solid = await tw.fullNode.request("walletsolidity/gettransactioninfobyid",
            { value: entry.txID }, "post");
          if (solid?.id) {
            assertReceipt(solid, measured);
            entry.state = "solidified"; entry.solidifiedInfo = solid; save();
            console.log(`${entry.label}: ${entry.txID} solidified`);
            return solid;
          }
          await sleep(2000);
        }
        assert.fail(`${entry.label}: finality uncertain; reconcile ${entry.txID}, do not replay`);
      }
      await sleep(1500);
    }
    assert.fail(`${entry.label}: inclusion uncertain; reconcile ${entry.txID}, do not replay`);
  }

  async function broadcast(label, signed, measured = false) {
    const entry = {
      label, txID: signed.txID, state: "prepared",
      explorer: `https://shasta.tronscan.org/#/transaction/${signed.txID}`,
    };
    // Journal txID BEFORE the call: a network exception may occur after acceptance.
    results.transactions.push(entry); save();
    const response = await tw.trx.sendRawTransaction(signed);
    entry.state = response.result === true ? "broadcast" : "rejected"; save();
    assert(response.result === true, `${label}: broadcast rejected; reconcile journal before retry`);
    return confirm(entry, measured);
  }

  async function system(label, tx) {
    return broadcast(label, await tw.trx.sign(tx));
  }

  async function provisionPlayer(role, energy, bandwidth) {
    const caller = new TronWeb({ fullHost: HOST, privateKey: keys[role].privateKey });
    const resources = await caller.trx.getAccountResources(keys[role].address);
    const net = Math.max(
      Number(resources.NetLimit || 0) - Number(resources.NetUsed || 0),
      Number(resources.freeNetLimit || 0) - Number(resources.freeNetUsed || 0)
    );
    assert(net >= bandwidth, `${role}: insufficient Bandwidth; do not fund player with TRX`);
    const available = Number(resources.EnergyLimit || 0) - Number(resources.EnergyUsed || 0);
    if (available >= energy) return;
    const amount = stakeForResources(energy - available,
      Number(resources.TotalEnergyWeight), Number(resources.TotalEnergyLimit));
    const capacity = await tw.trx.getCanDelegatedMaxSize(keys.sponsor.address, "ENERGY");
    const additional = Math.max(0, amount - Number(capacity.max_size || 0));
    const liquid = await tw.trx.getBalance(keys.sponsor.address);
    results.resourceRequests ||= [];
    results.resourceRequests.push({ role, energy, bandwidth, resourcesBefore: resources,
      delegationSun: amount, additionalStakeSun: additional, sponsorLiquidSun: liquid });
    save();
    assert(liquid >= additional + 25_000_000,
      `${role}: need ${additional / 1e6} additional test TRX staked plus 25 test TRX reserve; liquid ${liquid / 1e6}`);
    if (additional)
      await system(`top up Energy ${role}`, await tw.transactionBuilder.freezeBalanceV2(additional, "ENERGY"));
    await system(`top up delegated Energy ${role}`, await tw.transactionBuilder.delegateResource(
      amount, keys[role].address, "ENERGY", keys.sponsor.address, false
    ));
    assertResources(await caller.trx.getAccountResources(keys[role].address), energy, bandwidth);
  }

  async function write(label, caller, address, selector, params, measured = false) {
    await sleep(500);
    const simulation = await caller.transactionBuilder.triggerConstantContract(
      address, selector, { feeLimit: 500_000_000 }, params, caller.defaultAddress.base58
    );
    assert(simulation.result?.result === true, `${label}: preflight simulation failed`);
    const energyBudget = requiredEnergy(simulation.energy_used);
    const before = await caller.trx.getBalance(caller.defaultAddress.base58);
    const build = await caller.transactionBuilder.triggerSmartContract(
      address, selector, { feeLimit: 500_000_000, callValue: 0 }, params, caller.defaultAddress.base58
    );
    assert(build.result?.result === true && build.transaction, `${label}: transaction build failed`);
    let signed = await caller.trx.sign(build.transaction);
    const bandwidthBudget = Buffer.from(signed.raw_data_hex, "hex").length +
      (signed.signature || []).reduce((n, s) => n + Buffer.from(s, "hex").length + 2, 0) + 128;
    if (measured && label.startsWith("approve "))
      await provisionPlayer(label.slice("approve ".length), energyBudget, bandwidthBudget);
    if (measured && label.startsWith("approve ")) {
      // Delegation finality may take longer than the first transaction's expiry.
      // Build/sign a fresh transaction only after resources are ready.
      const fresh = await caller.transactionBuilder.triggerSmartContract(
        address, selector, { feeLimit: 500_000_000, callValue: 0 }, params, caller.defaultAddress.base58
      );
      assert(fresh.result?.result === true && fresh.transaction, `${label}: fresh transaction build failed`);
      signed = await caller.trx.sign(fresh.transaction);
      const freshSize = Buffer.from(signed.raw_data_hex, "hex").length +
        (signed.signature || []).reduce((n, s) => n + Buffer.from(s, "hex").length + 2, 0) + 128;
      assert(freshSize <= bandwidthBudget, `${label}: refreshed transaction exceeded Bandwidth budget`);
    }
    const resources = await caller.trx.getAccountResources(caller.defaultAddress.base58);
    results.preflights ||= [];
    results.preflights.push({ label, energyEstimate: simulation.energy_used, energyBudget,
      bandwidthBudget, resources, measured, broadcast: false });
    save();
    // Setup minting may burn the sponsor's test TRX, just like deployment.
    // This exception never applies to the measured approve/deposit/settle flow.
    if (measured) assertResources(resources, energyBudget, bandwidthBudget);
    const info = await broadcast(label, signed, measured);
    const after = await caller.trx.getBalance(caller.defaultAddress.base58);
    if (measured) {
      results.measurements.push({
        label, txID: info.id, energyEstimate: simulation.energy_used,
        energyBudget, bandwidthBudget, resourcesBefore: resources,
        receipt: info.receipt, feeSun: info.fee || 0,
        trxBeforeSun: before, trxAfterSun: after,
      }); save();
      assert.equal(before, after, `${label}: TRX balance changed`);
    }
    return info;
  }

  async function deploy(name, parameters) {
    const artifact = compiled[name];
    const existing = results.transactions.find((entry) => entry.label === `deploy ${name}`);
    if (existing) {
      assert.equal(name, "ProofToken", "Only the reconciled token deployment can be reused");
      assert(existing.solidifiedInfo?.contract_address, "Reconciled deployment has no contract address");
      const address = TronWeb.address.fromHex(existing.solidifiedInfo.contract_address);
      const deployed = await tw.trx.getContract(address);
      assert.equal(Number(deployed.consume_user_resource_percent), 100);
      return address;
    }
    const tx = await tw.transactionBuilder.createSmartContract({
      abi: artifact.abi, bytecode: artifact.evm.bytecode.object,
      feeLimit: 500_000_000, callValue: 0, userFeePercentage: 100,
      originEnergyLimit: 1, parameters,
    });
    const info = await system(`deploy ${name}`, tx);
    assert(info.contract_address, `${name}: no contract address`);
    const address = TronWeb.address.fromHex(info.contract_address);
    const deployed = await tw.trx.getContract(address);
    assert.equal(Number(deployed.consume_user_resource_percent), 100,
      "Caller must pay 100% of Energy, no hidden deployer subsidy");
    return address;
  }

  async function assertZeroPlayers() {
    const snapshot = {};
    for (const role of ["playerA", "playerB"]) {
      snapshot[role] = await tw.trx.getBalance(keys[role].address);
      assert.equal(snapshot[role], 0, `${role}: must remain exactly zero TRX`);
    }
    return snapshot;
  }

  // This uses Shasta staking to prove protocol mechanics, not a live rental provider.
  results.initialPlayerBalancesSun = await assertZeroPlayers(); save();
  if (!resumeSetup) {
  for (const role of ROLES) {
    const account = await tw.trx.getAccount(keys[role].address);
    if (!account.address)
      await system(`activate ${role}`, await tw.transactionBuilder.createAccount(keys[role].address));
  }
  results.activatedPlayerBalancesSun = await assertZeroPlayers(); save();
  await system("stake Energy", await tw.transactionBuilder.freezeBalanceV2(1_000_000_000, "ENERGY"));
  await system("stake Bandwidth", await tw.transactionBuilder.freezeBalanceV2(100_000_000, "BANDWIDTH"));
  for (const role of ["playerA", "playerB"]) {
    await system(`delegate Energy ${role}`, await tw.transactionBuilder.delegateResource(
      200_000_000, keys[role].address, "ENERGY", keys.sponsor.address, false
    ));
    await system(`delegate Bandwidth ${role}`, await tw.transactionBuilder.delegateResource(
      20_000_000, keys[role].address, "BANDWIDTH", keys.sponsor.address, false
    ));
  }
  }
  const token = await deploy("ProofToken", []);
  const escrow = await deploy("ProofEscrow", [
    token, keys.sponsor.address, keys.platform.address, keys.resourceTreasury.address,
  ]);
  results.contracts = { token, escrow }; save();
  const tokenContract = await tw.contract(compiled.ProofToken.abi, token);
  const escrowContract = await tw.contract(compiled.ProofEscrow.abi, escrow);
  const chainId = Number((await escrowContract.chainId().call()).toString());
  assert.equal(chainId, CHAIN_ID, "Refuse unexpected on-contract chain ID");
  const domain = { name: "Skills2CryptoEscrow", version: "2", chainId, verifyingContract: evm(escrow) };
  for (const role of ["playerA", "playerB"]) {
    await write(`mint ${role}`, tw, token, "mint(address,uint256)", [
      parameter("address", keys[role].address), parameter("uint256", "50000000"),
    ]);
    const caller = new TronWeb({ fullHost: HOST, privateKey: keys[role].privateKey });
    await assertZeroPlayers();
    await write(`approve ${role}`, caller, token, "approve(address,uint256)", [
      parameter("address", escrow), parameter("uint256", MaxUint256.toString()),
    ], true);
    await assertZeroPlayers();
    assert.equal((await tokenContract.allowance(keys[role].address, escrow).call()).toString(),
      MaxUint256.toString(), "Approval allowance not recorded");
    // Recycle this test-only sponsor delegation after the approval. Consumption
    // debt returns to the sponsor; reclaiming stake does NOT regenerate Energy.
    const topUp = results.resourceRequests?.filter((r) => r.role === role)
      .reduce((sum, r) => sum + r.delegationSun, 0) || 0;
    if (topUp) {
      await system(`reclaim Energy ${role}`, await tw.transactionBuilder.undelegateResource(
        200_000_000 + topUp, keys[role].address, "ENERGY", keys.sponsor.address
      ));
      await assertZeroPlayers();
    }
  }
  const balance = async (a) => BigInt((await tokenContract.balanceOf(a).call()).toString());
  for (const [reason, label] of ["normal", "draw", "disconnect"].entries()) {
    const id = keccak256(toUtf8Bytes(`shasta-proof-${path.basename(dir)}-${label}`));
    const before = await Promise.all(ROLES.map((r) => balance(keys[r].address)));
    const sigs = [];
    for (const role of ["playerA", "playerB"]) {
      const nonce = (await escrowContract.depositNonces(keys[role].address).call()).toString();
      sigs.push(await new Wallet(keys[role].privateKey).signTypedData(
        domain, DEPOSIT_TYPES, { matchId: id, stake: 5_000_000, nonce }
      ));
    }
    await write(`deposit ${label}`, tw, escrow,
      "depositUSDTGasless(bytes32,address,address,uint256,bytes,bytes)", [
        parameter("bytes32", id), parameter("address", keys.playerA.address),
        parameter("address", keys.playerB.address), parameter("uint256", "5000000"),
        parameter("bytes", sigs[0]), parameter("bytes", sigs[1]),
      ], true);
    assert.equal(await balance(escrow), 10_000_000n);
    assert.equal(Number((await escrowContract.matches(id).call()).status), 1);
    const winner = reason === 0 ? evm(keys.playerA.address) : ZeroAddress;
    const signature = await new Wallet(keys.sponsor.privateKey).signTypedData(
      domain, OUTCOME_TYPES, { matchId: id, winner, reason }
    );
    await write(`settle ${label}`, tw, escrow, "settleMatch(bytes32,address,uint8,bytes)", [
      parameter("bytes32", id),
      parameter("address", reason === 0 ? keys.playerA.address : TronWeb.address.fromHex("41" + "0".repeat(40))),
      parameter("uint8", reason), parameter("bytes", signature),
    ], true);
    const after = await Promise.all(ROLES.map((r) => balance(keys[r].address)));
    const deltas = after.map((v, i) => v - before[i]);
    assert.deepEqual(deltas, expectedDeltas(reason), `${label}: token accounting mismatch`);
    assert.equal(await balance(escrow), 0n);
    assert.equal(Number((await escrowContract.matches(id).call()).status), 2);
    results[label] = { matchId: id, deltasUnits: deltas.map(String),
      playerBalancesSun: await assertZeroPlayers() }; save();
  }
  for (const role of ["playerA", "playerB"])
    assert.equal((await escrowContract.depositNonces(keys[role].address).call()).toString(), "3");
  results.completed = true; results.finishedAt = new Date().toISOString(); save();
  console.log("Shasta fixture flow passed. Receipts and limitations are in results.json.");
}

module.exports = { runFlow };
