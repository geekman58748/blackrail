import { Router } from "express";
import { randomBytes, createHash } from "crypto";
import { eq } from "drizzle-orm";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  db,
  usersTable,
  walletsTable,
  magicLinksTable,
  loginSessionsTable,
} from "@workspace/db";

const router = Router();

// ── Wallet encryption (AES-GCM via Node crypto) ─────────────────────────────

function encryptPrivateKey(privateKey: string, password: string): string {
  const { createCipheriv, randomBytes: rb } = require("node:crypto");
  const key = createHash("sha256").update(password).digest();
  const iv = rb(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "enc:v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

function decryptPrivateKey(encrypted: string, password: string): string {
  const { createDecipheriv } = require("node:crypto");
  const key = createHash("sha256").update(password).digest();
  const [, ivRaw, tagRaw, ciphertextRaw] = encrypted.split(":");
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  const ciphertext = Buffer.from(ciphertextRaw, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

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
  await db.insert(magicLinksTable).values({ token, email: normalizedEmail, expiresAt });

  // In production, send email here. For now, log the link.
  const appUrl = process.env.PUBLIC_APP_URL || "https://blackrail.xyz";
  const magicLink = `${appUrl}/pages/auth-callback.html?token=${token}`;

  console.log(`[auth] Magic link for ${normalizedEmail}: ${magicLink}`);

  // TODO: Replace with email service (Resend, SendGrid, etc.)
  // await sendEmail(normalizedEmail, "Sign in to BlackRail", magicLink);

  res.json({ ok: true, message: "Magic link sent", _dev_link: magicLink });
});

// ── POST /auth/verify — verify magic link token, create session ───────────────

router.post("/auth/verify", async (req, res): Promise<void> => {
  const { token } = req.body as { token?: string };
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token is required" });
    return;
  }

  // Find the magic link
  const [link] = await db.select().from(magicLinksTable).where(eq(magicLinksTable.token, token));
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
    const encryptedPk = encryptPrivateKey(privateKey, link.email);

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

// ── POST /auth/reveal-key — decrypt and return private key ────────────────────

router.post("/auth/reveal-key", async (req, res): Promise<void> => {
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
  if (!wallet) {
    res.status(404).json({ error: "no wallet found" });
    return;
  }

  try {
    const privateKey = decryptPrivateKey(wallet.encryptedPrivateKey, user.email);
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
