import { Router } from "express";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, sessionsTable } from "@workspace/db";
import { CreateSessionBody } from "@workspace/api-zod";
import {
  isErConfigured,
  createAndDelegateFacade,
  getFacadeBalance,
  settleFacade,
} from "../lib/solana.js";

const router = Router();

function stubFacade(): string {
  // 44-char base58-ish placeholder until ER env vars are set
  return randomBytes(32).toString("base64url").slice(0, 44);
}

router.get("/sessions", async (req, res): Promise<void> => {
  const merchantId = req.query.merchantId as string | undefined;
  const rows = merchantId
    ? await db.select().from(sessionsTable).where(eq(sessionsTable.merchantId, merchantId))
    : await db.select().from(sessionsTable);
  res.json(rows.map(serialize));
});

router.post("/sessions", async (req, res): Promise<void> => {
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { label, expiryMinutes, amount, currency, merchantId } = parsed.data;
  const mins = expiryMinutes ?? 15;
  const id = randomBytes(16).toString("hex");

  let facadeAddress: string;
  let facadeKeypairB58: string | null = null;

  if (isErConfigured()) {
    try {
      const result = await createAndDelegateFacade();
      facadeAddress = result.facadeAddress;
      facadeKeypairB58 = result.keypairB58;
    } catch (e) {
      res.status(502).json({ error: "ER delegation failed", detail: String(e) });
      return;
    }
  } else {
    facadeAddress = stubFacade();
  }

  const [row] = await db.insert(sessionsTable).values({
    id,
    facadeAddress,
    facadeKeypairB58,
    label,
    expiryMinutes: mins,
    amount: amount != null ? String(amount) : null,
    currency: currency ?? "USDC",
    merchantId: merchantId ?? null,
    status: "active",
    expiresAt: new Date(Date.now() + mins * 60_000),
  }).returning();

  const origin = req.headers.origin ?? `${req.protocol}://${req.get("host")}`;
  res.status(201).json(serializeWithUrl(row, origin));
});

router.get("/sessions/:id", async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
  if (!row) { res.status(404).json({ error: "Session not found" }); return; }

  if (row.status === "active" && row.expiresAt < new Date()) {
    await db.update(sessionsTable).set({ status: "expired" }).where(eq(sessionsTable.id, id));
    row.status = "expired";
  }

  const origin = req.headers.origin ?? `${req.protocol}://${req.get("host")}`;
  res.json(serializeWithUrl(row, origin));
});

router.get("/sessions/:id/balance", async (req, res): Promise<void> => {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, req.params.id));
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  if (!isErConfigured()) { res.json({ balance: null, er: false }); return; }
  const balance = await getFacadeBalance(row.facadeAddress);
  res.json({ balance: balance.toString(), er: true });
});

router.post("/sessions/:id/settle", async (req, res): Promise<void> => {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, req.params.id));
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  if (row.status !== "active") { res.status(409).json({ error: `session is ${row.status}` }); return; }
  if (!row.facadeKeypairB58) { res.status(400).json({ error: "session has no ER keypair (stub mode)" }); return; }

  try {
    const sig = await settleFacade(row.facadeKeypairB58, row.facadeAddress);
    await db.update(sessionsTable).set({ status: "settled" }).where(eq(sessionsTable.id, row.id));
    res.json({ sig, status: "settled" });
  } catch (e) {
    res.status(502).json({ error: "settlement failed", detail: String(e) });
  }
});

router.delete("/sessions/:id", async (req, res): Promise<void> => {
  const [row] = await db.update(sessionsTable).set({ status: "expired" })
    .where(eq(sessionsTable.id, req.params.id)).returning();
  if (!row) { res.status(404).json({ error: "Session not found" }); return; }
  const origin = req.headers.origin ?? `${req.protocol}://${req.get("host")}`;
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

function serializeWithUrl(s: typeof sessionsTable.$inferSelect, origin: string) {
  return { ...serialize(s), checkoutUrl: `${origin}/pages/checkout.html?session=${s.id}` };
}

export default router;
