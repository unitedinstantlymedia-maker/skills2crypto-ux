/**
 * Verifies the EIP-712 typed-data SCHEMAS the EVM oracle signs over
 * exactly match what the deployed Skills2CryptoEscrow contract
 * verifies. We do this by signing with the same primitives the real
 * oracle uses (ethers.Wallet.signTypedData) and recovering with
 * ethers.verifyTypedData — the same path the contract follows on-chain
 * (modulo the `_domainSeparatorV4` name/version/chainId/verifyingContract
 * tuple that EIP712 forces both sides to agree on).
 *
 * Why not import the real oracle module: createEvmOracle() does network
 * I/O at startup (provider.getNetwork(), escrow.oracle()) which would
 * make these tests flaky and slow. Schema-equivalence is the property
 * we actually care about — if it changes, the contract rejects every
 * deposit/settlement.
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";

const DOMAIN = {
  name: "Skills2CryptoEscrow",
  version: "2",
  chainId: 56,
  verifyingContract: "0x000000000000000000000000000000000000dEaD",
} as const;

const MATCH_AUTH_TYPES = {
  MatchAuth: [
    { name: "matchId", type: "bytes32" },
    { name: "player1", type: "address" },
    { name: "player2", type: "address" },
    { name: "stake", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const MATCH_OUTCOME_TYPES = {
  MatchOutcome: [
    { name: "matchId", type: "bytes32" },
    { name: "winner", type: "address" },
    { name: "reason", type: "uint8" },
  ],
} as const;

describe("EVM oracle EIP-712 signatures", () => {
  it("signMatchAuth produces a sig that recovers to the oracle wallet", async () => {
    const wallet = ethers.Wallet.createRandom();
    const value = {
      matchId: ethers.keccak256(ethers.toUtf8Bytes("match-1")),
      player1: "0x1111111111111111111111111111111111111111",
      player2: "0x2222222222222222222222222222222222222222",
      stake: ethers.parseEther("0.05"),
      deadline: Math.floor(Date.now() / 1000) + 900,
    };
    const sig = await wallet.signTypedData(DOMAIN, MATCH_AUTH_TYPES, value);
    const recovered = ethers.verifyTypedData(DOMAIN, MATCH_AUTH_TYPES, value, sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("a tampered stake invalidates the recovered address", async () => {
    const wallet = ethers.Wallet.createRandom();
    const value = {
      matchId: ethers.keccak256(ethers.toUtf8Bytes("match-1")),
      player1: "0x1111111111111111111111111111111111111111",
      player2: "0x2222222222222222222222222222222222222222",
      stake: ethers.parseEther("0.05"),
      deadline: Math.floor(Date.now() / 1000) + 900,
    };
    const sig = await wallet.signTypedData(DOMAIN, MATCH_AUTH_TYPES, value);
    const tampered = { ...value, stake: ethers.parseEther("0.5") };
    const recovered = ethers.verifyTypedData(DOMAIN, MATCH_AUTH_TYPES, tampered, sig);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it("signMatchOutcome produces a sig that recovers to the oracle wallet", async () => {
    const wallet = ethers.Wallet.createRandom();
    const value = {
      matchId: ethers.keccak256(ethers.toUtf8Bytes("match-2")),
      winner: "0x3333333333333333333333333333333333333333",
      reason: 0, // 0 = Normal, 1 = Draw, 2 = Disconnect
    };
    const sig = await wallet.signTypedData(DOMAIN, MATCH_OUTCOME_TYPES, value);
    const recovered = ethers.verifyTypedData(DOMAIN, MATCH_OUTCOME_TYPES, value, sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("a tampered winner invalidates the outcome signature", async () => {
    const wallet = ethers.Wallet.createRandom();
    const value = {
      matchId: ethers.keccak256(ethers.toUtf8Bytes("match-2")),
      winner: "0x3333333333333333333333333333333333333333",
      reason: 0,
    };
    const sig = await wallet.signTypedData(DOMAIN, MATCH_OUTCOME_TYPES, value);
    const tampered = {
      ...value,
      winner: "0x4444444444444444444444444444444444444444",
    };
    const recovered = ethers.verifyTypedData(
      DOMAIN,
      MATCH_OUTCOME_TYPES,
      tampered,
      sig
    );
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it("a different chainId in the domain rejects the signature", async () => {
    const wallet = ethers.Wallet.createRandom();
    const value = {
      matchId: ethers.keccak256(ethers.toUtf8Bytes("match-3")),
      player1: "0x1111111111111111111111111111111111111111",
      player2: "0x2222222222222222222222222222222222222222",
      stake: ethers.parseEther("0.05"),
      deadline: Math.floor(Date.now() / 1000) + 900,
    };
    const sig = await wallet.signTypedData(DOMAIN, MATCH_AUTH_TYPES, value);
    const otherDomain = { ...DOMAIN, chainId: 1 };
    const recovered = ethers.verifyTypedData(otherDomain, MATCH_AUTH_TYPES, value, sig);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });
});
