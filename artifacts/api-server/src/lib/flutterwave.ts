// ── Flutterwave API integration for Nigerian bank transfers ───────────────────
// Docs: https://developer.flutterwave.com/v3.0/docs
// Why Flutterwave over Paystack: Starter account only needs BVN + NIN, no CAC

const FLW_API = "https://api.flutterwave.com/v3";

function getConfig() {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secretKey) throw new Error("FLUTTERWAVE_SECRET_KEY is required but not set");
  return { secretKey };
}

function headers(): Record<string, string> {
  const { secretKey } = getConfig();
  return {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };
}

// ── Nigerian bank codes (Flutterwave format) ─────────────────────────────────

export const NG_BANK_CODES: Record<string, string> = {
  "Access Bank": "044",
  "Citibank Nigeria": "023",
  "Ecobank Nigeria": "050",
  "Fidelity Bank Nigeria": "070",
  "First Bank of Nigeria": "011",
  "First City Monument Bank": "214",
  "Globus Bank": "00100",
  "Guaranty Trust Bank": "058",
  "Heritage Bank": "030",
  "Keystone Bank": "082",
  "Kuda Bank": "090267",
  "Moniepoint": "090405",
  "Opay": "090347",
  "Palmpay": "999991",
  "Polaris Bank": "076",
  "Providus Bank": "101",
  "Stanbic IBTC Bank": "221",
  "Standard Chartered Bank": "068",
  "Sterling Bank": "232",
  "SunTrust Bank": "100",
  "Titan Trust Bank": "102",
  "Union Bank of Nigeria": "032",
  "United Bank for Africa": "033",
  "Unity Bank": "215",
  "VFD Microfinance Bank": "090400",
  "Wema Bank": "035",
  "Zenith Bank": "057",
};

// ── Resolve bank account ─────────────────────────────────────────────────────

export interface ResolvedAccount {
  account_number: string;
  account_name: string;
  bank_code: string;
}

export async function resolveBankAccount(
  accountNumber: string,
  bankCode: string
): Promise<ResolvedAccount> {
  const res = await fetch(`${FLW_API}/accounts/resolve`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      account_number: accountNumber,
      account_bank: bankCode,
    }),
  });
  const body: any = await res.json();

  if (body.status !== "success") {
    throw new Error(body.message || "Failed to resolve bank account");
  }

  return {
    account_number: body.data.account_number,
    account_name: body.data.account_name,
    bank_code: bankCode,
  };
}

// ── Create transfer beneficiary ──────────────────────────────────────────────

export interface TransferBeneficiary {
  id: number;
  account_number: string;
  bank_code: string;
  account_name: string;
}

export async function createBeneficiary(params: {
  account_number: string;
  bank_code: string;
  account_name: string;
}): Promise<TransferBeneficiary> {
  const res = await fetch(`${FLW_API}/beneficiaries`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      account_number: params.account_number,
      bank_code: params.bank_code,
      name: params.account_name,
    }),
  });
  const body: any = await res.json();

  if (body.status !== "success") {
    throw new Error(body.message || "Failed to create beneficiary");
  }

  return {
    id: body.data.id,
    account_number: body.data.account_number,
    bank_code: body.data.bank_code,
    account_name: body.data.name,
  };
}

// ── Initiate transfer ────────────────────────────────────────────────────────

export interface TransferResult {
  id: number;
  reference: string;
  status: string;
  amount: number;
  account_number: string;
  bank_code: string;
}

export async function initiateTransfer(params: {
  beneficiary_id?: number;
  account_number: string;
  bank_code: string;
  amount: number; // in NGN (not kobo — Flutterwave v3 uses full amounts)
  reference?: string;
  narration?: string;
  currency?: string;
}): Promise<TransferResult> {
  const reference = params.reference || `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const payload: Record<string, unknown> = {
    account_bank: params.bank_code,
    account_number: params.account_number,
    amount: params.amount,
    reference,
    narration: params.narration || "BlackRail payment settlement",
    currency: params.currency || "NGN",
  };

  // If we have a beneficiary ID, use it (faster, cached)
  if (params.beneficiary_id) {
    payload.beneficiary = params.beneficiary_id;
  }

  const res = await fetch(`${FLW_API}/transfers`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  const body: any = await res.json();

  if (body.status !== "success") {
    throw new Error(body.message || "Transfer failed");
  }

  return {
    id: body.data.id,
    reference: body.data.reference,
    status: body.data.status,
    amount: body.data.amount,
    account_number: params.account_number,
    bank_code: params.bank_code,
  };
}

// ── Verify transfer ──────────────────────────────────────────────────────────

export async function verifyTransfer(reference: string): Promise<{
  status: string;
  amount: number;
  account_number: string;
  bank_code: string;
}> {
  const res = await fetch(`${FLW_API}/transfers/${reference}`, {
    headers: headers(),
  });
  const body: any = await res.json();

  if (body.status !== "success") {
    throw new Error(body.message || "Transfer verification failed");
  }

  return {
    status: body.data.status,
    amount: body.data.amount,
    account_number: body.data.account_number,
    bank_code: body.data.bank_code,
  };
}

// ── Get balance ──────────────────────────────────────────────────────────────

export async function getBalance(): Promise<{ balance: number; currency: string }> {
  const res = await fetch(`${FLW_API}/balances`, { headers: headers() });
  const body: any = await res.json();

  if (body.status !== "success") {
    throw new Error(body.message || "Failed to get balance");
  }

  // Flutterwave returns an array of balances, find NGN
  const ngnBalance = body.data?.find((b: any) => b.currency === "NGN");
  return {
    balance: ngnBalance?.balance || 0,
    currency: "NGN",
  };
}

// ── List banks ───────────────────────────────────────────────────────────────

export async function listBanks(): Promise<Array<{ name: string; code: string }>> {
  const res = await fetch(`${FLW_API}/banks/NG`, { headers: headers() });
  const body: any = await res.json();

  if (body.status !== "success") {
    throw new Error(body.message || "Failed to list banks");
  }

  return body.data.map((b: any) => ({ name: b.name, code: b.code }));
}
