import { PrivyClient } from "@privy-io/node";

// Privy app IDs are public client identifiers, not credentials. Keep the
// deployed API usable when Railway omits the non-secret variable, while still
// allowing an environment-specific app ID to override this demo default.
export const DEFAULT_PRIVY_APP_ID = "cms56lvu500030ckz9hxe7lex";

export function getPrivyAppId(): string {
  return process.env.PRIVY_APP_ID?.trim() || DEFAULT_PRIVY_APP_ID;
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