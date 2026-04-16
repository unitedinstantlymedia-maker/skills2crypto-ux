/**
 * TonOracle — TON-side counterpart of evmOracle / tronOracle.
 *
 * The on-chain contract is `Skills2CryptoEscrowTON` (Tact, see
 * contracts/ton/skills2crypto_escrow_simple.tact). Players send `PlayerDeposit`
 * messages directly via TonConnect; the oracle:
 *   - PrepareMatch(matchId, p1, p2, stake) — must be called before deposits
 *   - Settle(matchId, winner, reason) — distributes the pot after gameplay
 *   - CancelMatch(matchId) — refunds a partial deposit if a player times out
 *
 * Uses Ed25519 (TON's native curve) — NOT secp256k1 — so the oracle has its
 * own key derived from a 24-word mnemonic (TON_ORACLE_MNEMONIC), separate
 * from the EVM/Tron oracle key.
 */
import { TonClient, WalletContractV4, internal } from "@ton/ton";
import { mnemonicToWalletKey } from "@ton/crypto";
import { Address, beginCell, toNano, fromNano, Cell } from "@ton/core";
import type { KeyPair } from "@ton/crypto";

const TX_CONFIRM_POLL_INTERVAL_MS = 3000;
const TX_CONFIRM_MAX_ATTEMPTS = 40;

// Tact-generated message opcodes. Computed as the leading 32 bits of
// sha256("PrepareMatch ... ") — but Tact assigns sequential opcodes per
// message, starting at 1 for the first user-defined message in the file.
// We use crc32-style stable opcodes to match what the compiler emits when
// `message(0xNNNNNNNN)` is not specified. To keep the server independent
// from regenerating wrappers after every contract tweak, we hash ourselves.
import { crc32 } from "./tonCrc32";

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
  escrowAddress: string; // bounceable EQ… form
  platformWalletAddress: string;
  minTonBalance: number; // TON
  workchain: number;
}

function resolveConfig(): TonConfig {
  // No fallback for the platform wallet — payouts go straight to whatever is
  // configured here, so an accidental empty value would leak the 3% fee to
  // an attacker-controlled (or burned) address. Force operators to set it.
  return {
    endpoint: process.env.TON_RPC_URL || "https://toncenter.com/api/v2/jsonRPC",
    apiKey: process.env.TON_API_KEY,
    escrowAddress: loadEnvOrThrow("TON_ESCROW_CONTRACT"),
    platformWalletAddress: loadEnvOrThrow("TON_PLATFORM_WALLET"),
    minTonBalance: Number(process.env.TON_MIN_GAS ?? 1.0),
    workchain: Number(process.env.TON_WORKCHAIN ?? 0),
  };
}

let _cached: ReturnType<typeof build> | null = null;
let _startupRan = false;

export function createTonOracle() {
  if (!_cached) _cached = build();
  return _cached;
}

function matchIdToBigInt(matchId: string): bigint {
  // Match IDs are nanoid strings (16 chars). Hash to a uint256 the same way
  // EVM/Tron do (keccak256), to keep the per-match identifier consistent
  // across chains. We can't re-use ethers.keccak256 in a Tact map<Int> directly
  // — Tact's Int as uint256 just stores the big-endian integer, so we hash
  // and take the result as a bigint.
  // Use sha256 since @ton/crypto exposes it; the contract just stores
  // whatever uint256 we pass.
  const { createHash } = require("crypto");
  const h = createHash("sha256").update(matchId).digest();
  let n = 0n;
  for (const b of h) n = (n << 8n) | BigInt(b);
  return n;
}

