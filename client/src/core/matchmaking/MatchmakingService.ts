import { MatchParams, Match, getQueueKey } from "@/core/types";

const STORAGE_KEY_QUEUE = 'skills2crypto_queue';
const STORAGE_KEY_MATCHES = 'skills2crypto_matches';

type QueueEntry = MatchParams & { playerId: string, timestamp: number };
type Queue = Record<string, QueueEntry>;

export class MatchmakingService {
  private static instance: MatchmakingService;

  private constructor() {}

  static getInstance(): MatchmakingService {
    if (!MatchmakingService.instance) {
      MatchmakingService.instance = new MatchmakingService();
    }
    return MatchmakingService.instance;
  }

  private getQueue(): Queue {
    const stored = localStorage.getItem(STORAGE_KEY_QUEUE);
    return stored ? JSON.parse(stored) : {};
  }

  private setQueue(queue: Queue) {
    localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(queue));
  }

  private getMatches(): Record<string, Match> {
    const stored = localStorage.getItem(STORAGE_KEY_MATCHES);
    return stored ? JSON.parse(stored) : {};
  }

  private setMatches(matches: Record<string, Match>) {
    localStorage.setItem(STORAGE_KEY_MATCHES, JSON.stringify(matches));
  }

  // Add player to queue
  enqueue(params: MatchParams, playerId: string): void {
    const queue = this.getQueue();
    // Ensure stake is a number
    const safeParams = { ...params, stake: Number(params.stake) };
    const key = getQueueKey(safeParams.game, safeParams.asset, safeParams.stake);
    const uniqueKey = `${key}:${playerId}`; // Use playerId to prevent duplicate entries from same player? Or allow re-queue?
    
    console.log(`[Matchmaking] Enqueuing - Key: ${key}, Stake: ${safeParams.stake}, Player: ${playerId}`);

    // Check if already in queue to avoid duplicates
    if (queue[uniqueKey]) return;

    queue[uniqueKey] = { ...safeParams, playerId, timestamp: Date.now() };
    this.setQueue(queue);
    console.log(`[Matchmaking] Enqueued successfully: ${uniqueKey}`);

    // SIMULATION: If in prototype mode, trigger a mock match after a delay if no one joins
    // This allows single player testing
    setTimeout(() => {
      this.triggerMockMatch(safeParams, playerId);
    }, Math.random() * 700 + 800); // 800-1500ms delay
  }

  // Create a mock match against a bot for testing
  private triggerMockMatch(params: MatchParams, playerId: string) {
    // Check if player is still in queue (might have cancelled or matched real player)
    const queue = this.getQueue();
    // Use Number() to ensure stake is numeric
    const safeParams = { ...params, stake: Number(params.stake) };
    const key = getQueueKey(safeParams.game, safeParams.asset, safeParams.stake);
    const uniqueKey = `${key}:${playerId}`;
    
    if (!queue[uniqueKey]) {
      console.log(`[Matchmaking] Mock match skipped - player no longer in queue: ${uniqueKey}`);
      return;
    }

    console.log(`[Matchmaking] Triggering mock match for: ${uniqueKey}`);
    
    // Remove self from queue
    delete queue[uniqueKey];
    this.setQueue(queue);

    // Create Active Match with Mock Opponent
    const matchId = Math.random().toString(36).substring(7);
    const mockOpponentId = `mock_bot_${Math.floor(Math.random() * 1000)}`;
    
    const match: Match = {
      id: matchId,
      game: safeParams.game,
      asset: safeParams.asset,
      stake: safeParams.stake,
      status: 'active',
      players: [playerId, mockOpponentId],
      startTime: Date.now()
    };

    // Save match
    const matches = this.getMatches();
    matches[matchId] = match;
    this.setMatches(matches);

    console.log(`[Matchmaking] Mock Match Created: ${matchId} vs ${mockOpponentId} with stake ${match.stake}`);
  }

  // Try to find a match for the player
  tryMatch(params: MatchParams, playerId: string): Match | null {
    const queue = this.getQueue();
    const safeParams = { ...params, stake: Number(params.stake) };
    const key = getQueueKey(safeParams.game, safeParams.asset, safeParams.stake);

    console.log(`[Matchmaking] tryMatch - Key: ${key}, Stake: ${safeParams.stake}`);

    // Look for an entry with DIFFERENT playerId in the same bucket
    const waitingEntries = Object.entries(queue).filter(([k, v]) => k.startsWith(key + ":") && v.playerId !== playerId);

    if (waitingEntries.length > 0) {
      // Match found!
      const [waitingKey, opponent] = waitingEntries[0];
      
      console.log(`[Matchmaking] Match candidates found: ${waitingEntries.length}. Picking ${waitingKey}`);

      // Remove opponent from queue
      delete queue[waitingKey];
      // Remove self from queue if present
      const selfKey = `${key}:${playerId}`;
      if (queue[selfKey]) delete queue[selfKey];

      this.setQueue(queue);

      // Create Active Match
      const matchId = Math.random().toString(36).substring(7);
      const match: Match = {
        id: matchId,
        game: safeParams.game,
        asset: safeParams.asset,
        stake: safeParams.stake,
        status: 'active',
        players: [opponent.playerId, playerId],
        startTime: Date.now()
      };

      // Save match to shared storage so opponent can see it
      const matches = this.getMatches();
      matches[matchId] = match;
      this.setMatches(matches);

      console.log(`[Matchmaking] Match Created: ${matchId}`);
      return match;
    }

    return null;
  }

  cancel(params: MatchParams, playerId: string): void {
    const queue = this.getQueue();
    const key = getQueueKey(params.game, params.asset, params.stake);
    const uniqueKey = `${key}:${playerId}`;
    
    if (queue[uniqueKey]) {
      delete queue[uniqueKey];
      this.setQueue(queue);
      console.log(`[Matchmaking] Cancelled: ${uniqueKey}`);
    }
  }

  // Helper for polling to see if we got matched by someone else
  checkForMatch(playerId: string): Match | null {
    const matches = this.getMatches();
    // Look for active matches where I am a player
    // Prioritize newest matches by sorting by startTime
    // Filter out matches older than 2 minutes to prevent zombie matches
    const NOW = Date.now();
    const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes

    const found = Object.values(matches)
      .filter(m => (m.status === 'active' || m.status === 'finished') && m.players.includes(playerId))
      .filter(m => (NOW - (m.startTime || 0)) < STALE_THRESHOLD) // Only recent matches
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
      .find(Boolean); // Get first (newest)
      
    return found || null;
  }
}

export const matchmakingService = MatchmakingService.getInstance();
