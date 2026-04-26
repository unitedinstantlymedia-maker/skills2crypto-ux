# SKILLS2CRYPTO

Mobile-first web app for 1v1 skill games with crypto-only wagers.

## Overview

React + Express platform for 1v1 skill games (Chess, Tetris, Checkers,
Battleship) with native-asset wagers on four chains.

## ⚠️ Current Architecture: Escrow V2 (Task #16) — supersedes everything below

The escrow stack was rewritten end-to-end in Task #16. Anything in the
"Historical notes / legacy designs" sections further down (session keys,
oracle-submitted EVM settles, USDT permits, sponsored TRX, on-chain `Match`
preparation on TON, etc.) is **no longer in effect** — they are kept only for
context on how we got here. The authoritative current model is:

### Per-chain settle model
- **BNB (BSC) + ETH**: player-pays-gas. Each player calls
  `depositNative{value: stake}` themselves. After the game ends, the
  oracle EIP-712 signs a `MatchOutcome(matchId, winner, reason)` and the
  winner (or either player on Draw / Disconnect) calls `settleMatch` and
  pays their own gas. The oracle never broadcasts on EVM.
- **TON**: same model as EVM but with Tact + Ed25519 signatures. Players
  send a `Deposit` message; on game end the oracle signs a `Settle` BOC
  and the winner sends it via TonConnect, paying ~0.05 TON in gas.
- **Tron USDT**: fully gasless for players after a one-time
  `approve(escrow, MAX)` (player pays the ~30 TRX for that single approve).
  Oracle submits both `depositUSDTGasless` and `settleMatch` on Tron and
  recoups its TRX via a 0.5 % USDT gas-fund accumulator inside the escrow,
  which auto-swaps USDT → TRX on SunSwap V2 once it crosses 50 USDT.

### Files (V2)
- `contracts/evm/Skills2CryptoEscrow.sol` — V2 EVM escrow (BSC + ETH).
- `contracts/tron/Skills2CryptoEscrowTron.sol` — V2 Tron USDT escrow.
- `contracts/ton/skills2crypto_escrow.tact` — V2 TON escrow (canonical
  filename; old session-key draft has been removed).
- `server/oracle/evmOracle.ts` — `signMatchAuth` (deposit) +
  `signMatchOutcome` (settle); no on-chain submit.
- `server/oracle/tronOracle.ts` — `submitDepositUSDTGasless`,
  `submitSettlement`, `estimateApproveTrxCost` (live energy estimate via
  `triggerConstantContract`).
- `server/oracle/tonOracle.ts` — `signMatchOutcome` (Ed25519); no
  on-chain submit. Deposit / Settle / RefundNoShow message bodies are
  built using the auto-generated Tact wrapper at
  `contracts/ton/build/Skills2CryptoEscrowTON_Skills2CryptoEscrowTON.ts`
  so opcodes (Deposit `0xCD32A0F9`, Settle `0xDDC91D5F`, RefundNoShow
  `0x58DDC04B`) and the `Settle.signature: ^slice` ref-cell layout stay
  in sync with the deployed contract. The previous hand-rolled
  `crc32(name)` opcode derivation in `server/oracle/tonCrc32.ts` was
  wrong (Tact uses SHA-256 of the TLB type signature, not crc32 of the
  name) and caused every on-chain Deposit / Settle to bounce; that file
  is gone.
- `server/socket.ts → settleMatchOnChain` — for EVM/TON: signs and
  persists `settle_auth:${matchId}` in Redis, emits `settle-ready` to
  the match room. For Tron: calls `submitSettlement` directly.
- `server/routes.ts`:
  - `GET|POST /api/escrow/settle-auth[/:matchId]` — idempotent oracle
    auth lookup; client adapters poll this with retry.
  - `GET /api/tron/readiness` — returns live `approveTrxCostEstimate`,
    `approveEnergyEstimate`, `approveReady` (gated on
    `allowance ≥ 2^255`, i.e. the player did `approve(MAX)`).
- `client/src/core/escrow/EvmEscrowAdapter.ts`,
  `TonEscrowAdapter.ts`, `TronEscrowAdapter.ts` — `claimSettlement`
  with up to 10 × 3 s retry polling on the settle-auth race.

### Funding required for mainnet deploys
- ETH oracle: small balance for safety (signer-only)
- TON deployer: ~3 TON
- Tron deployer: ~300 TRX
- Tron escrow bootstrap: 50–100 USDT seeded so first gasless settles
  have TRX before SunSwap auto-swap kicks in

### Removed in V2 (do not look for these)
- `POST /api/tron/sponsor-trx`, `POST /api/tron/sponsor-challenge` →
  HTTP 410 stubs
- `POST /api/session/nonce`, `POST /api/session/register` → HTTP 410
- `POST /api/oracle/submit-deposit` (oracle-submitted EVM deposits)
- TON `PrepareMatch` on-chain step
- USDT permit / sessionKey flows on EVM
- `sponsorPlayerTrx` on Tron oracle

## Task #15 — Split deploy readiness (Netlify client + Railway server)

The repo can be deployed in two layouts:

1. **Single-host (Replit / `npm run build` + `npm start`)** — Express serves
   both API and the built client from `dist/public`. Unchanged behavior.
2. **Split deploy** — client → Netlify, server → Railway. Configured by:
   - **`client/src/lib/api.ts`** — exports `apiUrl(path)` + `socketUrl()`
     helpers. All `fetch("/api/...")` and `io(...)` calls in the client
     route through these so a single `VITE_API_BASE` env var redirects
     every request at build time.
   - **`netlify.toml`** — `npm run build:client` → `client/dist`, with SPA
     fallback. Required env: `VITE_API_BASE`, `PUBLIC_URL`,
     `VITE_PUBLIC_URL`, `VITE_USE_MOCK_ESCROW=false`, `VITE_FEE_ADDRESS`.
   - **`railway.toml`** — `npm run build:server` → `dist/index.cjs`, with
     `/healthz` probe. Required env: `ALLOWED_ORIGINS`, `DATABASE_URL`,
     Upstash creds, `ORACLE_PRIVATE_KEY`, plus per-chain RPC + escrow
     addresses.
   - **`script/build-client.ts`** / **`script/build-server.ts`** — split
     equivalents of the combined `script/build.ts`. The client build
     writes `client/dist/tonconnect-manifest.json` directly from the
     `PUBLIC_URL` env var (no static template file is checked in).
   - **`server/index.ts`** — `GET /healthz` returns `{status:"ok"}`.
     Also serves `GET /tonconnect-manifest.json` dynamically from the
     request's `X-Forwarded-Proto` / `X-Forwarded-Host` headers, so
     monolith deploys (Replit / Railway) need no `PUBLIC_URL` env var.
   - **`client/src/core/wallet/useTonConnect.ts`** — TonConnect
     `manifestUrl` honors `VITE_PUBLIC_URL`, falling back to
     `window.location.origin` for local dev.
   - **`client/src/config/escrow.ts`** — `FEE_ADDRESS` placeholder
     (`0xPLATFORM_COLD_WALLET_123`) replaced with the zero address so
     real on-chain use without a configured `VITE_FEE_ADDRESS` fails
     visibly instead of silently misrouting funds.
   - Top-level **`.gitignore`**, **`client/.env.example`**, expanded
     **`server/.env.example`** added.
   - **`README.md`** has the full Netlify + Railway runbook.

