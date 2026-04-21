# SKILLS2CRYPTO

Mobile-first 1v1 skill-game platform with crypto wagers on four native assets:
**BNB** (BSC), **ETH** (Ethereum), **USDT** (Tron TRC-20), **TON**.

## Current scope
- Games: Chess, Tetris (Block Stack), Checkers, Battleship
- Stake presets: 5 / 20 / 50 / 100 + Custom
- Fee: 3% of total pot (2× stake), winner receives `pot − platformFee − networkFee`
- V2 escrow:
  - **BSC / ETH / TON** — player pays own gas, settles on-chain
  - **Tron USDT** — fully gasless (oracle pays TRX, auto-recouped via 0.5% gas-fund + on-chain SunSwap V2 swap)

## Architecture
A 3-layer architecture decouples UI from chain logic:

1. **WalletAdapter** (`client/src/core/wallet`) — wallet connect / balance reads (MetaMask, TronLink, TonConnect).
2. **MatchmakingService** (`server/matchmaking`) — Redis-backed find-match queue + challenge links.
3. **EscrowAdapter** (`client/src/core/escrow`) — per-asset adapter (`Evm`, `Tron`, `Ton`, `Mock`) routed by `EscrowRouter`.

Server signs match-auth (deposit) and match-outcome (settle) messages with
`ORACLE_PRIVATE_KEY`; on-chain contracts verify those signatures.

## Run locally (Replit / single host)
```bash
npm install
npm run dev          # Express + Vite middleware on port 5000
```

## Split deployment — Netlify (client) + Railway (server)

The repo is configured to ship the React/Vite client to Netlify and the
Express + Socket.IO API to Railway. CORS, the API base URL, and the
TonConnect manifest are all configurable via env.

### 1. Backend → Railway
- Connect this repo to a new Railway service.
- `railway.toml` already declares the build, start, and `/healthz` probe.
- Set the env vars listed in `server/.env.example` (DB, Redis, oracle key,
  RPCs, escrow addresses). At minimum:
  - `NODE_ENV=production`
  - `ALLOWED_ORIGINS=https://<your-netlify-site>.netlify.app`
  - `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
  - `ORACLE_PRIVATE_KEY`
- Deploy. Note the public URL — e.g. `https://skills2crypto.up.railway.app`.

### 2. Frontend → Netlify
- Connect this repo to a new Netlify site.
- `netlify.toml` already declares `npm run build:client`, `client/dist`
  publish dir, and the SPA fallback.
- Set the env vars listed in `client/.env.example`:
  - `VITE_API_BASE=https://skills2crypto.up.railway.app`
  - `PUBLIC_URL=https://<your-netlify-site>.netlify.app`
  - `VITE_PUBLIC_URL=https://<your-netlify-site>.netlify.app`
  - `VITE_USE_MOCK_ESCROW=false`
  - `VITE_FEE_ADDRESS=0xYourPlatformColdWallet`
- Deploy. The build script post-processes
  `tonconnect-manifest.json`, replacing the `__PUBLIC_URL__` token with
  `PUBLIC_URL` so TonKeeper accepts the manifest.

### 3. Database migrations (production)
Drizzle pushes schema changes directly — no SQL migration files. Run from a
machine with the production `DATABASE_URL` exported (e.g. `railway run`):
```bash
DATABASE_URL=postgres://...prod... npm run db:push
# If Drizzle complains about destructive operations on existing data:
DATABASE_URL=postgres://...prod... npm run db:push -- --force
```
Re-run after every `shared/schema.ts` change before redeploying the server.

### 4. After both are live — 4-asset smoke test
General checks:
- `https://<railway>/healthz` returns `{ "status": "ok" }`.
- `https://<railway>/api/health/oracles` shows BSC / ETH / Tron / TON oracle
  wallets present (and TRX balance ≥ `TRON_MIN_GAS_TRX`).
- Netlify site loads, opens a websocket to Railway, and the lobby renders.

Then run a real 5-stake (or smallest-allowed) match on each asset:

| Asset      | Wallet          | Verify                                                            |
| ---------- | --------------- | ----------------------------------------------------------------- |
| **BNB**    | MetaMask (BSC)  | `depositNative` tx confirms; winner clicks settle, BNB lands; BscScan shows `MatchActive` + `MatchSettled`. |
| **ETH**    | MetaMask (ETH)  | Same as BNB but on Etherscan.                                     |
| **USDT**   | TronLink        | One-time `approve(escrow,MAX)` succeeds (~30 TRX); both deposits go through gaslessly; settle is gasless; Tronscan shows two `Deposit` and one `Settle` event. |
| **TON**    | TonKeeper       | TonConnect prompts manifest from `VITE_PUBLIC_URL`; both `Deposit` BOCs land; winner sends `Settle` BOC (~0.05 TON gas); TonViewer shows the settle tx. |

Also confirm: cancel-before-funded shows the right toast (self vs opponent),
match history populates from `/api/history/...`, and `/api/health/oracles`
TRX balance does **not** drop below `TRON_MIN_GAS_TRX` after the USDT match
(the 0.5% gas-fund + SunSwap auto-swap should recoup it).

### Build script reference
| Script              | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Local Replit dev (Express + Vite middleware)           |
| `npm run build`     | Combined build (client → `dist/public`, server → `dist/index.cjs`) |
| `npm run build:client` | Client-only build for Netlify (`client/dist`)       |
| `npm run build:server` | Server-only esbuild bundle for Railway              |
| `npm start`         | Run the bundled server (Replit / Railway alike)        |
| `npm run check`     | `tsc --noEmit`                                         |
