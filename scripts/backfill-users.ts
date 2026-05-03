// scripts/backfill-users.ts
//
// One-shot backfill for the Anti-cheat L1 `users` table (Task #46).
// Scans the existing `matches` table, collects every distinct wallet
// referenced as player1/player2/winner/loser, and upserts a row with
// status='active' and firstSeenAt/lastSeenAt set from the earliest /
// latest match it appears in.
//
// Idempotent — safe to re-run. Existing rows are touched, never
// downgraded (status preserved, firstSeenAt preserved, lastSeenAt
// advanced if a later match exists).
//
// Run: `npx tsx scripts/backfill-users.ts`

import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { matches, users } from "../shared/schema";

async function main(): Promise<void> {
  console.log("[backfill-users] scanning matches table…");
  const rows = await db
    .select({
      player1Id: matches.player1Id,
      player2Id: matches.player2Id,
      winnerId: matches.winnerId,
      loserId: matches.loserId,
      timestamp: matches.timestamp,
    })
    .from(matches);

  const firstSeen = new Map<string, number>();
  const lastSeen = new Map<string, number>();

  function note(wallet: string | null | undefined, ts: number): void {
    if (!wallet) return;
    const w = String(wallet).trim();
    if (!w) return;
    const prevFirst = firstSeen.get(w);
    if (prevFirst === undefined || ts < prevFirst) firstSeen.set(w, ts);
    const prevLast = lastSeen.get(w);
    if (prevLast === undefined || ts > prevLast) lastSeen.set(w, ts);
  }

  for (const r of rows) {
    const ts = Number(r.timestamp) || Date.now();
    note(r.player1Id, ts);
    note(r.player2Id, ts);
    note(r.winnerId, ts);
    note(r.loserId, ts);
  }

  console.log(
    `[backfill-users] found ${firstSeen.size} distinct wallet(s) across ${rows.length} match row(s)`,
  );

  let inserted = 0;
  let updated = 0;
  for (const [wallet, ts] of firstSeen.entries()) {
    const lastTs = lastSeen.get(wallet) ?? ts;
    // Idempotent upsert. On conflict we ONLY widen the time window
    // (firstSeenAt = LEAST, lastSeenAt = GREATEST) — status / banReason
    // / banned* fields are intentionally preserved so re-running the
    // backfill cannot overwrite an admin-applied ban.
    const res = await db
      .insert(users)
      .values({
        wallet,
        status: "active",
        firstSeenAt: ts,
        lastSeenAt: lastTs,
      })
      .onConflictDoUpdate({
        target: users.wallet,
        set: {
          firstSeenAt: sql`LEAST(${users.firstSeenAt}, ${ts})`,
          lastSeenAt: sql`GREATEST(${users.lastSeenAt}, ${lastTs})`,
        },
      });
    // node-postgres exposes `rowCount` on the underlying result; drizzle
    // hides it but the upsert always succeeds. Rough heuristic: count
    // every row as "processed" — actual insert vs update split is not
    // worth a second SELECT round-trip here.
    inserted++;
    void updated;
    void res;
  }

  console.log(`[backfill-users] processed ${inserted} wallet(s) (idempotent upsert)`);
  await pool.end();
}

main().catch((err) => {
  console.error("[backfill-users] failed:", err);
  process.exitCode = 1;
});