## Project Structure

- `client/` - React frontend with Vite
  - `src/components/` - UI components (shadcn/ui based)
  - `src/pages/` - Route pages
  - `src/core/` - Core business logic (wallet, escrow, matchmaking)
  - `src/context/` - React contexts (Game, Language)
- `server/` - Express backend
  - `index.ts` - Server entry point
  - `routes.ts` - API routes
- `shared/` - Shared types and schema
- `attached_assets/` - Images and assets

## Tech Stack

- **Frontend**: React 19, Vite, TailwindCSS, Wouter (routing), Framer Motion
- **Web3**: wagmi v2, viem v2, @wagmi/connectors (EVM), TronLink (Tron TRC-20), @tonconnect/ui-react + @ton/ton (TON)
- **Backend**: Express, TypeScript
- **Database**: PostgreSQL with Drizzle ORM (in-memory storage for prototype)
- **UI Components**: shadcn/ui (Radix UI based)

## Development

```bash
npm run dev         # Start development server (port 5000)
npm run build       # Build for production
npm run start       # Start production server
npm run db:push     # Push database schema
```

## Key Features

- Games: Chess, Tetris (Block Stack), Checkers, Battleship
- Assets: BNB (BSC native), ETH (Ethereum mainnet native), USDT (Tron TRC-20 only), TON (The Open Network). Each asset lives on exactly one chain — no cross-chain matching, no BSC USDT.
- Stake presets: 5 / 20 / 50 / 100 + Custom
- Fee: 3% of total pot
- Real wallet connections via @reown/appkit (EVM — MetaMask, Trust, Coinbase, WalletConnect)
- Nickname system (localStorage-based, per wallet address)
- Multi-language support (8 languages)

## Architecture

1. **WalletAdapter** (`src/core/wallet`): Manages wallet connection and balance reading
2. **MatchmakingService** (`src/core/matchmaking`): Handles finding opponents
3. **EscrowAdapter** (`src/core/escrow`): Core logic for locking funds, fees, and settlements

## Recent Fixes (Dec 24, 2025)

### Phase 1: Critical Bug Fixes ✅
1. **Build System Fixed**
   - Added missing client dependencies: socket.io-client, chess.js, react-chessboard, nanoid
   - Fixed script/build.ts to properly build from client directory
   - Added optimizeDeps to vite.config.ts for socket.io-client

2. **React Hook Error in ChessGame Fixed**
   - Removed external canvas library causing hook conflicts
   - Rewrote ChessGame.tsx with clean HTML/CSS grid (8x8 chessboard)
   - All React hooks now called at component top level
   - Game simulates 3-move gameplay with random outcome

3. **State Update Warning in Lobby Fixed**
   - Moved redirect logic from render phase to useEffect hook
   - Prevents "Cannot update component (Route) while rendering (Lobby)" warning
   - Proper dependency array management

### Current Status
- ✅ Server running on port 5000
- ✅ Socket.IO connected with reconnection logic
- ✅ All critical React errors resolved
- ✅ Build process working correctly for client/server
- ✅ Chess multiplayer fully implemented with Socket.IO sync
- ✅ Tetris multiplayer fully implemented with Socket.IO sync
- ✅ Checkers multiplayer fully implemented with Socket.IO sync
- ✅ Battleship multiplayer fully implemented with Socket.IO sync

### Chess Multiplayer (Dec 29, 2025)
1. **Socket.IO Events** - Server handles join-match, color-assigned, game-start, chess-move, opponent-move, chess-resign, chess-timeout
2. **Color Assignment** - First player = white, second = black, colors persist on reconnection
3. **Security** - Socket authorization validates all chess events before broadcasting
4. **Game End** - Automatic detection of checkmate, stalemate, timeout, resignation
5. **Timer Sync** - 30-minute timers per player synchronized via socket events
6. **Demo Mode Removed** - Games require real matchmaking between two players

### Tetris Multiplayer (Dec 29, 2025)
1. **Game Engine** - Standard pieces (I,O,T,S,Z,J,L), SRS rotation, wall kicks, line clearing
2. **Scoring System** - 100/300/500/800 points for 1-4 lines, multiplied by level
3. **Speed Increase** - Starts at 1000ms, decreases 80ms per level (min 100ms)
4. **Controls** - Keyboard: arrows move, space/up rotate, shift hard drop. Mobile: on-screen buttons
5. **Multiplayer Sync** - Real-time opponent board preview, score sync every 500ms
6. **Win Condition** - First player to fill board loses, opponent wins automatically
7. **Modern UI** - Ghost piece, next piece preview, clean minimal design (no retro)

### Checkers Multiplayer (Dec 29, 2025)
1. **Game Engine** - Official checkers rules with mandatory captures and multi-jump
2. **Board Setup** - Standard 8x8 board with 12 pieces per player (red/black)
3. **Piece Movement** - Diagonal moves, kings move both directions after promotion
4. **Mandatory Captures** - Must capture when possible, multi-jump required when available
5. **Multi-Jump Sync** - Each hop sends turnEnded=false, final hop sends turnEnded=true to switch turn
6. **Timer System** - 10-minute timers per player, only runs on active player's turn
7. **Win Conditions** - Capture all opponent pieces or block all legal moves
8. **Socket.IO Events** - join-checkers-match, checkers-color-assigned, checkers-game-start, checkers-move, opponent-checkers-move, checkers-timeout
9. **Color Assignment** - First player = red, second = black, colors persist on reconnection

### Battleship Multiplayer (Dec 29, 2025)
1. **Game Engine** - 10x10 grid, 5 ships (Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Destroyer 2)
2. **Two-Phase Gameplay** - Setup phase (place ships) → Battle phase (turn-based attacks)
3. **Dual Grids** - "Your Fleet" shows your ships and enemy hits, "Enemy Waters" shows your attack results
4. **Ship Placement** - Click to select ship, click grid to place, toggle horizontal/vertical orientation
5. **Server Validation** - All placements validated server-side (bounds, overlap, ship count)
6. **Attack History** - Server tracks all attacks to prevent duplicate hits (anti-cheat)
7. **Timer System** - 60-second timer per turn, auto-skip on timeout
8. **Win Condition** - Sink all 5 opponent ships to win
9. **Sunk Notifications** - Clear feedback when ships are sunk
10. **Socket.IO Events** - join-battleship-match, battleship-role-assigned, battleship-ready, battle-phase-start, battleship-attack, attack-result, opponent-attack, turn-skipped

### Automatic Result Submission (Dec 29, 2025)
1. **Server as Single Source of Truth** - All game results are determined and emitted by the server
2. **No Manual Confirmation** - Removed Victory/Draw/Defeat buttons from GameShell.tsx
3. **onFinishCalledRef Guard** - Prevents double-finish race conditions, separate from gameEndedRef
4. **game-result Event** - Server emits to ALL players via io.to() broadcast, clients ONLY call onFinish from this event
5. **Local Handlers** - handleTimeout, handleResign, handleStateChange update UI and emit to server but never call onFinish directly
6. **storeGameResult** - Server stores match results with matchId, gameType, winnerId, loserId, reason
7. **Disconnect Handling** - 30-second grace period with playerToSocket tracking, cancels forfeit if player reconnects

