# Skills2Crypto TON Escrow

Two Tact contracts live here:

- `skills2crypto_escrow.tact` — original draft using the EVM-style session-key
  pattern (oracle pools both stakes off-chain then submits a single `Deposit`
  message). Kept for reference / future jetton support.
- `skills2crypto_escrow_simple.tact` — **what the oracle actually deploys**.
  Players deposit their own TON directly via TonConnect after the oracle
  prepares the match on-chain. No session keys needed for native TON.

## Message flow (`skills2crypto_escrow_simple.tact`)

1. Oracle calls `PrepareMatch { matchId, p1, p2, stake }` once a match is made
   (server-side, paid in oracle TON).
2. Each player sends `PlayerDeposit { matchId }` with `stake + gasReserve` TON
   attached. TonConnect prompts the player's wallet (Tonkeeper, MyTonWallet…)
   to confirm the transfer.
3. Once both players have funded, `status` flips to `ACTIVE` automatically.
4. After gameplay completes, oracle calls `Settle { matchId, winner, reason }`
   to distribute the pot:
   - `reason = 0` (win) → winner gets `pot - 3% fee`, platform wallet gets fee.
   - `reason = 1` (draw) → both refunded `stake - 1.5% fee`.
   - `reason = 2` (disconnect) → both fully refunded.
5. Edge case: oracle can `CancelMatch` if only one player ever funded; the
   payer gets a full refund.

The contract holds the gas reserve so settlement can always be paid out by the
oracle without out-of-gas; any leftover gas on the recipient side is returned.

## Compiling

```bash
npm install -D @tact-lang/compiler
npx tact --config tact.config.json
```

Minimal `tact.config.json`:

```json
{
  "projects": [
    {
      "name": "skills2crypto_escrow_simple",
      "path": "./skills2crypto_escrow_simple.tact",
      "output": "./build",
      "options": { "debug": false }
    }
  ]
}
```

The Tact compiler emits TVM bytecode + a TypeScript wrapper under `./build/`.
The wrapper exposes `Skills2CryptoEscrowTON.fromInit(oracle, platformWallet,
gasReservePerPlayer)` for deployment.

## Deploying to TON mainnet

Use `@ton/blueprint` or a small ad-hoc script:

```ts
import { TonClient, WalletContractV4, internal } from "@ton/ton";
import { mnemonicToWalletKey } from "@ton/crypto";
import { toNano } from "@ton/core";
import { Skills2CryptoEscrowTON } from "./build/Skills2CryptoEscrowTON";

const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY,
});

const key = await mnemonicToWalletKey(process.env.TON_DEPLOYER_MNEMONIC!.split(" "));
const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });

const escrow = await Skills2CryptoEscrowTON.fromInit(
  Address.parse(process.env.TON_ORACLE_ADDRESS!),
  Address.parse(process.env.TON_PLATFORM_WALLET!),
  toNano("0.1")  // gas reserve per player (≈ $0.20 at $2/TON)
);

const seqno = await wallet.openClient(client).getSeqno();
await wallet.openClient(client).sendTransfer({
  seqno,
  secretKey: key.secretKey,
  messages: [internal({
    to: escrow.address,
    value: toNano("0.5"),
    init: escrow.init,
    body: beginCell().endCell(),
  })],
});

console.log("Escrow deployed at:", escrow.address.toString());
```

After deployment, set `TON_ESCROW_CONTRACT` to the printed address (bounceable
form, e.g. `EQA…`).

## Oracle wallet

The server's `tonOracle.ts` derives its wallet from `TON_ORACLE_MNEMONIC`
(a 24-word phrase). It uses `WalletContractV4` and Ed25519 signatures (TON's
native curve) — **not** the EVM secp256k1 key.

Generate a new oracle wallet with `@ton/crypto`:

```ts
import { mnemonicNew, mnemonicToWalletKey } from "@ton/crypto";
const phrase = await mnemonicNew(24);
console.log(phrase.join(" "));
```

Fund the resulting wallet with ~10 TON (covers ~5,000 settlement calls at
~0.05 TON/tx). The oracle must always retain enough TON to pay for
`PrepareMatch` and `Settle` — the per-match gas reserve baked into the
contract reimburses the oracle implicitly via the gas-return code paths.
