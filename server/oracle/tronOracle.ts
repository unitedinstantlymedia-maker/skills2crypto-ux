/**
 * TronOracle — mirrors evmOracle for the USDT TRC-20 escrow on Tron.
 *
 * The on-chain contract is the same Skills2CryptoEscrow Solidity code, deployed
 * via TronBox. The oracle:
 *   - Pays all TRX gas (settleMatch + depositUSDT calls)
 *   - Reimburses itself in USDT from the gasReserve baked into each deposit
 *   - Players hold only USDT TRC-20 (one-time approve to escrow needed)
 *
 * Players sign EIP-712 Deposit messages via TronLink; the oracle bundles both
 * sigs and calls depositUSDT(matchId, stake, p1, p2, sig1, sig2) on Tron.
 */
import TronWeb from "tronweb";
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
  player1: string; // Tron base58
  player2: string; // Tron base58
  player1EvmHex: string; // 0x… 20-byte form used in the EIP-712 type
  player2EvmHex: string;
  stake: string;
  nonce1: string;
  nonce2: string;
  escrowAddressEvmHex: string; // 0x… (verifyingContract for EIP-712)
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
    throw new TronOracleError(`Invalid Tron address (hex form): ${hex}`, "INVALID_ADDRESS");
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
  minTrxForGas: number; // in TRX
}

