import { Router, type Request } from "express";
import { randomBytes } from "crypto";
import { and, db, eq, or, sessionsTable, paymentsTable } from "@workspace/db";
import { CreateSessionBody } from "@workspace/api-zod";
import {
  createFacade,
  getFacadeBalance,
  settleFacade,
} from "../lib/solana.js";
import { capabilityMatches, merchantPrincipal, requireMerchant } from "../middlewares/auth.js";
import { decryptSecret, encryptSecret, hashCapability } from "../lib/secrets.js";

const router = Router();

function checkoutCapability(req: Request): string | undefined {
  return req.header("x-checkout-token")?.trim();
}

function atomicUsdc(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function decimalUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function checkoutOrigin(req: Request): string {
  const configured = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = req.header("origin");
  if (requestOrigin && configured.includes(requestOrigin)) return requestOrigin;
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`;
}

router.get("/sessions", requireMerchant, async (_req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const rows = await db.select().from(sessionsTable).where(eq(sessionsTable.merchantId, merchantId));
  res.json(rows.map(serialize));
});

router.post("/sessions", requireMerchant, async (req, res): Promise<void> => {
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { merchantId } = merchantPrincipal(res);
  const { label, expiryMinutes, amount, currency } = parsed.data;
  if (amount != null && amount < 0.5) {
    res.status(400).json({ error: "amount must be at least 0.50 USDC" });
    return;
  }
  const mins = expiryMinutes ?? 15;
  const id = randomBytes(16).toString("hex");
  const checkoutToken = randomBytes(32).toString("base64url");

  let facadeAddress: string;
  let facadeKeypairB58: string | null = null;

  try {
    const result = await createFacade();
    facadeAddress = result.facadeAddress;
    facadeKeypairB58 = encryptSecret(result.keypairB58);
  } catch (e) {
    res.status(502).json({ error: "Failed to generate facade address", detail: String(e) });
    return;
  }

  const [row] = await db.insert(sessionsTable).values({
    id,
    facadeAddress,
    facadeKeypairB58,
    label,
    expiryMinutes: mins,
    amount: amount != null ? String(amount) : null,
    currency: currency ?? "USDC",
    merchantId,
    checkoutTokenHash: hashCapability(checkoutToken),
    status: "active",
    expiresAt: new Date(Date.now() + mins * 60_000),
  }).returning();

  const origin = checkoutOrigin(req);
  res.status(201).json(serializeWithUrl(row, origin, checkoutToken));
});

router.get("/sessions/:id", async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
  if (!row) { res.status(404).json({ error: "Session not found" }); return; }

  // Public read: anyone with the session ID can view the facade address (for checkout)
  // Token is only required for balance and settle
  if (row.status === "active" && row.expiresAt < new Date()) {
    await db.update(sessionsTable).set({ status: "expired" }).where(eq(sessionsTable.id, id));
    row.status = "expired";
  }

  const origin = checkoutOrigin(req);
  res.json(serializeWithUrl(row, origin));
});

router.get("/sessions/:id/balance", async (req, res): Promise<void> => {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, req.params.id));
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  // Public: anyone can poll the facade balance during checkout
  const balance = await getFacadeBalance(row.facadeAddress);
  res.json({ balance: balance.toString(), er: true });
});

router.post("/sessions/:id/settle", async (req, res): Promise<void> => {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, req.params.id));
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  if (!capabilityMatches(checkoutCapability(req), row.checkoutTokenHash)) {
    res.status(401).json({ error: "invalid checkout capability" }); return;
  }
  if (row.status === "settled" && row.settlementTxHash) {
    res.json({ sig: row.settlementTxHash, private: row.settlementPrivate, status: "settled" });
    return;
  }
  if (row.expiresAt <= new Date()) {
    await db.update(sessionsTable).set({ status: "expired" })
      .where(and(eq(sessionsTable.id, row.id), eq(sessionsTable.status, "active")));
    res.status(410).json({ error: "session expired" });
    return;
  }
  if (!row.facadeKeypairB58) { res.status(400).json({ error: "session has no facade keypair" }); return; }

  const received = await getFacadeBalance(row.facadeAddress);
  const required = row.amount ? atomicUsdc(row.amount) : 1n;
  if (received < required) {
    res.status(409).json({
      error: "payment incomplete",
      required: required.toString(),
      received: received.toString(),
    });
    return;
  }

  // Atomically claim the session
  const [claimed] = await db.update(sessionsTable)
    .set({ status: "settling", settlementStartedAt: new Date(), settlementError: null })
    .where(and(
      eq(sessionsTable.id, row.id),
      or(eq(sessionsTable.status, "active"), eq(sessionsTable.status, "settlement_failed")),
    ))
    .returning();
  if (!claimed) { res.status(409).json({ error: "session settlement already in progress" }); return; }

  try {
    const sig = await settleFacade(decryptSecret(claimed.facadeKeypairB58!), claimed.facadeAddress, claimed.id);
    const settledAt = new Date();
    await db.transaction(async (tx) => {
      await tx.update(sessionsTable).set({
        status: "settled",
        settlementTxHash: sig,
        settlementPrivate: true,
        receivedAmount: decimalUsdc(received),
        settledAt,
        settlementError: null,
        facadeKeypairB58: null,
      }).where(and(eq(sessionsTable.id, claimed.id), eq(sessionsTable.status, "settling")));
      await tx.insert(paymentsTable).values({
        amount: decimalUsdc(received),
        currency: claimed.currency,
        facadeAddress: claimed.facadeAddress,
        sessionId: claimed.id,
        txHash: sig,
        merchantId: claimed.merchantId,
      }).onConflictDoNothing();
    });
    res.json({ sig, private: true, status: "settled" });
  } catch (e) {
    await db.update(sessionsTable).set({ status: "settlement_failed", settlementError: String(e) })
      .where(and(eq(sessionsTable.id, claimed.id), eq(sessionsTable.status, "settling")));
    res.status(502).json({ error: "settlement failed", detail: String(e) });
  }
});

router.delete("/sessions/:id", requireMerchant, async (req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [row] = await db.update(sessionsTable).set({ status: "expired" })
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.merchantId, merchantId))).returning();
  if (!row) { res.status(404).json({ error: "Session not found" }); return; }
  const origin = checkoutOrigin(req);
  res.json(serializeWithUrl(row, origin));
});

function serialize(s: typeof sessionsTable.$inferSelect) {
  return {
    id: s.id,
    facadeAddress: s.facadeAddress,
    label: s.label,
    expiryMinutes: s.expiryMinutes,
    amount: s.amount != null ? parseFloat(s.amount) : null,
    currency: s.currency,
    merchantId: s.merchantId,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  };
}

function serializeWithUrl(s: typeof sessionsTable.$inferSelect, origin: string, checkoutToken?: string) {
  const token = checkoutToken ? `#token=${encodeURIComponent(checkoutToken)}` : "";
  return { ...serialize(s), checkoutUrl: `${origin}/pages/checkout.html?session=${s.id}${token}` };
}

export default router;
