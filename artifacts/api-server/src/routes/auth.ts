import { Router } from "express";
import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Resend } from "resend";
import {
  db,
  usersTable,
  walletsTable,
  magicLinksTable,
  loginSessionsTable,
} from "@workspace/db";
import { encryptSecret, decryptSecret } from "../lib/secrets.js";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const isProd = process.env.NODE_ENV === "production";

const router = Router();

// ── POST /auth/magic-link — send magic link to email ──────────────────────────

router.post("/auth/magic-link", async (req, res): Promise<void> => {
  const { email } = req.body as { email?: string };
  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    res.status(400).json({ error: "invalid email format" });
    return;
  }

  // Generate token
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  // Upsert user
  let [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
  if (!user) {
    [user] = await db.insert(usersTable).values({ email: normalizedEmail }).returning();
  }

  // Store magic link
  await db.insert(magicLinksTable).values({ token, email: normalizedEmail, purpose: "login", expiresAt });

  const appUrl = process.env.PUBLIC_APP_URL || "https://blackrail.xyz";
  const magicLink = `${appUrl}/pages/auth-callback.html?token=${token}`;

  console.log(`[auth] Magic link for ${normalizedEmail}: ${magicLink}`);

  // Send email via Resend
  let emailSent = false;
  let emailError = '';
  if (resend) {
    try {
      const fromAddr = process.env.EMAIL_FROM || 'BlackRail <onboarding@resend.dev>';
      console.log(`[auth] Sending email from="${fromAddr}" to="${normalizedEmail}"`);
      const sendResult = await resend.emails.send({
        from: fromAddr,
        to: normalizedEmail,
        subject: "Sign in to BlackRail",
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:40px 20px">
            <h2 style="color:#111;font-size:20px;margin-bottom:8px">Sign in to BlackRail</h2>
            <p style="color:#666;font-size:14px;line-height:1.5">Click the button below to sign in. This link expires in 15 minutes.</p>
            <a href="${magicLink}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:100px;font-size:14px;font-weight:600;margin:16px 0">Sign in</a>
            <p style="color:#999;font-size:12px">If you didn't request this, ignore this email.</p>
          </div>
        `,
      });
      emailSent = true;
      console.log(`[auth] Email sent to ${normalizedEmail}, id=${sendResult.data?.id || 'unknown'}`);
    } catch (e: any) {
      emailError = e?.message || String(e);
      console.error(`[auth] Failed to send email to ${normalizedEmail}:`, emailError);
    }
  } else {
    emailError = 'Resend not configured (RESEND_API_KEY missing)';
    console.warn(`[auth] ${emailError}`);
  }

  const response: Record<string, unknown> = { ok: true, message: "Magic link sent" };
  if (!resend && !isProd) response._dev_link = magicLink;
  if (emailError) response._email_warning = emailError;
  res.json(response);
});

// ── POST /auth/verify — verify magic link token, create session ───────────────

router.post("/auth/verify", async (req, res): Promise<void> => {
  const { token } = req.body as { token?: string };
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token is required" });
    return;
  }

  // Find the magic link
  const [link] = await db.select().from(magicLinksTable).where(and(eq(magicLinksTable.token, token), eq(magicLinksTable.purpose, "login")));
  if (!link) {
    res.status(401).json({ error: "invalid token" });
    return;
  }
  if (link.used) {
    res.status(401).json({ error: "token already used" });
    return;
  }
  if (link.expiresAt < new Date()) {
    res.status(401).json({ error: "token expired" });
    return;
  }

  // Mark token as used
  await db.update(magicLinksTable).set({ used: true }).where(eq(magicLinksTable.id, link.id));

  // Find or create user
  let [user] = await db.select().from(usersTable).where(eq(usersTable.email, link.email));
  if (!user) {
    [user] = await db.insert(usersTable).values({ email: link.email }).returning();
  }

  // Auto-generate wallet if user doesn't have one
  let [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, user.id));
  if (!wallet) {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const privateKey = bs58.encode(keypair.secretKey);
    const encryptedPk = encryptSecret(privateKey);

    [wallet] = await db.insert(walletsTable).values({
      userId: user.id,
      publicKey,
      encryptedPrivateKey: encryptedPk,
    }).returning();
    console.log(`[auth] New wallet created for ${link.email}: ${publicKey}`);
  }

  // Create login session (7 days)
  const sessionToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(loginSessionsTable).values({
    token: sessionToken,
    userId: user.id,
    expiresAt,
  });

  res.json({
    ok: true,
    sessionToken,
    user: {
      id: user.id,
      email: user.email,
    },
    wallet: {
      publicKey: wallet.publicKey,
    },
  });
});

// ── GET /auth/me — get current user from session token ────────────────────────

router.get("/auth/me", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!sessionToken) {
    res.status(401).json({ error: "not authenticated" });
    return;
  }

  const [session] = await db
    .select()
    .from(loginSessionsTable)
    .where(eq(loginSessionsTable.token, sessionToken));

  if (!session || session.expiresAt < new Date()) {
    res.status(401).json({ error: "session expired" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId));
  if (!user) {
    res.status(401).json({ error: "user not found" });
    return;
  }

  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, user.id));

  res.json({
    user: { id: user.id, email: user.email },
    wallet: wallet ? { publicKey: wallet.publicKey } : null,
  });
});

// ── POST /auth/reveal-request — send fresh verification email for key reveal ─

router.post("/auth/reveal-request", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!sessionToken) { res.status(401).json({ error: "not authenticated" }); return; }

  const [session] = await db.select().from(loginSessionsTable).where(eq(loginSessionsTable.token, sessionToken));
  if (!session || session.expiresAt < new Date()) { res.status(401).json({ error: "session expired" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId));
  if (!user) { res.status(401).json({ error: "user not found" }); return; }

  // Generate reveal token (5 min expiry)
  const revealToken = "reveal_" + randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.insert(magicLinksTable).values({ token: revealToken, email: user.email, purpose: "reveal", expiresAt });

  const appUrl = process.env.PUBLIC_APP_URL || "https://blackrail.xyz";
  const revealLink = `${appUrl}/pages/auth-callback.html?token=${revealToken}`;
  console.log(`[auth] Reveal link for ${user.email}: ${revealLink}`);

  if (resend) {
    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "BlackRail <onboarding@resend.dev>",
        to: user.email,
        subject: "Confirm Private Key Export — BlackRail",
        html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:40px 20px"><h2 style="color:#111;font-size:20px;margin-bottom:8px">Confirm Key Export</h2><p style="color:#666;font-size:14px;line-height:1.5">Click below to authorize revealing your private key. This link expires in 5 minutes.</p><a href="${revealLink}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:100px;font-size:14px;font-weight:600;margin:16px 0">Confirm Export</a><p style="color:#999;font-size:12px">If you didn\'t request this, ignore this email.</p></div>`,
      });
    } catch (e) { console.error("[auth] Failed to send reveal email:", e); }
  }

  const response: Record<string, unknown> = { ok: true, message: "Verification email sent" };
  if (!resend && !isProd) response._dev_link = revealLink;
  res.json(response);
});

// ── POST /auth/reveal-key — decrypt and return private key ─

router.post("/auth/reveal-key", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!sessionToken) { res.status(401).json({ error: "not authenticated" }); return; }

  const [session] = await db.select().from(loginSessionsTable).where(eq(loginSessionsTable.token, sessionToken));
  if (!session || session.expiresAt < new Date()) { res.status(401).json({ error: "session expired" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId));
  if (!user) { res.status(401).json({ error: "user not found" }); return; }

  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.userId, user.id));
  if (!wallet) { res.status(404).json({ error: "no wallet found" }); return; }

  try {
    let privateKey: string;
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
    res.json({ publicKey: wallet.publicKey, privateKey });
  } catch (e) {
    res.status(500).json({ error: "failed to decrypt wallet" });
  }
});

// ── POST /auth/logout — invalidate session ────────────────────────────────────

router.post("/auth/logout", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (sessionToken) {
    await db.delete(loginSessionsTable).where(eq(loginSessionsTable.token, sessionToken));
  }

  res.json({ ok: true });
});

export default router;
