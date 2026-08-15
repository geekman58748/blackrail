import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";
import { LogPaymentBody } from "@workspace/api-zod";
import {
  isErConfigured,
  isWithdrawConfigured,
  getVaultAddress,
  getVaultBalance,
  withdrawFromVault,
} from "../lib/solana.js";

const router = Router();

router.get("/vault/balance", async (_req, res): Promise<void> => {
  if (!isErConfigured()) { res.json({ balance: null, configured: false }); return; }
  try {
    const raw = await getVaultBalance();
    const { wallet, ata } = getVaultAddress();
    res.json({ balance: (Number(raw) / 1e6).toFixed(6), configured: true, wallet, ata });
  } catch (e) {
    res.status(502).json({ error: "vault balance fetch failed", detail: String(e) });
  }
});

router.post("/vault/withdraw", async (req, res): Promise<void> => {
  if (!isWithdrawConfigured()) {
    res.status(400).json({ error: "SERVER_KEYPAIR not set — add it to env vars to enable withdrawals" });
    return;
  }
  const { destination, amount } = req.body as { destination: string; amount?: number };
  if (!destination) { res.status(400).json({ error: "destination required" }); return; }
  try {
    const sig = await withdrawFromVault(destination, BigInt(Math.round((amount ?? 0) * 1e6)));
    res.json({ sig, status: "withdrawn" });
  } catch (e) {
    res.status(502).json({ error: "withdrawal failed", detail: String(e) });
  }
});

router.get("/payments/stats", async (req, res): Promise<void> => {
  const merchantId = req.query.merchantId as string | undefined;

  const query = db.select().from(paymentsTable).orderBy(desc(paymentsTable.createdAt));
  const all = merchantId
    ? await query.where(eq(paymentsTable.merchantId, merchantId))
    : await query;

  const totalUSDC = all.reduce((acc, p) => acc + parseFloat(p.amount), 0);
  const recent = all.slice(0, 10).map(serialize);

  res.json({ totalUSDC, totalPayments: all.length, recent });
});

router.get("/payments", async (req, res): Promise<void> => {
  const merchantId = req.query.merchantId as string | undefined;
  const query = db.select().from(paymentsTable).orderBy(desc(paymentsTable.createdAt));
  const rows = merchantId
    ? await query.where(eq(paymentsTable.merchantId, merchantId))
    : await query;
  res.json(rows.map(serialize));
});

router.post("/payments", async (req, res): Promise<void> => {
  const parsed = LogPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { amount, currency, facadeAddress, sessionId, txHash, merchantId } = parsed.data;
  const [row] = await db
    .insert(paymentsTable)
    .values({
      amount: String(amount),
      currency: currency ?? "USDC",
      facadeAddress,
      sessionId: sessionId ?? null,
      txHash: txHash ?? null,
      merchantId: merchantId ?? null,
    })
    .returning();
  res.status(201).json(serialize(row));
});

function serialize(p: typeof paymentsTable.$inferSelect) {
  return {
    id: p.id,
    amount: parseFloat(p.amount),
    currency: p.currency,
    facadeAddress: p.facadeAddress,
    sessionId: p.sessionId,
    txHash: p.txHash,
    merchantId: p.merchantId,
    createdAt: p.createdAt.toISOString(),
  };
}

export default router;
