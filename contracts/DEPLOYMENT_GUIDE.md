# Skills2Crypto Smart Contracts — Deployment & Testing Guide

## Architecture Overview

### Built-in Gas Oracle (No External Paymaster)

The contract eliminates the need for external paymaster services. Here's how:

1. **Gas Price Feed**: The oracle (your server) calls `updateGasPrice(gasPriceInUsdt)` periodically (e.g., every 5 minutes) with the current gas cost denominated in USDT (for EVM) or TON (for TON network). Your server fetches gas prices from the RPC and token prices from CoinGecko/Binance API, then calculates: `gasPriceInUsdt = currentGasPrice * nativeTokenPriceInUsdt`.

2. **Gas Reserve Calculation**: When a deposit is made, the contract calculates:

   **EVM (USDT-denominated):**
   ```
   gasReserve = estimatedSettlementGas × gasPriceInUsdtPerGasUnit × gasReserveMultiplier / 100
   ```
   - `estimatedSettlementGas`: ~200,000 gas units for the `settleMatch` transaction
   - `gasPriceInUsdtPerGasUnit`: Cost per gas unit in USDT smallest units (e.g., for BSC at 3 Gwei with BNB=$600: `3e9 * 600 / 1e18 * 1e6 ≈ 1` → 0.000001 USDT per gas unit → value = 1)
   - `gasReserveMultiplier`: 150% (1.5x buffer for price fluctuations)
   - Result is in USDT smallest units (6 decimals: 1 USDT = 1,000,000)

   **TON:**
   ```
   gasReserve = gasPriceInTon × gasReserveMultiplier / 100
   ```
   - `gasPriceInTon`: Pre-calculated total gas cost in nanoTON for one settlement tx
   - Server calculates: `gasPriceInTon = estimatedGasFees` from TON RPC
   - Result is in nanoTON (9 decimals: 1 TON = 1,000,000,000)

3. **Deduction from Stake**: Each player's total lock = `stake + gasReserve`. The gasReserve is deducted in USDT/TON from what the player approved, so they never need native gas coins.

4. **After Settlement**: The server pays real gas in native coins (BNB/ETH) from its own hot wallet. The gasReserve (in USDT/TON) reimburses the server. Any unused portion is returned to players.

**Server-side flow:**
```
1. Server hot wallet has BNB/ETH for gas
2. Server calls settleMatch() → pays gas in BNB/ETH
3. Contract sends gasReserve (USDT) to platformWallet → reimburses server
4. Unused gasReserve returned to players
```

---

## Part 1: EVM Deployment (BSC)

### Prerequisites

```bash
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox @openzeppelin/contracts dotenv
```

### Hardhat Configuration

