export function validatePrivyFrontendConfig({ context, privyAppId }) {
  const value = (privyAppId || "").trim();
  if (context === "production" && !value) {
    throw new Error(
      "BLACKRAIL_PRIVY_APP_ID is required for production builds and must match the API server's PRIVY_APP_ID",
    );
  }
  return value;
}
