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
