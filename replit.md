# SKILLS2CRYPTO

Mobile-first web app prototype for 1v1 skill games with crypto-only wagers.

## Overview

This is a React + Express full-stack application that allows users to play 1v1 skill games (Chess, Tetris, Checkers) with crypto wagers. The app uses a 3-layer architecture to separate UI from logic and prepare for Web3 integration.

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
- Assets: USDT (BSC BEP-20 + Tron TRC-20), ETH (Ethereum), BNB (BSC), TON (The Open Network)
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
1. **@reown/appkit v1.8.19** - Universal wallet modal (MetaMask, Trust Wallet, Coinbase, WalletConnect QR, Rainbow) for ETH + BNB + USDT
2. **wagmi v2 + viem v2** - EVM wallet connections via WagmiAdapter from @reown/appkit-adapter-wagmi
3. **USDT on BSC** - USDT BEP-20 balance read via `useReadContract` with contract `0x55d398326f99059fF775485246999027B3197955` on BSC
4. **WalletProvider** - `client/src/core/wallet/WalletProvider.tsx` wraps app with WagmiProvider + QueryClientProvider, manages EVM state sync
5. **appKit config** - `client/src/config/wagmi.ts` with WagmiAdapter, dark theme, green accent, featured wallets
6. **WalletStore updated** - `syncRealWallet()` method syncs real wallet data, `setNickname()`, escrow protection, separate real/game balances
7. **Network labels** - Wallet page shows USDT=BNB Smart Chain (BEP-20), ETH=Ethereum, BNB=BNB Smart Chain
8. **Nickname system** - `NicknameDialog` component, localStorage by wallet address, auto-prompt on first connect
9. **Vite config** - `resolve.dedupe` for react/react-dom/react-jsx-runtime/valtio/@tanstack/react-query; `optimizeDeps.include` for all @reown + wagmi + viem packages
10. **Translations** - 11 keys across all 8 languages (Disconnect, Copied, Choose Nickname, Manage, etc.)
11. **App.tsx** - QueryClientProvider removed from top-level (now inside WalletProvider using shared queryClient from lib/queryClient.ts)
12. **Env var** - `VITE_REOWN_PROJECT_ID` required for appkit modal
13. **Removed** - TronLink/TronWallet/TronConnectDialog/ConnectWalletDialog all deleted; no Tron dependency

### Network Switching (Apr 13, 2026)
1. **Chain detection** - `useAppKitNetwork` tracks current wallet chain; exposed as `currentChainId`/`currentChainName` in WalletProvider context
2. **REQUIRED_CHAIN map** - Exported from WalletProvider: USDT→BSC (56), BNB→BSC (56), ETH→Ethereum (1)
3. **isCorrectChainForAsset(asset)** - Context helper returns boolean; compares current chain to asset requirement; USDT returns true if Tron is connected
4. **switchToChain(chainId)** - Calls `switchNetwork()` from @reown/appkit to prompt wallet chain switch
5. **Lobby network guard** - `handleStartSearch` blocks match start with toast if on wrong chain; amber banner shows "Switch to BSC/Ethereum" button
6. **Wallet page** - Shows current network name under address; per-asset amber banner with one-click switch button when on wrong chain
7. **Translations** - Network keys (Network, Switch to, to play with, Currently on, Switching..., Please switch to, Wrong Network) in all 7 locales
8. **USDT on Ethereum** - Also reads USDT ERC-20 balance from `0xdAC17F958D2ee523a2206206994597C13D831ec7` (6 decimals) on Ethereum mainnet

### TronLink / USDT TRC-20 (Apr 13, 2026)
1. **TronLink detection** - `useTronLink` hook (`client/src/core/wallet/useTronLink.ts`) auto-detects TronLink browser extension via `window.tronWeb`/`window.tronLink`
2. **TronLink NOT inside AppKit** - Tron is not an EVM chain; @reown/appkit has no Tron adapter. TronLink connection is handled separately alongside AppKit
3. **USDT TRC-20 balance** - Reads from contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (6 decimals) using `window.tronWeb.contract().at()` + `balanceOf()`
4. **Auto-reconnect** - If user previously connected TronLink (`localStorage tronlink_connected`), auto-reconnects on page load
5. **Balance polling** - USDT TRC-20 balance refreshes every 30 seconds when connected
6. **Account change events** - Listens for `window.message` events from TronLink (`setAccount`, `setNode`) for live account/network updates
7. **Total USDT** - Wallet page shows combined USDT = BSC (BEP-20) + ETH (ERC-20) + Tron (TRC-20) with per-network breakdown
8. **Wallet page** - Red-themed TronLink card with address, copy, disconnect; "Connect TronLink" button appears only when extension is detected
9. **Context values** - WalletProvider exposes: `isTronLinkInstalled`, `isTronConnected`, `tronAddress`, `usdtTrc20Balance`, `isTronConnecting`, `connectTronLink`, `disconnectTronLink`, `usdtBscBalance`, `usdtEthBalance`
10. **Network guard** - USDT is considered "correct chain" if user is on BSC (EVM) OR has TronLink connected — either satisfies the requirement
11. **Translations** - 3 new keys (Connect TronLink, Connecting..., Multi-Network) in all 7 locales
12. **Dual wallet support** - Users can connect both EVM (via AppKit) and Tron (via TronLink) simultaneously