### Testing & Polish (Dec 29, 2025)
1. **Game Result Flow** - finishMatch calls settleMatch → wallet credits via subscription pattern → history entry created → match status updated
2. **Wallet Updates** - WalletStore uses subscriber pattern, GameContext subscribes to auto-update React state on balance changes
3. **Disconnect Handling** - All games have reconnection: true, opponent-disconnected events show forfeit message
4. **Multiple Game Prevention** - Lobby redirects to /play if currentMatch is active
5. **Loading States** - WaitingRoom with player count, Loader2 icons, isFinding state in Lobby
6. **Error Messages** - Toast notifications for validation errors, ErrorBoundary for game crashes
7. **Game Rules** - Added tabbed rules section to Rules.tsx covering Chess, Tetris, Checkers, Battleship
8. **Mobile Responsive** - Layout has pb-40 padding for bottom nav, mobile-first container design

### Cleanup (Dec 29, 2025)
1. **Removed client-side MatchmakingService** - Deleted orphaned `client/src/core/matchmaking/` directory
2. **Server-side matchmaking only** - All matchmaking handled by `server/matchmaking/redisMatchmaking.ts` via Socket.IO

### PostgreSQL Match History (Dec 30, 2025)
1. **Database Schema** - Added `matches` table with columns: matchId, gameType, player1Id, player2Id, winnerId, loserId, stake, asset, pot, fee, payout, reason, timestamp
2. **Database Connection** - `server/db.ts` uses drizzle-orm/node-postgres with pg.Pool for stable queries
3. **Server Persistence** - `storeGameResult` in socket.ts saves match results to PostgreSQL, fetching match metadata (stake, asset, players) from Redis
4. **History API** - GET `/api/history/:playerId` returns match history filtered by player participation
5. **Client HistoryStore** - Fetches history from server API instead of localStorage, includes 30s cache TTL
6. **Draw Support** - Both player IDs stored for all matches, draw results show correct payout (stake - fee/2)

### Challenge Friend Feature (Dec 30, 2025)
1. **ChallengeStatus Enum** - `pending | accepted | expired | cancelled | completed` with Zod validation in shared/schema.ts
2. **ChallengeData Type** - Includes challengeId, game, asset, stake, challengerId/Name, accepterId/Name, socketId, expiresAt, completedAt
3. **POST /api/create-challenge** - Creates challenge with expiresAt timestamp, stores challengerSocketId, tracks in user:challenges set
4. **GET /api/challenge/:challengeId** - Retrieves full challenge data including status and expiration
5. **POST /api/accept-challenge** - Validates, updates status to accepted, stores accepterName, notifies both players via Socket.IO
6. **POST /api/cancel-challenge** - Validates ownership, updates status to cancelled, emits challenge-cancelled event
7. **GET /api/challenges/:userId** - Returns all challenges for a user, with optional status filter query param
8. **Challenge History Tracking** - Redis list `challenge:{id}:history` stores all status changes with timestamp and action
9. **Background Cleanup Job** - `server/matchmaking/challengeCleanup.ts` runs every 5 minutes, marks expired challenges, emits challenge-expired events
10. **Socket.IO Events** - challenge-match-created, challenge-accepted, challenge-expired, challenge-cancelled
11. **Redis Storage** - challenge:{id} (JSON), challenge:{id}:history (list), user:{id}:challenges (set), match:{id} (hash)
12. **Expiration** - Challenges expire after 1 hour (3600s TTL), expired challenges kept 24 hours for history

### Real Wallet Integration (Apr 13, 2026)
1. **@reown/appkit v1.8.19** - Universal wallet modal (MetaMask, Trust Wallet, Coinbase, WalletConnect QR, Rainbow) for ETH + BNB (USDT has since been moved off EVM entirely — see "BSC USDT Removed" below)
2. **wagmi v2 + viem v2** - EVM wallet connections via WagmiAdapter from @reown/appkit-adapter-wagmi
3. ~~**USDT on BSC**~~ — SUPERSEDED: BSC USDT (BEP-20) balance read was removed in the "BSC USDT Removed" pass. USDT is now Tron TRC-20 only.
4. **WalletProvider** - `client/src/core/wallet/WalletProvider.tsx` wraps app with WagmiProvider + QueryClientProvider, manages EVM state sync
5. **appKit config** - `client/src/config/wagmi.ts` with WagmiAdapter, dark theme, green accent, featured wallets
6. **WalletStore updated** - `syncRealWallet()` method syncs real wallet data, `setNickname()`, escrow protection, separate real/game balances
7. **Network labels** - Wallet page shows USDT=Tron (TRC-20), ETH=Ethereum, BNB=BNB Smart Chain (updated in the BSC USDT Removed pass)
8. **Nickname system** - `NicknameDialog` component, localStorage by wallet address, auto-prompt on first connect
9. **Vite config** - `resolve.dedupe` for react/react-dom/react-jsx-runtime/valtio/@tanstack/react-query; `optimizeDeps.include` for all @reown + wagmi + viem packages
10. **Translations** - 11 keys across all 8 languages (Disconnect, Copied, Choose Nickname, Manage, etc.)
11. **App.tsx** - QueryClientProvider removed from top-level (now inside WalletProvider using shared queryClient from lib/queryClient.ts)
12. **Env var** - `VITE_REOWN_PROJECT_ID` required for appkit modal
13. **Removed** - TronLink/TronWallet/TronConnectDialog/ConnectWalletDialog all deleted; no Tron dependency

### Network Switching (Apr 13, 2026)
1. **Chain detection** - `useAppKitNetwork` tracks current wallet chain; exposed as `currentChainId`/`currentChainName` in WalletProvider context
2. **REQUIRED_CHAIN map** - Exported from WalletProvider: BNB→BSC (56), ETH→Ethereum (1). USDT routes through TronLink (not EVM) and TON through TonConnect (see BSC USDT Removed).
3. **isCorrectChainForAsset(asset)** - Context helper returns boolean; compares current chain to asset requirement; USDT returns true if Tron is connected
4. **switchToChain(chainId)** - Calls `switchNetwork()` from @reown/appkit to prompt wallet chain switch
5. **Lobby network guard** - `handleStartSearch` blocks match start with toast if on wrong chain; amber banner shows "Switch to BSC/Ethereum" button
6. **Wallet page** - Shows current network name under address; per-asset amber banner with one-click switch button when on wrong chain
7. **Translations** - Network keys (Network, Switch to, to play with, Currently on, Switching..., Please switch to, Wrong Network) in all 7 locales
8. ~~**USDT on Ethereum**~~ — SUPERSEDED: USDT is Tron TRC-20 only; no ERC-20 or BEP-20 reads remain.

