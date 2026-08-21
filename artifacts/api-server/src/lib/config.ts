import { isWithdrawConfigured } from "./solana.js";

export function validateRuntimeConfig() {
  const configured = isWithdrawConfigured();
  if (configured && !process.env.FACADE_ENCRYPTION_KEY?.trim()) {
    throw new Error("FACADE_ENCRYPTION_KEY is required when Solana settlement is enabled");
  }
  if (process.env.NODE_ENV === "production") {
    for (const name of [
      "WITHDRAW_SECRET",
      "CORS_ORIGINS",
      "PUBLIC_APP_URL",
    ] as const) {
      if (!process.env[name]?.trim()) throw new Error(`${name} is required in production`);
    }
  }
  return { configured };
}