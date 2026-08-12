import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeysTable, db } from "@workspace/db";
import { getPrivyAppId } from "../lib/privy.js";

export type MerchantPrincipal = { merchantId: string; method: "api-key" | "privy" };

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

async function privyPrincipal(token: string): Promise<MerchantPrincipal | null> {
  const appId = getPrivyAppId();
  const response = await fetch("https://auth.privy.io/api/v1/users/me", {
    headers: { Authorization: `Bearer ${token}`, "privy-app-id": appId },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { id?: string; user?: { id?: string } };
  const merchantId = body.user?.id ?? body.id;
  return merchantId ? { merchantId, method: "privy" } : null;
}

export async function requireMerchant(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = credential(req);
    if (!raw) { res.status(401).json({ error: "merchant authentication required" }); return; }
    const principal = await apiKeyPrincipal(raw) ?? await privyPrincipal(raw);
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

export function requirePrivy(_req: Request, res: Response, next: NextFunction): void {
  if (merchantPrincipal(res).method !== "privy") { res.status(403).json({ error: "Privy login required" }); return; }
  next();
}

export function capabilityMatches(raw: string | undefined, expectedHash: string | null): boolean {
  if (!raw || !expectedHash) return false;
  const actual = Buffer.from(createHash("sha256").update(raw).digest("hex"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}