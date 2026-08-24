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


router.post("/vault/withdraw", requireMerchant, async (req, res): Promise<void> => {
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

router.get("/payments/stats", requireMerchant, async (_req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const query = db.select().from(paymentsTable).orderBy(desc(paymentsTable.createdAt));
  const all = await query.where(eq(paymentsTable.merchantId, merchantId));

  const totalUSDC = all.reduce((acc, p) => acc + parseFloat(p.amount), 0);
  const avgOrder = all.length > 0 ? totalUSDC / all.length : 0;
  const recent = all.slice(0, 10).map(serialize);

  // Daily breakdown for the last 30 days
  const now = new Date();
  const dailyMap: Record<string, { count: number; volume: number }> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyMap[key] = { count: 0, volume: 0 };
  }
  for (const p of all) {
    const key = p.createdAt.toISOString().slice(0, 10);
    if (dailyMap[key]) {
      dailyMap[key].count++;
      dailyMap[key].volume += parseFloat(p.amount);
    }
  }
  const daily = Object.entries(dailyMap).map(([date, data]) => ({
    date,
    count: data.count,
    volume: Math.round(data.volume * 100) / 100,
  }));

  // Hourly distribution (last 24h) for activity heatmap
  const hourly = Array(24).fill(0);
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  for (const p of all) {
    if (p.createdAt >= last24h) {
      hourly[p.createdAt.getHours()]++;
    }
  }

  res.json({ totalUSDC, avgOrder, totalPayments: all.length, recent, daily, hourly });
});

router.get("/payments", requireMerchant, async (_req, res): Promise<void> => {
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
