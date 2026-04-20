import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  type ContractTransactionResponse,
  type TransactionReceipt,
} from "ethers";

export type EvmChain = "BSC" | "ETH";

// V2 ABI — player-pays-gas. Oracle never sends a transaction; it only signs
// MatchAuth (for deposits) and MatchOutcome (for settlements) off-chain.
const ESCROW_ABI = [
  "function depositNative(bytes32 matchId, address player1, address player2, uint256 stake, uint256 deadline, bytes oracleSig) payable",
  "function refundNoShow(bytes32 matchId)",
  "function settleMatch(bytes32 matchId, address winner, uint8 reason, bytes oracleSig)",
  "function getDomainSeparator() view returns (bytes32)",
  "function oracle() view returns (address)",
  "function platformWallet() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
  "function getMatch(bytes32 matchId) view returns (tuple(address player1, address player2, uint256 stake, uint256 deadline, address firstDepositor, uint8 status))",
  "event MatchActive(bytes32 indexed matchId, address player1, address player2, uint256 stake)",
  "event PlayerDeposited(bytes32 indexed matchId, address indexed player, uint256 amount)",
  "event MatchSettled(bytes32 indexed matchId, address winner, uint8 reason, uint256 payout, uint256 platformFee)",
];

export interface MatchAuth {
  matchId: string;
  matchIdBytes32: string;
  player1: string;
  player2: string;
  stake: string;
  deadline: number;
  oracleSig: string;
  chainId: number;
  escrowAddress: string;
}

export interface MatchOutcomeAuth {
  matchId: string;
  matchIdBytes32: string;
  winner: string;
  reason: number;
  oracleSig: string;
  chainId: number;
  escrowAddress: string;
}

export class EvmOracleError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "EvmOracleError";
    this.code = code;
  }
}

function loadEnvOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new EvmOracleError(`Missing required env var: ${key}`, "ENV_MISSING");
  return v;
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 ? `${u.protocol}//${u.host}/***` : `${u.protocol}//${u.host}`;
  } catch {
    return "***";
  }
}

