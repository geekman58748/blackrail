import { Router, type Request, type Response } from "express";
import {
  isWithdrawConfigured,
  getVaultBalance,
  getVaultAddress,
  withdrawFromVault,
} from "../lib/solana.js";
import { merchantPrincipal, requireMerchant } from "../middlewares/auth.js";

const router = Router();

/**
 * GET /api/vault/balance
 * Returns current vault balance and ATA address for this merchant.
 * If vault is not configured, returns configured: false.
 */
router.get("/vault/balance", requireMerchant, async (_req: Request, res: Response): Promise<void> => {
  if (!isWithdrawConfigured()) {
    res.json({ configured: false, balance: null, ata: null });
    return;
  }

  try {
    const balance = await getVaultBalance();
    const { ata } = getVaultAddress();
    res.json({
      configured: true,
      balance: balance.toString(),
      ata,
    });
  } catch (err) {
    console.error("[vault/balance]", err);
    res.status(500).json({ error: "Failed to fetch vault balance" });
  }
});

/**
 * POST /api/vault/withdraw
 * Withdraws funds from vault to destination address.
 * Body: { destination: string, amount?: number }
 * If amount is 0 or omitted, sweeps entire vault.
 */
router.post("/vault/withdraw", requireMerchant, async (req: Request, res: Response): Promise<void> => {
  if (!isWithdrawConfigured()) {
    res.status(501).json({ error: "Withdrawals not configured" });
    return;
  }

  const { destination, amount } = req.body as { destination?: string; amount?: number };
  if (!destination || typeof destination !== "string") {
    res.status(400).json({ error: "destination is required" });
    return;
  }

  try {
    const sendAmount = amount && amount > 0 ? BigInt(Math.floor(amount * 1_000_000)) : BigInt(0);
    const sig = await withdrawFromVault(destination, sendAmount);
    res.json({ sig });
  } catch (err) {
    const message = String(err).toLowerCase();
    if (message.includes("invalid")) {
      res.status(400).json({ error: String(err) });
    } else if (message.includes("empty") || message.includes("available")) {
      res.status(409).json({ error: String(err) });
    } else {
      console.error("[vault/withdraw]", err);
      res.status(500).json({ error: "Withdrawal failed" });
    }
  }
});

export default router;
