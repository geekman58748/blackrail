// Privy app IDs are public client identifiers, not credentials. Keep the
// deployed API usable when Railway omits the non-secret variable, while still
// allowing an environment-specific app ID to override this demo default.
export const DEFAULT_PRIVY_APP_ID = "cms56lvu500030ckz9hxe7lex";

export function getPrivyAppId(): string {
  return process.env.PRIVY_APP_ID?.trim() || DEFAULT_PRIVY_APP_ID;
}