function resolveChainConfig(chain: EvmChain) {
  if (chain === "BSC") {
    return {
      rpcUrl: loadEnvOrThrow("BSC_RPC_URL"),
      escrowAddress: loadEnvOrThrow("BSC_ESCROW_ADDRESS"),
      chainId: Number(process.env.BSC_CHAIN_ID ?? 56),
      nativeSymbol: "BNB",
    };
  }
  return {
    rpcUrl: loadEnvOrThrow("ETH_RPC_URL"),
    escrowAddress: loadEnvOrThrow("ETH_ESCROW_ADDRESS"),
    chainId: Number(process.env.ETH_CHAIN_ID ?? 1),
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

  console.log(`[EvmOracle:${chain}] Oracle wallet (signer only): ${wallet.address}`);
  console.log(`[EvmOracle:${chain}] Escrow contract: ${cfg.escrowAddress}`);
  console.log(`[EvmOracle:${chain}] RPC: ${redactUrl(cfg.rpcUrl)}`);
  console.log(`[EvmOracle:${chain}] Expected chain ID: ${cfg.chainId}`);

  if (!_startupDiagRun[chain]) {
    _startupDiagRun[chain] = true;
    (async () => {
      try {
        const network = await provider.getNetwork();
        console.log(`[EvmOracle:${chain}] [startup] Connected to chain ${network.chainId}`);
        // The oracle no longer broadcasts transactions on EVM, so a low
        // native balance is informational only — log it without warning.
        const balance = await provider.getBalance(wallet.address);
        console.log(`[EvmOracle:${chain}] [startup] Oracle ${cfg.nativeSymbol} balance: ${ethers.formatEther(balance)} (signer-only, no gas needed)`);
        const onChainOracle = await escrow.oracle();
        console.log(`[EvmOracle:${chain}] [startup] Contract oracle address: ${onChainOracle}`);
        if (onChainOracle.toLowerCase() !== wallet.address.toLowerCase()) {
          console.error(`[EvmOracle:${chain}] [startup] MISMATCH: contract oracle is ${onChainOracle}, signer is ${wallet.address}`);
        } else {
          console.log(`[EvmOracle:${chain}] [startup] Oracle signer matches on-chain config — ready`);
        }
      } catch (err: any) {
        console.error(`[EvmOracle:${chain}] [startup] validation FAILED: ${err?.message || err}`);
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
        `Chain ID mismatch on ${chain}: expected ${cfg.chainId}, got ${actual}`,
        "CHAIN_MISMATCH"
      );
    }
    chainVerified = true;
  }

  function toMatchIdBytes32(matchId: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(matchId));
  }

  function buildDomain() {
    return {
      name: "Skills2CryptoEscrow",
      version: "2",
      chainId: cfg.chainId,
      verifyingContract: cfg.escrowAddress,
    };
  }

  /**
   * Off-chain MatchAuth signature. Both players will submit this same auth
   * (with their own stake) on-chain via depositNative.
   */
  async function signMatchAuth(params: {
    matchId: string;
    player1: string;
    player2: string;
    stake: bigint;
    deadline: number;
  }): Promise<MatchAuth> {
    await ensureChainVerified();
    if (!isValidAddress(params.player1) || !isValidAddress(params.player2)) {
      throw new EvmOracleError("player1/player2 must be valid EVM addresses", "INVALID_INPUT");
    }
    if (params.player1.toLowerCase() === params.player2.toLowerCase()) {
      throw new EvmOracleError("player1 and player2 cannot be the same", "INVALID_INPUT");
    }
    if (params.stake <= 0n) throw new EvmOracleError("stake must be positive", "INVALID_INPUT");
    if (!Number.isFinite(params.deadline) || params.deadline <= Math.floor(Date.now() / 1000)) {
      throw new EvmOracleError("deadline must be a future unix timestamp", "INVALID_INPUT");
    }

    const matchIdBytes32 = toMatchIdBytes32(params.matchId);
    const types = {
      MatchAuth: [
        { name: "matchId", type: "bytes32" },
        { name: "player1", type: "address" },
        { name: "player2", type: "address" },
        { name: "stake", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = {
      matchId: matchIdBytes32,
      player1: params.player1,
      player2: params.player2,
      stake: params.stake,
      deadline: params.deadline,
    };
    const oracleSig = await wallet.signTypedData(buildDomain(), types, value);
    return {
      matchId: params.matchId,
      matchIdBytes32,
      player1: params.player1,
      player2: params.player2,
      stake: params.stake.toString(),
      deadline: params.deadline,
      oracleSig,
      chainId: cfg.chainId,
      escrowAddress: cfg.escrowAddress,
    };
  }

  /**
   * Off-chain MatchOutcome signature. The winner (Normal) or either player
   * (Draw/Disconnect) calls escrow.settleMatch with this signature, paying
   * their own gas.
   *
   * @param winner - Winner EVM address. Pass ethers.ZeroAddress for Draw or
   *                 Disconnect (the contract enforces this).
   * @param reason - 0 = Normal, 1 = Draw, 2 = Disconnect.
   */
  async function signMatchOutcome(params: {
    matchId: string;
    winner: string;
    reason: number;
  }): Promise<MatchOutcomeAuth> {
    await ensureChainVerified();
    if (params.reason < 0 || params.reason > 2) {
      throw new EvmOracleError(`Invalid reason ${params.reason}`, "INVALID_REASON");
    }
    if (!isValidAddress(params.winner) && params.winner !== ethers.ZeroAddress) {
      throw new EvmOracleError("winner must be a valid EVM address or zero", "INVALID_INPUT");
    }

    const matchIdBytes32 = toMatchIdBytes32(params.matchId);
    const types = {
      MatchOutcome: [
        { name: "matchId", type: "bytes32" },
        { name: "winner", type: "address" },
        { name: "reason", type: "uint8" },
      ],
    };
    const value = {
      matchId: matchIdBytes32,
      winner: params.winner,
      reason: params.reason,
    };
    const oracleSig = await wallet.signTypedData(buildDomain(), types, value);
    return {
      matchId: params.matchId,
      matchIdBytes32,
      winner: params.winner,
      reason: params.reason,
      oracleSig,
      chainId: cfg.chainId,
      escrowAddress: cfg.escrowAddress,
    };
  }

  async function getMatchOnChain(matchId: string) {
    const matchIdBytes32 = toMatchIdBytes32(matchId);
    const m = await escrow.getMatch(matchIdBytes32);
    return {
      player1: m.player1 as string,
      player2: m.player2 as string,
      stake: m.stake as bigint,
      deadline: Number(m.deadline),
      firstDepositor: m.firstDepositor as string,
      status: Number(m.status), // 0 None, 1 WaitingForP2, 2 Active, 3 Settled
    };
  }

  async function getOracleBalance(): Promise<string> {
    const balance = await provider.getBalance(wallet.address);
    return ethers.formatEther(balance);
  }

  /**
   * Subscribe to MatchActive events (the second deposit completes a match).
   * Returns an unsubscribe function.
   */
  function watchMatchActive(
    handler: (evt: {
      matchId: string;
      player1: string;
      player2: string;
      stake: bigint;
    }) => void
  ): () => void {
    const listener = (
      matchIdBytes32: string,
      player1: string,
      player2: string,
      stake: bigint
    ) => {
      handler({ matchId: matchIdBytes32, player1, player2, stake });
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
    signMatchAuth,
    signMatchOutcome,
    getMatchOnChain,
    getOracleBalance,
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
