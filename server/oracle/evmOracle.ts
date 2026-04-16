import {
  ethers,
  JsonRpcProvider,
  Wallet,
  Contract,
  type TransactionReceipt,
  type ContractTransactionResponse,
} from "ethers";

const ESCROW_ABI = [
  "function registerSessionKey(address player, address sessionAddr, uint256 maxStakePerMatch, uint256 expiry, bytes signature)",
  "function depositUSDT(bytes32 matchId, uint256 stake, address player1, address player2, bytes sig1, bytes sig2)",
  "function depositUSDTWithPermit(bytes32 matchId, uint256 stake, address player1, address player2, bytes sig1, bytes sig2, tuple(uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit1, tuple(uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit2)",
  "function depositNative(bytes32 matchId, uint256 stake, address player1, address player2, bytes sig1, bytes sig2) payable",
  "function settleMatch(bytes32 matchId, address winner, uint8 reason)",
  "function updateGasPrice(uint256 _gasPricePerGasUnit)",
  "function getDomainSeparator() view returns (bytes32)",
  "function oracle() view returns (address)",
  "function owner() view returns (address)",
  "function usdtToken() view returns (address)",
  "function platformWallet() view returns (address)",
  "function depositNonces(address player) view returns (uint256)",
  "function getMatch(bytes32 matchId) view returns (tuple(bytes32 matchId, address player1, address player2, uint256 stake, uint8 assetType, uint256 gasReservePerPlayer, uint8 status))",
  "function getGasReserveEstimate() view returns (uint256)",
  "function getDepositNonce(address player) view returns (uint256)",
  "function getSessionKey(address player) view returns (tuple(address player, address sessionAddr, uint256 maxStakePerMatch, uint256 expiry, bool revoked))",
  "function sessionNonces(address player) view returns (uint256)",
  "event SessionKeyRegistered(address indexed player, address indexed sessionAddr, uint256 expiry)",
  "event MatchActive(bytes32 indexed matchId, address player1, address player2, uint256 stake, uint8 assetType, uint256 gasReservePerPlayer)",
  "event MatchSettled(bytes32 indexed matchId, address winner, uint8 reason, uint256 payout, uint256 platformFee)",
];

export interface PermitData {
  deadline: string;
  v: number;
  r: string;
  s: string;
}

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

