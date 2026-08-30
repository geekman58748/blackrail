import { Router } from "express";
import { eq } from "drizzle-orm";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { db, usersTable, walletsTable } from "@workspace/db";
import { getCachedBalance, setCachedBalance, getDefaultConnection, withTimeout } from "../lib/rpc-cache.js";

const router = Router();

// ── Auth helper: get user from session token ─────────────────────────────────

async function getUserFromToken(req: any) {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!sessionToken) return null;

  const { loginSessionsTable } = await import("@workspace/db");
  const [session] = await db
    .select()
    .from(loginSessionsTable)
    .where(eq(loginSessionsTable.token, sessionToken));
  if (!session || session.expiresAt < new Date()) return null;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId));
  return user ?? null;
}

// ── RPC / config ─────────────────────────────────────────────────────────────

import { DEFAULT_USDC_MINT } from "../lib/config.js";

function getUsdcMint(): PublicKey {
  return new PublicKey(process.env.USDC_MINT ?? DEFAULT_USDC_MINT);
}

function getConnection() {
  return getDefaultConnection();
}

// ── GET /wallet/balance — user's own wallet USDC balance ─────────────────────

router.get("/wallet/balance", async (req, res): Promise<void> => {
  const user = await getUserFromToken(req);
  if (!user) { res.status(401).json({ error: "not authenticated" }); return; }

  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, user.id));
  if (!wallet) { res.status(404).json({ error: "no wallet found" }); return; }

  try {
    const conn = getConnection();
    const mint = getUsdcMint();
    const cacheKey = `wallet:${wallet.publicKey}`;
    const cached = getCachedBalance(cacheKey);
    let balanceStr: string;
    if (cached !== null) {
      balanceStr = cached;
    } else {
      const ata = getAssociatedTokenAddressSync(mint, new PublicKey(wallet.publicKey));
      const acct = await withTimeout(getAccount(conn, ata), 8000, "wallet/balance");
      balanceStr = acct.amount.toString();
      setCachedBalance(cacheKey, balanceStr);
    }
    res.json({ balance: balanceStr, publicKey: wallet.publicKey });
  } catch {
    // ATA doesn't exist yet or zero balance
    res.json({ balance: "0", publicKey: wallet.publicKey });
  }
});

// ── POST /wallet/withdraw — send USDC to any Solana address ──────────────────

router.post("/wallet/withdraw", async (req, res): Promise<void> => {
  const user = await getUserFromToken(req);
  if (!user) { res.status(401).json({ error: "not authenticated" }); return; }

  const { destination, amount } = req.body as { destination?: string; amount?: string };
  if (!destination || !amount) {
    res.status(400).json({ error: "destination and amount are required" });
    return;
  }

  // Validate Solana address
  let destPk: PublicKey;
  try {
    destPk = new PublicKey(destination);
  } catch {
    res.status(400).json({ error: "invalid Solana address" });
    return;
  }

  // Parse amount (USDC has 6 decimals)
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    res.status(400).json({ error: "invalid amount" });
    return;
  }
  const atomicAmount = BigInt(Math.round(amountNum * 1_000_000));

  // Get wallet and decrypt private key
  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, user.id));
  if (!wallet) { res.status(404).json({ error: "no wallet found" }); return; }

  let privateKey: string;
  try {
    const { decryptSecret } = await import("../lib/secrets.js");
    try {
      privateKey = decryptSecret(wallet.encryptedPrivateKey);
    } catch {
      // Fallback: wallets created before FACADE_ENCRYPTION_KEY used email-derived key
      const { createDecipheriv, createHash } = await import("node:crypto");
      const key = createHash("sha256").update(user.email).digest();
      const [, _ver, ivRaw, tagRaw, ciphertextRaw] = wallet.encryptedPrivateKey.split(":");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
      decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
      privateKey = Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
    }
  } catch (e) {
    res.status(500).json({ error: "failed to decrypt wallet key" });
    return;
  }

  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const conn = getConnection();
    const mint = getUsdcMint();

    const sourceAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
    const destAta = getAssociatedTokenAddressSync(mint, destPk);

    // Check balance first
    let balance = 0n;
    try {
      const acct = await getAccount(conn, sourceAta);
      balance = acct.amount;
    } catch {
      res.status(400).json({ error: "no USDC balance" });
      return;
    }

    if (balance < atomicAmount) {
      res.status(400).json({
        error: "insufficient balance",
        available: (Number(balance) / 1e6).toFixed(2),
        requested: amountNum.toFixed(2),
      });
      return;
    }

    // Build transaction: create dest ATA if needed + transfer
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey, destAta, destPk, mint
      ),
      createTransferInstruction(sourceAta, destAta, keypair.publicKey, atomicAmount)
    );

    const sig = await sendAndConfirmTransaction(conn, tx, [keypair]);
    res.json({ ok: true, signature: sig, amount: amountNum.toFixed(2), destination });
  } catch (e: any) {
    console.error("[wallet/withdraw]", e);
    res.status(500).json({ error: "withdrawal failed", detail: e.message });
  }
});

export default router;
