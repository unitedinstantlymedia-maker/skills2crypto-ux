import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  type TransactionReceipt,
  type ContractTransactionResponse,
} from "ethers";

export type EvmChain = "BSC" | "ETH";

const ESCROW_ABI = [
  "function registerSessionKey(address player, address sessionAddr, uint256 maxStakePerMatch, uint256 expiry, bytes signature)",
  "function depositNativeAsPlayer(bytes32 matchId, address player1, address player2, uint256 stake, uint256 gasReserve, uint256 deadline, bytes oracleSig) payable",
  "function refundNoShow(bytes32 matchId)",
  "function settleMatch(bytes32 matchId, address winner, uint8 reason)",
  "function updateGasPrice(uint256 _gasPricePerGasUnit)",
  "function getDomainSeparator() view returns (bytes32)",
  "function oracle() view returns (address)",
  "function owner() view returns (address)",
  "function platformWallet() view returns (address)",
  "function depositNonces(address player) view returns (uint256)",
  "function getMatch(bytes32 matchId) view returns (tuple(bytes32 matchId, address player1, address player2, uint256 stake, uint8 assetType, uint256 gasReservePerPlayer, uint8 status, uint256 deadline, address firstDepositor))",
  "function getGasReserveEstimate() view returns (uint256)",
  "function getDepositNonce(address player) view returns (uint256)",
  "function getSessionKey(address player) view returns (tuple(address player, address sessionAddr, uint256 maxStakePerMatch, uint256 expiry, bool revoked))",
  "function sessionNonces(address player) view returns (uint256)",
  "event SessionKeyRegistered(address indexed player, address indexed sessionAddr, uint256 expiry)",
  "event MatchActive(bytes32 indexed matchId, address player1, address player2, uint256 stake, uint8 assetType, uint256 gasReservePerPlayer)",
  "event PlayerDeposited(bytes32 indexed matchId, address indexed player, uint256 amount)",
  "event MatchSettled(bytes32 indexed matchId, address winner, uint8 reason, uint256 payout, uint256 platformFee)",
];

const GAS_BUFFER_PERCENT = 20;
const TX_CONFIRMATION_BLOCKS = 1;

export interface SettleResult {
  txHash: string;
  matchId: string;
  gasUsed: string;
  blockNumber: number;
}

export interface MatchAuth {
  matchId: string;
  matchIdBytes32: string;
  player1: string;
  player2: string;
  stake: string;
  gasReserve: string;
  deadline: number;
  oracleSig: string;
  chainId: number;
  escrowAddress: string;
}

export class EvmOracleError extends Error {
  public readonly code: string;
  public readonly txHash?: string;

  constructor(message: string, code: string, txHash?: string) {
    super(message);
    this.name = "EvmOracleError";
    this.code = code;
    this.txHash = txHash;
  }
}

function loadEnvOrThrow(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new EvmOracleError(
      `Missing required environment variable: ${key}`,
      "ENV_MISSING"
    );
  }
  return val;
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function isValidBytes(hex: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(hex) && hex.length >= 4;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.length > 1) {
      return `${u.protocol}//${u.host}/***`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return "***";
  }
}

function resolveChainConfig(chain: EvmChain): {
  rpcUrl: string;
  escrowAddress: string;
  chainId: number;
  minNativeForGas: bigint;
  nativeSymbol: string;
} {
  if (chain === "BSC") {
    return {
      rpcUrl: loadEnvOrThrow("BSC_RPC_URL"),
      escrowAddress: loadEnvOrThrow("BSC_ESCROW_ADDRESS"),
      chainId: Number(process.env.BSC_CHAIN_ID ?? 56),
      minNativeForGas: ethers.parseEther("0.001"),
      nativeSymbol: "BNB",
    };
  }
  return {
    rpcUrl: loadEnvOrThrow("ETH_RPC_URL"),
    escrowAddress: loadEnvOrThrow("ETH_ESCROW_ADDRESS"),
    chainId: Number(process.env.ETH_CHAIN_ID ?? 1),
    minNativeForGas: ethers.parseEther("0.005"),
    nativeSymbol: "ETH",
  };
}

const _oracleCache: Partial<Record<EvmChain, ReturnType<typeof buildOracle>>> = {};
const _startupDiagRun: Partial<Record<EvmChain, boolean>> = {};

export function createEvmOracle(chain: EvmChain = "BSC") {
  const cached = _oracleCache[chain];
  if (cached) return cached;
  const built = buildOracle(chain);
  _oracleCache[chain] = built;
  return built;
}