function build() {
  const cfg = resolveConfig();
  const escrowAddress = Address.parse(cfg.escrowAddress);
  const platformWalletAddress = Address.parse(cfg.platformWalletAddress);

  const client = new TonClient({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
  });

  // Lazy-init oracle wallet (mnemonic → Ed25519 keypair → V4 wallet).
  let _wallet: WalletContractV4 | null = null;
  let _key: KeyPair | null = null;
  let _walletAddress: Address | null = null;

  async function ensureWallet(): Promise<{
    wallet: WalletContractV4;
    key: KeyPair;
    address: Address;
  }> {
    if (_wallet && _key && _walletAddress) {
      return { wallet: _wallet, key: _key, address: _walletAddress };
    }
    const phrase = loadEnvOrThrow("TON_ORACLE_MNEMONIC").trim().split(/\s+/);
    if (phrase.length !== 24) {
      throw new TonOracleError(
        `TON_ORACLE_MNEMONIC must be 24 words (got ${phrase.length})`,
        "INVALID_MNEMONIC"
      );
    }
    _key = await mnemonicToWalletKey(phrase);
    _wallet = WalletContractV4.create({ workchain: cfg.workchain, publicKey: _key.publicKey });
    _walletAddress = _wallet.address;
    return { wallet: _wallet, key: _key, address: _walletAddress };
  }

  if (!_startupRan) {
    _startupRan = true;
    (async () => {
      try {
        const { address } = await ensureWallet();
        const oracleStr = address.toString({ bounceable: false });
        console.log(`[TonOracle] Oracle wallet: ${oracleStr}`);
        console.log(`[TonOracle] Escrow contract: ${cfg.escrowAddress}`);
        console.log(`[TonOracle] Platform wallet: ${cfg.platformWalletAddress}`);
        const balanceNano = await client.getBalance(address);
        const balanceTon = Number(fromNano(balanceNano));
        console.log(`[TonOracle] [startup] Oracle TON balance: ${balanceTon}`);
        if (balanceTon < cfg.minTonBalance) {
          console.warn(
            `[TonOracle] [startup] WARNING: balance < ${cfg.minTonBalance} TON — top up ${oracleStr}`
          );
        }
        try {
          const onChainOracle = await client.runMethod(escrowAddress, "getOracle", []);
          const oracleOnChain = onChainOracle.stack.readAddress();
          if (oracleOnChain.equals(address)) {
            console.log(`[TonOracle] [startup] Contract.oracle matches — ready`);
          } else {
            console.error(
              `[TonOracle] [startup] MISMATCH: contract oracle is ${oracleOnChain.toString()}, our wallet is ${oracleStr}`
            );
          }
        } catch (e: any) {
          console.warn(`[TonOracle] [startup] could not call getOracle: ${e?.message || e}`);
        }
      } catch (e: any) {
        console.error(`[TonOracle] [startup] init failed: ${e?.message || e}`);
      }
    })();
  }

  /**
   * Build the body cell for a Tact message. Tact opcodes are computed by the
   * compiler (a deterministic 32-bit hash of the message name + field types).
   * We pre-compute them via crc32 so the server doesn't need the generated
   * TypeScript wrapper. Each opcode listed here MUST match what the compiler
   * actually emits — verify by inspecting the generated wrapper after
   * recompiling the .tact file.
   */
  const OP = {
    PrepareMatch: crc32("PrepareMatch"),
    PlayerDeposit: crc32("PlayerDeposit"),
    Settle: crc32("Settle"),
    CancelMatch: crc32("CancelMatch"),
    UpdateGasReserve: crc32("UpdateGasReserve"),
    SetOracle: crc32("SetOracle"),
    SetPlatformWallet: crc32("SetPlatformWallet"),
  } as const;

  function encodePrepareMatch(
    matchIdHash: bigint,
    p1: Address,
    p2: Address,
    stakeNano: bigint
  ): Cell {
    return beginCell()
      .storeUint(OP.PrepareMatch, 32)
      .storeUint(matchIdHash, 256)
      .storeAddress(p1)
      .storeAddress(p2)
      .storeCoins(stakeNano)
      .endCell();
  }

  function encodeSettle(matchIdHash: bigint, winner: Address, reason: number): Cell {
    return beginCell()
      .storeUint(OP.Settle, 32)
      .storeUint(matchIdHash, 256)
      .storeAddress(winner)
      .storeUint(reason, 8)
      .endCell();
  }

  function encodeCancel(matchIdHash: bigint): Cell {
    return beginCell()
      .storeUint(OP.CancelMatch, 32)
      .storeUint(matchIdHash, 256)
      .endCell();
  }

  /**
   * Public encoder used by /api/ton/deposit-info — the client puts this
   * cell in the TonConnect transaction payload so the contract recognizes
   * the message as PlayerDeposit (otherwise it would be a bare transfer
   * and the contract receive(msg: PlayerDeposit) wouldn't fire).
   */
  function encodePlayerDepositPayload(matchId: string): string {
    const matchIdHash = matchIdToBigInt(matchId);
    const cell = beginCell()
      .storeUint(OP.PlayerDeposit, 32)
      .storeUint(matchIdHash, 256)
      .endCell();
    return cell.toBoc().toString("base64");
  }

  async function ensureOracleHasGas(): Promise<void> {
    const { address } = await ensureWallet();
    const balanceNano = await client.getBalance(address);
    const balanceTon = Number(fromNano(balanceNano));
    if (balanceTon < cfg.minTonBalance) {
      throw new TonOracleError(
        `Oracle TON balance ${balanceTon} below minimum ${cfg.minTonBalance}. Top up ${address.toString({ bounceable: false })}.`,
        "ORACLE_NO_GAS"
      );
    }
  }

  /**
   * Send a message from the oracle wallet to the escrow and wait for BOTH:
   *   1. The wallet seqno to advance (= our external message was accepted).
   *   2. `verify()` to return true (= the on-chain contract STATE actually
   *      reflects our intent — e.g. match created, status SETTLED, etc.).
   *
   * TON's V4 wallet seqno advances regardless of whether the resulting
   * internal message bounces or hits a `require` failure inside the
   * destination contract, so seqno alone is NOT a success signal. We must
   * inspect contract state to know whether the message had its intended
   * effect.
   */
  async function sendOracleMessageAndVerify(
    body: Cell,
    valueTon: string,
    verify: () => Promise<boolean>,
    label: string
  ): Promise<string> {
    await ensureOracleHasGas();
    const { wallet, key } = await ensureWallet();
    const opened = client.open(wallet);
    const seqno = await opened.getSeqno();
    await opened.sendTransfer({
      seqno,
      secretKey: key.secretKey,
      messages: [
        internal({
          to: escrowAddress,
          value: toNano(valueTon),
          bounce: true,
          body,
        }),
      ],
    });

    let seqnoAdvanced = false;
    for (let i = 0; i < TX_CONFIRM_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, TX_CONFIRM_POLL_INTERVAL_MS));
      try {
        if (!seqnoAdvanced) {
          const newSeq = await opened.getSeqno();
          if (newSeq > seqno) {
            seqnoAdvanced = true;
          }
        }
        if (seqnoAdvanced) {
          // External message went through — now confirm the contract
          // actually applied the intended state change. If our internal
          // message bounced (wrong opcode, failed require, etc.) verify()
          // will keep returning false until we time out.
          const ok = await verify().catch(() => false);
          if (ok) return `seqno:${seqno + 1}:${label}`;
        }
      } catch {
        /* transient toncenter errors are fine to ignore */
      }
    }
    throw new TonOracleError(
      seqnoAdvanced
        ? `Oracle tx (${label}) was sent but contract state did not update — likely contract reverted/bounced`
        : `Oracle wallet seqno did not advance after ${TX_CONFIRM_MAX_ATTEMPTS} polls (${label})`,
      seqnoAdvanced ? "TX_BOUNCED" : "TX_TIMEOUT"
    );
  }

  async function prepareMatch(params: {
    matchId: string;
    player1: string;
    player2: string;
    stakeTon: number;
  }): Promise<{ txid: string }> {
    const p1 = Address.parse(params.player1);
    const p2 = Address.parse(params.player2);
    if (p1.equals(p2)) {
      throw new TonOracleError("Players cannot share an address", "INVALID_INPUT");
    }
    if (!Number.isFinite(params.stakeTon) || params.stakeTon <= 0) {
      throw new TonOracleError("stake must be > 0", "INVALID_INPUT");
    }
    const matchIdHash = matchIdToBigInt(params.matchId);
    const stakeNano = toNano(params.stakeTon.toString());
    const body = encodePrepareMatch(matchIdHash, p1, p2, stakeNano);
    console.log(`[TonOracle] PrepareMatch — match=${params.matchId} stake=${params.stakeTon} TON`);
    // Short-circuit if the match already exists on-chain (idempotency from a
    // previous successful PrepareMatch in this or another process).
    const existing = await getMatchOnChain(params.matchId).catch(() => null);
    if (existing && existing.status >= 1) {
      console.log(`[TonOracle] PrepareMatch — match ${params.matchId} already on-chain (status=${existing.status})`);
      return { txid: `noop:already-prepared:${existing.status}` };
    }
    // 0.1 TON covers gas + storage for the PrepareMatch call. We then verify
    // the contract really created the match (seqno advance is not enough —
    // see comment in sendOracleMessageAndVerify).
    const txid = await sendOracleMessageAndVerify(
      body,
      "0.1",
      async () => {
        const m = await getMatchOnChain(params.matchId);
        return !!m && m.status >= 1; // any non-NONE status means the match exists
      },
      `PrepareMatch:${params.matchId}`
    );
    console.log(`[TonOracle] PrepareMatch confirmed on-chain: ${txid}`);
    return { txid };
  }

  async function submitSettlement(
    matchId: string,
    winnerFriendly: string,
    reason: number
  ): Promise<{ txHash: string; matchId: string }> {
    if (reason < 0 || reason > 2) {
      throw new TonOracleError(`Invalid settle reason: ${reason}`, "INVALID_REASON");
    }
    // For draw / disconnect we still need a non-null Address slot; the
    // contract ignores winner unless reason == 0. Use the oracle's own
    // wallet address as a safe placeholder (never read on those paths).
    const { address: oracleAddr } = await ensureWallet();
    const winner = reason === 0 ? Address.parse(winnerFriendly) : oracleAddr;
    const matchIdHash = matchIdToBigInt(matchId);
    const body = encodeSettle(matchIdHash, winner, reason);
    console.log(
      `[TonOracle] Settle — match=${matchId} winner=${winnerFriendly} reason=${reason}`
    );
    // Idempotency: if the match has already reached a terminal state on-chain
    // (SETTLED == 3, CANCELLED == 4) treat as success — sending Settle to a
    // cancelled match would bounce, and re-settling a settled one is a no-op.
    const existing = await getMatchOnChain(matchId).catch(() => null);
    if (existing && existing.status >= 3) {
      console.log(
        `[TonOracle] Settle — match ${matchId} already terminal on-chain (status=${existing.status})`
      );
      return {
        txHash: existing.status === 3 ? `noop:already-settled` : `noop:already-cancelled`,
        matchId,
      };
    }
    const txid = await sendOracleMessageAndVerify(
      body,
      "0.15",
      async () => {
        const m = await getMatchOnChain(matchId);
        return !!m && m.status === 3; // STATUS_SETTLED
      },
      `Settle:${matchId}`
    );
    console.log(`[TonOracle] Settle confirmed on-chain: ${txid}`);
    return { txHash: txid, matchId };
  }

  async function cancelMatch(matchId: string): Promise<{ txid: string }> {
    const matchIdHash = matchIdToBigInt(matchId);
    const body = encodeCancel(matchIdHash);
    console.log(`[TonOracle] CancelMatch — match=${matchId}`);
    const existing = await getMatchOnChain(matchId).catch(() => null);
    if (existing && existing.status === 4) {
      return { txid: `noop:already-cancelled` };
    }
    const txid = await sendOracleMessageAndVerify(
      body,
      "0.1",
      async () => {
        const m = await getMatchOnChain(matchId);
        return !!m && m.status === 4; // STATUS_CANCELLED
      },
      `CancelMatch:${matchId}`
    );
    return { txid };
  }

  /**
   * Read the on-chain Match struct via the get-method `getMatch`. Returns
   * the parsed status + funded flags so the server can detect when both
   * deposits have arrived without needing to poll deposit txes individually.
   */
  async function getMatchOnChain(matchId: string): Promise<{
    status: number;
    p1Funded: boolean;
    p2Funded: boolean;
    stakeNano: string;
    gasReservePerPlayerNano: string;
  } | null> {
    try {
      const matchIdHash = matchIdToBigInt(matchId);
      const result = await client.runMethod(escrowAddress, "getMatch", [
        { type: "int", value: matchIdHash },
      ]);
      // Returns Maybe Match — first item is null if absent.
      const tuple = result.stack.readTupleOpt();
      if (!tuple) return null;
      // Field order in struct Match: matchId(uint256), p1, p2, stake, gas, p1Funded, p2Funded, status
      tuple.readBigNumber(); // matchId
      tuple.readAddress();   // p1
      tuple.readAddress();   // p2
      const stake = tuple.readBigNumber();
      const gasReserve = tuple.readBigNumber();
      const p1Funded = tuple.readBoolean();
      const p2Funded = tuple.readBoolean();
      const status = Number(tuple.readBigNumber());
      return {
        status,
        p1Funded,
        p2Funded,
        stakeNano: stake.toString(),
        gasReservePerPlayerNano: gasReserve.toString(),
      };
    } catch (e: any) {
      // Tact get-methods on a missing key revert; treat as "not found".
      const msg = String(e?.message || e);
      if (msg.includes("exit_code") || msg.includes("not found") || msg.includes("revert")) {
        return null;
      }
      throw e;
    }
  }

  async function getGasReservePerPlayerTon(): Promise<number> {
    try {
      const r = await client.runMethod(escrowAddress, "getGasReservePerPlayer", []);
      const nano = r.stack.readBigNumber();
      return Number(fromNano(nano));
    } catch {
      // Fallback default if the contract isn't reachable yet.
      return 0.1;
    }
  }

  async function getOracleAddressFriendly(): Promise<string> {
    const { address } = await ensureWallet();
    return address.toString({ bounceable: false });
  }

  async function getOracleBalanceTon(): Promise<number> {
    const { address } = await ensureWallet();
    const nano = await client.getBalance(address);
    return Number(fromNano(nano));
  }

  return {
    chain: "TON" as const,
    get escrowAddressFriendly() {
      return cfg.escrowAddress;
    },
    get platformWalletFriendly() {
      return cfg.platformWalletAddress;
    },
    encodePlayerDepositPayload,
    prepareMatch,
    submitSettlement,
    cancelMatch,
    getMatchOnChain,
    getGasReservePerPlayerTon,
    getOracleAddressFriendly,
    getOracleBalanceTon,
  };
}

export type TonOracle = ReturnType<typeof createTonOracle>;
