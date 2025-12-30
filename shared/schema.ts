import { sql } from "drizzle-orm";
import { pgTable, text, varchar, real, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

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

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertMatchSchema = createInsertSchema(matches).omit({
  id: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertMatch = z.infer<typeof insertMatchSchema>;
export type Match = typeof matches.$inferSelect;

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
