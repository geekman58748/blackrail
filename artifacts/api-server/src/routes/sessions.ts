import { Router, type Request } from "express";
import { randomBytes } from "crypto";
import { and, db, eq, or, sessionsTable, paymentsTable, walletsTable, usersTable } from "@workspace/db";
import { CreateSessionBody } from "@workspace/api-zod";
import {
  createFacade,
  getFacadeBalance,
  settleFacade,
} from "../lib/solana.js";
import { capabilityMatches, merchantPrincipal, requireMerchant } from "../middlewares/auth.js";
import { decryptSecret, encryptSecret, hashCapability } from "../lib/secrets.js";
import { notifyMerchant, sendBuyerReceipt, type PaymentNotification } from "../lib/notifications.js";

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
    console.error('[sessions] createFacade FAILED:', String(e));
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
  res.json({ balance: balance.toString() });
});

router.post("/sessions/:id/settle", async (req, res): Promise<void> => {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, req.params.id));
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  if (!capabilityMatches(checkoutCapability(req), row.checkoutTokenHash)) {
    res.status(401).json({ error: "invalid checkout capability" }); return;
  }
  // Accept buyer email from checkout page
  const buyerEmail = (req.body as any)?.buyerEmail || (req.headers["x-buyer-email"] as string) || null;
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
    // Look up user's wallet to send settlement to their dedicated address
    const merchantUserId = Number(claimed.merchantId);
    console.log(`[settle] merchantId=${claimed.merchantId}, userId=${merchantUserId}`);
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, merchantUserId));
    const destinationAddress = wallet?.publicKey ?? undefined;
    console.log(`[settle] wallet=${wallet?.publicKey ?? 'NONE'}, destination=${destinationAddress ?? 'FALLBACK to server'}`);

    // Decrypt recipient wallet key for MB auto-withdraw
    let recipientPrivateKey: string | undefined;
    if (wallet?.encryptedPrivateKey) {
      // Try primary decrypt (FACADE_ENCRYPTION_KEY)
      try {
        recipientPrivateKey = decryptSecret(wallet.encryptedPrivateKey);
        console.log(`[settle] decrypted recipient wallet key via FACADE_ENCRYPTION_KEY`);
      } catch (e1) {
        console.warn(`[settle] FACADE_ENCRYPTION_KEY decrypt failed, trying email fallback:`, String(e1).slice(0, 80));
        // Fallback: wallets created before FACADE_ENCRYPTION_KEY used email-derived key
        try {
          const [merchantUser] = await db.select().from(usersTable).where(eq(usersTable.id, merchantUserId));
          if (merchantUser) {
            const { createDecipheriv, createHash } = await import("node:crypto");
            const key = createHash("sha256").update(merchantUser.email).digest();
            const parts = wallet.encryptedPrivateKey.split(":");
            const [, _ver, ivRaw, tagRaw, ciphertextRaw] = parts;
            const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
            decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
            recipientPrivateKey = Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
            console.log(`[settle] decrypted recipient wallet key via email fallback`);
          }
        } catch (e2) {
          console.warn(`[settle] email fallback decrypt also failed:`, String(e2).slice(0, 80));
        }
      }
    } else {
      console.warn(`[settle] wallet has no encryptedPrivateKey — cannot auto-withdraw`);
    }

    // Decrypt with retry — transient RPC errors can cause first attempt to fail
    let decryptedKey: string;
    try {
      decryptedKey = decryptSecret(claimed.facadeKeypairB58!);
    } catch (decryptErr) {
      console.error(`[settle] decrypt FAILED for session ${claimed.id}: ${decryptErr}`);
      console.error(`[settle] enc_prefix=${claimed.facadeKeypairB58!.slice(0, 20)}...`);
      // Store the failed state with actionable error message
      const errMsg = `decrypt failed — check FACADE_ENCRYPTION_KEY_PREVIOUS includes the key used when this session was created: ${decryptErr}`;
      await db.update(sessionsTable).set({ status: "settlement_failed", settlementError: errMsg })
        .where(and(eq(sessionsTable.id, claimed.id), eq(sessionsTable.status, "settling")));
      res.status(502).json({ error: "settlement failed", detail: errMsg });        return;
    }

    // Fire settlement in background — return 200 immediately so the
    // checkout UI transitions without waiting for MB transfer+withdraw+crank.
    const settledAt = new Date();
    res.status(200).json({ sig: "pending", private: true, status: "settled" });
    // Clear polling on the client side
    settleFacade(decryptedKey, claimed.facadeAddress, claimed.id, destinationAddress, recipientPrivateKey).then(async (sig) => {
    await db.transaction(async (tx) => {
      await tx.update(sessionsTable).set({
        status: "settled",
        settlementTxHash: sig,
        settlementPrivate: true,
        receivedAmount: decimalUsdc(received),
        settledAt,
        settlementError: null,
        facadeKeypairB58: null,
        ...(buyerEmail ? { buyerEmail } : {}),
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
    // Fire notifications (non-blocking)
    const [merchantUser] = await db.select().from(usersTable).where(eq(usersTable.id, merchantUserId));
    if (merchantUser) {
      const notificationPayload: PaymentNotification = {
        event: "payment.settled",
        session: {
          id: claimed.id,
          label: claimed.label,
          amount: claimed.amount ?? "0",
          currency: claimed.currency,
          facadeAddress: claimed.facadeAddress,
          txHash: sig,
          receivedAmount: decimalUsdc(received),
          settledAt: new Date().toISOString(),
        },
        merchant: {
          id: claimed.merchantId,
          email: merchantUser.email,
        },
      };
      notifyMerchant(
        merchantUser.email,
        merchantUser.webhookUrl ?? null,
        merchantUser.webhookSecret ?? null,
        merchantUser.emailNotifications,
        notificationPayload
      ).catch(() => {});
    }

    }).catch((bgErr) => console.error("[settle] background settlement failed:", bgErr));

    // Send buyer receipt email (non-blocking)
    if (buyerEmail) {
      sendBuyerReceipt(buyerEmail, {
        sessionId: claimed.id,
        label: claimed.label,
        amount: decimalUsdc(received),
        currency: claimed.currency,
        facadeAddress: claimed.facadeAddress,
        txHash: sig,
        settledAt: settledAt.toISOString(),
      }).catch(() => {});
    }
  } catch (e) {
    const errMsg = String(e);
    console.error(`[settle] FAILED for session ${claimed.id}: ${errMsg}`);
    await db.update(sessionsTable).set({ status: "settlement_failed", settlementError: errMsg })
      .where(and(eq(sessionsTable.id, claimed.id), eq(sessionsTable.status, "settling")));
    res.status(502).json({ error: "settlement failed", detail: errMsg });
  }
});

// ── GET /sessions/failed — list all failed settlements for admin recovery ────
router.get("/sessions/failed", requireMerchant, async (_req, res): Promise<void> => {
  const { merchantId } = merchantPrincipal(res);
  const rows = await db.select().from(sessionsTable)
    .where(and(eq(sessionsTable.merchantId, merchantId), eq(sessionsTable.status, "settlement_failed")));
  res.json(rows.map((r) => ({
    id: r.id,
    facadeAddress: r.facadeAddress,
    label: r.label,
    amount: r.amount,
    currency: r.currency,
    settlementError: r.settlementError,
    createdAt: r.createdAt,
    facadeKeypairB58: r.facadeKeypairB58 ? "[encrypted]" : "[missing]",
  })));
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