export function chainForAsset(asset: string): EvmChain | null {
  if (asset === "BNB") return "BSC";
  if (asset === "ETH") return "ETH";
  return null;
}

function buildOracle(chain: EvmChain) {
  const cfg = resolveChainConfig(chain);
  const privateKey = loadEnvOrThrow("ORACLE_PRIVATE_KEY");

  if (!isValidAddress(cfg.escrowAddress)) {
    throw new EvmOracleError(
      `${chain}_ESCROW_ADDRESS is not a valid EVM address: ${cfg.escrowAddress}`,
      "INVALID_CONFIG"
    );
  }

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const escrow = new Contract(cfg.escrowAddress, ESCROW_ABI, wallet);

  console.log(`[EvmOracle:${chain}] Oracle wallet: ${wallet.address}`);
  console.log(`[EvmOracle:${chain}] Escrow contract: ${cfg.escrowAddress}`);
  console.log(`[EvmOracle:${chain}] RPC: ${redactUrl(cfg.rpcUrl)}`);
  console.log(`[EvmOracle:${chain}] Expected chain ID: ${cfg.chainId}`);

  if (!_startupDiagRun[chain]) {
    _startupDiagRun[chain] = true;
    (async () => {
      try {
        const network = await provider.getNetwork();
        console.log(`[EvmOracle:${chain}] [startup] Connected to chain ${network.chainId}`);
        const balance = await provider.getBalance(wallet.address);
        console.log(`[EvmOracle:${chain}] [startup] Oracle ${cfg.nativeSymbol} balance: ${ethers.formatEther(balance)}`);
        if (balance < cfg.minNativeForGas) {
          console.warn(`[EvmOracle:${chain}] [startup] WARNING: Oracle ${cfg.nativeSymbol} balance too low for gas!`);
        }
        const domainSep = await escrow.getDomainSeparator();
        console.log(`[EvmOracle:${chain}] [startup] Contract getDomainSeparator() OK: ${domainSep.slice(0, 18)}...`);
        const onChainOracle = await escrow.oracle();
        console.log(`[EvmOracle:${chain}] [startup] Contract oracle address: ${onChainOracle}`);
        if (onChainOracle.toLowerCase() !== wallet.address.toLowerCase()) {
          console.error(`[EvmOracle:${chain}] [startup] MISMATCH: Contract oracle is ${onChainOracle}, but our wallet is ${wallet.address}`);
        } else {
          console.log(`[EvmOracle:${chain}] [startup] Oracle address matches — contract is ready`);
        }
      } catch (err: any) {
        console.error(`[EvmOracle:${chain}] [startup] Contract validation FAILED: ${err?.message || err}`);
      }
    })();
  }

  let chainVerified = false;
  async function ensureChainVerified(): Promise<void> {
    if (chainVerified) return;
    const network = await provider.getNetwork();
    const actual = Number(network.chainId);
    if (actual !== cfg.chainId) {
      throw new EvmOracleError(
        `Chain ID mismatch on ${chain}: expected ${cfg.chainId}, got ${actual}.`,
        "CHAIN_MISMATCH"
      );
    }
    chainVerified = true;
  }

  function addGasBuffer(estimatedGas: bigint): bigint {
    return (estimatedGas * BigInt(100 + GAS_BUFFER_PERCENT)) / 100n;
  }

  async function ensureOracleHasGas(): Promise<void> {
    const balance = await provider.getBalance(wallet.address);
    if (balance < cfg.minNativeForGas) {
      const balStr = ethers.formatEther(balance);
      console.error(`[EvmOracle:${chain}] Oracle ${cfg.nativeSymbol} balance critically low: ${balStr}. Please send ${cfg.nativeSymbol} to ${wallet.address}`);
      throw new EvmOracleError(
        `Oracle wallet has insufficient ${cfg.nativeSymbol} for gas (${balStr}). Please top up ${wallet.address}.`,
        "ORACLE_NO_GAS"
      );
    }
  }

  async function waitForReceipt(tx: ContractTransactionResponse): Promise<TransactionReceipt> {
    const receipt = await tx.wait(TX_CONFIRMATION_BLOCKS);
    if (!receipt) {
      throw new EvmOracleError("Transaction receipt is null — tx may have been dropped", "RECEIPT_NULL", tx.hash);
    }
    if (receipt.status === 0) {
      throw new EvmOracleError("Transaction reverted on-chain", "TX_REVERTED", tx.hash);
    }
    return receipt;
  }

  function toMatchIdBytes32(matchId: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(matchId));
  }

  /**
   * Produce an EIP-712 MatchAuth signature for the given match parameters.
   * Both players will submit this exact signature (+ params) on-chain with
   * their own stake+gasReserve.
   */
  async function signMatchAuth(params: {
    matchId: string;
    player1: string;
    player2: string;
    stake: bigint;
    gasReserve: bigint;
    deadline: number;
  }): Promise<MatchAuth> {
    await ensureChainVerified();

    if (!isValidAddress(params.player1) || !isValidAddress(params.player2)) {
      throw new EvmOracleError("player1/player2 must be valid EVM addresses", "INVALID_INPUT");
    }
    if (params.player1.toLowerCase() === params.player2.toLowerCase()) {
      throw new EvmOracleError("player1 and player2 cannot be the same address", "INVALID_INPUT");
    }
    if (params.stake <= 0n) throw new EvmOracleError("stake must be positive", "INVALID_INPUT");
    if (params.gasReserve < 0n) throw new EvmOracleError("gasReserve must be non-negative", "INVALID_INPUT");
    if (!Number.isFinite(params.deadline) || params.deadline <= Math.floor(Date.now() / 1000)) {
      throw new EvmOracleError("deadline must be a future unix timestamp", "INVALID_INPUT");
    }

    const matchIdBytes32 = toMatchIdBytes32(params.matchId);

    const domain = {
      name: "Skills2CryptoEscrow",
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: cfg.escrowAddress,
    };
    const types = {
      MatchAuth: [
        { name: "matchId", type: "bytes32" },
        { name: "player1", type: "address" },
        { name: "player2", type: "address" },
        { name: "stake", type: "uint256" },
        { name: "gasReserve", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = {
      matchId: matchIdBytes32,
      player1: params.player1,
      player2: params.player2,
      stake: params.stake,
      gasReserve: params.gasReserve,
      deadline: params.deadline,
    };

    const oracleSig = await wallet.signTypedData(domain, types, value);

    return {
      matchId: params.matchId,
      matchIdBytes32,
      player1: params.player1,
      player2: params.player2,
      stake: params.stake.toString(),
      gasReserve: params.gasReserve.toString(),
      deadline: params.deadline,
      oracleSig,
      chainId: cfg.chainId,
      escrowAddress: cfg.escrowAddress,
    };
  }

  async function submitSettlement(
    matchId: string,
    winner: string,
    reason: number
  ): Promise<SettleResult> {
    await ensureChainVerified();

    if (!matchId) throw new EvmOracleError("matchId cannot be empty", "INVALID_INPUT");
    if (reason < 0 || reason > 2) {
      throw new EvmOracleError(`Invalid settle reason: ${reason}`, "INVALID_REASON");
    }
    if (!isValidAddress(winner) && winner !== ethers.ZeroAddress) {
      throw new EvmOracleError("winner must be a valid EVM address or zero address", "INVALID_INPUT");
    }

    const matchIdBytes32 = toMatchIdBytes32(matchId);
    console.log(`[EvmOracle:${chain}] submitSettlement — match: ${matchId}, winner: ${winner}, reason: ${reason}`);

    await ensureOracleHasGas();

    try {
      const estimatedGas = await escrow.settleMatch.estimateGas(matchIdBytes32, winner, reason);
      const gasLimit = addGasBuffer(estimatedGas);
      const tx: ContractTransactionResponse = await escrow.settleMatch(matchIdBytes32, winner, reason, { gasLimit });
      console.log(`[EvmOracle:${chain}] Settle tx sent: ${tx.hash}`);
      const receipt = await waitForReceipt(tx);
      console.log(`[EvmOracle:${chain}] Settlement confirmed in block ${receipt.blockNumber}`);
      return {
        txHash: tx.hash,
        matchId,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
      };
    } catch (err: any) {
      if (err instanceof EvmOracleError) throw err;
      const reason_msg = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      console.error(`[EvmOracle:${chain}] submitSettlement failed: ${reason_msg}`);
      throw new EvmOracleError(`Settlement failed: ${reason_msg}`, "SETTLE_FAILED", err?.hash);
    }
  }

  async function updateGasPrice(gasPricePerUnit: bigint): Promise<string> {
    await ensureChainVerified();
    await ensureOracleHasGas();
    try {
      const estimatedGas = await escrow.updateGasPrice.estimateGas(gasPricePerUnit);
      const gasLimit = addGasBuffer(estimatedGas);
      const tx: ContractTransactionResponse = await escrow.updateGasPrice(gasPricePerUnit, { gasLimit });
      await waitForReceipt(tx);
      return tx.hash;
    } catch (err: any) {
      const reason = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      throw new EvmOracleError(`Gas price update failed: ${reason}`, "GAS_UPDATE_FAILED");
    }
  }

  async function registerSessionKey(
    player: string,
    sessionAddr: string,
    maxStakePerMatch: bigint,
    expiry: bigint,
    signature: string
  ): Promise<{ txHash: string; blockNumber: number }> {
    await ensureChainVerified();

    if (!isValidAddress(player)) throw new EvmOracleError("player must be a valid EVM address", "INVALID_INPUT");
    if (!isValidAddress(sessionAddr)) throw new EvmOracleError("sessionAddr must be a valid EVM address", "INVALID_INPUT");
    if (maxStakePerMatch <= 0n) throw new EvmOracleError("maxStakePerMatch must be positive", "INVALID_INPUT");
    if (!isValidBytes(signature)) throw new EvmOracleError("signature must be valid hex", "INVALID_INPUT");

    console.log(`[EvmOracle:${chain}] registerSessionKey — player: ${player}, session: ${sessionAddr}`);
    await ensureOracleHasGas();

    try {
      const estimatedGas = await escrow.registerSessionKey.estimateGas(player, sessionAddr, maxStakePerMatch, expiry, signature);
      const gasLimit = addGasBuffer(estimatedGas);
      const tx: ContractTransactionResponse = await escrow.registerSessionKey(player, sessionAddr, maxStakePerMatch, expiry, signature, { gasLimit });
      const receipt = await waitForReceipt(tx);
      return { txHash: tx.hash, blockNumber: receipt.blockNumber };
    } catch (err: any) {
      if (err instanceof EvmOracleError) throw err;
      const reason = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      throw new EvmOracleError(`Session registration failed: ${reason}`, "SESSION_REGISTER_FAILED", err?.hash);
    }
  }

  async function getSessionNonce(player: string): Promise<bigint> {
    if (!isValidAddress(player)) throw new EvmOracleError("player must be a valid EVM address", "INVALID_INPUT");
    return escrow.sessionNonces(player);
  }

  async function getSessionKeyOnChain(player: string) {
    if (!isValidAddress(player)) throw new EvmOracleError("player must be a valid EVM address", "INVALID_INPUT");
    return escrow.getSessionKey(player);
  }

  async function getMatchOnChain(matchId: string) {
    const matchIdBytes32 = toMatchIdBytes32(matchId);
    const m = await escrow.getMatch(matchIdBytes32);
    return {
      matchId: m.matchId,
      player1: m.player1,
      player2: m.player2,
      stake: m.stake as bigint,
      assetType: Number(m.assetType),
      gasReservePerPlayer: m.gasReservePerPlayer as bigint,
      status: Number(m.status),
      deadline: Number(m.deadline),
      firstDepositor: m.firstDepositor as string,
    };
  }

  async function getOracleBalance(): Promise<string> {
    const balance = await provider.getBalance(wallet.address);
    return ethers.formatEther(balance);
  }

  async function getGasReserveEstimate(): Promise<bigint> {
    const estimate = await escrow.getGasReserveEstimate();
    return estimate as bigint;
  }

  /**
   * Subscribe to MatchActive events. Handler fires with decoded match info.
   * Returns an unsubscribe function.
   */
  function watchMatchActive(
    handler: (evt: {
      matchId: string;
      player1: string;
      player2: string;
      stake: bigint;
      assetType: number;
      gasReserve: bigint;
    }) => void
  ): () => void {
    const listener = (
      matchIdBytes32: string,
      player1: string,
      player2: string,
      stake: bigint,
      assetType: bigint,
      gasReservePerPlayer: bigint
    ) => {
      handler({
        matchId: matchIdBytes32,
        player1,
        player2,
        stake,
        assetType: Number(assetType),
        gasReserve: gasReservePerPlayer,
      });
    };
    escrow.on("MatchActive", listener);
    console.log(`[EvmOracle:${chain}] Subscribed to MatchActive events`);
    return () => {
      escrow.off("MatchActive", listener);
    };
  }

  return {
    chain,
    chainId: cfg.chainId,
    registerSessionKey,
    getSessionNonce,
    getSessionKeyOnChain,
    signMatchAuth,
    submitSettlement,
    updateGasPrice,
    getMatchOnChain,
    getOracleBalance,
    getGasReserveEstimate,
    watchMatchActive,
    get address() {
      return wallet.address;
    },
    get escrowAddress() {
      return cfg.escrowAddress;
    },
  };
}

export type EvmOracle = ReturnType<typeof createEvmOracle>;
