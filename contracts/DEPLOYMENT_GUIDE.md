# Skills2Crypto V2 Escrow — Deployment Guide

> **Architecture: V2 (Task #16, MERGED).** Native chains (BSC / Ethereum / TON)
> are **player-pays-gas**: each player deposits their own stake, the oracle only
> signs authorization payloads off-chain, and the **winner** (or either player on
> draw/disconnect) calls `settleMatch` from their own wallet. Tron USDT remains
> **gasless** for players: the oracle pays all TRX, recouping it via a 0.5%
> on-chain SunSwap V2 auto-swap of the gas-fund accumulator.
>
> The historical V1 oracle-broadcast flow described in earlier revisions is
> deprecated and intentionally absent from this document.

## Platform wallets (Ledger)

| Network  | Platform wallet                                            |
|----------|-------------------------------------------------------------|
| BSC      | `0x7F8Bc18A773f101194071aA559d15d2a59bf6832`                |
| Ethereum | `0x7F8Bc18A773f101194071aA559d15d2a59bf6832`                |
| Tron     | `TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq`                        |
| TON      | `UQA5WizZJ5JCSJDnIonF12X5rbPINxgX6Y6dkpiCZ_-WB7x7`          |

## Oracle wallets

| Network  | Oracle address                                             | Source                       |
|----------|-------------------------------------------------------------|------------------------------|
| BSC      | `0x2ad7345E4ad7Fff0Ec5cB41B96e69035f96DFCB8`                | `ORACLE_PRIVATE_KEY`         |
| Ethereum | `0x2ad7345E4ad7Fff0Ec5cB41B96e69035f96DFCB8`                | `ORACLE_PRIVATE_KEY`         |
| Tron     | TronWeb-derived from the same `ORACLE_PRIVATE_KEY`          | `ORACLE_PRIVATE_KEY`         |
| TON      | Ed25519 pubkey derived from `TON_ORACLE_MNEMONIC` (24 words)| `TON_ORACLE_MNEMONIC`        |

---

## Deployment workflow

All four chains use the same operator pattern:

1. Copy `.env.deploy.example` → `.env.deploy` on the operator's machine.
2. Fill in only the keys/mnemonics needed for the chain you are deploying.
3. `set -a && source .env.deploy && set +a` to load it into the current shell.
4. Fund the deployer address printed in step 5 with the per-chain minimum.
5. Run **one** of:
   ```bash
   npm run deploy:bsc      # ≈0.05 BNB
   npm run deploy:eth      # ≈0.05–0.10 ETH
   npm run deploy:tron     # ≈2,500 TRX
   npm run deploy:ton      # ≈3 TON
   ```
6. Record the printed contract address into:
   - the production secrets store as `BSC_ESCROW_ADDRESS` /
     `ETH_ESCROW_ADDRESS` / `TRON_ESCROW_CONTRACT` /
     `TON_ESCROW_CONTRACT`
   - `replit.md` under "V2 Mainnet Addresses"
7. Restart the backend and verify `GET /api/health/oracles` reports OK for
   that chain.
8. Wipe the deployer key from your shell (`unset DEPLOYER_PRIVATE_KEY` etc.)
   and shred `.env.deploy` if you saved it.

**Order:** BSC → ETH → Tron → TON. BSC is cheapest, so any toolchain bug
gets caught before more expensive chains are touched.

### Security guard-rails

- Deploy keys live in `.env.deploy` (never committed) **or** in your shell
  process env. They are never echoed to logs, never persisted to repo files.
- Each EVM deploy script aborts early with a clear error if the deployer
  balance is below the per-chain minimum, so you can't accidentally publish
  half a contract.
- The Tron migration uses `--reset` so a stuck migration cannot silently
  redeploy with a wrong constructor on retry.

---

## Constructors (for reference)

### `Skills2CryptoEscrow` (BSC, Ethereum)

```solidity
constructor(address _platformWallet, address _oracle)
    Ownable(msg.sender)
    EIP712("Skills2CryptoEscrow", "2");
```

The oracle address must match `ORACLE_PRIVATE_KEY` because the contract's
`ECDSA.recover(_hashTypedDataV4(...), oracleSig) == oracle` checks the
sig produced by `signMatchAuth` / `signMatchOutcome` server-side.

### `Skills2CryptoEscrowTron` (Tron)

```solidity
constructor(
    address _usdt,            // TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
    address _platformWallet,  // TEWL…5aqq
    address _oracle,          // TronWeb-derived from ORACLE_PRIVATE_KEY
    address _oracleGasFund,   // TBDdWCw89Z28LG6c9s7vC8bQiACVe57XNy
    address _sunSwapRouter,   // TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax
    address _wtrx,            // TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR
    uint256 _swapThreshold    // 50 USDT in 6-decimals = 50_000_000
);
```

All defaults are baked into `contracts/tron/migrations/2_deploy_escrow.js`;
override only via env vars listed in `.env.deploy.example`.

### `Skills2CryptoEscrowTON` (TON, Tact)

```tact
init(oraclePubkey: Int, platformWallet: Address, depositTimeoutSeconds: Int)
```

`scripts/deploy-ton.mjs` derives `oraclePubkey` from `TON_ORACLE_MNEMONIC`
automatically and reads `platformWallet` + `depositTimeoutSeconds` from
the env vars in `.env.deploy.example`.

---

## Settlement flow (V2)

For all native chains:

1. Server signs `MatchOutcome(matchId, winner, reason)` off-chain via
   `POST /api/escrow/settle-auth`.
2. Client calls `escrow.settleMatch(matchId, winner, reason, oracleSig)`
   (EVM/Tron) or sends a `Settle` message with the Ed25519 sig (TON).
3. Contract verifies the signature and pays out:
   - **Normal:** winner gets `2*stake - 3% fee`.
   - **Draw:** each player gets `stake - 1.5% fee`.
   - **Disconnect:** each player gets full `stake` (no fee).

For Tron USDT, step 2 is performed by the oracle (because the player has no
TRX) and an additional 0.5% is taken into a gas-fund accumulator that
auto-swaps to TRX via SunSwap V2 once it crosses the configured threshold.

---

## Per-chain reference

### BSC

| Setting       | Value                                                         |
|---------------|---------------------------------------------------------------|
| RPC           | `https://bsc-dataseed.binance.org` (override `BSC_RPC_URL`)   |
| Chain ID      | 56                                                            |
| Explorer      | `https://bscscan.com`                                         |
| Min funds     | 0.05 BNB on the deployer                                      |

### Ethereum

| Setting       | Value                                                         |
|---------------|---------------------------------------------------------------|
| RPC           | Set `ETH_RPC_URL` (Alchemy / Infura / your own node)          |
| Chain ID      | 1                                                             |
| Explorer      | `https://etherscan.io`                                        |
| Min funds     | 0.05–0.10 ETH on the deployer (gas-market dependent)          |

### Tron

| Setting       | Value                                                         |
|---------------|---------------------------------------------------------------|
| RPC           | `https://api.trongrid.io` (override via `TRON_RPC_URL`)       |
| Chain ID      | 728126428                                                     |
| Explorer      | `https://tronscan.org`                                        |
| Min funds     | ≈2,500 TRX on the deployer                                    |
| Compiler      | `tronbox compile` (Solidity 0.8.24, runs=200)                 |

### TON

| Setting       | Value                                                         |
|---------------|---------------------------------------------------------------|
| RPC           | `https://toncenter.com/api/v2/jsonRPC` (use `TON_API_KEY`)    |
| Explorer      | `https://tonviewer.com`                                       |
| Min funds     | ≥3 TON on the deployer                                        |
| Compiler      | `@tact-lang/compiler` 1.5.x (Node 20 compatible)              |
