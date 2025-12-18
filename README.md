# SKILLS2CRYPTO

Mobile-first web app prototype for 1v1 skill games with crypto-only wagers.

## Current scope
- Games: Chess, Tetris (Block Stack), Checkers
- Assets: USDT, ETH, TON
- Stake presets: 5 / 20 / 50 / 100 + Custom
- Fee: 3% of total pot (2x stake), winner receives pot - fee
- Non-custodial concept (prototype simulates wallet state)

## Architecture
Refactored into a 3-layer architecture to separate UI from logic and prepare for Web3 integration:

1.  **WalletAdapter** (`src/core/wallet`): Manages wallet connection and balance reading. Currently uses a Mock implementation.
2.  **MatchmakingService** (`src/core/matchmaking`): Handles finding opponents based on game/asset/stake.
3.  **EscrowAdapter** (`src/core/escrow`): The core logic for locking funds, calculating fees, and settling matches.
    *   **MockEscrowAdapter**: In-memory simulation for rapid prototyping.
    *   **EvmEscrowAdapter**: Skeleton for future on-chain integration.

Configuration is central in `src/config/escrow.ts`.

## Run locally
```bash
npm install
npm run dev
```
