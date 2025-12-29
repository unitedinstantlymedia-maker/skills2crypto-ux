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
  - `storage.ts` - In-memory storage (MemStorage)
- `shared/` - Shared types and schema
- `attached_assets/` - Images and assets

## Tech Stack

- **Frontend**: React 19, Vite, TailwindCSS, Wouter (routing), Framer Motion
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

- Games: Chess, Tetris (Block Stack), Checkers
- Assets: USDT, ETH, TON
- Stake presets: 5 / 20 / 50 / 100 + Custom
- Fee: 3% of total pot
- Non-custodial concept (prototype simulates wallet state)
- Multi-language support

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
- ⚠️ Tetris/Checkers engines not yet implemented (placeholder games work)

### Chess Multiplayer (Dec 29, 2025)
1. **Socket.IO Events** - Server handles join-match, color-assigned, game-start, chess-move, opponent-move, chess-resign, chess-timeout
2. **Color Assignment** - First player = white, second = black, colors persist on reconnection
3. **Security** - Socket authorization validates all chess events before broadcasting
4. **Game End** - Automatic detection of checkmate, stalemate, timeout, resignation
5. **Timer Sync** - 30-minute timers per player synchronized via socket events
6. **Demo Mode Removed** - Games require real matchmaking between two players
