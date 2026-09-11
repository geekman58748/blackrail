// ── Paystack API integration for Nigerian bank transfers ─────────────────────
// Docs: https://paystack.com/docs/api/

const PAYSTACK_API = "https://api.paystack.co";

function getKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is required but not set");
  return key;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getKey()}`,
    "Content-Type": "application/json",
  };
}

// ── Nigerian bank codes (top banks) ──────────────────────────────────────────

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
  bank_id: number;
}

export async function resolveBankAccount(
  accountNumber: string,
  bankCode: string
): Promise<ResolvedAccount> {
  const url = `${PAYSTACK_API}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`;
  const res = await fetch(url, { headers: headers() });
  const body: any = await res.json();

  if (!body.status) {
    throw new Error(body.message || "Failed to resolve bank account");
  }

  return {
    account_number: body.data.account_number,
    account_name: body.data.account_name,
    bank_id: body.data.bank_id,
  };
}

// ── Create transfer recipient ────────────────────────────────────────────────

export interface TransferRecipient {
  recipient_code: string;
  type: string;
  name: string;
  account_number: string;
  bank_code: string;
}

export async function createTransferRecipient(params: {
  name: string;
  account_number: string;
  bank_code: string;
  type?: string;
}): Promise<TransferRecipient> {
  const res = await fetch(`${PAYSTACK_API}/transferrecipient`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: params.type || "nuban",
      name: params.name,
      account_number: params.account_number,
      bank_code: params.bank_code,
      currency: "NGN",
    }),
  });
  const body: any = await res.json();

  if (!body.status) {
    throw new Error(body.message || "Failed to create transfer recipient");
  }

  return body.data;
}

// ── Initiate transfer ────────────────────────────────────────────────────────

export interface TransferResult {
  reference: string;
  transfer_code: string;
  status: string;
  amount: number;
}

export async function initiateTransfer(params: {
  recipient: string; // recipient_code
  amount: number; // in kobo (NGN * 100)
  reference?: string;
  reason?: string;
  currency?: string;
}): Promise<TransferResult> {
  const reference = params.reference || `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const res = await fetch(`${PAYSTACK_API}/transfer`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      source: "balance",
      recipient: params.recipient,
      amount: params.amount, // Paystack expects amount in kobo
      reference,
      reason: params.reason || "BlackRail payment settlement",
      currency: params.currency || "NGN",
    }),
  });
  const body: any = await res.json();

  if (!body.status) {
    throw new Error(body.message || "Transfer failed");
  }

  return {
    reference: body.data.reference,
    transfer_code: body.data.transfer_code,
    status: body.data.status,
    amount: body.data.amount,
  };
}

// ── Verify transfer ──────────────────────────────────────────────────────────

export async function verifyTransfer(reference: string): Promise<{
  status: string;
  amount: number;
  recipient: { name: string; account_number: string };
}> {
  const res = await fetch(`${PAYSTACK_API}/transfer/verify/${reference}`, {
    headers: headers(),
  });
  const body: any = await res.json();

  if (!body.status) {
    throw new Error(body.message || "Transfer verification failed");
  }

  return {
    status: body.data.status,
    amount: body.data.amount,
    recipient: {
      name: body.data.recipient.name,
      account_number: body.data.recipient.account_number,
    },
  };
}

// ── Get balance ──────────────────────────────────────────────────────────────

export async function getPaystackBalance(): Promise<{ available: number; currency: string }> {
  const res = await fetch(`${PAYSTACK_API}/balance`, { headers: headers() });
  const body: any = await res.json();

  if (!body.status) {
    throw new Error(body.message || "Failed to get balance");
  }

  return {
    available: body.data.balance,
    currency: body.data.currency,
  };
}

// ── List banks ───────────────────────────────────────────────────────────────

export async function listBanks(): Promise<Array<{ name: string; code: string }>> {
  const res = await fetch(`${PAYSTACK_API}/bank?country=nigeria`, { headers: headers() });
  const body: any = await res.json();

  if (!body.status) {
    throw new Error(body.message || "Failed to list banks");
  }

  return body.data.map((b: any) => ({ name: b.name, code: b.code }));
}
