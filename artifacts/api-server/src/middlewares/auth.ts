import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeysTable, db, loginSessionsTable, usersTable, walletsTable } from "@workspace/db";

export type MerchantPrincipal = { merchantId: string; method: "api-key" | "session" };

function credential(req: Request): string | null {
  const key = req.header("x-api-key")?.trim();
  if (key) return key;
  const auth = req.header("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

async function apiKeyPrincipal(raw: string): Promise<MerchantPrincipal | null> {
  if (!raw.startsWith("mrg_")) return null;
  const keyHash = createHash("sha256").update(raw).digest("hex");
  const [key] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.keyHash, keyHash)).limit(1);
  if (!key) return null;
  await db.update(apiKeysTable).set({ lastUsedAt: new Date() }).where(eq(apiKeysTable.id, key.id));
  return { merchantId: key.merchantId, method: "api-key" };
}

async function sessionPrincipal(raw: string): Promise<MerchantPrincipal | null> {
  // Session tokens are 64-char hex strings
  if (raw.length !== 64 || !/^[0-9a-f]+$/.test(raw)) return null;

  const [session] = await db
    .select()
    .from(loginSessionsTable)
    .where(eq(loginSessionsTable.token, raw));

  if (!session || session.expiresAt < new Date()) return null;

  // Use user ID as merchant ID
  return { merchantId: String(session.userId), method: "session" };
}

export async function requireMerchant(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = credential(req);
    if (!raw) { res.status(401).json({ error: "merchant authentication required" }); return; }
    const principal = await apiKeyPrincipal(raw) ?? await sessionPrincipal(raw);
    if (!principal) { res.status(401).json({ error: "invalid merchant credential" }); return; }
    res.locals.merchant = principal;
    next();
  } catch (error) {
    req.log?.error({ err: error }, "merchant authentication failed");
    res.status(503).json({ error: "authentication service unavailable" });
  }
}

export function merchantPrincipal(res: Response): MerchantPrincipal {
  const principal = res.locals.merchant as MerchantPrincipal | undefined;
  if (!principal) throw new Error("merchant principal missing");
  return principal;
}

export function capabilityMatches(raw: string | undefined, expectedHash: string | null): boolean {
  if (!raw || !expectedHash) return false;
  const actual = Buffer.from(createHash("sha256").update(raw).digest("hex"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
