import { Router } from "express";
import { db, desc, eq, paymentsTable } from "@workspace/db";
import { isWithdrawConfigured, getVaultBalance, getVaultAddress, withdrawFromVault } from "../lib/solana.js";
import { merchantPrincipal, requireMerchant } from "../middlewares/auth.js";

const router = Router();

router.get("/vault/balance", async (_req, res): Promise<void> => {
  if (!isWithdrawConfigured()) { res.json({ balance: null, configured: false }); return; }
  const raw = await getVaultBalance();
  const { wallet, ata } = getVaultAddress();
  res.json({ balance: (Number(raw) / 1e6).toFixed(6), configured: true, wallet, ata });
});

router.use(requireMerchant);

router.post("/vault/withdraw", async (req, res): Promise<void> => {
  const secret = req.headers["x-withdraw-secret"];
  if (!secret || secret !== process.env.WITHDRAW_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!isWithdrawConfigured()) {
    res.status(400).json({ error: "VAULT_KEYPAIR not set — add it to Railway env vars to enable withdrawals" });
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

router.get("/payments/stats", async (_req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const query = db.select().from(paymentsTable).orderBy(desc(paymentsTable.createdAt));
  const all = await query.where(eq(paymentsTable.merchantId, merchantId));

  const totalUSDC = all.reduce((acc, p) => acc + parseFloat(p.amount), 0);
  const recent = all.slice(0, 10).map(serialize);

  res.json({ totalUSDC, totalPayments: all.length, recent });
});

router.get("/payments", async (_req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const query = db.select().from(paymentsTable).orderBy(desc(paymentsTable.createdAt));
  const rows = await query.where(eq(paymentsTable.merchantId, merchantId));
  res.json(rows.map(serialize));
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
