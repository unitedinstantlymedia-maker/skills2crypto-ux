// Lightweight in-memory abuse-rejection counters. Surfaced through the
// existing /api/internal/system-readiness endpoint so dashboards /
// uptime probes can graph spikes in socket-cap and matchmaking-cooldown
// rejections without standing up a full metrics pipeline.

interface AbuseCounters {
  socketCapRejections: number;
  matchmakingCooldownRejections: number;
  lastSocketCapRejectionAt: number | null;
  lastMatchmakingCooldownRejectionAt: number | null;
}

const counters: AbuseCounters = {
  socketCapRejections: 0,
  matchmakingCooldownRejections: 0,
  lastSocketCapRejectionAt: null,
  lastMatchmakingCooldownRejectionAt: null,
};

export function recordSocketCapRejection(): void {
  counters.socketCapRejections += 1;
  counters.lastSocketCapRejectionAt = Date.now();
}

export function recordMatchmakingCooldownRejection(): void {
  counters.matchmakingCooldownRejections += 1;
  counters.lastMatchmakingCooldownRejectionAt = Date.now();
}

export function getAbuseCountersStatus(): Readonly<AbuseCounters> {
  return { ...counters };
}

export function _resetAbuseCountersForTests(): void {
  counters.socketCapRejections = 0;
  counters.matchmakingCooldownRejections = 0;
  counters.lastSocketCapRejectionAt = null;
  counters.lastMatchmakingCooldownRejectionAt = null;
}
