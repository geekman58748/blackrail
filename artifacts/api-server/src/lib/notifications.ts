import { Resend } from "resend";
import { createHmac } from "crypto";

// ── Resend setup ──────────────────────────────────────────────────────────────
const resendKey = process.env.RESEND_API_KEY;
const resend = resendKey ? new Resend(resendKey) : null;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "BlackRail <noreply@blackrail.xyz>";

// ── Webhook firing ────────────────────────────────────────────────────────────
export interface PaymentNotification {
  event: "payment.settled";
  session: {
    id: string;
    label: string;
    amount: string;
    currency: string;
    facadeAddress: string;
    txHash: string;
    receivedAmount: string;
    settledAt: string;
  };
  merchant: {
    id: string;
    email: string;
  };
}

export async function fireWebhook(
  webhookUrl: string,
  webhookSecret: string | null,
  payload: PaymentNotification
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "BlackRail-Webhook/1.0",
  };

  // Sign the payload if a secret is configured
  if (webhookSecret) {
    const signature = createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");
    headers["X-BlackRail-Signature"] = `sha256=${signature}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      console.log(`[webhook] POST ${webhookUrl} returned ${resp.status}`);
      return { ok: false, status: resp.status };
    }

    console.log(`[webhook] POST ${webhookUrl} → ${resp.status}`);
    return { ok: true, status: resp.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[webhook] POST ${webhookUrl} failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ── Email notification ────────────────────────────────────────────────────────
export async function sendPaymentEmail(
  to: string,
  payload: PaymentNotification
): Promise<{ ok: boolean; error?: string }> {
  if (!resend) {
    console.log("[email] Resend not configured, skipping email");
    return { ok: false, error: "resend not configured" };
  }

  const { session } = payload;
  const amount = session.receivedAmount || session.amount;

  try {
    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Payment Received: $${amount} ${session.currency} — ${session.label}`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#f8fafc;border-radius:12px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
            <div style="width:32px;height:32px;border-radius:8px;background:rgba(168,173,196,0.1);border:1px solid rgba(168,173,196,0.15);display:flex;align-items:center;justify-content:center;">
              <span style="color:#a8c4b0;font-size:16px;">✓</span>
            </div>
            <span style="font-weight:700;font-size:16px;letter-spacing:-0.02em;">BlackRail</span>
          </div>

          <div style="background:rgba(168,196,176,0.08);border:1px solid rgba(168,196,176,0.15);border-radius:10px;padding:20px;margin-bottom:20px;text-align:center;">
            <div style="font-size:32px;font-weight:800;color:#fff;margin-bottom:4px;">$${amount}</div>
            <div style="font-size:13px;color:rgba(168,173,196,0.8);font-family:monospace;">${session.currency}</div>
          </div>

          <div style="margin-bottom:20px;">
            <div style="font-size:11px;color:rgba(74,82,100,0.8);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Order</div>
            <div style="font-size:14px;color:#fff;font-weight:500;">${session.label}</div>
          </div>

          <div style="margin-bottom:20px;">
            <div style="font-size:11px;color:rgba(74,82,100,0.8);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Transaction</div>
            <a href="https://solscan.io/tx/${session.txHash}?cluster=devnet" style="font-size:12px;color:#a8c4b0;font-family:monospace;text-decoration:none;">${session.txHash.slice(0, 16)}… ↗</a>
          </div>

          <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;margin-top:16px;">
            <div style="font-size:11px;color:rgba(74,82,100,0.6);">
              Settled at ${new Date(session.settledAt).toLocaleString()} · Facade ${session.facadeAddress.slice(0, 8)}…
            </div>
          </div>
        </div>
      `,
    });

    if (result.error) {
      console.log(`[email] Failed to send to ${to}:`, result.error);
      return { ok: false, error: String(result.error) };
    }

    console.log(`[email] Payment notification sent to ${to}, id=${result.data?.id}`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[email] Error sending to ${to}: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ── Buyer Receipt Email ───────────────────────────────────────────────────────

export interface BuyerReceiptData {
  sessionId: string;
  label: string;
  amount: string;
  currency: string;
  facadeAddress: string;
  txHash: string;
  settledAt: string;
}

export async function sendBuyerReceipt(
  to: string,
  data: BuyerReceiptData
): Promise<{ ok: boolean; error?: string }> {
  if (!resend) {
    console.log("[email] Resend not configured, skipping buyer receipt");
    return { ok: false, error: "resend not configured" };
  }

  try {
    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `Payment Receipt — $${data.amount} ${data.currency}`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:40px 28px;background:#0a0b10;color:#f1f3f9;border-radius:16px;border:1px solid rgba(255,255,255,0.06);">
          <!-- Header -->
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px;">
            <div style="width:36px;height:36px;border-radius:10px;background:rgba(177,141,248,0.1);border:1px solid rgba(177,141,248,0.15);display:flex;align-items:center;justify-content:center;">
              <span style="color:#b18df8;font-size:18px;font-weight:700;">B</span>
            </div>
            <div>
              <span style="font-weight:700;font-size:16px;letter-spacing:-0.02em;color:#fff;">BlackRail</span>
              <span style="display:block;font-size:10px;color:rgba(160,164,185,0.6);letter-spacing:0.08em;text-transform:uppercase;">Private Payment Receipt</span>
            </div>
          </div>

          <!-- Amount Card -->
          <div style="background:rgba(177,141,248,0.06);border:1px solid rgba(177,141,248,0.12);border-radius:12px;padding:28px 20px;margin-bottom:28px;text-align:center;">
            <div style="font-size:40px;font-weight:800;color:#fff;letter-spacing:-0.03em;">$${data.amount}</div>
            <div style="font-size:13px;color:rgba(160,164,185,0.7);font-family:'Courier New',monospace;margin-top:4px;">${data.currency}</div>
            <div style="margin-top:12px;display:inline-flex;align-items:center;gap:6px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.15);border-radius:6px;padding:4px 12px;">
              <span style="color:#4ade80;font-size:12px;">✓</span>
              <span style="color:#4ade80;font-size:11px;font-weight:600;letter-spacing:0.04em;">SETTLED</span>
            </div>
          </div>

          <!-- Transaction Details -->
          <div style="margin-bottom:24px;">
            <div style="font-size:11px;color:rgba(120,124,165,0.7);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;">Transaction Details</div>
            <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:10px;padding:16px;">
              <table style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="font-size:12px;color:rgba(160,164,185,0.6);padding:6px 0;">Order</td>
                  <td style="font-size:12px;color:#fff;font-weight:500;text-align:right;padding:6px 0;">${data.label}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:rgba(160,164,185,0.6);padding:6px 0;border-top:1px solid rgba(255,255,255,0.04);">Session</td>
                  <td style="font-size:11px;color:rgba(200,202,216,0.8);font-family:'Courier New',monospace;text-align:right;padding:6px 0;border-top:1px solid rgba(255,255,255,0.04);">#${data.sessionId.slice(0, 12)}…</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:rgba(160,164,185,0.6);padding:6px 0;border-top:1px solid rgba(255,255,255,0.04);">Settled At</td>
                  <td style="font-size:12px;color:#fff;text-align:right;padding:6px 0;border-top:1px solid rgba(255,255,255,0.04);">${new Date(data.settledAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                </tr>
              </table>
            </div>
          </div>

          <!-- On-Chain Proof -->
          <div style="margin-bottom:24px;">
            <div style="font-size:11px;color:rgba(120,124,165,0.7);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px;">On-Chain Proof</div>
            <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:10px;padding:14px 16px;">
              <div style="font-size:10px;color:rgba(160,164,185,0.5);margin-bottom:6px;">Transaction Signature</div>
              <a href="https://solscan.io/tx/${data.txHash}?cluster=devnet" style="font-size:12px;color:#b18df8;font-family:'Courier New',monospace;text-decoration:none;word-break:break-all;line-height:1.5;">${data.txHash}</a>
            </div>
          </div>

          <!-- Privacy Note -->
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:10px;padding:14px 16px;margin-bottom:28px;">
            <div style="font-size:11px;color:rgba(160,164,185,0.6);line-height:1.6;">
              <span style="color:#b18df8;">🔒</span> Your payment was routed through a one-time ephemeral address. The facade address <span style="font-family:'Courier New',monospace;color:rgba(200,202,216,0.7);">${data.facadeAddress.slice(0, 6)}…${data.facadeAddress.slice(-4)}</span> has been dissolved. No on-chain trace links this payment to your identity.
            </div>
          </div>

          <!-- Footer -->
          <div style="border-top:1px solid rgba(255,255,255,0.05);padding-top:16px;text-align:center;">
            <div style="font-size:10px;color:rgba(120,124,165,0.4);letter-spacing:0.04em;">BlackRail — Private Payments on Solana</div>
            <div style="font-size:10px;color:rgba(120,124,165,0.3);margin-top:4px;">This receipt serves as proof of payment. Save it for your records.</div>
          </div>
        </div>
      `,
    });

    if (result.error) {
      console.log(`[email] Buyer receipt failed for ${to}:`, result.error);
      return { ok: false, error: String(result.error) };
    }

    console.log(`[email] Buyer receipt sent to ${to}, id=${result.data?.id}`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[email] Error sending buyer receipt to ${to}: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ── Combined notification dispatcher ──────────────────────────────────────────
export async function notifyMerchant(
  merchantEmail: string,
  webhookUrl: string | null,
  webhookSecret: string | null,
  emailEnabled: boolean,
  payload: PaymentNotification
): Promise<void> {
  // Fire webhook (non-blocking, don't fail settlement on webhook failure)
  if (webhookUrl) {
    fireWebhook(webhookUrl, webhookSecret, payload).catch(() => {});
  }

  // Send email (non-blocking)
  if (emailEnabled) {
    sendPaymentEmail(merchantEmail, payload).catch(() => {});
  }
}
