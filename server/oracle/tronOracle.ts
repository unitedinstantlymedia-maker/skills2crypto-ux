/**
 * TronOracle V2 — gasless USDT TRC-20 escrow.
 *
 * Architecture (Task #16 rewrite):
 *   - Players make a one-time approve(escrow, MAX) themselves (TRX paid by
 *     the player; oracle does NOT sponsor TRX anymore).
 *   - For each match:
 *       1. Server builds Deposit EIP-712 typed-data; both players sign via
 *          TronLink.
 *       2. Server calls depositUSDTGasless(matchId, p1, p2, stake, sig1, sig2)
 *          — oracle pays TRX gas, contract pulls stake from each player.
 *   - For settlement: server signs MatchOutcome and calls settleMatch on-chain
 *     (oracle pays TRX gas; players never broadcast TX). The contract takes
 *     a 0.5% gas-fund fee in USDT and auto-swaps to TRX above threshold.
 */
import { TronWeb } from "tronweb";
import { ethers } from "ethers";

const USDT_TRC20_DECIMALS = 6;
const TX_POLL_INTERVAL_MS = 1500;
const TX_POLL_MAX_ATTEMPTS = 40;

export interface TronSettleResult {
  txHash: string;
  matchId: string;
  blockNumber?: number;
}

export interface TronDepositAuth {
  matchId: string;
  matchIdBytes32: string;
  player1: string;
  player2: string;
  player1EvmHex: string;
  player2EvmHex: string;
  stake: string;
  nonce1: string;
  nonce2: string;
  escrowAddressEvmHex: string;
  escrowAddressBase58: string;
  chainId: number;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
}

export class TronOracleError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "TronOracleError";
    this.code = code;
  }
}

function loadEnvOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new TronOracleError(`Missing required env var: ${key}`, "ENV_MISSING");
  return v;
}

function isTronAddress(addr: string): boolean {
  return typeof addr === "string" && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr);
}

function tronAddressToEvmHex(tronAddress: string, tw: any): string {
  const hex = tw.address.toHex(tronAddress);
  if (!/^41[0-9a-fA-F]{40}$/.test(hex)) {
    throw new TronOracleError(`Invalid Tron address (hex): ${hex}`, "INVALID_ADDRESS");
  }
  return "0x" + hex.slice(2);
}

function evmHexToTronAddress(evmHex: string, tw: any): string {
  const stripped = evmHex.toLowerCase().replace(/^0x/, "");
  return tw.address.fromHex("41" + stripped);
}

interface TronConfig {
  fullHost: string;
  escrowBase58: string;
  usdtBase58: string;
  platformWalletBase58: string;
  chainId: number;
  minTrxForGas: number;
}

function resolveConfig(): TronConfig {
  return {
    fullHost: process.env.TRON_RPC_URL || "https://api.trongrid.io",
    escrowBase58: loadEnvOrThrow("TRON_ESCROW_CONTRACT"),
    usdtBase58: process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    platformWalletBase58: process.env.TRON_PLATFORM_WALLET || "TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq",
    chainId: Number(process.env.TRON_CHAIN_ID ?? 728126428),
    minTrxForGas: Number(process.env.TRON_MIN_GAS_TRX ?? 50),
  };
}

let _cached: ReturnType<typeof build> | null = null;
let _startupRun = false;

export function createTronOracle() {
  if (!_cached) _cached = build();
  return _cached;
}

