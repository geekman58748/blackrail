import { PrivyClient } from "@privy-io/node";

// Privy app IDs are public client identifiers, but they are NOT
// interchangeable: verifyAccessToken() checks a token's `aud` claim against
// this exact value. Falling back to a hardcoded demo app ID here is what
// caused production sign-outs — if the real PRIVY_APP_ID env var was ever
// missing, the API would silently verify tokens against the wrong app and
// every login would fail auth immediately after succeeding on the frontend.
// There is no safe default for this value; it must always be supplied
// explicitly and must match the app ID the frontend is configured with.
export function getPrivyAppId(): string {
  const appId = process.env.PRIVY_APP_ID?.trim();
  if (!appId) {
    throw new Error(
      "PRIVY_APP_ID is required and must match the frontend's configured Privy app ID",
    );
  }
  return appId;
}

let privyClient: PrivyClient | undefined;

export function getPrivyClient(): PrivyClient {
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appSecret) {
    throw new Error("PRIVY_APP_SECRET is required for Privy authentication");
  }

  if (!privyClient) {
    privyClient = new PrivyClient({
      appId: getPrivyAppId(),
      appSecret,
    });
  }

  return privyClient;
}
