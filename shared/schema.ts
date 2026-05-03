import { sql } from "drizzle-orm";
import { pgTable, varchar, real, bigint, integer, jsonb, index, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const matches = pgTable("matches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  matchId: varchar("match_id").notNull(),
  gameType: varchar("game_type", { length: 20 }).notNull(),
  player1Id: varchar("player1_id").notNull(),
  player2Id: varchar("player2_id").notNull(),
  winnerId: varchar("winner_id"),
  loserId: varchar("loser_id"),
  stake: real("stake").notNull(),
  asset: varchar("asset", { length: 10 }).notNull(),
  pot: real("pot").notNull(),
  fee: real("fee").notNull(),
  payout: real("payout").notNull(),
  reason: varchar("reason", { length: 50 }),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
});

export const insertMatchSchema = createInsertSchema(matches).omit({
  id: true,
});

export type InsertMatch = z.infer<typeof insertMatchSchema>;
export type Match = typeof matches.$inferSelect;

// Anti-cheat L1 — durable per-move audit log. One row is appended for
// every server-validated move in chess, checkers, dominoes, battleship,
// tetris, and xiangqi. Writes are fire-and-forget from the socket hot
// path so a transient DB outage cannot stall live gameplay; the index
// on (match_id, ply) supports the read endpoint and downstream replay.
export const matchMoves = pgTable(
  "match_moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: varchar("match_id").notNull(),
    gameType: varchar("game_type", { length: 20 }).notNull(),
    ply: integer("ply").notNull(),
    actorId: varchar("actor_id").notNull(),
    payload: jsonb("payload").notNull(),
    serverTimestampMs: bigint("server_timestamp_ms", { mode: "number" }).notNull(),
    msSinceLastMove: integer("ms_since_last_move"),
  },
  (t) => ({
    // UNIQUE so a retried insert (the bounded-retry loop in
    // recordMatchMove) cannot create a duplicate ply if a previous
    // attempt actually committed before the client saw the error.
    matchPlyIdx: uniqueIndex("match_moves_match_ply_idx").on(t.matchId, t.ply),
  }),
);

export type MatchMove = typeof matchMoves.$inferSelect;
export type InsertMatchMove = typeof matchMoves.$inferInsert;

// Anti-cheat L1 — soft-ban infrastructure (Task #46).
//
// Every wallet that interacts with the system gets a row here. The
// `status` column is the central authority for matchmaking gating:
//   - 'active'        → normal play
//   - 'shadowbanned'  → matchmaker silently never pairs them (UI shows
//                       a normal "Searching..." spinner)
//   - 'banned'        → explicit rejection at every entry point and
//                       any open sockets are forcibly disconnected
//
// Wallet is the primary key because every other table in the schema
// (matches.player1Id, matchMoves.actorId, etc.) already keys players
// by raw wallet address — there's no separate user-id namespace.
export const users = pgTable(
  "users",
  {
    wallet: varchar("wallet").primaryKey(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    banReason: varchar("ban_reason", { length: 200 }),
    bannedAt: bigint("banned_at", { mode: "number" }),
    bannedBy: varchar("banned_by", { length: 200 }),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    notes: jsonb("notes"),
  },
  (t) => ({
    statusIdx: index("users_status_idx").on(t.status),
  }),
);

export const UserStatusEnum = z.enum(["active", "shadowbanned", "banned"]);
export type UserStatus = z.infer<typeof UserStatusEnum>;
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const ChallengeStatusEnum = z.enum(["pending", "accepted", "expired", "cancelled", "completed"]);
export type ChallengeStatus = z.infer<typeof ChallengeStatusEnum>;

export const ChallengeDataSchema = z.object({
  challengeId: z.string(),
  game: z.string(),
  asset: z.string(),
  stake: z.number(),
  challengerId: z.string(),
  challengerName: z.string(),
  challengerSocketId: z.string().optional(),
  accepterId: z.string().optional(),
  accepterName: z.string().optional(),
  matchId: z.string().optional(),
  status: ChallengeStatusEnum,
  createdAt: z.number(),
  expiresAt: z.number(),
  completedAt: z.number().optional(),
});

export type ChallengeData = z.infer<typeof ChallengeDataSchema>;

export const ChallengeHistoryEntrySchema = z.object({
  timestamp: z.number(),
  status: ChallengeStatusEnum,
  action: z.string(),
});

export type ChallengeHistoryEntry = z.infer<typeof ChallengeHistoryEntrySchema>;
