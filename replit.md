# SKILLS2CRYPTO

Mobile-first web app for 1v1 skill games with crypto-only wagers.

## Run & Operate

```bash
npm run dev         # Start development server (port 5000)
npm run build       # Build for production
npm run start       # Start production server
npm run db:push     # Push database schema
npm test            # Run vitest tests
```

**Environment Variables:**
- `VITE_API_BASE`, `PUBLIC_URL`, `VITE_PUBLIC_URL`, `VITE_USE_MOCK_ESCROW`, `VITE_FEE_ADDRESS` (Client)
- `ALLOWED_ORIGINS`, `DATABASE_URL`, `ORACLE_PRIVATE_KEY`, `TON_ORACLE_MNEMONIC`, `TON_PLATFORM_WALLET`, `TON_ESCROW_CONTRACT`, `BSC_RPC_URL`, `BSC_ESCROW_ADDRESS`, `BSC_CHAIN_ID`, `ETH_RPC_URL`, `ETH_ESCROW_ADDRESS`, `ETH_CHAIN_ID`, `SERVER_SESSION_WALLET`, `VITE_REOWN_PROJECT_ID`, `TRON_MIN_GAS_TRX`, `OPS_ALERT_WEBHOOK`, `OPS_KILLSWITCH_TOKEN`, `RECONCILE_ENABLED` (Server)

## Stack

- **Frontend**: React 19, Vite, TailwindCSS, Wouter, Framer Motion
- **Web3**: wagmi v2, viem v2, @wagmi/connectors, TronLink, @tonconnect/ui-react, @ton/ton
- **Backend**: Express, TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **UI Components**: shadcn/ui

## Where things live

- `client/`: React frontend
  - `src/components/`: UI components
  - `src/pages/`: Route pages
  - `src/core/`: Core business logic (wallet, escrow, matchmaking)
  - `src/context/`: React contexts (Game, Language)
  - `src/lib/api.ts`: API URL helpers
  - `src/config/wagmi.ts`: AppKit configuration
  - `src/config/escrow.ts`: Escrow configuration
- `server/`: Express backend
  - `index.ts`: Server entry point, health checks, manifest serving
  - `routes.ts`: API routes
  - `oracle/`: Oracle services (`evmOracle.ts`, `tronOracle.ts`, `tonOracle.ts`)
  - `security/`: Security-related middleware and services
  - `db.ts`: Database connection
- `contracts/`: Smart contracts
  - `evm/Skills2CryptoEscrow.sol`: EVM (BSC + ETH) escrow
  - `tron/Skills2CryptoEscrowTron.sol`: Tron USDT escrow
  - `ton/skills2crypto_escrow.tact`: TON escrow
  - `DEPLOYMENT_GUIDE.md`: Deployment instructions
- `shared/`: Shared types and Zod schemas (`schema.ts`, `walletShape.ts`)
- `attached_assets/`: Static assets
- `netlify.toml`: Netlify client deployment config
- `railway.toml`: Railway server deployment config

## Architecture decisions

- **Escrow V2 Model**: Player-pays-gas for EVM/TON, gasless for Tron USDT (oracle covers gas and recoups via fee accumulator). Oracle only signs outcomes for EVM/TON, players broadcast. Oracle directly submits for Tron.
- **Split Deploy**: Client and server can be deployed independently (e.g., Netlify for client, Railway for server) using `VITE_API_BASE` for routing.
- **Multi-chain Support**: Native asset wagers on BNB (BSC), ETH (Ethereum), USDT (Tron TRC-20), and TON. Each asset is tied to a specific chain.
- **Unified Wallet Experience**: @reown/appkit for EVM chains, separate integrations for TronLink and TonConnect, allowing simultaneous connections.
- **Server-side Game Resolution**: All game outcomes are determined and persisted by the server, which then triggers on-chain settlement via the appropriate oracle.

## Product

- **Games**: Chess, Tetris, Checkers, Battleship with real-time multiplayer sync.
- **Assets**: BNB (BSC), ETH (Ethereum), USDT (Tron TRC-20), TON (The Open Network).
- **Wagers**: Configurable stake presets (5, 20, 50, 100) plus custom amounts.
- **Fees**: 3% platform fee on winning outcomes.
- **Wallet Integration**: Real wallet connections via MetaMask, Trust, Coinbase, WalletConnect, TronLink, Tonkeeper, MyTonWallet.
- **Nickname System**: Wallet-address based nicknames stored locally.
- **Multi-language Support**: 8 languages for the UI.
- **Challenge Friend**: Create and accept challenges for direct matches.
- **Match History**: Persistent match history stored in PostgreSQL.

## User preferences

_Populate as you build_

## Gotchas

- **TronLink `approve(escrow, MAX)`**: Players must perform a one-time approval transaction on Tron, costing ~30 TRX, to enable gasless USDT deposits.
- **Oracle Funding**: While EVM/TON oracles are signer-only, the Tron oracle needs sufficient TRX balance (default 50 TRX) for gasless transactions. Monitor `/api/health/oracles`.
- **MatchAuth Race Condition**: Both players fetch `MatchAuth` for EVM/TON deposits. The first to deposit creates the match on-chain, the second funds it. Client-side polling handles this.
- **Session Keys**: EVM deposits require a signed session key, which expires after 365 days or 10,000 USDT max stake per match (though max stake is higher for native coins).

## Pointers

- **Solidity Contracts**: Refer to `contracts/evm/Skills2CryptoEscrow.sol`, `contracts/tron/Skills2CryptoEscrowTron.sol`, `contracts/ton/skills2crypto_escrow.tact`.
- **Deployment Guide**: `contracts/DEPLOYMENT_GUIDE.md` for detailed contract deployment and operational procedures.
- **Wagmi Docs**: [https://wagmi.sh/react/getting-started](https://wagmi.sh/react/getting-started)
- **TonConnect Docs**: [https://tonconnect.github.io/](https://tonconnect.github.io/)
- **Drizzle ORM Docs**: [https://orm.drizzle.team/](https://orm.drizzle.team/)