function build() {
  const cfg = resolveConfig();
  const privateKey = loadEnvOrThrow("ORACLE_PRIVATE_KEY").replace(/^0x/, "");
  const tw = new TronWeb({ fullHost: cfg.fullHost, privateKey });
  const derived = tw.address.fromPrivateKey(privateKey);
  if (!derived) throw new Error("Failed to derive Tron address from ORACLE_PRIVATE_KEY");
  const oracleBase58: string = derived;
  const escrowEvmHex = tronAddressToEvmHex(cfg.escrowBase58, tw);

  console.log(`[TronOracle] Oracle wallet: ${oracleBase58}`);
  console.log(`[TronOracle] Escrow contract: ${cfg.escrowBase58}`);
  console.log(`[TronOracle] USDT contract: ${cfg.usdtBase58}`);
  console.log(`[TronOracle] Chain ID: ${cfg.chainId}`);

  if (!_startupRun) {
    _startupRun = true;
    // Periodic balance logger: Tron is the only chain whose oracle still
    // broadcasts on-chain transactions (USDT deposits + settlements), so
    // it's the only one that can run out of "gas". Log every 5 minutes
    // so operators see balance drift before users hit ORACLE_NO_GAS.
    const PERIODIC_BALANCE_INTERVAL_MS = 5 * 60_000;
    const balanceTimer = setInterval(async () => {
      try {
        const sun = await tw.trx.getBalance(oracleBase58);
        const trx = sun / 1_000_000;
        const tag = trx < cfg.minTrxForGas ? "WARN" : "info";
        console.log(`[TronOracle] [periodic ${tag}] Oracle TRX balance: ${trx} (min: ${cfg.minTrxForGas})`);
      } catch (e: any) {
        console.warn(`[TronOracle] [periodic] balance check failed: ${e?.message || e}`);
      }
    }, PERIODIC_BALANCE_INTERVAL_MS);
    // Allow the process to exit cleanly in tests / shutdown.
    if (typeof balanceTimer.unref === "function") balanceTimer.unref();

    (async () => {
      try {
        const balanceSun = await tw.trx.getBalance(oracleBase58);
        const balanceTrx = balanceSun / 1_000_000;
        console.log(`[TronOracle] [startup] Oracle TRX balance: ${balanceTrx}`);
        if (balanceTrx < cfg.minTrxForGas) {
          console.warn(`[TronOracle] [startup] WARNING: TRX balance < ${cfg.minTrxForGas} — top up ${oracleBase58}`);
        }
        const onChainOracle = await callView("oracle", []);
        const onChainOracleBase58 = evmHexToTronAddress(onChainOracle, tw);
        console.log(`[TronOracle] [startup] Contract.oracle() = ${onChainOracleBase58}`);
        if (onChainOracleBase58 !== oracleBase58) {
          console.error(`[TronOracle] [startup] MISMATCH: contract oracle is ${onChainOracleBase58}, signer is ${oracleBase58}`);
        } else {
          console.log(`[TronOracle] [startup] Oracle matches — ready`);
        }
      } catch (e: any) {
        console.error(`[TronOracle] [startup] validation failed: ${e?.message || e}`);
      }
    })();
  }

  function toMatchIdBytes32(matchId: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(matchId));
  }

  async function ensureOracleHasGas(): Promise<void> {
    const sun = await tw.trx.getBalance(oracleBase58);
    const trx = sun / 1_000_000;
    if (trx < cfg.minTrxForGas) {
      throw new TronOracleError(
        `Oracle TRX balance insufficient (${trx} TRX). Top up ${oracleBase58}.`,
        "ORACLE_NO_GAS"
      );
    }
  }

  async function callView(method: string, params: any[]): Promise<any> {
    const fnSelector = method + "(" + params.map((p) => p.type).join(",") + ")";
    const args = params.map((p) => ({ type: p.type, value: p.value }));
    const tx = await tw.transactionBuilder.triggerConstantContract(
      cfg.escrowBase58,
      fnSelector,
      {},
      args,
      oracleBase58
    );
    const result = tx?.constant_result?.[0];
    if (!result) throw new TronOracleError(`View call failed: ${method}`, "VIEW_FAILED");
    if (method === "oracle" || method === "platformWallet" || method === "owner" || method === "oracleGasFund") {
      return "0x" + result.slice(-40);
    }
    return result;
  }

  async function triggerWrite(
    method: string,
    params: Array<{ type: string; value: any }>,
    feeLimitTrx = 200
  ): Promise<{ txid: string }> {
    await ensureOracleHasGas();
    const fnSelector = method + "(" + params.map((p) => p.type).join(",") + ")";
    const tx = await tw.transactionBuilder.triggerSmartContract(
      cfg.escrowBase58,
      fnSelector,
      { feeLimit: feeLimitTrx * 1_000_000, callValue: 0 },
      params.map((p) => ({ type: p.type, value: p.value })),
      oracleBase58
    );
    if (!tx?.result?.result) {
      throw new TronOracleError(
        `triggerSmartContract failed for ${method}: ${tx?.result?.message || "unknown"}`,
        "TRIGGER_FAILED"
      );
    }
    const signed = await tw.trx.sign(tx.transaction);
    const sent = await tw.trx.sendRawTransaction(signed);
    if (!sent?.result || !sent?.txid) {
      throw new TronOracleError(`Broadcast failed for ${method}: ${JSON.stringify(sent)}`, "BROADCAST_FAILED");
    }
    return { txid: sent.txid };
  }

  async function waitForTx(txid: string): Promise<any> {
    for (let i = 0; i < TX_POLL_MAX_ATTEMPTS; i++) {
      try {
        const info = await tw.trx.getTransactionInfo(txid);
        if (info && info.id) {
          if (info.receipt?.result && info.receipt.result !== "SUCCESS") {
            throw new TronOracleError(`Tx reverted: ${info.receipt.result}`, "TX_REVERTED");
          }
          return info;
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, TX_POLL_INTERVAL_MS));
    }
    throw new TronOracleError(`Tx not confirmed after ${TX_POLL_MAX_ATTEMPTS} polls: ${txid}`, "TX_TIMEOUT");
  }

  function buildDomain() {
    return {
      name: "Skills2CryptoEscrow",
      version: "2",
      chainId: cfg.chainId,
      verifyingContract: escrowEvmHex,
    };
  }

  const DEPOSIT_TYPES = {
    Deposit: [
      { name: "matchId", type: "bytes32" },
      { name: "stake", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const OUTCOME_TYPES = {
    MatchOutcome: [
      { name: "matchId", type: "bytes32" },
      { name: "winner", type: "address" },
      { name: "reason", type: "uint8" },
    ],
  };

  /**
   * Build the EIP-712 typed-data + per-player nonces for both players to
   * sign via TronLink. Each player's signature authorizes a single
   * `transferFrom(player, escrow, stake)`.
   */
  async function buildDepositAuth(params: {
    matchId: string;
    player1Base58: string;
    player2Base58: string;
    stakeUsdt: number;
  }): Promise<TronDepositAuth> {
    if (!isTronAddress(params.player1Base58) || !isTronAddress(params.player2Base58)) {
      throw new TronOracleError("Player addresses must be Tron base58", "INVALID_INPUT");
    }
    if (params.player1Base58 === params.player2Base58) {
      throw new TronOracleError("Players cannot share an address", "INVALID_INPUT");
    }
    // Defense-in-depth: refuse to issue deposit auth for the platform's own
    // infrastructure addresses (oracle / platform wallet). The matchmaking
    // layer (server/security/systemAddresses.ts via /api/find-match) is the
    // primary guard; this is a backstop. `null` means the registry has not
    // yet initialised — fail open so a cold-start race can't deadlock.
    const { isForbiddenTronAddressSync } = await import("../security/systemAddresses");
    if (
      isForbiddenTronAddressSync(params.player1Base58) === true ||
      isForbiddenTronAddressSync(params.player2Base58) === true
    ) {
      throw new TronOracleError(
        "Refusing to issue deposit auth: one of the players is a platform infrastructure wallet",
        "FORBIDDEN_PLAYER"
      );
    }
    if (!Number.isFinite(params.stakeUsdt) || params.stakeUsdt <= 0) {
      throw new TronOracleError("stake must be > 0", "INVALID_INPUT");
    }

    const stakeUnits = BigInt(Math.round(params.stakeUsdt * 10 ** USDT_TRC20_DECIMALS));
    const matchIdBytes32 = toMatchIdBytes32(params.matchId);
    const player1Hex = tronAddressToEvmHex(params.player1Base58, tw);
    const player2Hex = tronAddressToEvmHex(params.player2Base58, tw);

    const nonce1Hex = await callView("getDepositNonce", [{ type: "address", value: player1Hex }]);
    const nonce2Hex = await callView("getDepositNonce", [{ type: "address", value: player2Hex }]);
    const nonce1 = BigInt("0x" + (nonce1Hex as string).slice(-64));
    const nonce2 = BigInt("0x" + (nonce2Hex as string).slice(-64));

    return {
      matchId: params.matchId,
      matchIdBytes32,
      player1: params.player1Base58,
      player2: params.player2Base58,
      player1EvmHex: player1Hex,
      player2EvmHex: player2Hex,
      stake: stakeUnits.toString(),
      nonce1: nonce1.toString(),
      nonce2: nonce2.toString(),
      escrowAddressEvmHex: escrowEvmHex,
      escrowAddressBase58: cfg.escrowBase58,
      chainId: cfg.chainId,
      domain: buildDomain(),
      types: DEPOSIT_TYPES,
    };
  }

  function verifyDepositSig(params: {
    matchIdBytes32: string;
    stakeUnits: string;
    nonce: string;
    expectedPlayerEvmHex: string;
    signature: string;
  }): boolean {
    const value = {
      matchId: params.matchIdBytes32,
      stake: BigInt(params.stakeUnits),
      nonce: BigInt(params.nonce),
    };
    try {
      const recovered = ethers.verifyTypedData(buildDomain(), DEPOSIT_TYPES, value, params.signature);
      return recovered.toLowerCase() === params.expectedPlayerEvmHex.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Submit gasless deposit. Pulls `stake` USDT from each player using their
   * pre-existing approval. Both players' EIP-712 sigs are verified by the
   * contract. Oracle pays TRX gas.
   */
  async function submitDepositUSDTGasless(params: {
    matchId: string;
    player1EvmHex: string;
    player2EvmHex: string;
    stakeUnits: string;
    sig1: string;
    sig2: string;
  }): Promise<{ txid: string }> {
    const matchIdBytes32 = toMatchIdBytes32(params.matchId);
    console.log(`[TronOracle] depositUSDTGasless — match=${params.matchId}`);
    const { txid } = await triggerWrite(
      "depositUSDTGasless",
      [
        { type: "bytes32", value: matchIdBytes32 },
        { type: "address", value: params.player1EvmHex },
        { type: "address", value: params.player2EvmHex },
        { type: "uint256", value: params.stakeUnits },
        { type: "bytes", value: params.sig1.replace(/^0x/, "") },
        { type: "bytes", value: params.sig2.replace(/^0x/, "") },
      ],
      300
    );
    console.log(`[TronOracle] deposit broadcast: ${txid}`);
    await waitForTx(txid);
    console.log(`[TronOracle] deposit confirmed: ${txid}`);
    return { txid };
  }

  /**
   * Sign a MatchOutcome off-chain (used internally by submitSettlement) and
   * also exposed for admin tooling.
   */
  async function signMatchOutcome(params: {
    matchId: string;
    winnerEvmHex: string;
    reason: number;
  }): Promise<string> {
    if (params.reason < 0 || params.reason > 2) {
      throw new TronOracleError(`Invalid reason ${params.reason}`, "INVALID_REASON");
    }
    const matchIdBytes32 = toMatchIdBytes32(params.matchId);
    const value = {
      matchId: matchIdBytes32,
      winner: params.winnerEvmHex,
      reason: params.reason,
    };
    const signer = new ethers.Wallet(privateKey);
    return signer.signTypedData(buildDomain(), OUTCOME_TYPES, value);
  }

  async function submitSettlement(
    matchId: string,
    winnerEvmHex: string,
    reason: number
  ): Promise<TronSettleResult> {
    const matchIdBytes32 = toMatchIdBytes32(matchId);
    const oracleSig = await signMatchOutcome({ matchId, winnerEvmHex, reason });
    console.log(`[TronOracle] settleMatch — match=${matchId} winner=${winnerEvmHex} reason=${reason}`);
    const { txid } = await triggerWrite(
      "settleMatch",
      [
        { type: "bytes32", value: matchIdBytes32 },
        { type: "address", value: winnerEvmHex },
        { type: "uint8", value: reason },
        { type: "bytes", value: oracleSig.replace(/^0x/, "") },
      ],
      300
    );
    const info = await waitForTx(txid);
    return { txHash: txid, matchId, blockNumber: info?.blockNumber };
  }

  async function getMatchOnChain(matchId: string): Promise<{
    status: number; // 0 None, 1 Active, 2 Settled
    player1EvmHex: string;
    player2EvmHex: string;
    stake: string;
  }> {
    const matchIdBytes32 = toMatchIdBytes32(matchId);
    const fnSelector = "getMatch(bytes32)";
    const tx = await tw.transactionBuilder.triggerConstantContract(
      cfg.escrowBase58,
      fnSelector,
      {},
      [{ type: "bytes32", value: matchIdBytes32 }],
      oracleBase58
    );
    const raw = tx?.constant_result?.[0];
    if (!raw) throw new TronOracleError("getMatch view returned empty", "VIEW_FAILED");
    // V2 Match struct: address p1 | address p2 | uint256 stake | uint8 status
    const slots = raw.match(/.{1,64}/g) || [];
    const player1EvmHex = "0x" + (slots[0] || "").slice(-40);
    const player2EvmHex = "0x" + (slots[1] || "").slice(-40);
    const stake = BigInt("0x" + (slots[2] || "0")).toString();
    const status = parseInt(slots[3] || "0", 16);
    return { status, player1EvmHex, player2EvmHex, stake };
  }

  async function getOracleBalanceTrx(): Promise<number> {
    const sun = await tw.trx.getBalance(oracleBase58);
    return sun / 1_000_000;
  }

  async function getPlayerBalanceTrx(playerBase58: string): Promise<number> {
    const sun = await tw.trx.getBalance(playerBase58);
    return sun / 1_000_000;
  }

  async function getUsdtAllowance(playerBase58: string): Promise<bigint> {
    const fnSelector = "allowance(address,address)";
    const params = [
      { type: "address", value: tronAddressToEvmHex(playerBase58, tw) },
      { type: "address", value: escrowEvmHex },
    ];
    const tx = await tw.transactionBuilder.triggerConstantContract(
      cfg.usdtBase58,
      fnSelector,
      {},
      params,
      playerBase58
    );
    const result = tx?.constant_result?.[0];
    if (!result) return 0n;
    return BigInt("0x" + result);
  }

  /**
   * Live estimate of the TRX cost of `USDT.approve(escrow, MAX)` for a given
   * player wallet. Uses TronGrid's triggerConstantContract to get
   * `energy_used`, then converts via the chain's energyFee (sun per energy
   * unit). Returns whole TRX (rounded up + small safety buffer).
   */
  async function estimateApproveTrxCost(playerBase58: string): Promise<{
    energy: number;
    trx: number;
  }> {
    const MAX_UINT256_HEX =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const fnSelector = "approve(address,uint256)";
    const params = [
      { type: "address", value: escrowEvmHex },
      { type: "uint256", value: MAX_UINT256_HEX },
    ];
    let energyUsed = 0;
    try {
      const tx = await tw.transactionBuilder.triggerConstantContract(
        cfg.usdtBase58,
        fnSelector,
        {},
        params,
        playerBase58
      );
      energyUsed = Number((tx as any)?.energy_used || 0);
    } catch (e: any) {
      console.warn(
        "[TronOracle] estimateApproveTrxCost triggerConstantContract failed:",
        e?.message || e
      );
    }
    if (!energyUsed || energyUsed <= 0) {
      // Fallback to a conservative literature value if the node refuses to
      // estimate (rare; happens on some public RPCs for unfunded callers).
      energyUsed = 65_000;
    }
    let energyFeeSun = 420; // mainnet default if param fetch fails
    try {
      const params = await tw.trx.getChainParameters();
      const ef = (params as any[])?.find?.((p) => p?.key === "getEnergyFee");
      if (ef && typeof ef.value === "number") energyFeeSun = ef.value;
    } catch (e: any) {
      console.warn(
        "[TronOracle] getChainParameters failed, using default energyFee:",
        e?.message || e
      );
    }
    const trxRaw = (energyUsed * energyFeeSun) / 1_000_000;
    // 20% buffer + round up to next whole TRX for UX clarity.
    const trx = Math.ceil(trxRaw * 1.2);
    return { energy: energyUsed, trx };
  }

  async function getAccumulatedGasFundUSDT(): Promise<bigint> {
    try {
      const fnSelector = "accumulatedGasFundUSDT()";
      const tx = await tw.transactionBuilder.triggerConstantContract(
        cfg.escrowBase58,
        fnSelector,
        {},
        [],
        oracleBase58
      );
      const result = tx?.constant_result?.[0];
      if (!result) return 0n;
      return BigInt("0x" + result);
    } catch {
      return 0n;
    }
  }

  return {
    chain: "TRON" as const,
    chainId: cfg.chainId,
    get oracleAddress() {
      return oracleBase58;
    },
    get escrowAddressBase58() {
      return cfg.escrowBase58;
    },
    get escrowAddressEvmHex() {
      return escrowEvmHex;
    },
    get usdtAddressBase58() {
      return cfg.usdtBase58;
    },
    tronAddressToEvmHex: (a: string) => tronAddressToEvmHex(a, tw),
    evmHexToTronAddress: (h: string) => evmHexToTronAddress(h, tw),
    buildDepositAuth,
    verifyDepositSig,
    submitDepositUSDTGasless,
    signMatchOutcome,
    submitSettlement,
    getMatchOnChain,
    getOracleBalanceTrx,
    getPlayerBalanceTrx,
    getUsdtAllowance,
    getAccumulatedGasFundUSDT,
    estimateApproveTrxCost,
  };
}

export type TronOracle = ReturnType<typeof createTronOracle>;