function resolveConfig(): TronConfig {
  return {
    fullHost: loadEnvOrThrow("TRON_RPC_URL"),
    escrowBase58: loadEnvOrThrow("TRON_ESCROW_CONTRACT"),
    usdtBase58: process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    platformWalletBase58: process.env.TRON_PLATFORM_WALLET || "TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq",
    // Tron mainnet uses chainId 728126428 (0x2b6653dc) for TIP-712 by convention.
    chainId: Number(process.env.TRON_CHAIN_ID ?? 728126428),
    minTrxForGas: Number(process.env.TRON_MIN_GAS_TRX ?? 20),
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

  const tw = new (TronWeb as any)({
    fullHost: cfg.fullHost,
    privateKey,
  });

  const oracleBase58: string = tw.address.fromPrivateKey(privateKey);
  const escrowEvmHex = tronAddressToEvmHex(cfg.escrowBase58, tw);

  console.log(`[TronOracle] Oracle wallet: ${oracleBase58}`);
  console.log(`[TronOracle] Escrow contract: ${cfg.escrowBase58}`);
  console.log(`[TronOracle] USDT contract: ${cfg.usdtBase58}`);
  console.log(`[TronOracle] Chain ID: ${cfg.chainId}`);

  if (!_startupRun) {
    _startupRun = true;
    (async () => {
      try {
        const balanceSun = await tw.trx.getBalance(oracleBase58);
        const balanceTrx = balanceSun / 1_000_000;
        console.log(`[TronOracle] [startup] Oracle TRX balance: ${balanceTrx}`);
        if (balanceTrx < cfg.minTrxForGas) {
          console.warn(`[TronOracle] [startup] WARNING: TRX balance below ${cfg.minTrxForGas} — top up ${oracleBase58}`);
        }
        const onChainOracle = await callView("oracle", []);
        const onChainOracleBase58 = evmHexToTronAddress(onChainOracle, tw);
        console.log(`[TronOracle] [startup] Contract.oracle() = ${onChainOracleBase58}`);
        if (onChainOracleBase58 !== oracleBase58) {
          console.error(`[TronOracle] [startup] MISMATCH: contract oracle is ${onChainOracleBase58}, our wallet is ${oracleBase58}`);
        } else {
          console.log(`[TronOracle] [startup] Oracle address matches — contract is ready`);
        }
      } catch (e: any) {
        console.error(`[TronOracle] [startup] Validation failed: ${e?.message || e}`);
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
        `Oracle TRX balance insufficient (${trx} TRX). Please top up ${oracleBase58}.`,
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
    // For address-returning calls, take the last 40 hex chars as evm-style
    if (method === "oracle" || method === "platformWallet" || method === "owner") {
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

  /**
   * Build the EIP-712 typed data + per-player nonces required for both
   * players to sign the Deposit message via TronLink. The server cross-verifies
   * the signatures before broadcasting depositUSDT.
   */
  async function buildDepositAuth(params: {
    matchId: string;
    player1Base58: string;
    player2Base58: string;
    stakeUsdt: number;
  }): Promise<TronDepositAuth> {
    if (!isTronAddress(params.player1Base58)) {
      throw new TronOracleError("player1 must be a Tron base58 address", "INVALID_INPUT");
    }
    if (!isTronAddress(params.player2Base58)) {
      throw new TronOracleError("player2 must be a Tron base58 address", "INVALID_INPUT");
    }
    if (params.player1Base58 === params.player2Base58) {
      throw new TronOracleError("Players cannot share an address", "INVALID_INPUT");
    }
    if (!Number.isFinite(params.stakeUsdt) || params.stakeUsdt <= 0) {
      throw new TronOracleError("stake must be > 0", "INVALID_INPUT");
    }

    const stakeUnits = BigInt(Math.round(params.stakeUsdt * 10 ** USDT_TRC20_DECIMALS));
    const matchIdBytes32 = toMatchIdBytes32(params.matchId);

    const player1Hex = tronAddressToEvmHex(params.player1Base58, tw);
    const player2Hex = tronAddressToEvmHex(params.player2Base58, tw);

    const nonce1 = await callView("getDepositNonce", [{ type: "address", value: player1Hex }]);
    const nonce2 = await callView("getDepositNonce", [{ type: "address", value: player2Hex }]);
    const nonce1Big = BigInt("0x" + (nonce1 as string).slice(-64));
    const nonce2Big = BigInt("0x" + (nonce2 as string).slice(-64));

    const domain = {
      name: "Skills2CryptoEscrow",
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: escrowEvmHex,
    };
    const types = {
      Deposit: [
        { name: "matchId", type: "bytes32" },
        { name: "stake", type: "uint256" },
        { name: "assetType", type: "uint8" },
        { name: "nonce", type: "uint256" },
      ],
    };

    return {
      matchId: params.matchId,
      matchIdBytes32,
      player1: params.player1Base58,
      player2: params.player2Base58,
      player1EvmHex: player1Hex,
      player2EvmHex: player2Hex,
      stake: stakeUnits.toString(),
      nonce1: nonce1Big.toString(),
      nonce2: nonce2Big.toString(),
      escrowAddressEvmHex: escrowEvmHex,
      escrowAddressBase58: cfg.escrowBase58,
      chainId: cfg.chainId,
      domain,
      types,
    };
  }

  /**
   * Verify a player's EIP-712 Deposit signature recovers to the expected EVM
   * address derived from their Tron base58 address.
   */
  function verifyDepositSig(params: {
    matchIdBytes32: string;
    stakeUnits: string;
    nonce: string;
    expectedPlayerEvmHex: string;
    signature: string;
  }): boolean {
    const domain = {
      name: "Skills2CryptoEscrow",
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: escrowEvmHex,
    };
    const types = {
      Deposit: [
        { name: "matchId", type: "bytes32" },
        { name: "stake", type: "uint256" },
        { name: "assetType", type: "uint8" },
        { name: "nonce", type: "uint256" },
      ],
    };
    const value = {
      matchId: params.matchIdBytes32,
      stake: BigInt(params.stakeUnits),
      assetType: 0, // USDT
      nonce: BigInt(params.nonce),
    };

    try {
      const recovered = ethers.verifyTypedData(domain, types, value, params.signature);
      return recovered.toLowerCase() === params.expectedPlayerEvmHex.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Submit depositUSDT on-chain after both players have signed. Pulls
   * `stake + gasReserve` USDT from each player via the allowance they
   * previously approved to the escrow.
   */
  async function submitDepositUSDT(params: {
    matchId: string;
    stakeUnits: string;
    player1EvmHex: string;
    player2EvmHex: string;
    sig1: string;
    sig2: string;
  }): Promise<{ txid: string }> {
    const matchIdBytes32 = toMatchIdBytes32(params.matchId);
    const args = [
      { type: "bytes32", value: matchIdBytes32 },
      { type: "uint256", value: params.stakeUnits },
      { type: "address", value: params.player1EvmHex },
      { type: "address", value: params.player2EvmHex },
      { type: "bytes", value: params.sig1.replace(/^0x/, "") },
      { type: "bytes", value: params.sig2.replace(/^0x/, "") },
    ];
    console.log(`[TronOracle] depositUSDT — match: ${params.matchId}`);
    const { txid } = await triggerWrite("depositUSDT", args, 300);
    console.log(`[TronOracle] deposit tx broadcast: ${txid}`);
    await waitForTx(txid);
    console.log(`[TronOracle] deposit confirmed: ${txid}`);
    return { txid };
  }

  async function submitSettlement(
    matchId: string,
    winnerEvmHex: string,
    reason: number
  ): Promise<TronSettleResult> {
    if (reason < 0 || reason > 2) {
      throw new TronOracleError(`Invalid settle reason: ${reason}`, "INVALID_REASON");
    }
    const matchIdBytes32 = toMatchIdBytes32(matchId);
    console.log(`[TronOracle] submitSettlement — match: ${matchId}, winner: ${winnerEvmHex}, reason: ${reason}`);
    const { txid } = await triggerWrite(
      "settleMatch",
      [
        { type: "bytes32", value: matchIdBytes32 },
        { type: "address", value: winnerEvmHex },
        { type: "uint8", value: reason },
      ],
      300
    );
    const info = await waitForTx(txid);
    return {
      txHash: txid,
      matchId,
      blockNumber: info?.blockNumber,
    };
  }

  async function getMatchOnChain(matchId: string): Promise<{ status: number; firstDepositorEvmHex: string }> {
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
    // Match struct decoded layout: bytes32 matchId | address p1 | address p2 |
    //   uint256 stake | uint8 assetType | uint256 gasReserve | uint8 status |
    //   uint256 deadline | address firstDepositor
    // Each slot is 64 hex chars.
    const slots = raw.match(/.{1,64}/g) || [];
    const status = parseInt(slots[6] || "0", 16);
    const firstDepositorEvmHex = "0x" + (slots[8] || "").slice(-40);
    return { status, firstDepositorEvmHex };
  }

  async function getOracleBalanceTrx(): Promise<number> {
    const sun = await tw.trx.getBalance(oracleBase58);
    return sun / 1_000_000;
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
    submitDepositUSDT,
    submitSettlement,
    getMatchOnChain,
    getOracleBalanceTrx,
  };
}

export type TronOracle = ReturnType<typeof createTronOracle>;
