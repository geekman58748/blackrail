// ── Liquidity Pool Service ───────────────────────────────────────────────────
// Manages the NGN liquidity pool and handles USDC → NGN settlement
// Uses Flutterwave for bank transfers (no CAC needed for Starter account)

import {
  db,
  liquidityPoolTable,
  nairaSettlementsTable,
  merchantBankAccountsTable,
  eq,
  and,
} from "@workspace/db";
import {
  createBeneficiary,
  initiateTransfer,
  resolveBankAccount,
  NG_BANK_CODES,
} from "./flutterwave.js";

const DEFAULT_RATE = 1360; // NGN per 1 USDC

// ── Get or create the default liquidity pool ─────────────────────────────────

export async function getPool() {
  const [pool] = await db
    .select()
    .from(liquidityPoolTable)
    .where(eq(liquidityPoolTable.poolName, "main"));

  if (!pool) {
    const [created] = await db
      .insert(liquidityPoolTable)
      .values({ poolName: "main", balanceNgn: "0", seededNgn: "0" })
      .returning();
    return created;
  }

  return pool;
}

// ── Seed the pool with NGN ───────────────────────────────────────────────────

export async function seedPool(amountNgn: number): Promise<{
  pool: typeof liquidityPoolTable.$inferSelect;
  message: string;
}> {
  const pool = await getPool();

  const newBalance = Number(pool.balanceNgn) + amountNgn;
  const newSeeded = Number(pool.seededNgn) + amountNgn;

  const [updated] = await db
    .update(liquidityPoolTable)
    .set({
      balanceNgn: String(newBalance),
      seededNgn: String(newSeeded),
      updatedAt: new Date(),
    })
    .where(eq(liquidityPoolTable.id, pool.id))
    .returning();

  console.log(
    `[liquidity] Pool seeded: +₦${amountNgn.toLocaleString()} → balance ₦${newBalance.toLocaleString()}`
  );

  return {
    pool: updated,
    message: `Pool seeded with ₦${amountNgn.toLocaleString()}. New balance: ₦${newBalance.toLocaleString()}`,
  };
}

// ── Convert USDC to NGN ──────────────────────────────────────────────────────

export function usdcToNgn(usdcAmount: number, rate?: number): number {
  return Math.round(usdcAmount * (rate || DEFAULT_RATE) * 100) / 100;
}

// ── Link a merchant's Nigerian bank account ──────────────────────────────────

