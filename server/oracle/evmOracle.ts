import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  type TransactionReceipt,
  type ContractTransactionResponse,
} from "ethers";

const ESCROW_ABI = [
  "function depositUSDT(bytes32 matchId, uint256 stake, address player1, address player2, bytes sig1, bytes sig2)",
  "function depositNative(bytes32 matchId, uint256 stake, address player1, address player2, bytes sig1, bytes sig2) payable",
  "function settleMatch(bytes32 matchId, address winner, uint8 reason)",
  "function updateGasPrice(uint256 _gasPricePerGasUnit)",
  "function getMatch(bytes32 matchId) view returns (tuple(bytes32 matchId, address player1, address player2, uint256 stake, uint8 assetType, uint256 gasReservePerPlayer, uint8 status))",
  "function getGasReserveEstimate() view returns (uint256)",
  "function getDepositNonce(address player) view returns (uint256)",
  "function getSessionKey(address player) view returns (tuple(address player, address sessionAddr, uint256 maxStakePerMatch, uint256 expiry, bool revoked))",
  "event MatchActive(bytes32 indexed matchId, address player1, address player2, uint256 stake, uint8 assetType, uint256 gasReservePerPlayer)",
  "event MatchSettled(bytes32 indexed matchId, address winner, uint8 reason, uint256 payout, uint256 platformFee)",
];

const GAS_BUFFER_PERCENT = 20;
const TX_CONFIRMATION_BLOCKS = 1;
const EXPECTED_CHAIN_ID = Number(process.env.BSC_CHAIN_ID ?? 56);

export interface DepositResult {
  txHash: string;
  matchId: string;
  gasUsed: string;
  blockNumber: number;
}