### TronLink / USDT TRC-20 (Apr 13, 2026)
1. **TronLink detection** - `useTronLink` hook (`client/src/core/wallet/useTronLink.ts`) auto-detects TronLink browser extension via `window.tronWeb`/`window.tronLink`
2. **TronLink NOT inside AppKit** - Tron is not an EVM chain; @reown/appkit has no Tron adapter. TronLink connection is handled separately alongside AppKit
3. **USDT TRC-20 balance** - Reads from contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (6 decimals) using `window.tronWeb.contract().at()` + `balanceOf()`
4. **Auto-reconnect** - If user previously connected TronLink (`localStorage tronlink_connected`), auto-reconnects on page load
5. **Balance polling** - USDT TRC-20 balance refreshes every 30 seconds when connected
6. **Account change events** - Listens for `window.message` events from TronLink (`setAccount`, `setNode`) for live account/network updates
7. **Total USDT** - Wallet page shows USDT = Tron (TRC-20) only (BSC BEP-20 and ETH ERC-20 paths removed; see BSC USDT Removed)
8. **Wallet page** - Red-themed TronLink card with address, copy, disconnect; "Connect TronLink" button appears only when extension is detected
9. **Context values** - WalletProvider exposes: `isTronLinkInstalled`, `isTronConnected`, `tronAddress`, `usdtTrc20Balance`, `isTronConnecting`, `connectTronLink`, `disconnectTronLink` (BSC/ETH USDT balance fields were removed)
10. **Network guard** - USDT is considered "correct chain" only if TronLink is connected (BSC USDT path removed)
11. **Translations** - 3 new keys (Connect TronLink, Connecting..., Multi-Network) in all 7 locales
12. **Dual wallet support** - Users can connect both EVM (via AppKit) and Tron (via TronLink) simultaneously

### TON Integration (Apr 14, 2026)
1. **@tonconnect/ui** - TON wallet connection via TonConnect UI (Tonkeeper, MyTonWallet, etc.), separate from EVM AppKit
2. **useTonConnect hook** - `client/src/core/wallet/useTonConnect.ts` manages TON wallet state, balance polling, address conversion
3. **Balance via RPC** - Fetches native TON balance from `https://toncenter.com/api/v2/jsonRPC` using `getAddressBalance`
4. **Address format** - Raw hex address from TonConnect converted to user-friendly format via `@ton/core` `Address.parseRaw()`
5. **Balance polling** - 30-second interval refresh when connected
6. **Manifest** - Served dynamically by `GET /tonconnect-manifest.json` in `server/index.ts` from request headers (monolith), or generated at build time by `script/build-client.ts` from `PUBLIC_URL` (Netlify split deploy)
7. **Asset type** - `Asset` type updated to `'USDT' | 'ETH' | 'BNB' | 'TON'` across client and server
8. **WalletProvider** - TON state integrated: `isTonConnected`, `tonAddress`, `tonBalance`, `connectTonWallet`, `disconnectTonWallet`
9. **WalletStore** - All balance records include TON (default 0)
10. **Wallet page** - Sky-blue themed TON wallet card, TON balance display, "Connect TON" button
11. **Lobby** - TON added as 4th asset option with blue TON icon; "Connect TON wallet" banner when TON selected without connection
12. **Landing page** - TON icon (blue circle with diamond shape) shown alongside USDT/ETH/BNB
13. **Network guard** - TON asset requires `isTonConnected` for correct chain; no EVM chain switching needed
14. **No escrow yet** - TON escrow/smart contract logic not implemented; wallet connection and balance display only
15. **Translations** - 3 new keys (Connect TON, Connect TON wallet to play with TON, Connect your TON wallet to play with) in all 7 locales
16. **"Crypto Only" rule** - Updated to mention TON in all 7 locale translations

### About Page (Apr 14, 2026)
1. **About.tsx** - New page at `/about` with platform manifesto text
2. **Landing link** - "About" icon link placed next to "Rules" in top-left corner of landing page
3. **Translations** - All About page text translated across all 7 locales

### Smart Contracts (Apr 14, 2026)
1. **EVM Escrow** - `contracts/evm/Skills2CryptoEscrow.sol` (Solidity 0.8.24, OpenZeppelin)
   - Session keys with EIP-712 signatures (365-day validity)
   - Native coin (ETH/BNB) support (USDT token functions in the Solidity source are reserved for the Tron deployment only — BSC runs native BNB only)
   - Built-in gas oracle: server updates gas price in USDT, contract deducts gasReserve from stake
   - 3% platform fee on normal/draw, 0% on disconnect
   - Oracle-only settlement, ReentrancyGuard, events for all state changes
2. **TON Escrow** - `contracts/ton/skills2crypto_escrow.tact` (Tact language)
   - Same logic for native TON coin
   - Session registration, deposit, settlement with 3 reasons
   - Built-in gas calculation in TON
3. **Deployment Guide** - `contracts/DEPLOYMENT_GUIDE.md` covers gas oracle design, BSC/TON testnet deployment, full match cycle testing, and testnet-to-mainnet migration

### EVM Oracle Service (Apr 15, 2026)
1. **server/oracle/evmOracle.ts** - Server-side oracle using ethers.js v6 for on-chain escrow interaction
2. **createEvmOracle()** - Factory function returns oracle instance; loads `ORACLE_PRIVATE_KEY`, `BSC_RPC_URL`, `BSC_ESCROW_ADDRESS` from env
3. **submitDeposit()** - Calls `depositUSDT` on the escrow contract with matchId, stake, player addresses, and EIP-712 signatures
4. **submitDepositNative()** - Calls `depositNative` for ETH/BNB wagers with msg.value
5. **submitSettlement()** - Calls `settleMatch` with winner address and reason (0=Normal, 1=Draw, 2=Disconnect)
6. **updateGasPrice()** - Calls `updateGasPrice` on contract to update the gas oracle
7. **Gas estimation** - All tx functions estimate gas then add 20% buffer before sending
8. **Error handling** - Custom `EvmOracleError` class with error codes (ENV_MISSING, DEPOSIT_FAILED, SETTLE_FAILED, TX_REVERTED, etc.)
9. **Read helpers** - `getMatchOnChain()`, `getOracleBalance()`, `getGasReserveEstimate()` for monitoring
10. **Env vars required** - `ORACLE_PRIVATE_KEY`, `BSC_RPC_URL`, `BSC_ESCROW_ADDRESS`
11. **Dependency** - ethers v6 added to root package.json

### EIP-712 Session Key Signing (Apr 15, 2026)
1. **useSessionKey hook** - `client/src/core/wallet/useSessionKey.ts` manages session key lifecycle
   - Signs EIP-712 typed data matching contract's `SESSION_TYPEHASH` via wagmi's `useSignTypedData`
   - Domain: `{name: "Skills2CryptoEscrow", version: "1", chainId, verifyingContract}`
   - Message: `{player, sessionAddr, maxStakePerMatch, expiry, nonce}`
   - Fetches current nonce from server → signs → sends signature to server → server registers on-chain
   - Persists session in localStorage keyed by `sk_session_{address}_{chainId}`
   - Auto-expires: removes stored session if expiry has passed
   - 365-day validity, 10,000 USDT max stake per match
2. **SessionKeyDialog** - `client/src/components/wallet/SessionKeyDialog.tsx` prompts user after first EVM wallet connect
   - Shows signing/registering states with loading spinners
   - "Skip for now" option; auto-closes on success
   - Error display for rejected signatures or failed registration
