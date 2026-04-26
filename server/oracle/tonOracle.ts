/**
 * TonOracle V2 — TON player-pays-gas escrow signer.
 *
 * The oracle no longer broadcasts on-chain transactions. It only:
 *   - Signs MatchOutcome (Ed25519) off-chain so players can call Settle.
 *   - Provides Deposit message body encoders so the client can send the
 *     PlayerDeposit TX via TonConnect.
 *   - Reads on-chain match state via get-methods.
 *
 * Ed25519 keypair is derived from TON_ORACLE_MNEMONIC (24 words).
 *
 * Message bodies (Deposit / Settle / RefundNoShow) are built using the
 * Tact-generated `store…` helpers in
 * `contracts/ton/build/Skills2CryptoEscrowTON_Skills2CryptoEscrowTON.ts`.
 * Those helpers carry the correct 32-bit opcodes (SHA-256 of the TLB type
 * signature, NOT crc32 of the message name) and the correct field layout
 * for each message — in particular `Settle.signature` is `^slice` (a ref
 * cell), not an inline slice. Hand-rolling those bytes is what caused the
 * deployed contract to bounce every Deposit / Settle in V2 task #16.
 */
import { createHash } from "node:crypto";
import { TonClient } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Address, beginCell, toNano, fromNano, Cell } from "@ton/core";
import type { KeyPair } from "@ton/crypto";
import nacl from "tweetnacl";
import {
  storeDeposit,
  storeSettle,
  storeRefundNoShow,
} from "../../contracts/ton/build/Skills2CryptoEscrowTON_Skills2CryptoEscrowTON";

export class TonOracleError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "TonOracleError";
    this.code = code;
  }
}

function loadEnvOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new TonOracleError(`Missing required env var: ${key}`, "ENV_MISSING");
  return v;
}

interface TonConfig {
  endpoint: string;
  apiKey: string | undefined;
  escrowAddress: string;
  platformWalletAddress: string;
}

function resolveConfig(): TonConfig {
  return {
    endpoint: process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC",
    apiKey: process.env.TON_API_KEY,
    escrowAddress: loadEnvOrThrow("TON_ESCROW_CONTRACT"),
    platformWalletAddress: loadEnvOrThrow("TON_PLATFORM_WALLET"),
  };
}

let _cached: ReturnType<typeof build> | null = null;
let _startupRan = false;

export function createTonOracle() {
  if (!_cached) _cached = build();
  return _cached;
}

function matchIdToBigInt(matchId: string): bigint {
  // Hash the nanoid match ID to a uint256 so it fits the contract's Int slot.
  const h = createHash("sha256").update(matchId).digest();
  let n = 0n;
  for (const b of h) n = (n << 8n) | BigInt(b);
  return n;
}

