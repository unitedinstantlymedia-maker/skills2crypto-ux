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
  - `src/context/` - React contexts (Game, Language, Socket)
- `server/` - Express backend
  - `index.ts` - Server entry point
  - `routes.ts` - API routes
  - `adapters/` - Game adapter framework (pluggable game modules)
  - `services/` - Core services (matchEngine, escrow)
- `shared/` - Shared types and schema (protocol.ts)
- `attached_assets/` - Images and assets

## Tech Stack

- **Frontend**: React 19, Vite, TailwindCSS, Wouter (routing), Framer Motion, react-chessboard, socket.io-client
- **Backend**: Express, TypeScript, chess.js, socket.io
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

### Game Engines (All Server-Authoritative)

**Chess** (`server/adapters/chess.ts`):
- Uses chess.js for full rule validation
- Detects checkmate, stalemate, draw, threefold repetition, insufficient material

**Checkers** (`server/adapters/checkers.ts`):
- 8x8 board with red/black pieces
- Forward-only moves for men, multi-direction for kings
- Mandatory captures, multi-jump sequences
- King promotion at opposite end
- Game ends when player has no pieces or no legal moves

**Battleship** (`server/adapters/battleship.ts`):
- 10x10 grids per player, 5 ships randomly placed
- Fire action with hit/miss tracking
- Extra turn on hit, turn switches on miss
- Game ends when all ships sunk

**Tetris** (`server/adapters/tetris.ts`):
- 10x20 board with 7 tetromino types
- Actions: move_left, move_right, rotate, drop, soft_drop
- Server controls piece spawning (no client-triggered spawn)
- Line clearing with scoring (100/300/500/800)
- Game over when piece cannot spawn

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

### Socket.IO Server (Real-time Match Lifecycle)
Server-authoritative real-time communication:

**Match Registry** (in-memory):
```typescript
matches = {
  [matchId]: {
    id, game, asset, amount,
    players: { [playerId]: { socketId, connected } },
    status: "waiting" | "active" | "paused" | "finished",
    state: {}
  }
}
```

**Socket Events**:
- `join_match` - Player joins match (validates authorization)
- `leave_match` - Player leaves match (transitions to paused)
- `disconnect` - Handle socket disconnect (pauses match)
- `match_state` - Server → Client: `{ matchId, status, players }`
- `match_found` - Server → Client: Match created notification

**Status Transitions**:
- `waiting` → `active` when 2 players connected
- `active` → `paused` when <2 players connected
- Reconnect resumes `paused` → `active`

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

- Games: Chess, Tetris, Checkers, Battleship (all server-validated)
- Assets: USDT, ETH, TON
- Stake presets: 5 / 20 / 50 / 100 + Custom
- Fee: 3% of total pot (configurable)
- Server-authoritative game logic
- Pluggable game adapter system
- Mock escrow ready for cold wallet integration
- Multi-language support

## Match Lifecycle (Server-Authoritative)

### Match Status Flow
- `waiting` → `active` when 2 players connected
- `active` → `paused` when <2 players connected
- `active` → `finished` when game ends (checkmate, resign, draw, stalemate)

### Game Actions
1. Client emits `game_action` → Server validates via GameAdapter
2. Valid: Server updates state, broadcasts `game_state` to both players
3. Invalid: Server emits `action_rejected` with reason
4. Finished: Server emits `match_finished` with final result, blocks all further actions

### MatchResult Type
```typescript
interface MatchResult {
  status: "finished";
  reason: "checkmate" | "resign" | "draw" | "stalemate" | "disconnect";
  winner?: string;
  draw?: boolean;
}
```

## Security Notes

- The `getOrCreateMatch()` DEV fallback auto-creates matches for testing
- In production, this should be removed and proper auth added
- Escrow service uses placeholder addresses (PLATFORM_FEE_ADDRESS)
- Server is the sole authority for game logic - NO client-side decisions