let _startupDiagRun = false;

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

  if (!_startupDiagRun) {
    _startupDiagRun = true;
    (async () => {
      try {
        const network = await provider.getNetwork();
        console.log(`[EvmOracle] [startup] Connected to chain ${network.chainId}`);
        const balance = await provider.getBalance(wallet.address);
        console.log(`[EvmOracle] [startup] Oracle BNB balance: ${ethers.formatEther(balance)}`);
        if (balance < ethers.parseEther("0.001")) {
          console.warn(`[EvmOracle] [startup] WARNING: Oracle BNB balance too low for gas!`);
        }
        const domainSep = await escrow.getDomainSeparator();
        console.log(`[EvmOracle] [startup] Contract getDomainSeparator() OK: ${domainSep.slice(0, 18)}...`);
        const onChainOracle = await escrow.oracle();
        console.log(`[EvmOracle] [startup] Contract oracle address: ${onChainOracle}`);
        if (onChainOracle.toLowerCase() !== wallet.address.toLowerCase()) {
          console.error(`[EvmOracle] [startup] MISMATCH: Contract oracle is ${onChainOracle}, but our wallet is ${wallet.address}`);
        } else {
          console.log(`[EvmOracle] [startup] Oracle address matches — contract is ready`);
        }
      } catch (err: any) {
        console.error(`[EvmOracle] [startup] Contract validation FAILED: ${err?.message || err}`);
        console.error(`[EvmOracle] [startup] The deployed contract may be outdated. Redeployment may be needed.`);
      }
    })();
  }

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

  const MIN_ORACLE_BNB = ethers.parseEther("0.001");

  async function ensureOracleHasGas(): Promise<void> {
    const balance = await provider.getBalance(wallet.address);
    if (balance < MIN_ORACLE_BNB) {
      const balStr = ethers.formatEther(balance);
      console.error(`[EvmOracle] Oracle BNB balance critically low: ${balStr} BNB. Please send BNB to ${wallet.address}`);
      throw new EvmOracleError(
        `Oracle wallet has insufficient BNB for gas (${balStr} BNB). Please top up ${wallet.address} with at least 0.01 BNB.`,
        "ORACLE_NO_GAS"
      );
    }
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

    await ensureOracleHasGas();

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

  async function submitDepositWithPermit(
    matchId: string,
    stake: bigint,
    player1: string,
    player2: string,
    sig1: string,
    sig2: string,
    permit1: PermitData | null,
    permit2: PermitData | null
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

    const emptyPermit = { deadline: "0", v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash };

    const p1 = permit1 && permit1.deadline !== "0"
      ? { deadline: permit1.deadline, v: permit1.v, r: permit1.r, s: permit1.s }
      : emptyPermit;
    const p2 = permit2 && permit2.deadline !== "0"
      ? { deadline: permit2.deadline, v: permit2.v, r: permit2.r, s: permit2.s }
      : emptyPermit;

    const matchIdBytes32 = toMatchIdBytes32(matchId);

    console.log(`[EvmOracle] submitDepositWithPermit — match: ${matchId}`);
    console.log(`[EvmOracle]   stake: ${stake.toString()}`);
    console.log(`[EvmOracle]   player1: ${player1} (permit: ${p1.deadline !== "0"})`);
    console.log(`[EvmOracle]   player2: ${player2} (permit: ${p2.deadline !== "0"})`);

    await ensureOracleHasGas();

    try {
      const estimatedGas = await escrow.depositUSDTWithPermit.estimateGas(
        matchIdBytes32,
        stake,
        player1,
        player2,
        sig1,
        sig2,
        [p1.deadline, p1.v, p1.r, p1.s],
        [p2.deadline, p2.v, p2.r, p2.s]
      );
      const gasLimit = addGasBuffer(estimatedGas);

      console.log(
        `[EvmOracle] Gas estimate: ${estimatedGas.toString()}, limit: ${gasLimit.toString()}`
      );

      const tx: ContractTransactionResponse = await escrow.depositUSDTWithPermit(
        matchIdBytes32,
        stake,
        player1,
        player2,
        sig1,
        sig2,
        [p1.deadline, p1.v, p1.r, p1.s],
        [p2.deadline, p2.v, p2.r, p2.s],
        { gasLimit }
      );

      console.log(`[EvmOracle] DepositWithPermit tx sent: ${tx.hash}`);
      const receipt = await waitForReceipt(tx);

      console.log(
        `[EvmOracle] DepositWithPermit confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`
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
      console.error(`[EvmOracle] submitDepositWithPermit failed: ${reason}`);
      throw new EvmOracleError(
        `DepositWithPermit failed: ${reason}`,
        "DEPOSIT_PERMIT_FAILED",
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

    await ensureOracleHasGas();

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

    await ensureOracleHasGas();

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

    await ensureOracleHasGas();

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

  async function registerSessionKey(
    player: string,
    sessionAddr: string,
    maxStakePerMatch: bigint,
    expiry: bigint,
    signature: string
  ): Promise<{ txHash: string; blockNumber: number }> {
    await ensureChainVerified();

    if (!isValidAddress(player)) {
      throw new EvmOracleError("player must be a valid EVM address", "INVALID_INPUT");
    }
    if (!isValidAddress(sessionAddr)) {
      throw new EvmOracleError("sessionAddr must be a valid EVM address", "INVALID_INPUT");
    }
    if (maxStakePerMatch <= 0n) {
      throw new EvmOracleError("maxStakePerMatch must be positive", "INVALID_INPUT");
    }
    if (!isValidBytes(signature)) {
      throw new EvmOracleError("signature must be valid hex", "INVALID_INPUT");
    }

    console.log(`[EvmOracle] registerSessionKey — player: ${player}, session: ${sessionAddr}`);

    await ensureOracleHasGas();

    try {
      const estimatedGas = await escrow.registerSessionKey.estimateGas(
        player,
        sessionAddr,
        maxStakePerMatch,
        expiry,
        signature
      );
      const gasLimit = addGasBuffer(estimatedGas);

      const tx: ContractTransactionResponse = await escrow.registerSessionKey(
        player,
        sessionAddr,
        maxStakePerMatch,
        expiry,
        signature,
        { gasLimit }
      );

      console.log(`[EvmOracle] RegisterSession tx sent: ${tx.hash}`);
      const receipt = await waitForReceipt(tx);
      console.log(`[EvmOracle] Session registered in block ${receipt.blockNumber}`);

      return { txHash: tx.hash, blockNumber: receipt.blockNumber };
    } catch (err: any) {
      if (err instanceof EvmOracleError) throw err;
      const reason = err?.reason || err?.shortMessage || err?.message || "Unknown error";
      console.error(`[EvmOracle] registerSessionKey failed: ${reason}`);
      throw new EvmOracleError(`Session registration failed: ${reason}`, "SESSION_REGISTER_FAILED", err?.hash);
    }
  }

  async function signDepositAuthorization(
    matchId: string,
    stake: bigint,
    assetType: number,
    player: string
  ): Promise<string> {
    const nonce = await escrow.getDepositNonce(player);
    const matchIdBytes32 = toMatchIdBytes32(matchId);

    const DEPOSIT_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes("Deposit(bytes32 matchId,uint256 stake,uint8 assetType,uint256 nonce)")
    );

    const domainSeparator = await escrow.getDomainSeparator();

    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "uint256", "uint8", "uint256"],
        [DEPOSIT_TYPEHASH, matchIdBytes32, stake, assetType, nonce]
      )
    );

    const digest = ethers.keccak256(
      ethers.solidityPacked(
        ["string", "bytes32", "bytes32"],
        ["\x19\x01", domainSeparator, structHash]
      )
    );

    const sig = wallet.signingKey.sign(digest);
    return ethers.Signature.from(sig).serialized;
  }

  async function getSessionNonce(player: string): Promise<bigint> {
    if (!isValidAddress(player)) {
      throw new EvmOracleError("player must be a valid EVM address", "INVALID_INPUT");
    }
    return escrow.sessionNonces(player);
  }

  async function getSessionKeyOnChain(player: string) {
    if (!isValidAddress(player)) {
      throw new EvmOracleError("player must be a valid EVM address", "INVALID_INPUT");
    }
    return escrow.getSessionKey(player);
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

  async function getUsdtAllowance(owner: string): Promise<bigint> {
    const USDT_ABI = ["function allowance(address owner, address spender) view returns (uint256)"];
    const usdtAddr = await escrow.usdtToken();
    const usdt = new Contract(usdtAddr, USDT_ABI, provider);
    return usdt.allowance(owner, escrowAddress);
  }

  async function preflightDeposit(
    player1: string,
    player2: string,
    stake: bigint,
    isNative: boolean
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const checks: string[] = [];

    const [sk1, sk2] = await Promise.all([
      escrow.getSessionKey(player1),
      escrow.getSessionKey(player2),
    ]);

    if (sk1.player === ethers.ZeroAddress || sk1.player.toLowerCase() !== player1.toLowerCase()) {
      checks.push(`Player1 (${player1}) has no session key registered`);
    } else {
      if (sk1.revoked) checks.push(`Player1 session key is revoked`);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (BigInt(sk1.expiry) <= now) checks.push(`Player1 session key expired`);
      if (stake > BigInt(sk1.maxStakePerMatch)) {
        checks.push(`Player1 stake ${stake} exceeds session limit ${sk1.maxStakePerMatch}`);
      }
    }

    if (sk2.player === ethers.ZeroAddress || sk2.player.toLowerCase() !== player2.toLowerCase()) {
      checks.push(`Player2 (${player2}) has no session key registered`);
    } else {
      if (sk2.revoked) checks.push(`Player2 session key is revoked`);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (BigInt(sk2.expiry) <= now) checks.push(`Player2 session key expired`);
      if (stake > BigInt(sk2.maxStakePerMatch)) {
        checks.push(`Player2 stake ${stake} exceeds session limit ${sk2.maxStakePerMatch}`);
      }
    }

    if (!isNative) {
      const gasReserve = await escrow.getGasReserveEstimate();
      const totalPerPlayer = stake + BigInt(gasReserve);

      const [allowance1, allowance2] = await Promise.all([
        getUsdtAllowance(player1),
        getUsdtAllowance(player2),
      ]);

      if (allowance1 < totalPerPlayer) {
        checks.push(`Player1 USDT allowance ${allowance1} < required ${totalPerPlayer}`);
      }
      if (allowance2 < totalPerPlayer) {
        checks.push(`Player2 USDT allowance ${allowance2} < required ${totalPerPlayer}`);
      }
    }

    if (checks.length > 0) {
      return { ok: false, reason: checks.join("; ") };
    }
    return { ok: true };
  }

  return {
    registerSessionKey,
    getSessionNonce,
    getSessionKeyOnChain,
    submitDeposit,
    submitDepositWithPermit,
    submitDepositNative,
    submitSettlement,
    updateGasPrice,
    signDepositAuthorization,
    getMatchOnChain,
    getOracleBalance,
    getGasReserveEstimate,
    getUsdtAllowance,
    preflightDeposit,
    get address() {
      return wallet.address;
    },
    get escrowAddress() {
      return escrowAddress;
    },
  };
}

export type EvmOracle = ReturnType<typeof createEvmOracle>;
