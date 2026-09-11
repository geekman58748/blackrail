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

router.post("/liquidity/pool/seed", requireMerchant, async (req, res): Promise<void> => {
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

router.post("/liquidity/bank/link", requireMerchant, async (req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const { bankName, accountNumber } = req.body as {
    bankName?: string;
    accountNumber?: string;
  };

  if (!bankName || !accountNumber) {
    res.status(400).json({ error: "bankName and accountNumber are required" });
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
    const userId = Number(merchantId);
    const bank = await linkBankAccount({ userId, bankName, accountNumber });
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

router.post("/liquidity/settle", requireMerchant, async (req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const { sessionId, usdcAmount } = req.body as {
    sessionId?: string;
    usdcAmount?: number;
  };

  if (!sessionId || !usdcAmount) {
    res.status(400).json({ error: "sessionId and usdcAmount are required" });
    return;
  }

  try {
    const settlement = await settleToNaira({
      sessionId,
      merchantUserId: Number(merchantId),
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
        paystackTransferRef: settlement.paystackTransferRef,
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