3. **WalletProvider integration** - Session dialog auto-opens after nickname dialog, only if no existing session key
   - Context exposes `hasSessionKey` and `promptSessionKey` for Lobby/Play pages
4. **Server routes** - Two new endpoints in `server/routes.ts`:
   - `GET /api/session/nonce?player=0x...&chainId=56` — returns current nonce and server session wallet address
   - `POST /api/session/register` — validates inputs, verifies session address matches server wallet, calls oracle's `registerSessionKey`
5. **Oracle extension** - `evmOracle.ts` gains `registerSessionKey()`, `getSessionNonce()`, `getSessionKeyOnChain()`
6. **Env vars** - `SERVER_SESSION_WALLET` (server-side), `VITE_SERVER_SESSION_WALLET` + `VITE_BSC_ESCROW_ADDRESS` (client-side)

### Unified Onboarding & Deposit Pipeline (Apr 15, 2026) — SUPERSEDED by "BSC USDT Removed"
1. ~~3-step onboarding~~ — now 2 steps (Signing → Registering); the USDT Permit step was deleted.
2. ~~useUsdtPermit hook~~ — the hook file was deleted.
3. ~~Gasless USDT deposits via EIP-2612 permit~~ — no longer applicable; USDT is Tron-only and the BSC oracle handles BNB natively.
4. **Contract: depositUSDTWithPermit** — the Solidity function still exists in the source file for future Tron deployment, but it is NOT called from the BSC oracle.
5. ~~Server permit endpoints~~ — `GET /api/session/permit-nonce` and `POST /api/session/permit` were removed from `server/routes.ts`.
6. ~~Deposit route reads stored permits~~ — `/api/oracle/submit-deposit` now rejects any non-BNB asset and calls `submitDepositNative` only.
7. ~~WalletProvider auto-triggers permit signing~~ — removed; session-key registration is the final onboarding step.
8. **useSessionKey escrowAddress** — Hook still returns `escrowAddress` from the server nonce response; it is used for session-key registration only.
9. **EvmEscrowAdapter** - `client/src/core/escrow/EvmEscrowAdapter.ts` with `lockFunds`, `submitDeposit` (calls `/api/oracle/submit-deposit`), `settleMatch`, `getEstimatedNetworkFee`
10. **Escrow factory** - `client/src/core/escrow/index.ts` selects Mock vs Real adapter based on `VITE_USE_MOCK_ESCROW` env var (defaults to mock)
11. **GameContext + Lobby updated** - Both now import from escrow factory (`@/core/escrow`) instead of direct `MockEscrowAdapter` import
12. **Env vars** - Client: `VITE_USE_MOCK_ESCROW` (default true), `VITE_ESCROW_CHAIN_ID` (default 56); Server: `ORACLE_PRIVATE_KEY`, `BSC_RPC_URL`, `BSC_ESCROW_ADDRESS`, `BSC_CHAIN_ID`, `SERVER_SESSION_WALLET`

### Matchmaking & Socket Architecture Fix (Apr 15, 2026)
1. **Socket stability** - Socket `useEffect` dependency array changed from `[isFinding, selectedGame, selectedAsset, stakeAmount]` to `[]` (mount-only). State accessed via refs (`isFindingRef`, `selectedGameRef`, etc.) to prevent stale closures and socket reconnection during matchmaking.
2. **match-found handler** - Added missing `s.emit('join-match', ...)` call so the waiting player actually joins the socket room when matched. Both the match-found handler and the immediate-match branch now emit `join-match` with `{ matchId, playerId }` object format.
3. **Oracle BNB balance guard** - `ensureOracleHasGas()` checks oracle wallet BNB balance before every on-chain tx (registerSessionKey, submitDeposit, submitDepositWithPermit, submitDepositNative, submitSettlement, updateGasPrice). Error code `ORACLE_NO_GAS`.
4. **Shared socket architecture** - All 4 game components (Chess, Tetris, Checkers, Battleship) now reuse the single socket from `GameContext` instead of each creating their own `io()` connection. GameContext exposes `socket` via context value (`useGame().socket`). Game components use `socket.on()`/`socket.off()` for event registration and cleanup (no more `removeAllListeners` or `socket.close`).
5. **Play.tsx gate fix** - Changed `hasBothPlayers` check from `players?.filter(Boolean).length === 2` to `status === 'waiting'`. The `match-found` socket event handler didn't set a `players` array, so the queued player was permanently stuck on WaitingRoom despite match being active.

### V2 Mainnet Addresses (Task #20, deploys in progress as of Apr 22, 2026)

| Chain | Contract | Status |
|-------|----------|--------|
| BSC | `0x379ADe242CC712EBA77c2149F4cC48dD4d2778e9` | LIVE — `Skills2CryptoEscrow` V2, deploy tx `0xa840a0a1e047bdc83c2c2d56675321aab7ee2a8c9491a88efca243557a59867b` |
| Ethereum | `0x9F11DB204d7f7E8c805a67a0128898e65CF19b02` | LIVE — `Skills2CryptoEscrow` V2, deploy tx `0x33759151adbca385928d4c1449b915a31039ab7f291ea5330bfa05941cf80402` |
| Tron | `TV4vtagjKzRL7AMEiEqgZUZeCmn6iC55Ho` | LIVE — `Skills2CryptoEscrowTron` V2 (hex `41d17f6fb200353dbbe59a35511522e10874f558ae`); oracle `TDsjBnqY84bkhgMCSRhWv8Ey3sCQc2r8Pi`; SunSwap router `TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax`; swap threshold 50 USDT |
| TON | `EQCL2rrhPFu53S9KWWSoDWKcF_STP65YHki8FJdKNcQ6rImQ` | LIVE — `Skills2CryptoEscrowTON` V2; oracle Ed25519 pubkey `c5bdf6948e2eb3394d1b99bc61bd68ba9d3f2196ef6f4c0942cc65e49a11a719`; deposit timeout 3600s |

V2 constructor for BSC/ETH: `(platformWallet=0x7F8B…6832, oracle=0x2ad7…FCB8)` with EIP-712 `name="Skills2CryptoEscrow"`, `version="2"`. Deployer is the same wallet as the oracle. Deploy scripts: `scripts/deploy-bsc.cjs`, `scripts/deploy-eth.cjs`, `scripts/deploy-ton.mjs`, `contracts/tron/migrations/2_deploy_escrow.js`. Operator workflow documented in `contracts/DEPLOYMENT_GUIDE.md`.

### Deprecated V1 BSC Deployment (Apr 15, 2026 — superseded Apr 22, 2026)
- The legacy V1 BSC contract (USDT-based oracle-broadcast model) is deprecated and no longer referenced from the runtime — `BSC_ESCROW_ADDRESS` and `VITE_BSC_ESCROW_ADDRESS` now point at the V2 address above.

