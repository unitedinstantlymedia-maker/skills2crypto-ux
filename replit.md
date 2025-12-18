# SKILLS2CRYPTO

Mobile-first web app prototype for 1v1 skill games with crypto-only wagers.

## Overview

This is a React + Express full-stack application that allows users to play 1v1 skill games (Chess, Tetris, Checkers) with crypto wagers. The server is the authoritative source of truth for all game logic, move validation, and match outcomes.

## Project Structure

- `client/` - React frontend with Vite
  - `src/components/` - UI components (shadcn/ui based)
  - `src/components/games/` - Game-specific UI (ChessGame, TetrisGame, etc.)
  - `src/pages/` - Route pages
  - `src/core/` - Core business logic (wallet, escrow, matchmaking)
  - `src/context/` - React contexts (Game, Language)
- `server/` - Express backend
  - `index.ts` - Server entry point
  - `routes.ts` - API routes
  - `adapters/` - Game adapter framework (pluggable game modules)
  - `services/` - Core services (matchEngine, escrow)
- `shared/` - Shared types and schema (protocol.ts)
- `attached_assets/` - Images and assets

## Tech Stack

- **Frontend**: React 19, Vite, TailwindCSS, Wouter (routing), Framer Motion, react-chessboard
- **Backend**: Express, TypeScript, chess.js
- **Database**: PostgreSQL with Drizzle ORM (in-memory storage for prototype)
- **UI Components**: shadcn/ui (Radix UI based)

## Development

```bash
npm run dev         # Start development server (port 5000)
npm run build       # Build for production
npm run start       # Start production server
npm run db:push     # Push database schema
```

## Server Architecture

### Game Adapter Framework
Each game implements the `GameAdapter` interface:
- `initState()` - Initialize game state
- `validateMove(state, move, playerId, players)` - Validate a move
- `applyMove(state, move)` - Apply a move to state
- `checkResult(state, players)` - Check for game end
- `getCurrentPlayer(state, players)` - Get current player

### Match Engine
Handles match lifecycle:
- `createMatch()` - Create a new match with escrow lock
- `submitMove()` - Validate and apply a move
- `resignMatch()` - Handle resignation
- `getMatch()` / `getOrCreateMatch()` - Retrieve match state

### Escrow Service
Configurable fee and recipient for future cold wallet integration:
- `lock()` - Lock funds for a match
- `release()` - Release funds to winner (minus fee)
- `refundAll()` - Refund on draws

### Matchmaking Service (Real-time)
In-memory queue for real 1v1 matchmaking:
- Queue grouped by `{game}|{asset}|{amount}` composite key
- First player enters queue → status: "waiting"
- Second player with same params → match created, both notified
- WebSocket notifications for real-time match updates

### WebSocket Server
Real-time communication on `/ws`:
- `register` - Map playerId to socket connection
- `find_match` - Join matchmaking queue via WebSocket
- `cancel_search` - Cancel matchmaking search
- `match_found` - Server → Client notification when matched

## API Endpoints

### Game Matches
- `POST /api/matches` - Create a new match
- `GET /api/matches/:id` - Get match by ID (auto-creates for DEV)
- `POST /api/matches/:id/move` - Submit a move
- `POST /api/matches/:id/resign` - Resign from match

### Matchmaking
- `POST /api/find-match` - Join matchmaking queue
  - Body: `{ game, asset, amount, playerId }`
  - Response: `{ status: "waiting" }` or `{ status: "matched", matchId }`
- `GET /api/matchmaking/match/:id` - Get matchmaking match details
- `GET /api/matchmaking/stats` - Get queue stats

## Key Features

- Games: Chess (server-validated), Tetris (Block Stack), Checkers
- Assets: USDT, ETH, TON
- Stake presets: 5 / 20 / 50 / 100 + Custom
- Fee: 3% of total pot (configurable)
- Server-authoritative game logic
- Pluggable game adapter system
- Mock escrow ready for cold wallet integration
- Multi-language support

## Security Notes

- The `getOrCreateMatch()` DEV fallback auto-creates matches for testing
- In production, this should be removed and proper auth added
- Escrow service uses placeholder addresses (PLATFORM_FEE_ADDRESS)