export interface SettleResult {
  txHash: string;
  matchId: string;
  gasUsed: string;
  blockNumber: number;
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

export function createEvmOracle() {
  const privateKey = loadEnvOrThrow("ORACLE_PRIVATE_KEY");
  const rpcUrl = loadEnvOrThrow("BSC_RPC_URL");
  const escrowAddress = loadEnvOrThrow("BSC_ESCROW_ADDRESS");

  if (!isValidAddress(escrowAddress)) {
    throw new EvmOracleError(
      `BSC_ESCROW_ADDRESS is not a valid EVM address: ${escrowAddress}`,
      "INVALID_CONFIG"
    );
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const escrow = new Contract(escrowAddress, ESCROW_ABI, wallet);

  console.log(`[EvmOracle] Oracle wallet: ${wallet.address}`);
  console.log(`[EvmOracle] Escrow contract: ${escrowAddress}`);
  console.log(`[EvmOracle] RPC: ${redactUrl(rpcUrl)}`);
  console.log(`[EvmOracle] Expected chain ID: ${EXPECTED_CHAIN_ID}`);

  async function verifyChainId(): Promise<void> {
    const network = await provider.getNetwork();
    const actual = Number(network.chainId);
    if (actual !== EXPECTED_CHAIN_ID) {
      throw new EvmOracleError(
        `Chain ID mismatch: expected ${EXPECTED_CHAIN_ID}, got ${actual}. Check BSC_RPC_URL.`,
        "CHAIN_MISMATCH"
      );
    }
  }

  let chainVerified = false;
  async function ensureChainVerified(): Promise<void> {
    if (!chainVerified) {
      await verifyChainId();
      chainVerified = true;
    }
  }

  function addGasBuffer(estimatedGas: bigint): bigint {
    return (estimatedGas * BigInt(100 + GAS_BUFFER_PERCENT)) / 100n;
  }

  async function waitForReceipt(
    tx: ContractTransactionResponse
  ): Promise<TransactionReceipt> {
    const receipt = await tx.wait(TX_CONFIRMATION_BLOCKS);
    if (!receipt) {
      throw new EvmOracleError(
        "Transaction receipt is null — tx may have been dropped",
        "RECEIPT_NULL",
        tx.hash
      );
    }
    if (receipt.status === 0) {
      throw new EvmOracleError(
        "Transaction reverted on-chain",
        "TX_REVERTED",
        tx.hash
      );
    }
    return receipt;
  }

  function toMatchIdBytes32(matchId: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(matchId));
  }

  async function submitDeposit(
    matchId: string,
    stake: bigint,
    player1: string,
    player2: string,
    sig1: string,
    sig2: string
  ): Promise<DepositResult> {
    await ensureChainVerified();

    if (!matchId || matchId.length === 0) {
      throw new EvmOracleError("matchId cannot be empty", "INVALID_INPUT");
    }
    if (stake <= 0n) {
      throw new EvmOracleError("stake must be positive", "INVALID_INPUT");
    }
    if (!isValidAddress(player1) || !isValidAddress(player2)) {
      throw new EvmOracleError("player1 and player2 must be valid EVM addresses", "INVALID_INPUT");
    }
    if (player1.toLowerCase() === player2.toLowerCase()) {
      throw new EvmOracleError("player1 and player2 cannot be the same address", "INVALID_INPUT");
    }
    if (!isValidBytes(sig1) || !isValidBytes(sig2)) {
      throw new EvmOracleError("sig1 and sig2 must be valid hex signatures", "INVALID_INPUT");
    }

    const matchIdBytes32 = toMatchIdBytes32(matchId);

    console.log(`[EvmOracle] submitDeposit — match: ${matchId}`);
    console.log(`[EvmOracle]   stake: ${stake.toString()}`);
    console.log(`[EvmOracle]   player1: ${player1}`);
    console.log(`[EvmOracle]   player2: ${player2}`);

    try {
      const estimatedGas = await escrow.depositUSDT.estimateGas(
        matchIdBytes32,
        stake,
        player1,
        player2,
        sig1,
        sig2
      );
      const gasLimit = addGasBuffer(estimatedGas);

      console.log(
        `[EvmOracle] Gas estimate: ${estimatedGas.toString()}, limit: ${gasLimit.toString()}`
      );

      const tx: ContractTransactionResponse = await escrow.depositUSDT(
        matchIdBytes32,
        stake,
        player1,
        player2,
        sig1,
        sig2,
        { gasLimit }
      );

      console.log(`[EvmOracle] Deposit tx sent: ${tx.hash}`);

      const receipt = await waitForReceipt(tx);

      console.log(
        `[EvmOracle] Deposit confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`
      );

      return {
        txHash: tx.hash,
        matchId,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
      };
    } catch (err: any) {
      if (err instanceof EvmOracleError) throw err;

      const reason = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      console.error(`[EvmOracle] submitDeposit failed: ${reason}`);
      throw new EvmOracleError(
        `Deposit failed: ${reason}`,
        "DEPOSIT_FAILED",
        err?.hash
      );
    }
  }

  async function submitDepositNative(
    matchId: string,
    stake: bigint,
    player1: string,
    player2: string,
    sig1: string,
    sig2: string,
    totalValue: bigint
  ): Promise<DepositResult> {
    await ensureChainVerified();

    if (!matchId || matchId.length === 0) {
      throw new EvmOracleError("matchId cannot be empty", "INVALID_INPUT");
    }
    if (stake <= 0n) {
      throw new EvmOracleError("stake must be positive", "INVALID_INPUT");
    }
    if (!isValidAddress(player1) || !isValidAddress(player2)) {
      throw new EvmOracleError("player1 and player2 must be valid EVM addresses", "INVALID_INPUT");
    }
    if (player1.toLowerCase() === player2.toLowerCase()) {
      throw new EvmOracleError("player1 and player2 cannot be the same address", "INVALID_INPUT");
    }
    if (!isValidBytes(sig1) || !isValidBytes(sig2)) {
      throw new EvmOracleError("sig1 and sig2 must be valid hex signatures", "INVALID_INPUT");
    }
    if (totalValue <= 0n) {
      throw new EvmOracleError("totalValue must be positive", "INVALID_INPUT");
    }

    const matchIdBytes32 = toMatchIdBytes32(matchId);

    console.log(`[EvmOracle] submitDepositNative — match: ${matchId}, value: ${totalValue.toString()}`);

    try {
      const estimatedGas = await escrow.depositNative.estimateGas(
        matchIdBytes32,
        stake,
        player1,
        player2,
        sig1,
        sig2,
        { value: totalValue }
      );
      const gasLimit = addGasBuffer(estimatedGas);

      const tx: ContractTransactionResponse = await escrow.depositNative(
        matchIdBytes32,
        stake,
        player1,
        player2,
        sig1,
        sig2,
        { gasLimit, value: totalValue }
      );

      console.log(`[EvmOracle] DepositNative tx sent: ${tx.hash}`);

      const receipt = await waitForReceipt(tx);

      console.log(
        `[EvmOracle] DepositNative confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`
      );

      return {
        txHash: tx.hash,
        matchId,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
      };
    } catch (err: any) {
      if (err instanceof EvmOracleError) throw err;

      const reason = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      console.error(`[EvmOracle] submitDepositNative failed: ${reason}`);
      throw new EvmOracleError(
        `DepositNative failed: ${reason}`,
        "DEPOSIT_NATIVE_FAILED",
        err?.hash
      );
    }
  }

  async function submitSettlement(
    matchId: string,
    winner: string,
    reason: number
  ): Promise<SettleResult> {
    await ensureChainVerified();

    if (!matchId || matchId.length === 0) {
      throw new EvmOracleError("matchId cannot be empty", "INVALID_INPUT");
    }
    if (reason < 0 || reason > 2) {
      throw new EvmOracleError(
        `Invalid settle reason: ${reason}. Must be 0 (Normal), 1 (Draw), or 2 (Disconnect).`,
        "INVALID_REASON"
      );
    }
    if (!isValidAddress(winner) && winner !== ethers.ZeroAddress) {
      throw new EvmOracleError("winner must be a valid EVM address or zero address", "INVALID_INPUT");
    }

    const matchIdBytes32 = toMatchIdBytes32(matchId);

    const reasonLabels: Record<number, string> = {
      0: "Normal",
      1: "Draw",
      2: "Disconnect",
    };

    console.log(`[EvmOracle] submitSettlement — match: ${matchId}`);
    console.log(`[EvmOracle]   winner: ${winner}`);
    console.log(`[EvmOracle]   reason: ${reason} (${reasonLabels[reason] ?? "Unknown"})`);

    try {
      const estimatedGas = await escrow.settleMatch.estimateGas(
        matchIdBytes32,
        winner,
        reason
      );
      const gasLimit = addGasBuffer(estimatedGas);

      console.log(
        `[EvmOracle] Gas estimate: ${estimatedGas.toString()}, limit: ${gasLimit.toString()}`
      );

      const tx: ContractTransactionResponse = await escrow.settleMatch(
        matchIdBytes32,
        winner,
        reason,
        { gasLimit }
      );

      console.log(`[EvmOracle] Settle tx sent: ${tx.hash}`);

      const receipt = await waitForReceipt(tx);

      console.log(
        `[EvmOracle] Settlement confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`
      );

      return {
        txHash: tx.hash,
        matchId,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
      };
    } catch (err: any) {
      if (err instanceof EvmOracleError) throw err;

      const reason_msg = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      console.error(`[EvmOracle] submitSettlement failed: ${reason_msg}`);
      throw new EvmOracleError(
        `Settlement failed: ${reason_msg}`,
        "SETTLE_FAILED",
        err?.hash
      );
    }
  }

  async function updateGasPrice(gasPricePerUnit: bigint): Promise<string> {
    await ensureChainVerified();
    console.log(`[EvmOracle] updateGasPrice: ${gasPricePerUnit.toString()}`);

    try {
      const estimatedGas = await escrow.updateGasPrice.estimateGas(gasPricePerUnit);
      const gasLimit = addGasBuffer(estimatedGas);

      const tx: ContractTransactionResponse = await escrow.updateGasPrice(
        gasPricePerUnit,
        { gasLimit }
      );

      const receipt = await waitForReceipt(tx);
      console.log(`[EvmOracle] Gas price updated, tx: ${tx.hash}`);
      return tx.hash;
    } catch (err: any) {
      const reason = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      console.error(`[EvmOracle] updateGasPrice failed: ${reason}`);
      throw new EvmOracleError(`Gas price update failed: ${reason}`, "GAS_UPDATE_FAILED");
    }
  }

  async function getMatchOnChain(matchId: string) {
    const matchIdBytes32 = toMatchIdBytes32(matchId);
    return escrow.getMatch(matchIdBytes32);
  }

  async function getOracleBalance(): Promise<string> {
    const balance = await provider.getBalance(wallet.address);
    return ethers.formatEther(balance);
  }

  async function getGasReserveEstimate(): Promise<string> {
    const estimate = await escrow.getGasReserveEstimate();
    return estimate.toString();
  }

  return {
    submitDeposit,
    submitDepositNative,
    submitSettlement,
    updateGasPrice,
    getMatchOnChain,
    getOracleBalance,
    getGasReserveEstimate,
    get address() {
      return wallet.address;
    },
    get escrowAddress() {
      return escrowAddress;
    },
  };
}

export type EvmOracle = ReturnType<typeof createEvmOracle>;