### Real-Money Deposit & Settlement Pipeline (Apr 15, 2026)
1. **Wallet addresses in matchmaking** - `findMatch` API now sends `walletAddress`; Redis `match:{id}` stores `addr1`/`addr2` alongside `p1`/`p2` (socket IDs)
2. **Server-side deposit signatures** - Oracle generates EIP-712 `Deposit` signatures for both players using its private key (registered as session key). `signDepositAuthorization()` in `evmOracle.ts` fetches per-player deposit nonces, constructs EIP-712 digest, signs with oracle wallet.
3. **Self-sufficient deposit endpoint** - `POST /api/oracle/submit-deposit` now accepts only `{ matchId }`. Looks up player addresses, stake, and asset from Redis. Generates deposit sigs server-side. Redis lock (`deposit_lock:{matchId}`) prevents double-deposit.
4. **EvmEscrowAdapter.lockFunds wired** - Client `lockFunds()` now calls `/api/oracle/submit-deposit` with matchId. Handles 409 (already in progress) and `alreadyDeposited` responses gracefully.
5. **Server-side auto-settlement** - `storeGameResult()` in `socket.ts` calls `settleMatchOnChain()` after DB save. Settlement uses Redis lock (`settle_lock:{matchId}`) to prevent double-settlement. Maps game result to contract settlement reason (0=Normal win, 1=Draw, 2=Disconnect).
6. **Full pipeline flow**: Player connects wallet → onboarding (session key + USDT permit) → findMatch sends walletAddress → match formed with addresses in Redis → `lockFunds` triggers server deposit → oracle signs + submits `depositUSDTWithPermit` → game plays → `game-end` triggers server settlement → oracle calls `settleMatch` on-chain

### Blockchain Pipeline Fix (Apr 16, 2026)
1. **ABI mismatch fixed** - Oracle's `ESCROW_ABI` was missing `getDomainSeparator`, `oracle()`, `owner()`, `usdtToken()`, `platformWallet()`, `depositNonces()`. Every deposit failed with "escrow.getDomainSeparator is not a function". Now all view functions match the compiled artifact.
2. **Server-side settlement wired** - `settleMatchOnChain()` added to `socket.ts`. Called automatically after `storeGameResult` saves to DB. Uses Redis lock (`settle_lock:{matchId}`). Maps game reasons: checkmate/timeout/resignation → reason 0 (Normal), draw → reason 1 (Draw), disconnect/forfeit/abandoned → reason 2 (Disconnect).
3. **Deduplication guard** - Redis-based idempotency (`gameresult_lock:{matchId}`) prevents duplicate DB inserts and double-settlement when both players emit `game-end` for the same match. Only the first event triggers processing.
4. **Startup diagnostics** - First `createEvmOracle()` call runs a one-time async diagnostic: verifies chain connection, oracle BNB balance, `getDomainSeparator()` call, and that on-chain oracle address matches the server wallet. Logs clear success/failure messages.
5. **Client settlement clarified** - `EvmEscrowAdapter.settleMatch` calculates expected payout/fee locally for UI display but notes that actual settlement is handled server-side.
6. **Contract validation note** - If the (now-deprecated) V1 BSC contract was deployed from an older Solidity source without `getDomainSeparator()` or `depositUSDTWithPermit()`, redeployment is required. The startup diagnostic will detect this and log a clear error. (Superseded by V2 deploy on Apr 22, 2026 — see V2 Mainnet Addresses table above.)

