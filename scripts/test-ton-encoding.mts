/**
 * Offline regression test for the TON on-chain message encoding produced by
 * `server/oracle/tonOracle.ts`.
 *
 * Why this exists: V2 task #16 deployed an escrow that bounced every real
 * Deposit / Settle because the message bodies the server handed to TonConnect
 * did not match the contract's TLB layout (wrong opcodes, signature stored
 * inline instead of as a ref cell). Nothing in CI exercised those bytes, so
 * the bug only surfaced when a player sent real TON. This script round-trips
 * every message body through the auto-generated Tact wrappers and asserts:
 *
 *   - the leading 32-bit opcode equals the value documented in
 *     contracts/ton/build/Skills2CryptoEscrowTON_Skills2CryptoEscrowTON.md,
 *   - every encoded field decodes back to the exact input,
 *   - Settle.signature is loadable as a referenced cell holding 64 bytes,
 *   - the Ed25519 signature verifies against the cell hash the contract
 *     itself recomputes in `receive(msg: Settle)` (matchId | winner | reason).
 *
 * No RPC, no funded wallet — pure encoding checks. Fails the build on any
 * mismatch.
 */
import { Address, Cell, beginCell } from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { randomBytes, createHash } from "node:crypto";
import nacl from "tweetnacl";

import {
  loadDeposit,
  loadSettle,
  loadRefundNoShow,
} from "../contracts/ton/build/Skills2CryptoEscrowTON_Skills2CryptoEscrowTON.js";

const DEPOSIT_OPCODE = 0xcd32a0f9;
const SETTLE_OPCODE = 0xddc91d5f;
const REFUND_NO_SHOW_OPCODE = 0x58ddc04b;

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function randomAddress(): Address {
  return new Address(0, randomBytes(32));
}

function matchIdToBigInt(matchId: string): bigint {
  // Mirrors tonOracle.matchIdToBigInt — we can't import it directly because
  // the module is wrapped in a closure, but the formula is fixed by the
  // contract's uint256 slot.
  const h = createHash("sha256").update(matchId).digest();
  let n = 0n;
  for (const b of h) n = (n << 8n) | BigInt(b);
  return n;
}

