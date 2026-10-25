"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { TronWeb } = require("tronweb");

const ROLES = ["sponsor", "playerA", "playerB", "platform", "resourceTreasury"];

// The root key comes only from a dedicated test-only secret at runtime.
// A public run ID lets us reconstruct every role after filesystem replacement.
// Never persist or log the return value; only publish publicAddresses().
function deriveRoles(secret, runId) {
  assert(typeof secret === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(secret),
    "Set SHASTA_TEST_SPONSOR_PRIVATE_KEY securely to a dedicated test-only wallet key");
  assert(typeof runId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(runId), "Invalid public run ID");
  const root = secret.replace(/^0x/, "");
  const sponsor = TronWeb.address.fromPrivateKey(root);
  assert(typeof sponsor === "string" && TronWeb.isAddress(sponsor), "Invalid test-only sponsor key");
  const keys = { sponsor: { address: sponsor, privateKey: root } };
  for (const role of ROLES.slice(1)) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const privateKey = crypto.createHmac("sha256", Buffer.from(root, "hex"))
        .update(`skills2crypto/shasta-only/v1/${runId}/${role}/${attempt}`).digest("hex");
      const address = TronWeb.address.fromPrivateKey(privateKey);
      if (typeof address === "string" && TronWeb.isAddress(address)) {
        keys[role] = { address, privateKey };
        break;
      }
    }
    assert(keys[role], "Could not derive disposable role");
  }
  assert.equal(new Set(Object.values(keys).map((v) => v.address)).size, ROLES.length,
    "Test roles must have distinct addresses");
  return keys;
}

const publicAddresses = (keys) =>
  Object.fromEntries(ROLES.map((role) => [role, keys[role].address]));

module.exports = { deriveRoles, publicAddresses, ROLES };
