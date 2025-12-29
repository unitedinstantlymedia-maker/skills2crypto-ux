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

- Games: Chess, Tetris (Block Stack), Checkers, Battleship
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
