// ── Settlement Math ──────────────────────────────────────────────────────────

/** Convert a USDC decimal string like "1.20" to atomic units (bigint, 6 decimals) */
export function atomicUsdc(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

/** Convert atomic units (bigint) back to a USDC decimal string */
export function decimalUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

// ── Fee Adjustment ───────────────────────────────────────────────────────────

export interface FeeAdjustmentResult {
  adjusted: boolean;
  amountToSend: bigint;
  reason?: string;
}

/**
 * Adjust settlement amount for MB fees.
 * If fee >= amount, return null (can't settle).
 * If fee > 0 and < amount, return amount - fee.
 * Otherwise return the original amount.
 */
export function adjustForFees(amount: bigint, feeTokens: bigint): FeeAdjustmentResult {
  if (feeTokens >= amount) {
    return { adjusted: false, amountToSend: 0n, reason: "fee exceeds amount" };
  }
  if (feeTokens > 0n) {
    return { adjusted: true, amountToSend: amount - feeTokens };
  }
  return { adjusted: false, amountToSend: amount };
}

// ── Balance Threshold ────────────────────────────────────────────────────────

export interface BalanceCheck {
  received: bigint;
  required: bigint;
  sufficient: boolean;
  percentFunded: number;
}

/** Check if balance meets required threshold */
export function checkBalance(received: bigint, required: bigint): BalanceCheck {
  const sufficient = received >= required && received > 0n;
  const percentFunded = required > 0n ? Number((received * 100n) / required) : 0;
  return { received, required, sufficient, percentFunded };
}

// ── Capability / Token Matching ──────────────────────────────────────────────

import { createHash, timingSafeEqual } from "node:crypto";

/** Hash a plaintext token and return hex */
export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of a token against its expected hash */
export function capabilityMatches(raw: string | undefined, expectedHash: string | null): boolean {
  if (!raw || !expectedHash) return false;
  const actual = createHash("sha256").update(raw).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Session Expiry ───────────────────────────────────────────────────────────

export function isExpired(expiresAt: Date): boolean {
  return expiresAt <= new Date();
}

export function sessionTimeRemaining(expiresAt: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
}

// ── MB Minimum Threshold ─────────────────────────────────────────────────────

export const MB_MIN_SETTLEMENT = 500_000n; // 0.50 USDC

export function shouldUseMb(amount: bigint): boolean {
  return amount >= MB_MIN_SETTLEMENT;
}
