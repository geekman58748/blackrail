/**
 * RPC timeout wrapper + in-memory balance cache.
 *
 * Solana devnet public RPC is aggressively rate-limited (429). Without a
 * timeout the getAccount() call hangs and the client gives up.
 *
 * @solana/web3.js v1.x does NOT support a custom `fetch` option on
 * Connection, so we wrap RPC calls with Promise.race instead.
 */

import { Connection, type Commitment, PublicKey } from "@solana/web3.js";

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

// ── Timeout wrapper ────────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 15_000; // 15 seconds — devnet RPC can take 8-10s

/**
 * Races a promise against a timeout. Rejects with a clear error if the
 * inner promise doesn't resolve in time.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms = RPC_TIMEOUT_MS,
  label = "RPC call",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
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

  _defaultConnection = new Connection(rpcUrl, {
    commitment: "confirmed" as Commitment,
  });

  return _defaultConnection;
}

/**
 * Fetch an SPL token balance with caching + timeout.
 * Returns the raw bigint amount, or 0n on any error.
 */
export async function fetchTokenBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
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
    const acct = await withTimeout(getAccount(connection, ata));
    const bal = acct.amount.toString();
    setCachedBalance(key, bal);
    return BigInt(bal);
  } catch {
    // ATA doesn't exist, zero balance, timeout, or RPC error
    return 0n;
  }
}
