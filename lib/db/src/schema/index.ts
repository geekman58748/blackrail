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
  buyerEmail: varchar("buyer_email", { length: 255 }),
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

// ── USERS ────────────────────────────────────────────────────────────────────
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  webhookUrl: varchar("webhook_url", { length: 500 }),
  webhookSecret: varchar("webhook_secret", { length: 100 }),
  emailNotifications: boolean("email_notifications").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

// ── WALLETS ──────────────────────────────────────────────────────────────────
export const walletsTable = pgTable("wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  publicKey: varchar("public_key", { length: 100 }).notNull(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("wallets_user_id_unique").on(table.userId),
]);

export const insertWalletSchema = createInsertSchema(walletsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof walletsTable.$inferSelect;

// ── MAGIC LINKS ──────────────────────────────────────────────────────────────
export const magicLinksTable = pgTable("magic_links", {
  id: serial("id").primaryKey(),
  token: varchar("token", { length: 80 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull(),
  purpose: varchar("purpose", { length: 20 }).notNull().default("login"),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMagicLinkSchema = createInsertSchema(magicLinksTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMagicLink = z.infer<typeof insertMagicLinkSchema>;
export type MagicLink = typeof magicLinksTable.$inferSelect;

// ── LOGIN SESSIONS ───────────────────────────────────────────────────────────
export const loginSessionsTable = pgTable("login_sessions", {
  id: serial("id").primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLoginSessionSchema = createInsertSchema(loginSessionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLoginSession = z.infer<typeof insertLoginSessionSchema>;
export type LoginSession = typeof loginSessionsTable.$inferSelect;

// ── MERCHANT BANK ACCOUNTS (Nigerian) ───────────────────────────────────────
export const merchantBankAccountsTable = pgTable("merchant_bank_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  bankName: varchar("bank_name", { length: 100 }).notNull(),
  bankCode: varchar("bank_code", { length: 10 }).notNull(),
  accountNumber: varchar("account_number", { length: 20 }).notNull(),
  accountName: varchar("account_name", { length: 200 }).notNull(),
  flutterwaveRecipientId: varchar("flutterwave_recipient_id", { length: 50 }),
  isDefault: boolean("is_default").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("merchant_bank_user_unique").on(table.userId),
]);

export const insertMerchantBankAccountSchema = createInsertSchema(merchantBankAccountsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMerchantBankAccount = z.infer<typeof insertMerchantBankAccountSchema>;
export type MerchantBankAccount = typeof merchantBankAccountsTable.$inferSelect;

// ── LIQUIDITY POOL (NGN) ────────────────────────────────────────────────────
export const liquidityPoolTable = pgTable("liquidity_pool", {
  id: serial("id").primaryKey(),
  poolName: varchar("pool_name", { length: 100 }).notNull().default("main"),
  balanceNgn: numeric("balance_ngn", { precision: 20, scale: 2 }).notNull().default("0"),
  seededNgn: numeric("seeded_ngn", { precision: 20, scale: 2 }).notNull().default("0"),
  totalDisbursedNgn: numeric("total_disbursed_ngn", { precision: 20, scale: 2 }).notNull().default("0"),
  usdcRate: numeric("usdc_rate", { precision: 10, scale: 2 }).notNull().default("1360"),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLiquidityPoolSchema = createInsertSchema(liquidityPoolTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLiquidityPool = z.infer<typeof insertLiquidityPoolSchema>;
export type LiquidityPool = typeof liquidityPoolTable.$inferSelect;

// ── NAIRA SETTLEMENTS ───────────────────────────────────────────────────────
export const nairaSettlementsTable = pgTable("naira_settlements", {
  id: serial("id").primaryKey(),
  sessionId: varchar("session_id", { length: 100 }).notNull(),
  merchantUserId: integer("merchant_user_id").notNull().references(() => usersTable.id),
  usdcAmount: numeric("usdc_amount", { precision: 10, scale: 6 }).notNull(),
  nairaAmount: numeric("naira_amount", { precision: 14, scale: 2 }).notNull(),
  exchangeRate: numeric("exchange_rate", { precision: 10, scale: 2 }).notNull(),
  bankName: varchar("bank_name", { length: 100 }),
  accountNumber: varchar("account_number", { length: 20 }),
  accountName: varchar("account_name", { length: 200 }),
  flutterwaveTransferId: varchar("flutterwave_transfer_id", { length: 100 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  statusMessage: text("status_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const insertNairaSettlementSchema = createInsertSchema(nairaSettlementsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertNairaSettlement = z.infer<typeof insertNairaSettlementSchema>;
export type NairaSettlement = typeof nairaSettlementsTable.$inferSelect;
