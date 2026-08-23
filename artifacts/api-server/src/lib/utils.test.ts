import { describe, it, expect } from "vitest";
import {
  atomicUsdc,
  decimalUsdc,
  adjustForFees,
  checkBalance,
  hashToken,
  capabilityMatches,
  isExpired,
  sessionTimeRemaining,
  shouldUseMb,
  MB_MIN_SETTLEMENT,
} from "./utils.js";

// ── atomicUsdc: USDC string → bigint ────────────────────────────────────────

describe("atomicUsdc", () => {
  it("converts whole numbers", () => {
    expect(atomicUsdc("1")).toBe(1_000_000n);
    expect(atomicUsdc("10")).toBe(10_000_000n);
  });

  it("converts decimal amounts", () => {
    expect(atomicUsdc("1.20")).toBe(1_200_000n);
    expect(atomicUsdc("0.50")).toBe(500_000n);
    expect(atomicUsdc("0.01")).toBe(10_000n);
  });

  it("converts zero", () => {
    expect(atomicUsdc("0")).toBe(0n);
    expect(atomicUsdc("0.00")).toBe(0n);
  });

  it("handles amounts with fewer than 6 decimals", () => {
    expect(atomicUsdc("1.5")).toBe(1_500_000n);
    expect(atomicUsdc("2.12")).toBe(2_120_000n);
  });

  it("truncates to 6 decimals (no rounding)", () => {
    expect(atomicUsdc("1.1234567")).toBe(1_123_456n);
    expect(atomicUsdc("0.0000001")).toBe(0n);
  });

  it("handles large amounts", () => {
    expect(atomicUsdc("1000000")).toBe(1_000_000_000_000n);
  });
});

// ── decimalUsdc: bigint → USDC string ───────────────────────────────────────

describe("decimalUsdc", () => {
  it("converts atomic units back to decimal", () => {
    expect(decimalUsdc(1_000_000n)).toBe("1.000000");
    expect(decimalUsdc(1_200_000n)).toBe("1.200000");
  });

  it("converts zero", () => {
    expect(decimalUsdc(0n)).toBe("0.000000");
  });

  it("pads fractions correctly", () => {
    expect(decimalUsdc(10_000n)).toBe("0.010000");
    expect(decimalUsdc(100n)).toBe("0.000100");
    expect(decimalUsdc(1n)).toBe("0.000001");
  });

  it("round-trips with atomicUsdc", () => {
    const original = "3.141592";
    expect(decimalUsdc(atomicUsdc(original))).toBe("3.141592");
  });
});

// ── adjustForFees: MB fee adjustment ─────────────────────────────────────────

describe("adjustForFees", () => {
  it("returns original amount when no fees", () => {
    const result = adjustForFees(1_200_000n, 0n);
    expect(result.amountToSend).toBe(1_200_000n);
    expect(result.adjusted).toBe(false);
  });

  it("subtracts fee when fee < amount", () => {
    const result = adjustForFees(1_200_000n, 50_000n);
    expect(result.amountToSend).toBe(1_150_000n);
    expect(result.adjusted).toBe(true);
  });

  it("returns zero when fee >= amount", () => {
    const result = adjustForFees(1_000_000n, 1_000_000n);
    expect(result.amountToSend).toBe(0n);
    expect(result.reason).toBe("fee exceeds amount");
  });

  it("returns zero when fee > amount", () => {
    const result = adjustForFees(500_000n, 600_000n);
    expect(result.amountToSend).toBe(0n);
    expect(result.reason).toBe("fee exceeds amount");
  });

  it("handles exact fee match at 0.50 USDC", () => {
    const result = adjustForFees(MB_MIN_SETTLEMENT, MB_MIN_SETTLEMENT);
    expect(result.amountToSend).toBe(0n);
    expect(result.reason).toBe("fee exceeds amount");
  });

  it("handles tiny fees", () => {
    const result = adjustForFees(1_200_000n, 1n);
    expect(result.amountToSend).toBe(1_199_999n);
    expect(result.adjusted).toBe(true);
  });
});

