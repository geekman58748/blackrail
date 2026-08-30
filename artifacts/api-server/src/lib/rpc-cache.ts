/**
 * RPC timeout + in-memory balance cache.
 * Solana devnet public RPC is aggressively rate-limited (429). Without a
 * timeout the Connection.getAccountInfo() call hangs until the client gives
 * up. This module wraps fetch with a configurable timeout and caches
 * balance lookups for a short TTL so we don't hammer the RPC on every
 * dashboard poll.
 */

import { Connection, type Commitment } from "@solana/web3.js";

// ── Balance cache ──────────────────────────────────────────────────────────────

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const balanceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10_000; // 10 seconds

export function getCachedBalance(key: string): string | null {
  const entry = balanceCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.value;
  balanceCache.delete(key);
  return null;
}

export function setCachedBalance(key: string, value: string): void {
  balanceCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Fetch-with-timeout ─────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 8_000; // 8 seconds per RPC call

function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ── Connection factory ─────────────────────────────────────────────────────────

let _defaultConnection: Connection | null = null;

export function getDefaultConnection(): Connection {
  if (_defaultConnection) return _defaultConnection;

  const cluster = process.env.SOLANA_CLUSTER?.trim() || "devnet";
  const rpcUrl =
    process.env.SOLANA_RPC?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    (cluster === "devnet"
      ? "https://api.devnet.solana.com"
      : "https://api.mainnet-beta.solana.com");

  // @solana/web3.js v1.98 accepts a custom `fetch` in the config object
  _defaultConnection = new Connection(rpcUrl, {
    commitment: "confirmed" as Commitment,
    fetch: fetchWithTimeout as typeof globalThis.fetch,
  } as any);

  return _defaultConnection;
}

/**
 * Fetch an SPL token balance with caching + timeout.
 * Returns the raw bigint amount, or 0n on any error.
 */
export async function fetchTokenBalance(
  connection: Connection,
  mint: import("@solana/web3.js").PublicKey,
  owner: import("@solana/web3.js").PublicKey,
  cacheKey?: string,
): Promise<bigint> {
  const key = cacheKey ?? `${owner.toBase58()}:${mint.toBase58()}`;

  const cached = getCachedBalance(key);
  if (cached !== null) return BigInt(cached);

  try {
    const { getAssociatedTokenAddressSync, getAccount } = await import(
      "@solana/spl-token"
    );
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const acct = await getAccount(connection, ata);
    const bal = acct.amount.toString();
    setCachedBalance(key, bal);
    return BigInt(bal);
  } catch {
    // ATA doesn't exist yet, zero balance, or RPC error
    return 0n;
  }
}