async function main() {
  // The oracle's build() function reads env at first call. Populate it with a
  // throwaway mnemonic and dummy addresses so we can drive the encoders
  // without touching the network.
  const mnemonic = await mnemonicNew(24);
  process.env.TON_ORACLE_MNEMONIC = mnemonic.join(" ");
  process.env.TON_ESCROW_CONTRACT = randomAddress().toString();
  process.env.TON_PLATFORM_WALLET = randomAddress().toString();
  // Point at an unreachable host so the startup self-check (which we don't
  // care about here) fails fast and silently.
  process.env.TON_RPC_URL = "http://127.0.0.1:1/__test__";

  const { createTonOracle } = await import("../server/oracle/tonOracle.js");
  const oracle = createTonOracle();

  const matchId = "test-match-" + randomBytes(8).toString("hex");
  const matchIdBig = matchIdToBigInt(matchId);
  const player1 = randomAddress();
  const player2 = randomAddress();
  const winner = player1;
  const stakeTon = 1.25;
  const stakeNano = 1_250_000_000n;

  // --- Deposit ----------------------------------------------------------
  console.log("Deposit:");
  const depositBoc = oracle.encodeDepositPayload({
    matchId,
    player1Friendly: player1.toString(),
    player2Friendly: player2.toString(),
    stakeTon,
  });
  const depositSlice = Cell.fromBase64(depositBoc).beginParse();
  check(
    "leading opcode = 0xCD32A0F9",
    depositSlice.preloadUint(32) === DEPOSIT_OPCODE,
    `got 0x${depositSlice.preloadUint(32).toString(16)}`,
  );
  const depositDecoded = loadDeposit(depositSlice);
  check("matchId round-trips", depositDecoded.matchId === matchIdBig);
  check(
    "player1 round-trips",
    depositDecoded.player1.equals(player1),
    depositDecoded.player1.toString(),
  );
  check(
    "player2 round-trips",
    depositDecoded.player2.equals(player2),
    depositDecoded.player2.toString(),
  );
  check(
    "stake round-trips",
    depositDecoded.stake === stakeNano,
    `got ${depositDecoded.stake}`,
  );

  // --- RefundNoShow -----------------------------------------------------
  console.log("RefundNoShow:");
  const refundBoc = oracle.encodeRefundNoShowPayload(matchId);
  const refundSlice = Cell.fromBase64(refundBoc).beginParse();
  check(
    "leading opcode = 0x58DDC04B",
    refundSlice.preloadUint(32) === REFUND_NO_SHOW_OPCODE,
    `got 0x${refundSlice.preloadUint(32).toString(16)}`,
  );
  const refundDecoded = loadRefundNoShow(refundSlice);
  check("matchId round-trips", refundDecoded.matchId === matchIdBig);

  // --- Settle (REASON_NORMAL = 0) ---------------------------------------
  console.log("Settle:");
  const reason = 0;
  const signed = await oracle.signMatchOutcome({
    matchId,
    winnerFriendly: winner.toString(),
    reason,
  });
  const settleSlice = Cell.fromBase64(signed.payloadBoc).beginParse();
  check(
    "leading opcode = 0xDDC91D5F",
    settleSlice.preloadUint(32) === SETTLE_OPCODE,
    `got 0x${settleSlice.preloadUint(32).toString(16)}`,
  );
  // loadSettle reads the opcode, the body, then loadRef().asSlice() for the
  // signature. If the encoder put the 64 sig bytes inline (the V2 #16 bug),
  // loadRef() would throw before we ever get a populated `signature`.
  const settleDecoded = loadSettle(settleSlice);
  check("matchId round-trips", settleDecoded.matchId === matchIdBig);
  check(
    "winner round-trips",
    settleDecoded.winner.equals(winner),
    settleDecoded.winner.toString(),
  );
  check(
    "reason round-trips",
    settleDecoded.reason === BigInt(reason),
    `got ${settleDecoded.reason}`,
  );
  const sigBits = settleDecoded.signature.remainingBits;
  const sigRefs = settleDecoded.signature.remainingRefs;
  check(
    "signature lives in a ref cell with exactly 64 bytes (512 bits)",
    sigBits === 512 && sigRefs === 0,
    `bits=${sigBits} refs=${sigRefs}`,
  );

  // --- Verify signature against the cell hash the contract recomputes ---
  // The Tact contract's `receive(msg: Settle)` builds:
  //   beginCell().storeUint(matchId,256).storeAddress(winner).storeUint(reason,8).endCell()
  // and calls checkSignature(payload.hash(), msg.signature, oraclePubkey).
  // Locally we verify the same way using nacl (Ed25519).
  const payloadCellHash = beginCell()
    .storeUint(matchIdBig, 256)
    .storeAddress(winner)
    .storeUint(reason, 8)
    .endCell()
    .hash();
  check(
    "messageHashHex matches recomputed payload cell hash",
    Buffer.from(payloadCellHash).toString("hex") === signed.messageHashHex,
  );
  const sigBytes = settleDecoded.signature.loadBuffer(64);
  const oraclePubkeyHex = await oracle.getOraclePubkeyHex();
  const pubkey = Buffer.from(oraclePubkeyHex, "hex");
  check(
    "Ed25519 signature verifies against contract-computed cell hash",
    nacl.sign.detached.verify(payloadCellHash, sigBytes, pubkey),
  );

  // --- Sanity: a synthetic outcome signed with a throwaway key also works.
  // This locks in the (matchId | winner | reason) layout independent of the
  // oracle's own keypair plumbing.
  console.log("Synthetic Ed25519 outcome:");
  const throwaway = await mnemonicToPrivateKey(await mnemonicNew(24));
  const synthMatchId = matchIdToBigInt("synthetic");
  const synthWinner = randomAddress();
  const synthReason = 1;
  const synthHash = beginCell()
    .storeUint(synthMatchId, 256)
    .storeAddress(synthWinner)
    .storeUint(synthReason, 8)
    .endCell()
    .hash();
  const synthSig = nacl.sign.detached(synthHash, throwaway.secretKey);
  check(
    "throwaway-key signature verifies via the same construction",
    nacl.sign.detached.verify(synthHash, synthSig, throwaway.publicKey),
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll TON encoding checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