Create `contracts/evm/hardhat.config.js`:
```javascript
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: "0.8.24",
  networks: {
    // BSC Testnet
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY],
    },
    // BSC Mainnet
    bscMainnet: {
      url: "https://bsc-dataseed1.binance.org",
      chainId: 56,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY],
    },
    // Ethereum Sepolia Testnet
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`,
      chainId: 11155111,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY],
    },
    // Ethereum Mainnet
    ethereum: {
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`,
      chainId: 1,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY],
    },
  },
};
```

### Deploy Script

Create `contracts/evm/scripts/deploy.js`:
```javascript
const hre = require("hardhat");

// Platform wallet addresses (Ledger) per network:
//   BSC:      0x7F8Bc18A773f101194071aA559d15d2a59bf6832
//   Ethereum: 0x7F8Bc18A773f101194071aA559d15d2a59bf6832
//   Tron:     TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq

const PLATFORM_WALLETS = {
  bscTestnet:  "0x7F8Bc18A773f101194071aA559d15d2a59bf6832",
  bscMainnet:  "0x7F8Bc18A773f101194071aA559d15d2a59bf6832",
  sepolia:     "0x7F8Bc18A773f101194071aA559d15d2a59bf6832",
  ethereum:    "0x7F8Bc18A773f101194071aA559d15d2a59bf6832",
  // Tron uses a separate TronBox deploy script with address: TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq
};

async function main() {
  const network = hre.network.name;
  const PLATFORM_WALLET = PLATFORM_WALLETS[network];
  if (!PLATFORM_WALLET) throw new Error(`No platform wallet configured for network: ${network}`);

  // BSC Testnet USDT (use a mock or testnet USDT)
  const USDT_ADDRESS = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd"; // BSC Testnet USDT
  const ORACLE_ADDRESS = process.env.ORACLE_WALLET; // Your server's wallet
  const INITIAL_GAS_PRICE_USDT = 1; // Cost per gas unit in USDT smallest units (see guide for calculation)
  const USDT_DECIMALS = 6;

  console.log(`Deploying to ${network} with platform wallet: ${PLATFORM_WALLET}`);

  const Escrow = await hre.ethers.getContractFactory("Skills2CryptoEscrow");
  const escrow = await Escrow.deploy(
    USDT_ADDRESS,
    USDT_DECIMALS,
    PLATFORM_WALLET,
    ORACLE_ADDRESS,
    INITIAL_GAS_PRICE_USDT
  );
  await escrow.waitForDeployment();
  console.log("Skills2CryptoEscrow deployed to:", await escrow.getAddress());
}

main().catch(console.error);
```

### Deploy Commands

```bash
# BSC Testnet (platform wallet: 0x7F8Bc18A773f101194071aA559d15d2a59bf6832)
npx hardhat run scripts/deploy.js --network bscTestnet

# BSC Mainnet (platform wallet: 0x7F8Bc18A773f101194071aA559d15d2a59bf6832)
npx hardhat run scripts/deploy.js --network bscMainnet

# Ethereum Sepolia (platform wallet: 0x7F8Bc18A773f101194071aA559d15d2a59bf6832)
npx hardhat run scripts/deploy.js --network sepolia

# Ethereum Mainnet (platform wallet: 0x7F8Bc18A773f101194071aA559d15d2a59bf6832)
npx hardhat run scripts/deploy.js --network ethereum

# Tron: Use TronBox with platform wallet TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq
```

---

## Part 2: TON Deployment

### Prerequisites

```bash
npm install --save-dev @tact-lang/compiler @ton/core @ton/crypto @ton/ton
```

### Compile

```bash
npx tact --config tact.config.json
```

`tact.config.json`:
```json
{
  "projects": [{
    "name": "Skills2CryptoEscrowTON",
    "path": "./contracts/ton/skills2crypto_escrow.tact",
    "output": "./contracts/ton/output"
  }]
}
```

### Deploy Script (TypeScript)

```typescript
import { toNano, Address } from "@ton/core";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

async function deploy() {
  // TON Testnet
  const client = new TonClient({
    endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
    apiKey: process.env.TONCENTER_API_KEY,
  });

  const mnemonic = process.env.TON_MNEMONIC!.split(" ");
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });

  const oracleAddress = Address.parse(process.env.ORACLE_TON_ADDRESS!);
  const platformWallet = Address.parse("UQA5WizZJ5JCSJDnIonF12X5rbPINxgX6Y6dkpiCZ_-WB7x7"); // Ledger TON wallet
  const gasPriceInTon = toNano("0.01"); // Initial gas price estimate

  // Deploy using compiled contract from tact output
  // The exact deployment code depends on tact compiler output
  console.log("Deploy with oracle:", oracleAddress.toString());
  console.log("Platform wallet:", platformWallet.toString()); // UQA5WizZJ5JCSJDnIonF12X5rbPINxgX6Y6dkpiCZ_-WB7x7
}

deploy().catch(console.error);
```

---

## Testing a Full Match Cycle

### Setup: Two Test Wallets

```
Wallet A (Player 1): Generate via MetaMask or use Hardhat account #0
Wallet B (Player 2): Generate via MetaMask or use Hardhat account #1
Server Wallet (Oracle): Your deployer or a dedicated hot wallet
```

### Test 1: Normal Win

```javascript
// 1. Register session keys for both players
await escrow.registerSessionKey(
  playerA.address,           // player
  serverWallet.address,      // sessionAddr (server signs on behalf)
  ethers.parseUnits("100", 6), // max 100 USDT per match
  Math.floor(Date.now()/1000) + 365*86400, // 365 days
  playerASignature           // EIP-712 signature from player A
);
// Repeat for player B

// 2. Both players approve USDT spending
await usdt.connect(playerA).approve(escrowAddress, ethers.parseUnits("1000", 6));
await usdt.connect(playerB).approve(escrowAddress, ethers.parseUnits("1000", 6));

// 3. Server deposits for match
const matchId = ethers.keccak256(ethers.toUtf8Bytes("match-001"));
await escrow.connect(oracle).depositUSDT(
  matchId,
  ethers.parseUnits("10", 6), // 10 USDT stake
  playerA.address,
  playerB.address,
  sig1, // deposit signature from session key
  sig2
);
// → Emits MatchActive, locks 10 USDT + gasReserve per player

// 4. Settle: Player A wins
await escrow.connect(oracle).settleMatch(matchId, playerA.address, 0); // reason=0 Normal
// → Player A receives 20 USDT - 3% fee = 19.40 USDT
// → Platform receives 0.60 USDT
// → Both players get gasReserve returned
```

### Test 2: Draw

```javascript
const matchId2 = ethers.keccak256(ethers.toUtf8Bytes("match-002"));
// ... deposit same as above ...
await escrow.connect(oracle).settleMatch(matchId2, ethers.ZeroAddress, 1); // reason=1 Draw
// → Each player receives 10 - 0.30 = 9.70 USDT
// → Platform receives 0.60 USDT total
// → Gas reserves returned
```

### Test 3: Disconnect

```javascript
const matchId3 = ethers.keccak256(ethers.toUtf8Bytes("match-003"));
// ... deposit same as above ...
await escrow.connect(oracle).settleMatch(matchId3, ethers.ZeroAddress, 2); // reason=2 Disconnect
// → Each player receives full 10 USDT stake back
// → NO platform fee charged
// → Unused gas reserves returned
// → Gas spent on deposit tx is NOT refundable (already consumed by the network)
```

### TON Testing

Same flow but using TON testnet:
```typescript
// Deposit: Oracle sends message with TON value = (stake + gasReserve) * 2
await contract.send(oracle, { value: toNano("1.2") }, {
  $$type: "Deposit",
  matchId: 1n,
  player1: playerA,
  player2: playerB,
  stake: toNano("0.5"),
});

// Settle: Normal win
await contract.send(oracle, { value: toNano("0.1") }, {
  $$type: "Settle",
  matchId: 1n,
  winner: playerA,
  reason: 0n,
});
```

---

## Testnet → Mainnet Migration Checklist

### EVM (BSC)

| Setting | Testnet | Mainnet |
|---------|---------|---------|
| RPC URL | `https://data-seed-prebsc-1-s1.binance.org:8545` | `https://bsc-dataseed1.binance.org` |
| Chain ID | 97 | 56 |
| USDT Contract | `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` | `0x55d398326f99059fF775485246999027B3197955` |
| Escrow Contract | Deploy new on mainnet | New address after deploy |
| Block Explorer | `https://testnet.bscscan.com` | `https://bscscan.com` |
| Gas Price | ~5 Gwei | ~3-5 Gwei |

### EVM (Ethereum)

| Setting | Testnet (Sepolia) | Mainnet |
|---------|---------|---------|
| RPC URL | `https://sepolia.infura.io/v3/YOUR_KEY` | `https://mainnet.infura.io/v3/YOUR_KEY` |
| Chain ID | 11155111 | 1 |
| USDT Contract | Use mock ERC20 | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| Escrow Contract | Deploy new on mainnet | New address after deploy |

### TON

| Setting | Testnet | Mainnet |
|---------|---------|---------|
| RPC URL | `https://testnet.toncenter.com/api/v2/jsonRPC` | `https://toncenter.com/api/v2/jsonRPC` |
| Explorer | `https://testnet.tonviewer.com` | `https://tonviewer.com` |
| Contract | Deploy new on mainnet | New address after deploy |

### Code Changes for Mainnet

1. **Server `.env`**:
   ```env
   # Change these per network
   BSC_RPC_URL=https://bsc-dataseed1.binance.org
   BSC_CHAIN_ID=56
   BSC_USDT_ADDRESS=0x55d398326f99059fF775485246999027B3197955
   BSC_ESCROW_ADDRESS=<your-mainnet-deployment>
   BSC_PLATFORM_WALLET=0x7F8Bc18A773f101194071aA559d15d2a59bf6832

   ETH_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
   ETH_CHAIN_ID=1
   ETH_PLATFORM_WALLET=0x7F8Bc18A773f101194071aA559d15d2a59bf6832

   TRON_PLATFORM_WALLET=TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq

   TON_RPC_URL=https://toncenter.com/api/v2/jsonRPC
   TON_ESCROW_ADDRESS=<your-mainnet-deployment>
   TON_PLATFORM_WALLET=UQA5WizZJ5JCSJDnIonF12X5rbPINxgX6Y6dkpiCZ_-WB7x7
   ```

2. **Client `vite` env**:
   ```env
   VITE_BSC_ESCROW_ADDRESS=<mainnet-address>
   VITE_ETH_ESCROW_ADDRESS=<mainnet-address>
   VITE_TON_ESCROW_ADDRESS=<mainnet-address>
   ```

3. **Gas price oracle**: Update the server's gas price fetcher to use mainnet gas trackers:
   - BSC: `https://api.bscscan.com/api?module=gastracker&action=gasoracle`
   - ETH: `https://api.etherscan.io/api?module=gastracker&action=gasoracle`

4. **Security before mainnet**:
   - Run a professional audit on both contracts
   - Set `gasReserveMultiplier` to at least 150 (1.5x buffer)
   - Test with small amounts first ($1-5 stakes)
   - Verify all event emissions are being captured by your indexer
   - Ensure oracle hot wallet has sufficient native coin balance for gas

---

## Fee Summary

| Scenario | Platform Fee | Gas Reserve |
|----------|-------------|-------------|
| Normal Win | 3% of total pot | Returned to both players |
| Draw | 3% of total pot (split equally) | Returned to both players |
| Disconnect | 0% (no fee) | Returned to both players |

**Note**: Gas spent on the `deposit` transaction is consumed by the network and cannot be refunded. Only the gasReserve (reserved for the settlement transaction) is returnable.

---

## Tron Deployment Notes

The same Solidity contract works on Tron with these differences:
- Compile with `tronbox` instead of Hardhat
- Platform wallet (Ledger): `TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq`
- USDT TRC-20 address: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- Use `tronWeb` SDK for deployment
- Session key signatures use the same EIP-712 format (TronLink supports it)
- Gas is measured in "energy" and "bandwidth" on Tron — adjust `estimatedSettlementGas` accordingly

---

## Platform Wallet Summary (Ledger Addresses)

| Network | Address |
|---------|---------|
| BSC (BNB Smart Chain) | `0x7F8Bc18A773f101194071aA559d15d2a59bf6832` |
| Ethereum | `0x7F8Bc18A773f101194071aA559d15d2a59bf6832` |
| Tron | `TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq` |
| TON | `UQA5WizZJ5JCSJDnIonF12X5rbPINxgX6Y6dkpiCZ_-WB7x7` |

All platform fees (3% of total pot on normal wins and draws) are sent to these addresses. The EVM address is the same for BSC and Ethereum since your Ledger uses the same address across EVM chains.

---

## Player-Submitted Native Deposit Model (BNB & ETH)

Native (BNB / ETH) matches now use a **player-submitted** deposit flow.
The oracle no longer funds the stake — each player sends their own
`stake + gasReserve` directly to the escrow contract.

### Function

```
depositNativeAsPlayer(
  bytes32 matchId,
  address player1,
  address player2,
  uint256 stake,
  uint256 gasReserve,
  uint256 deadline,
  bytes oracleSig
) external payable
```

- `oracleSig` is an EIP-712 signature over the `MatchAuth` struct, produced
  by the server-side oracle wallet. Both players submit the SAME signature
  along with their own `msg.value == stake + gasReserve`.
- The first caller flips the match to `WaitingForP2`. The second caller
  flips it to `Active`, which emits `MatchActive` (the server listens for
  this event and notifies both players via socket).
- If the second player never shows up, the first depositor can call
  `refundNoShow(matchId)` after `deadline` to reclaim their full deposit.

### Backend endpoints

- `POST /api/oracle/match-auth` → returns `{ player1, player2, stake,
  gasReserve, deadline, oracleSig, chainId, escrowAddress }` for a given
  matchId. Cached in Redis so both players receive identical params.
- `GET /api/oracle/match-status/:matchId` → returns the on-chain match
  status (used by the client to know when both players have deposited).

### Per-chain configuration

Required environment variables:

| Var                   | Purpose                                  |
|-----------------------|------------------------------------------|
| `ORACLE_PRIVATE_KEY`  | Same key signs MatchAuth on both chains  |
| `BSC_RPC_URL`         | BSC RPC endpoint                         |
| `BSC_ESCROW_ADDRESS`  | Escrow contract on BSC                   |
| `BSC_CHAIN_ID`        | Defaults to 56                           |
| `ETH_RPC_URL`         | Ethereum mainnet RPC                     |
| `ETH_ESCROW_ADDRESS`  | Escrow contract on Ethereum mainnet      |
| `ETH_CHAIN_ID`        | Defaults to 1                            |

### Deploy commands

```
# BSC mainnet
npx hardhat run scripts/deploy-bsc.cjs --network bscMainnet

# Ethereum mainnet (manual op — requires funded deployer key)
npx hardhat run scripts/deploy-eth.cjs --network ethMainnet
```

The contract constructor takes a USDT token argument that is unused on
the Ethereum deployment (USDT is only routed through Tron in this
project — see Task #13).