export async function linkBankAccount(params: {
  userId: number;
  bankName: string;
  accountNumber: string;
}): Promise<typeof merchantBankAccountsTable.$inferSelect> {
  const bankCode = NG_BANK_CODES[params.bankName];
  if (!bankCode) {
    throw new Error(`Unsupported bank: ${params.bankName}. Supported: ${Object.keys(NG_BANK_CODES).join(", ")}`);
  }

  // Resolve account name via Flutterwave
  const resolved = await resolveBankAccount(params.accountNumber, bankCode);

  // Create Flutterwave beneficiary
  const beneficiary = await createBeneficiary({
    account_number: params.accountNumber,
    bank_code: bankCode,
    account_name: resolved.account_name,
  });

  // Upsert bank account
  const [existing] = await db
    .select()
    .from(merchantBankAccountsTable)
    .where(eq(merchantBankAccountsTable.userId, params.userId));

  if (existing) {
    const [updated] = await db
      .update(merchantBankAccountsTable)
      .set({
        bankName: params.bankName,
        bankCode,
        accountNumber: params.accountNumber,
        accountName: resolved.account_name,
        flutterwaveRecipientId: String(beneficiary.id),
        isDefault: true,
      })
      .where(eq(merchantBankAccountsTable.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(merchantBankAccountsTable)
    .values({
      userId: params.userId,
      bankName: params.bankName,
      bankCode,
      accountNumber: params.accountNumber,
      accountName: resolved.account_name,
      flutterwaveRecipientId: String(beneficiary.id),
    })
    .returning();

  return created;
}

// ── Get merchant's bank account ──────────────────────────────────────────────

export async function getMerchantBank(userId: number) {
  const [bank] = await db
    .select()
    .from(merchantBankAccountsTable)
    .where(eq(merchantBankAccountsTable.userId, userId));
  return bank ?? null;
}

// ── Execute NGN settlement (the core function) ──────────────────────────────

export async function settleToNaira(params: {
  sessionId: string;
  merchantUserId: number;
  usdcAmount: number;
}): Promise<typeof nairaSettlementsTable.$inferSelect> {
  const { sessionId, merchantUserId, usdcAmount } = params;

  // 1. Get pool
  const pool = await getPool();
  if (!pool.isActive) {
    throw new Error("Liquidity pool is not active");
  }

  const rate = Number(pool.usdcRate);
  const nairaAmount = usdcToNgn(usdcAmount, rate);

  // 2. Check pool has enough NGN
  const poolBalance = Number(pool.balanceNgn);
  if (poolBalance < nairaAmount) {
    throw new Error(
      `Insufficient liquidity: pool has ₦${poolBalance.toLocaleString()}, need ₦${nairaAmount.toLocaleString()}`
    );
  }

  // 3. Get merchant's bank account
  const bank = await getMerchantBank(merchantUserId);
  if (!bank) {
    throw new Error("Merchant has no linked bank account");
  }

  // 4. Create settlement record (pending)
  const [settlement] = await db
    .insert(nairaSettlementsTable)
    .values({
      sessionId,
      merchantUserId,
      usdcAmount: String(usdcAmount),
      nairaAmount: String(nairaAmount),
      exchangeRate: String(rate),
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      accountName: bank.accountName,
      status: "processing",
    })
    .returning();

  // 5. Initiate Flutterwave transfer
  try {
    if (!bank.flutterwaveRecipientId) {
      throw new Error("No Flutterwave beneficiary ID — re-link bank account");
    }

    const beneficiaryId = parseInt(bank.flutterwaveRecipientId, 10);
    const reference = `br_${sessionId.slice(0, 12)}_${Date.now()}`;

    const transfer = await initiateTransfer({
      beneficiary_id: beneficiaryId,
      account_number: bank.accountNumber,
      bank_code: bank.bankCode,
      amount: nairaAmount, // Flutterwave v3 uses full amounts, not kobo
      reference,
      narration: `BlackRail payment settlement — $${usdcAmount} USDC`,
    });

    // 6. Deduct from pool and record settlement
    await db.transaction(async (tx) => {
      // Deduct from pool
      const newBalance = poolBalance - nairaAmount;
      await tx
        .update(liquidityPoolTable)
        .set({
          balanceNgn: String(newBalance),
          totalDisbursedNgn: String(Number(pool.totalDisbursedNgn) + nairaAmount),
          updatedAt: new Date(),
        })
        .where(eq(liquidityPoolTable.id, pool.id));

      // Update settlement record
      await tx
        .update(nairaSettlementsTable)
        .set({
          status: "sent",
          flutterwaveTransferId: String(transfer.id),
          statusMessage: `Flutterwave transfer ${transfer.status}: ${transfer.reference}`,
          completedAt: new Date(),
        })
        .where(eq(nairaSettlementsTable.id, settlement.id));
    });

    console.log(
      `[liquidity] ₦${nairaAmount.toLocaleString()} sent to ${bank.accountName} (${bank.accountNumber}) via ${bank.bankName} — ref: ${transfer.reference}`
    );

    // Return updated settlement
    const [updated] = await db
      .select()
      .from(nairaSettlementsTable)
      .where(eq(nairaSettlementsTable.id, settlement.id));
    return updated;
  } catch (err: any) {
    // Mark settlement as failed
    await db
      .update(nairaSettlementsTable)
      .set({
        status: "failed",
        statusMessage: err.message || String(err),
      })
      .where(eq(nairaSettlementsTable.id, settlement.id));

    console.error(`[liquidity] Settlement failed for session ${sessionId}:`, err.message);
    throw err;
  }
}

// ── Get settlement history for a merchant ────────────────────────────────────

export async function getMerchantSettlements(userId: number, limit = 20) {
  return db
    .select()
    .from(nairaSettlementsTable)
    .where(eq(nairaSettlementsTable.merchantUserId, userId))
    .then((rows) => rows.slice(0, limit));
}

// ── Get pool stats ───────────────────────────────────────────────────────────

export async function getPoolStats() {
  const pool = await getPool();
  return {
    balance: Number(pool.balanceNgn),
    seeded: Number(pool.seededNgn),
    disbursed: Number(pool.totalDisbursedNgN),
    rate: Number(pool.usdcRate),
    isActive: pool.isActive,
  };
}
