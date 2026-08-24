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