### BSC USDT Removed — USDT Moves to Tron Only (Apr 16, 2026)
1. **No USDT on BSC** — All BSC USDT (BEP-20) support removed from frontend, backend, and oracle. USDT is now exclusively a TRC-20 asset on the Tron network. EVM oracle on BSC handles only BNB native deposits.
2. **Frontend removed** — Deleted `client/src/core/wallet/useUsdtApproval.ts` and `useUsdtPermit.ts`. WalletProvider no longer reads BSC USDT balance, no `usdtBscBalance` context value, no on-chain approval flow. `REQUIRED_CHAIN` reduced to `{ BNB, ETH }` only — USDT routes through TronLink, TON through TonConnect.
3. **Onboarding simplified** — `SessionKeyDialog` now has 2 steps (Sign session key → Register on-chain). `OnboardingStep` type dropped `'approving'`. No more USDT approval transaction during EVM onboarding.
4. **Wallet page** — USDT card now shows only Tron (TRC-20) balance with a "Connect TronLink" prompt when extension is detected but not connected. EVM card title updated to "EVM (ETH / BNB)".
5. **Lobby** — Selecting USDT triggers a Tron-specific banner ("Connect TronLink to play with USDT"); BNB/ETH still show the network-switch banner.
6. **Backend removed** — `GET /api/session/permit-nonce` and `POST /api/session/permit` deleted from `server/routes.ts`. The `/api/oracle/submit-deposit` endpoint now rejects any non-BNB/ETH asset with HTTP 400 and the message "EVM oracle only supports BNB/ETH native deposits".
7. **EVM oracle slimmed** — `submitDeposit`, `submitDepositWithPermit`, `getUsdtAllowance`, and `PermitData` interface removed from `server/oracle/evmOracle.ts`. ABI no longer references `depositUSDT`, `depositUSDTWithPermit`, or `usdtToken`. `preflightDeposit` simplified to just session-key checks (USDT allowance branch removed).
8. **Contracts untouched** — `contracts/evm/Skills2CryptoEscrow.sol` still defines `depositUSDT` / `depositUSDTWithPermit`; the source is preserved for future Tron USDT contract deployment (Task #13). The deployed BSC contract simply leaves those functions unused.
9. **Follow-up tasks** — Task #12 (player-submitted native BNB+ETH deposits) and Task #13 (Tron USDT TRC-20 oracle integration) build on this clean baseline.

### Deposit Pipeline Fix — Permit & Session (Apr 16, 2026) — SUPERSEDED by "BSC USDT Removed"
1. ~~BSC USDT decimals fixed~~ — no longer applicable; BSC USDT support was removed entirely in the later pass.
2. **Session key maxStake fixed** — Changed from `parseUnits('10000', 6)` (10 billion) to `parseUnits('1000000', 18)` (10^24). Old limit was too small for 18-decimal native coins (0.0075 BNB = 7.5 * 10^15 > 10^10). Stale cached sessions with old maxStake are auto-invalidated from localStorage.
3. ~~EIP-2612 permit replaced with on-chain approve~~ — no longer applicable; both `useUsdtPermit` and `useUsdtApproval` hooks were deleted along with BSC USDT support.
4. ~~Deposit endpoint uses depositUSDTWithPermit with null permits~~ — no longer applicable; `depositUSDT*` is no longer called from the BSC oracle, which is BNB-native only.
5. **Pre-flight deposit checks** — `oracle.preflightDeposit()` checks both players' session keys (registered, not revoked, not expired, maxStake sufficient) before attempting on-chain deposit. Returns a specific failure reason for each check. USDT allowance branch removed.
6. **Deploy script updated** — `scripts/deploy-bsc.cjs` USDT_DECIMALS corrected from 6 to 18 for future redeployments.
7. **SessionKeyDialog updated** — Step 3 text changed from "USDT permit" to "USDT approval" to reflect the actual on-chain approve flow.

---

## Task #12 — Player-submitted Native BNB & ETH Deposits (current model)

The previous oracle-funded native deposit flow described above is **SUPERSEDED**.
Native (BNB & ETH) matches now use a **player-submitted** model.

### Contract changes (`contracts/evm/Skills2CryptoEscrow.sol`)
- New `MatchStatus.WaitingForP2` (appended at end of enum to preserve ordinals).
- `Match` struct gains `deadline` and `firstDepositor` fields.
- New `MatchAuth` EIP-712 typehash and `depositNativeAsPlayer(matchId, player1, player2, stake, gasReserve, deadline, oracleSig)` — payable, player-callable. First caller opens match in `WaitingForP2`; second caller flips to `Active`.
- `refundNoShow(matchId)` — first depositor reclaims funds after `deadline` if opponent never shows.
- `depositNative` (oracle-funded) removed from contract; existing USDT paths preserved for the Tron task.

### Multi-chain oracle (`server/oracle/evmOracle.ts`)
- `createEvmOracle(chain: 'BSC' | 'ETH')` factory with per-chain caching.
- BSC reads `BSC_RPC_URL` / `BSC_ESCROW_ADDRESS` / `BSC_CHAIN_ID` (default 56).
- ETH reads `ETH_RPC_URL` / `ETH_ESCROW_ADDRESS` / `ETH_CHAIN_ID` (default 1).
- Same `ORACLE_PRIVATE_KEY` signs MatchAuth on both chains.
- New helpers: `signMatchAuth(...)`, `getMatchOnChain(...)`, `watchMatchActive(handler)`.
- `submitDepositNative` removed.

### Backend routes
- `POST /api/oracle/submit-deposit` removed.
- `POST /api/oracle/match-auth` — returns `{ matchIdBytes32, player1, player2, stake, gasReserve, deadline, oracleSig, chainId, escrowAddress }`. Cached in Redis (20-min TTL) so both players get identical params.
- `GET /api/oracle/match-status/:matchId` — returns on-chain status (0=None, 1=Active, 2=Settled, 3=WaitingForP2).
- `POST /api/session/register` and `GET /api/session/nonce` now route by chainId (1 → ETH oracle, 56 → BSC oracle).
- `settleMatchOnChain` in `server/socket.ts` dispatches by asset (BNB → BSC oracle, ETH → ETH oracle).

### Server bootstrap (`server/index.ts`)
- Initialises BSC and ETH oracles independently (whichever env vars are set).
- Subscribes to `MatchActive` events on each chain and emits `match-funded` socket event into `match:{matchId}` room.

### Frontend (`client/src/core/escrow/EvmEscrowAdapter.ts`)
- `lockFunds(matchId, asset, stake)` now: fetches MatchAuth, calls `depositNativeAsPlayer` via `@wagmi/core` `writeContract` with `value = stake + gasReserve`, waits for the receipt, then polls `/api/oracle/match-status/:matchId` until status === Active.
- No retries on user-facing tx failures; the user must explicitly try again.

---

## Task #14 — Native TON Escrow Integration

TON uses its own contract, oracle key, and player flow because it sits on a
different VM (TVM) and curve (Ed25519) than the EVM/Tron stack.

### Smart contracts (`contracts/ton/`)
- `skills2crypto_escrow_simple.tact` — production contract. `PrepareMatch`
  (oracle), `PlayerDeposit` (player via TonConnect), `Settle` (oracle),
  `CancelMatch` (oracle). 3% platform fee, per-player gas reserve baked into
  the deposit so the oracle is always reimbursed for `Settle` gas.
- `skills2crypto_escrow.tact` — original session-key draft, kept for jetton
  exploration; **not deployed**.
- `contracts/ton/README.md` — Tact compile + deploy instructions.

### Oracle (`server/oracle/tonOracle.ts`)
- Derives an Ed25519 keypair from `TON_ORACLE_MNEMONIC` (24 words) into a
  `WalletContractV4`. Independent of the EVM/Tron oracle.
- Builds Tact message bodies (`PrepareMatch`, `PlayerDeposit`,
  `Settle`, `CancelMatch`) with explicit opcodes. (Historical: this used
  to derive opcodes via `server/oracle/tonCrc32.ts`, which was wrong —
  Task #26 replaced that with imports from the auto-generated Tact
  wrapper and the crc32 helper file is removed.)
- `prepareMatch / submitSettlement / cancelMatch / getMatchOnChain /
  encodePlayerDepositPayload`. Match IDs are sha256 → uint256 (TVM-friendly;
  doesn't need to match EVM's keccak256 since the contracts are separate).

### Backend routes (`server/routes.ts`)
- `GET /api/ton/config` — public escrow / oracle / gas-reserve info.
- `GET /api/ton/readiness` — pre-search wallet balance check.
- `POST /api/ton/deposit-info` — idempotently calls `PrepareMatch` on-chain
  and returns `{ escrowAddress, amountNano, payloadBoc, validUntilSec }`.
- `GET /api/ton/match-status/:matchId` — reads the on-chain `Match` struct;
  emits `match-funded` once status flips to `ACTIVE` (status==2).
- `POST /api/ton/notify-deposit` — informational breadcrumb from client.
- `/api/find-match` gated on TON balance ≥ stake + gasReserve + 0.05.
- `server/socket.ts settleMatchOnChain` dispatches `asset === 'TON'` to
  `tonOracle.submitSettlement(matchId, winnerFriendlyAddress, reason)`.

### Frontend
- `client/src/core/escrow/TonEscrowAdapter.ts` — `lockFunds` fetches
  deposit-info, calls `tc.sendTransaction` (TonConnect), then polls
  `/api/ton/match-status` until `ACTIVE`. `ensureTonReadyForStake` is the
  pre-find-match readiness check.
- `client/src/core/wallet/useTonConnect.ts` — caches the `TonConnectUI`
  instance on `window.__TON_CONNECT_UI__` so adapters can reuse it (and to
  avoid the "already initialized" error on re-mount).
- `client/src/core/escrow/index.ts` — `EscrowRouter` routes `TON` to
  `tonEscrowAdapter` when not in mock mode.

### Env vars (server)
- `TON_ESCROW_CONTRACT` — bounceable EQ… address of the deployed contract.
- `TON_ORACLE_MNEMONIC` — 24-word mnemonic for the oracle wallet.
- `TON_PLATFORM_WALLET` — friendly TON address that receives the 3% fee.
- `TON_RPC_URL` (optional, default toncenter v2 jsonRPC).
- `TON_API_KEY` (optional, recommended for toncenter rate limits).
- `TON_MIN_GAS` (optional, default 1.0 TON).
- `TON_WORKCHAIN` (optional, default 0).

### Deployment
- BSC redeployment required (struct + new function). Use `scripts/deploy-bsc.cjs`.
- ETH mainnet deployment is a manual op with funded deployer key. Use `scripts/deploy-eth.cjs`.
- Set `ETH_RPC_URL` and `ETH_ESCROW_ADDRESS` after the ETH deployment to enable the ETH path.

## Task #16 — Escrow V2 (player-pays-gas + gasless Tron USDT)

Architectural rewrite of all four escrow contracts and the matching server +
client code. Previous V1 contracts and server submitSettlement() flow are
replaced.

### Contracts
- **EVM** (`contracts/evm/Skills2CryptoEscrow.sol`, V2): native-only,
  player-callable `depositNative(matchId, p1, p2, stake, deadline, oracleSig)`
  (no `gasReserve`), winner-callable `settleMatch(matchId, winner, reason,
  oracleSig)`. Two EIP-712 typed structs: `MatchAuth` (deposit) and
  `MatchOutcome` (settlement). Domain `version = "2"`. Statuses:
  `0 None`, `1 WaitingForP2`, `2 Active`, `3 Settled`.
- **Tron USDT** (`contracts/tron/Skills2CryptoEscrowTron.sol`): gasless for
  players. Oracle submits both `depositUSDT` (verifies two EIP-712 player
  sigs and pulls `stake` USDT each via `transferFrom`) and `settleMatch`.
  `0.5%` of every settlement payout accrues to a gas-fund accumulator that
  auto-swaps USDT → TRX via SunSwap V2 once the threshold (50 USDT) is
  reached and forwards the TRX to the oracle wallet.
- **TON** (`contracts/ton/skills2crypto_escrow_v2.tact`): players send
  `Deposit(matchId, p1, p2, stake)` directly via TonConnect. Settle is sent
  by the winner (or any player on Draw / Disconnect) with a
  `Settle(matchId, winner, reason, signature)` BOC carrying the oracle's
  Ed25519 signature; contract verifies via `checkSignature`. Match struct
  is auto-created on the first Deposit.

### Server oracle layer (`server/oracle/`)
- `evmOracle.ts`: `signMatchAuth({ matchId, player1, player2, stake,
  deadline })` and `signMatchOutcome({ matchId, winner, reason })`. No more
  on-chain settle path. `watchMatchActive` listens for the new
  `MatchActive(matchId, p1, p2, stake)` event (no `gasReserve` field).
- `tronOracle.ts`: `submitDepositUSDTGasless()` (oracle pays TRX, recouped
  via gas-fund + SunSwap), `submitSettlement()` (oracle still pays TRX),
  plus `signMatchOutcome()` for any future client-driven path. TRX
  sponsorship code removed entirely.
- `tonOracle.ts`: `encodeDepositPayload()` (BOC the player attaches to
  TonConnect), `signMatchOutcome()` (Ed25519 over `cell.hash()` of
  `(matchId, winner, reason)`) returning `{ payloadBoc, signatureHex }`,
  `encodeRefundNoShowPayload()`. `prepareMatch` and on-chain `Settle` send
  paths are gone.

### Server routes (`server/routes.ts`)
- `POST /api/oracle/match-auth` no longer returns `gasReserve`.
- `GET /api/oracle/match-status/:matchId` returns the V2 status numbering
  in `statusV2` while keeping a backwards-compatible `status` field
  (1 = Active / fully funded, 2 = Settled, 3 = WaitingForP2).
- `POST /api/tron/deposit-sig` now triggers `submitDepositUSDTGasless`.
- `GET /api/tron/readiness` only requires allowance ≥ stake. Player needs
  ~30 TRX themselves for the one-time `approve(escrow, MAX)`.
- `POST /api/ton/deposit-info` returns the new V2 Deposit BOC and an
  `amountTon = stake + 0.05` (gas buffer); no PrepareMatch flow.
- `GET /api/ton/config` returns `{ escrowAddress, platformWallet,
  oraclePubkeyHex }` (no oracle address / gas reserve fields).
- **NEW**: `GET /api/escrow/settle-auth/:matchId` — returns the oracle-
  signed `MatchOutcome` (EVM) or signed Settle BOC (TON) so the
  winner / either player can call `settleMatch` themselves. Tron USDT
  matches return 409 (oracle settles directly).
- **REMOVED (returns HTTP 410)**: `/api/tron/sponsor-challenge`,
  `/api/tron/sponsor-trx`, `/api/session/nonce`, `/api/session/register`.

### Server settle flow (`server/socket.ts settleMatchOnChain`)
- TRON: unchanged — oracle calls `submitSettlement` directly.
- EVM / TON: oracle only signs the outcome. The signed auth is persisted
  in Redis under `settle_auth:${matchId}` (7-day TTL) and a `settle-ready`
  socket event is emitted into the `match:${matchId}` room. Clients fetch
  via `/api/escrow/settle-auth/:matchId` and broadcast on-chain
  themselves.

### Client adapters (`client/src/core/escrow/`)
- `EvmEscrowAdapter`: deposit uses V2 ABI (`depositNative`, `value =
  stake`); new `claimSettlement(matchId)` fetches the auth and calls
  `settleMatch` via wagmi. `settleMatch` (UI helper) fires-and-forgets
  `claimSettlement` for win / draw outcomes.
- `TonEscrowAdapter`: deposit unchanged in shape, just uses the new
  Deposit BOC; new `claimSettlement(matchId)` sends the signed Settle BOC
  via TonConnect (~0.05 TON gas).
- `TronEscrowAdapter`: TRX sponsorship code removed — players pay their
  own ~30 TRX once for `approve(escrow, MAX)`. Per-match deposits and
  settlement remain gasless. Required allowance is now exactly `stake`.

### Funding required before mainnet deploys
- **BSC / ETH oracle wallet (`0x2ad7345E…CB8`)**: signer-only — needs
  ~zero, but ~0.01 ETH is recommended for occasional admin txs.
- **TON deployer**: ~3 TON for the V2 contract deploy + oracle key
  registration.
- **Tron deployer**: ~300 TRX for the V2 contract deploy.
- **Tron oracle bootstrap**: 50–100 USDT to seed the gas-fund accumulator
  so it can auto-swap once and start self-sustaining.

## Task #10 — Oracle balance monitoring & V2 obsolescence notes

The original Task #10 was scoped against the V1 EVM contract that had
`updateGasPrice()`, a `gasReserve` field, and required the oracle wallet
to fund both players' BNB stakes via `msg.value`. **The Task #16 V2
rewrite eliminated all three of those mechanisms** for BSC and Ethereum:

- `Skills2CryptoEscrow.sol` no longer exposes `updateGasPrice()` — there
  is no gas oracle to update on EVM chains.
- The contract has no `gasReserve` field; `depositNative` requires
  exactly `msg.value == stake` from one of the two named players.
- The oracle wallet never broadcasts a settle / deposit transaction on
  BSC or ETH. Players pay their own gas via wagmi `writeContract`. A
  zero-balance oracle wallet is operationally fine on EVM.

What Task #10 still applies to is **operational visibility**, which is
implemented as follows:

- `GET /api/health/oracles` returns per-chain status for BSC, ETH, Tron,
  and TON in one call: oracle address, escrow address, native balance,
  and an `okForGas` flag. Tron is the only chain that can flip false
  (when oracle TRX falls below `TRON_MIN_GAS_TRX`, default 50). EVM and
  TON always report `okForGas: true` with a `note` explaining why.
- `tronOracle.ts` now logs the oracle's TRX balance every 5 minutes
  (with a `WARN` tag below `TRON_MIN_GAS_TRX`) so operators see drift
  before users hit `ORACLE_NO_GAS`. The interval is `unref()`-ed so it
  doesn't block process exit.
- `tonOracle.getEscrowBalanceTon()` reads the contract's own TON balance
  (the meaningful liquidity number — TON oracle is signer-only) and is
  exposed via the health endpoint.

Tron's gas economics are handled by the on-chain SunSwap V2 auto-swap
described elsewhere in this file (0.5% gas-fund fee accumulates and
swaps to TRX at the configured threshold), so it does not need a JS
gas-price oracle either.
