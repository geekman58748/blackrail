import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  numeric,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── PAYMENTS ──────────────────────────────────────────────────────────────────
export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull().default("USDC"),
  facadeAddress: varchar("facade_address", { length: 100 }).notNull(),
  sessionId: varchar("session_id", { length: 100 }),
  txHash: varchar("tx_hash", { length: 100 }),
  merchantId: varchar("merchant_id", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("payments_session_id_unique").on(table.sessionId),
]);

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof paymentsTable.$inferSelect;

// ── SESSIONS ─────────────────────────────────────────────────────────────────
export const sessionsTable = pgTable("sessions", {
  id: varchar("id", { length: 100 }).primaryKey(),
  facadeAddress: varchar("facade_address", { length: 100 }).notNull(),
  label: text("label").notNull(),
  expiryMinutes: integer("expiry_minutes").notNull().default(15),
  amount: numeric("amount", { precision: 10, scale: 2 }),
  currency: varchar("currency", { length: 10 }).notNull().default("USDC"),
  merchantId: varchar("merchant_id", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  facadeKeypairB58: text("facade_keypair_b58"),
  checkoutTokenHash: varchar("checkout_token_hash", { length: 64 }),
  settlementTxHash: varchar("settlement_tx_hash", { length: 100 }),
  settlementPrivate: boolean("settlement_private"),
  settlementError: text("settlement_error"),
  settlementStartedAt: timestamp("settlement_started_at"),
  settledAt: timestamp("settled_at"),
  receivedAmount: numeric("received_amount", { precision: 20, scale: 6 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({
  createdAt: true,
});
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;

// ── API KEYS ──────────────────────────────────────────────────────────────────
export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  merchantId: varchar("merchant_id", { length: 100 }).notNull(),
  keyHash: varchar("key_hash", { length: 200 }).notNull(),
  keyPrefix: varchar("key_prefix", { length: 24 }).notNull(),
  label: text("label").notNull().default("Default"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
});

export const insertApiKeySchema = createInsertSchema(apiKeysTable).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeysTable.$inferSelect;
