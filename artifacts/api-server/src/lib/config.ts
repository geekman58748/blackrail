import { validateSolanaConfig } from "./solana.js";

export function validateRuntimeConfig() {
  const solana = validateSolanaConfig();
  if (solana.configured && !process.env.FACADE_ENCRYPTION_KEY?.trim()) {
    throw new Error("FACADE_ENCRYPTION_KEY is required when Solana settlement is enabled");
  }
  if (process.env.NODE_ENV === "production") {
    // PRIVY_APP_ID must match the app ID the frontend is configured with, or
    // Privy access-token verification fails for every login (users appear to
    // be signed out immediately). There is no safe default for it, so it's
    // required here just like the other deployment configuration and secrets.
    for (const name of [
      "WITHDRAW_SECRET",
      "CORS_ORIGINS",
      "PUBLIC_APP_URL",
      "PRIVY_APP_SECRET",
      "PRIVY_APP_ID",
    ] as const) {
      if (!process.env[name]?.trim()) throw new Error(`${name} is required in production`);
    }
  }
  return solana;
}