### TON Integration (Apr 14, 2026)
1. **@tonconnect/ui** - TON wallet connection via TonConnect UI (Tonkeeper, MyTonWallet, etc.), separate from EVM AppKit
2. **useTonConnect hook** - `client/src/core/wallet/useTonConnect.ts` manages TON wallet state, balance polling, address conversion
3. **Balance via RPC** - Fetches native TON balance from `https://toncenter.com/api/v2/jsonRPC` using `getAddressBalance`
4. **Address format** - Raw hex address from TonConnect converted to user-friendly format via `@ton/core` `Address.parseRaw()`
5. **Balance polling** - 30-second interval refresh when connected
6. **Manifest** - `client/public/tonconnect-manifest.json` for dApp metadata
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
   - USDT (BEP-20) and native coin (ETH/BNB) support
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

### Unified Onboarding & Deposit Pipeline (Apr 15, 2026)
1. **3-step onboarding** - SessionKeyDialog now shows: Signing → Registering → Signing USDT Permit (via `OnboardingStep` type)
2. **useUsdtPermit hook** - `client/src/core/wallet/useUsdtPermit.ts` signs EIP-2612 permit off-chain (no gas tx), stores in localStorage + sends to `POST /api/session/permit`
3. **Gasless USDT deposits** - Users sign one off-chain EIP-2612 permit during onboarding. When oracle submits deposits, it calls `depositUSDTWithPermit` which executes the permit on-chain + transfers USDT in one tx. Oracle pays gas in BNB, reimbursed via `gasReserve` deducted in USDT.
4. **Contract: depositUSDTWithPermit** - New function in `Skills2CryptoEscrow.sol` accepts permit data (deadline, v, r, s) for both players. Uses `_tryPermit` helper with try/catch to handle already-used or unsupported permits gracefully. Falls back to existing allowance if permit fails.
5. **Server permit endpoints** - `GET /api/session/permit-nonce` fetches ERC-20 nonce + token name from BSC. `POST /api/session/permit` stores signed permit in Redis (30-day TTL).
6. **Deposit route updated** - `POST /api/oracle/submit-deposit` checks Redis for stored permits before calling oracle. If permits exist, uses `submitDepositWithPermit`; otherwise falls back to `submitDeposit` (requires prior on-chain approval).
7. **WalletProvider wiring** - After session key registration succeeds, auto-triggers USDT permit signing; `onboardingStep` state drives SessionKeyDialog UI; dialog auto-closes when both session key + permit complete
8. **useSessionKey escrowAddress** - Hook now returns `escrowAddress` from server nonce response, used to set the spender for USDT permit
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

### BSC Mainnet Deployment (Apr 15, 2026)
1. **Contract deployed** - `Skills2CryptoEscrow` at `0xa8a1481c0F26eA10410a9145A48935ED24d3D0f7` on BSC Mainnet (chain 56)
2. **Tx hash** - `0x823c59a298520e53bfcb2fc6309efe5c10c3df25af6e2878acb76dc511152599`
3. **Constructor params** - USDT=`0x55d398326f99059fF775485246999027B3197955` (6 decimals), Platform=`0x7F8Bc18A773f101194071aA559d15d2a59bf6832`, Oracle=`0x2ad7345E4ad7Fff0Ec5cB41B96e69035f96DFCB8`, initialGasPrice=1
4. **Deployer** - `0x2ad7345E4ad7Fff0Ec5cB41B96e69035f96DFCB8` (same as oracle)
5. **Hardhat setup** - `hardhat.config.cjs` with Solidity 0.8.24, cancun EVM, optimizer 200 runs; deploy script at `scripts/deploy-bsc.cjs`
6. **Dependencies** - hardhat@^2.28, @nomicfoundation/hardhat-ethers, @openzeppelin/contracts@5.6.1

### Real-Money Deposit & Settlement Pipeline (Apr 15, 2026)
1. **Wallet addresses in matchmaking** - `findMatch` API now sends `walletAddress`; Redis `match:{id}` stores `addr1`/`addr2` alongside `p1`/`p2` (socket IDs)
2. **Server-side deposit signatures** - Oracle generates EIP-712 `Deposit` signatures for both players using its private key (registered as session key). `signDepositAuthorization()` in `evmOracle.ts` fetches per-player deposit nonces, constructs EIP-712 digest, signs with oracle wallet.
3. **Self-sufficient deposit endpoint** - `POST /api/oracle/submit-deposit` now accepts only `{ matchId }`. Looks up player addresses, stake, and asset from Redis. Generates deposit sigs server-side. Redis lock (`deposit_lock:{matchId}`) prevents double-deposit.
4. **EvmEscrowAdapter.lockFunds wired** - Client `lockFunds()` now calls `/api/oracle/submit-deposit` with matchId. Handles 409 (already in progress) and `alreadyDeposited` responses gracefully.
5. **Server-side auto-settlement** - `storeGameResult()` in `socket.ts` calls `settleMatchOnChain()` after DB save. Settlement uses Redis lock (`settle_lock:{matchId}`) to prevent double-settlement. Maps game result to contract settlement reason (0=Normal win, 1=Draw, 2=Disconnect).
6. **Full pipeline flow**: Player connects wallet → onboarding (session key + USDT permit) → findMatch sends walletAddress → match formed with addresses in Redis → `lockFunds` triggers server deposit → oracle signs + submits `depositUSDTWithPermit` → game plays → `game-end` triggers server settlement → oracle calls `settleMatch` on-chain