// ── checkBalance: payment threshold ──────────────────────────────────────────

describe("checkBalance", () => {
  it("sufficient when balance >= required", () => {
    const result = checkBalance(1_200_000n, 1_200_000n);
    expect(result.sufficient).toBe(true);
    expect(result.percentFunded).toBe(100);
  });

  it("sufficient when balance > required", () => {
    const result = checkBalance(2_000_000n, 1_200_000n);
    expect(result.sufficient).toBe(true);
    expect(result.percentFunded).toBe(166);
  });

  it("insufficient when balance < required", () => {
    const result = checkBalance(500_000n, 1_200_000n);
    expect(result.sufficient).toBe(false);
    expect(result.percentFunded).toBe(41);
  });

  it("insufficient when balance is zero", () => {
    const result = checkBalance(0n, 1_200_000n);
    expect(result.sufficient).toBe(false);
    expect(result.percentFunded).toBe(0);
  });

  it("handles zero required (any positive balance is sufficient)", () => {
    const result = checkBalance(1n, 0n);
    expect(result.sufficient).toBe(true);
  });

  it("insufficient when both zero", () => {
    const result = checkBalance(0n, 0n);
    expect(result.sufficient).toBe(false);
  });
});

// ── hashToken + capabilityMatches: checkout token verification ───────────────

describe("hashToken", () => {
  it("produces consistent SHA-256 hex", () => {
    const hash = hashToken("test-token-123");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different inputs produce different hashes", () => {
    const h1 = hashToken("token-a");
    const h2 = hashToken("token-b");
    expect(h1).not.toBe(h2);
  });

  it("same input produces same hash", () => {
    const h1 = hashToken("consistent");
    const h2 = hashToken("consistent");
    expect(h1).toBe(h2);
  });
});

describe("capabilityMatches", () => {
  it("matches when token hashes to expected", () => {
    const token = "my-checkout-token-abc";
    const hash = hashToken(token);
    expect(capabilityMatches(token, hash)).toBe(true);
  });

  it("rejects wrong token", () => {
    const hash = hashToken("correct-token");
    expect(capabilityMatches("wrong-token", hash)).toBe(false);
  });

  it("rejects undefined token", () => {
    expect(capabilityMatches(undefined, "somehash")).toBe(false);
  });

  it("rejects null expected hash", () => {
    expect(capabilityMatches("token", null)).toBe(false);
  });

  it("rejects empty string token", () => {
    expect(capabilityMatches("", hashToken("token"))).toBe(false);
  });
});

// ── Expiry checks ───────────────────────────────────────────────────────────

describe("isExpired", () => {
  it("returns true for past dates", () => {
    const past = new Date(Date.now() - 10_000);
    expect(isExpired(past)).toBe(true);
  });

  it("returns false for future dates", () => {
    const future = new Date(Date.now() + 600_000);
    expect(isExpired(future)).toBe(false);
  });
});

describe("sessionTimeRemaining", () => {
  it("returns positive seconds for future expiry", () => {
    const future = new Date(Date.now() + 60_000);
    const remaining = sessionTimeRemaining(future);
    expect(remaining).toBeGreaterThan(55);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it("returns 0 for past expiry", () => {
    const past = new Date(Date.now() - 10_000);
    expect(sessionTimeRemaining(past)).toBe(0);
  });
});

// ── MB threshold ────────────────────────────────────────────────────────────

describe("shouldUseMb", () => {
  it("returns true for >= 0.50 USDC", () => {
    expect(shouldUseMb(500_000n)).toBe(true);
    expect(shouldUseMb(1_200_000n)).toBe(true);
    expect(shouldUseMb(10_000_000n)).toBe(true);
  });

  it("returns false for < 0.50 USDC", () => {
    expect(shouldUseMb(499_999n)).toBe(false);
    expect(shouldUseMb(100_000n)).toBe(false);
    expect(shouldUseMb(1n)).toBe(false);
  });

  it("returns false for zero", () => {
    expect(shouldUseMb(0n)).toBe(false);
  });
});
