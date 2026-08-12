import { validateSolanaConfig } from "./solana.js";

export function validateRuntimeConfig() {
  const solana = validateSolanaConfig();
  if (solana.configured && !process.env.FACADE_ENCRYPTION_KEY?.trim()) {
    throw new Error("FACADE_ENCRYPTION_KEY is required when Solana settlement is enabled");
  }
  if (process.env.NODE_ENV === "production") {
    // PRIVY_APP_ID is a public client identifier and has a safe fallback in
    // getPrivyAppId(); the remaining values are deployment configuration or
    // secrets and must still be explicitly supplied.
    for (const name of ["WITHDRAW_SECRET", "CORS_ORIGINS", "PUBLIC_APP_URL"] as const) {
      if (!process.env[name]?.trim()) throw new Error(`${name} is required in production`);
    }
  }
  return solana;
}