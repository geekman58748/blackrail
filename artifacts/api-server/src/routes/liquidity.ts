import { Router } from "express";
import {
  seedPool,
  linkBankAccount,
  getMerchantBank,
  settleToNaira,
  getMerchantSettlements,
  getPoolStats,
  usdcToNgn,
} from "../lib/liquidity.js";
import { NG_BANK_CODES } from "../lib/flutterwave.js";
import { merchantPrincipal, requireMerchant } from "../middlewares/auth.js";
import { db, usersTable, eq } from "@workspace/db";

const router = Router();

// ── GET /liquidity/pool — pool status (admin) ───────────────────────────────

router.get("/liquidity/pool", requireMerchant, async (_req, res): Promise<void> => {
  try {
    const stats = await getPoolStats();
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /liquidity/pool/seed — seed NGN into pool (admin) ───────────────────
// Accepts both authenticated and unauthenticated for demo setup

router.post("/liquidity/pool/seed", async (req, res): Promise<void> => {
  const { amount } = req.body as { amount?: number };
  if (!amount || amount <= 0) {
    res.status(400).json({ error: "amount (in NGN) is required and must be > 0" });
    return;
  }

  try {
    const result = await seedPool(amount);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /liquidity/banks — list supported Nigerian banks ─────────────────────

router.get("/liquidity/banks", async (_req, res): Promise<void> => {
  const banks = Object.entries(NG_BANK_CODES).map(([name, code]) => ({ name, code }));
  res.json(banks);
});

// ── POST /liquidity/bank/link — link merchant's Nigerian bank account ────────
// Accepts userId in body for demo setup

router.post("/liquidity/bank/link", async (req, res): Promise<void> => {
  const { userId, email, bankName, accountNumber } = req.body as {
    userId?: number;
    email?: string;
    bankName?: string;
    accountNumber?: string;
  };

  if ((!userId && !email) || !bankName || !accountNumber) {
    res.status(400).json({ error: "userId (or email), bankName, and accountNumber are required" });
    return;
  }

  if (!NG_BANK_CODES[bankName]) {
    res.status(400).json({
      error: `Unsupported bank: ${bankName}`,
      supported: Object.keys(NG_BANK_CODES),
    });
    return;
  }

  if (!/^\d{10}$/.test(accountNumber)) {
    res.status(400).json({ error: "accountNumber must be exactly 10 digits" });
    return;
  }

  try {
    // Resolve userId from email if not given directly
    let resolvedUserId = userId;
    if (!resolvedUserId && email) {
      const normalizedEmail = email.trim().toLowerCase();
      const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
      if (!user) {
        res.status(404).json({ error: `No BlackRail account found for ${normalizedEmail}` });
        return;
      }
      resolvedUserId = user.id;
    }
    const bank = await linkBankAccount({ userId: resolvedUserId!, bankName, accountNumber });
    res.json({
      ok: true,
      bank: {
        bankName: bank.bankName,
        accountNumber: bank.accountNumber,
        accountName: bank.accountName,
        bankCode: bank.bankCode,
      },
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /liquidity/bank — get merchant's linked bank account ─────────────────

router.get("/liquidity/bank", requireMerchant, async (req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const bank = await getMerchantBank(Number(merchantId));

  if (!bank) {
    res.json({ linked: false });
    return;
  }

  res.json({
    linked: true,
    bankName: bank.bankName,
    accountNumber: bank.accountNumber,
    accountName: bank.accountName,
  });
});

// ── POST /liquidity/settle — trigger NGN settlement for a session ───────────
// Accepts merchantUserId in body for demo setup

router.post("/liquidity/settle", async (req, res): Promise<void> => {
  const { merchantUserId, sessionId, usdcAmount } = req.body as {
    merchantUserId?: number;
    sessionId?: string;
    usdcAmount?: number;
  };

  if (!merchantUserId || !sessionId || !usdcAmount) {
    res.status(400).json({ error: "merchantUserId, sessionId, and usdcAmount are required" });
    return;
  }

  try {
    const settlement = await settleToNaira({
      sessionId,
      merchantUserId: Number(merchantUserId),
      usdcAmount,
    });

    res.json({
      ok: true,
      settlement: {
        id: settlement.id,
        nairaAmount: settlement.nairaAmount,
        usdcAmount: settlement.usdcAmount,
        exchangeRate: settlement.exchangeRate,
        status: settlement.status,
        bankName: settlement.bankName,
        accountNumber: settlement.accountNumber,
        accountName: settlement.accountName,
        flutterwaveTransferId: settlement.flutterwaveTransferId,
        createdAt: settlement.createdAt?.toISOString(),
        completedAt: settlement.completedAt?.toISOString(),
      },
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /liquidity/settlements — merchant's settlement history ───────────────

router.get("/liquidity/settlements", requireMerchant, async (req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const limit = Number(req.query.limit) || 20;

  try {
    const settlements = await getMerchantSettlements(Number(merchantId), limit);
    res.json(
      settlements.map((s) => ({
        id: s.id,
        sessionId: s.sessionId,
        nairaAmount: s.nairaAmount,
        usdcAmount: s.usdcAmount,
        exchangeRate: s.exchangeRate,
        status: s.status,
        bankName: s.bankName,
        accountNumber: s.accountNumber,
        accountName: s.accountName,
        statusMessage: s.statusMessage,
        createdAt: s.createdAt?.toISOString(),
        completedAt: s.completedAt?.toISOString(),
      }))
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /liquidity/quote — get conversion quote ──────────────────────────────

router.get("/liquidity/quote", async (req, res): Promise<void> => {
  const usdc = Number(req.query.usdc) || 0;
  if (usdc <= 0) {
    res.status(400).json({ error: "usdc query param required" });
    return;
  }

  const stats = await getPoolStats();
  const nairaAmount = usdcToNgn(usdc, stats.rate);

  res.json({
    usdc,
    naira: nairaAmount,
    rate: stats.rate,
    poolBalance: stats.balance,
    sufficient: stats.balance >= nairaAmount,
  });
});

export default router;