function build() {
  const cfg = resolveConfig();
  const escrowAddress = Address.parse(cfg.escrowAddress);
  const client = new TonClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey });

  // Lazy keypair init — derived from mnemonic (Ed25519 over Curve25519).
  let _key: KeyPair | null = null;
  async function ensureKey(): Promise<KeyPair> {
    if (_key) return _key;
    const phrase = loadEnvOrThrow("TON_ORACLE_MNEMONIC").trim().split(/\s+/);
    if (phrase.length !== 24) {
      throw new TonOracleError(
        `TON_ORACLE_MNEMONIC must be 24 words (got ${phrase.length})`,
        "INVALID_MNEMONIC"
      );
    }
    _key = await mnemonicToPrivateKey(phrase);
    return _key;
  }

  if (!_startupRan) {
    _startupRan = true;
    (async () => {
      try {
        const key = await ensureKey();
        const pubkeyHex = Buffer.from(key.publicKey).toString("hex");
        console.log(`[TonOracle] Oracle pubkey (Ed25519, hex): ${pubkeyHex}`);
        console.log(`[TonOracle] Escrow contract: ${cfg.escrowAddress}`);
        console.log(`[TonOracle] Platform wallet: ${cfg.platformWalletAddress}`);
        try {
          const r = await client.runMethod(escrowAddress, "getOraclePubkey", []);
          const onChain = r.stack.readBigNumber();
          const onChainHex = onChain.toString(16).padStart(64, "0");
          if (onChainHex === pubkeyHex) {
            console.log(`[TonOracle] [startup] Contract.oraclePubkey matches — ready`);
          } else {
            console.error(`[TonOracle] [startup] MISMATCH: contract pubkey ${onChainHex} != signer ${pubkeyHex}`);
          }
        } catch (e: any) {
          console.warn(`[TonOracle] [startup] could not call getOraclePubkey: ${e?.message || e}`);
        }
      } catch (e: any) {
        console.error(`[TonOracle] [startup] init failed: ${e?.message || e}`);
      }
    })();
  }

  /**
   * Build the Deposit message body cell that the player attaches to their
   * TonConnect transaction. The contract handles match creation on first
   * deposit and transitions to ACTIVE on the second.
   */
  function encodeDepositPayload(params: {
    matchId: string;
    player1Friendly: string;
    player2Friendly: string;
    stakeTon: number;
  }): string {
    const matchIdHash = matchIdToBigInt(params.matchId);
    const p1 = Address.parse(params.player1Friendly);
    const p2 = Address.parse(params.player2Friendly);
    const stakeNano = toNano(params.stakeTon.toString());
    const cell = beginCell()
      .store(
        storeDeposit({
          $$type: "Deposit",
          matchId: matchIdHash,
          player1: p1,
          player2: p2,
          stake: stakeNano,
        })
      )
      .endCell();
    return cell.toBoc().toString("base64");
  }

  /**
   * Sign the (matchId, winner, reason) outcome with the oracle's Ed25519
   * key. Returns the BOC payload (Settle message body, signature embedded
   * as a ref cell) and the signature alone — clients send the BOC via
   * TonConnect.
   */
  async function signMatchOutcome(params: {
    matchId: string;
    winnerFriendly: string; // "" for Draw/Disconnect — placeholder used
    reason: number;
  }): Promise<{ payloadBoc: string; signatureHex: string; messageHashHex: string }> {
    if (params.reason < 0 || params.reason > 2) {
      throw new TonOracleError(`Invalid reason ${params.reason}`, "INVALID_REASON");
    }
    const matchIdHash = matchIdToBigInt(params.matchId);
    const winnerAddr =
      params.reason === 0 && params.winnerFriendly
        ? Address.parse(params.winnerFriendly)
        : // Placeholder — contract ignores winner unless reason == 0.
          Address.parseRaw("0:0000000000000000000000000000000000000000000000000000000000000000");

    // Build the cell hash that the contract will hash itself in checkSignature.
    // This MUST match the contract's payload construction in
    // `receive(msg: Settle)` exactly: matchId(uint256) | winner(address) |
    // reason(uint8). The .hash() of this cell is what is signed off-chain
    // and what the contract's checkSignature() will recompute.
    const payloadCell: Cell = beginCell()
      .storeUint(matchIdHash, 256)
      .storeAddress(winnerAddr)
      .storeUint(params.reason, 8)
      .endCell();
    const messageHash = payloadCell.hash();

    const key = await ensureKey();
    const signature = nacl.sign.detached(messageHash, key.secretKey);

    // The Tact contract declares `signature: Slice` on the Settle message,
    // which the Tact compiler serialises as `^slice` (a referenced cell).
    // Wrap the 64 raw signature bytes in a fresh cell, expose it as a
    // Slice, and let storeSettle() emit the correct ref-cell layout.
    const signatureSlice = beginCell()
      .storeBuffer(Buffer.from(signature))
      .endCell()
      .asSlice();

    const settleBody = beginCell()
      .store(
        storeSettle({
          $$type: "Settle",
          matchId: matchIdHash,
          winner: winnerAddr,
          reason: BigInt(params.reason),
          signature: signatureSlice,
        })
      )
      .endCell();

    return {
      payloadBoc: settleBody.toBoc().toString("base64"),
      signatureHex: Buffer.from(signature).toString("hex"),
      messageHashHex: Buffer.from(messageHash).toString("hex"),
    };
  }

  function encodeRefundNoShowPayload(matchId: string): string {
    const matchIdHash = matchIdToBigInt(matchId);
    return beginCell()
      .store(
        storeRefundNoShow({
          $$type: "RefundNoShow",
          matchId: matchIdHash,
        })
      )
      .endCell()
      .toBoc()
      .toString("base64");
  }

  /**
   * Read the on-chain Match struct via getMatch get-method.
   *
   * NOTE: We can't use the auto-generated `Skills2CryptoEscrowTON.getGetMatch`
   * wrapper here, and we can't use `TupleReader.readTupleOpt()` followed by
   * `readBigNumber()`/`readAddress()` either. There is an asymmetry in
   * `@ton/ton`'s `parseStack`:
   *
   *   - Top-level stack items are `TupleItem` objects with a `.type`
   *     discriminator (`{type: "int", value: bigint}`, `{type: "tuple", items: [...]}`)
   *   - But items INSIDE a `tuple` (parsed via `parseStackEntry`) come back
   *     as **raw values**: `bigint` for numbers, `Cell` for cells/slices,
   *     `Array` for nested tuples — no `.type` field at all.
   *
   * `TupleReader.readBigNumber()` checks `popped.type !== "int"` and throws
   * `"Not a number"` against those raw values. The Tact-generated
   * `loadTupleMatch` does exactly that, so calling `getGetMatch` from the
   * wrapper hits the same trap. Fix: pop the outer tuple item ourselves and
   * decode the raw inner array directly.
   *
   * Match field order from `loadTupleMatch`:
   *   0: matchId (bigint, 256-bit)
   *   1: player1 (Cell — slice cell containing an Address)
   *   2: player2 (Cell — slice cell containing an Address)
   *   3: stake   (bigint, nanoton)
   *   4: p1Funded (bigint — TVM bool: -1n = true, 0n = false)
   *   5: p2Funded (bigint — TVM bool)
   *   6: firstDepositAt (bigint, uint32)
   *   7: status (bigint, uint8: 0 none / 1 pending / 2 active / 3 settled / 4 cancelled)
   */
  async function getMatchOnChain(matchId: string): Promise<{
    status: number;
    p1Funded: boolean;
    p2Funded: boolean;
    stakeNano: string;
  } | null> {
    try {
      const matchIdHash = matchIdToBigInt(matchId);
      const result = await client.runMethod(escrowAddress, "getMatch", [
        { type: "int", value: matchIdHash },
      ]);

      const outer = result.stack.pop();
      if (!outer || outer.type === "null") return null;
      if (outer.type !== "tuple") {
        throw new TonOracleError(
          `getMatch returned unexpected stack type "${outer.type}"`,
          "BAD_STACK_SHAPE"
        );
      }

      const items = outer.items as unknown as any[];
      if (items.length < 8) {
        throw new TonOracleError(
          `getMatch tuple has ${items.length} items, expected 8`,
          "BAD_STACK_SHAPE"
        );
      }

      const stake = items[3] as bigint;
      const p1Funded = (items[4] as bigint) !== 0n;
      const p2Funded = (items[5] as bigint) !== 0n;
      const status = Number(items[7] as bigint);

      return { status, p1Funded, p2Funded, stakeNano: stake.toString() };
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("exit_code") || msg.includes("not found") || msg.includes("revert")) {
        return null;
      }
      throw e;
    }
  }

  async function getOraclePubkeyHex(): Promise<string> {
    const key = await ensureKey();
    return Buffer.from(key.publicKey).toString("hex");
  }

  /**
   * Read the on-chain TON balance of the escrow contract. The TON oracle
   * is signer-only (it never broadcasts), so there's no oracle wallet
   * balance to monitor. The contract's own TON balance is what funds
   * settlement payouts (each match's deposits accumulate there), so it
   * is the meaningful number to surface in health checks.
   */
  async function getEscrowBalanceTon(): Promise<number> {
    try {
      const balanceNano = await client.getBalance(escrowAddress);
      return Number(fromNano(balanceNano));
    } catch (e: any) {
      throw new TonOracleError(
        `getBalance failed for ${cfg.escrowAddress}: ${e?.message || e}`,
        "RPC_FAILED"
      );
    }
  }

  return {
    chain: "TON" as const,
    get escrowAddressFriendly() {
      return cfg.escrowAddress;
    },
    get platformWalletFriendly() {
      return cfg.platformWalletAddress;
    },
    encodeDepositPayload,
    encodeRefundNoShowPayload,
    signMatchOutcome,
    getMatchOnChain,
    getOraclePubkeyHex,
    getEscrowBalanceTon,
  };
}

export type TonOracle = ReturnType<typeof createTonOracle>;
