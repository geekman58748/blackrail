import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "D6au34Ft153B5ghrujVzTg4nGJFiitpePnoQ666JPzB7"
);

const DEFAULT_MB_API = "https://payments.magicblock.app";
const DEFAULT_CLUSTER = "devnet";
const SUPPORTED_CLUSTERS = new Set(["devnet", "mainnet-beta"]);

type MagicBlockTransferResponse = {
  signature?: string;
  sig?: string;
  txId?: string;
  transactionBase64?: string;
  requiredSigners?: string[];
  sendTo?: string;
  fees?: { lamports?: string; tokens?: string };
};

function getCluster(): string {
  return process.env.SOLANA_CLUSTER?.trim() || DEFAULT_CLUSTER;
}

function getMagicBlockApi(): string {
  return (process.env.MAGICBLOCK_API_URL?.trim() || DEFAULT_MB_API).replace(/\/$/, "");
}

async function requestMagicBlockTransfer(
  token: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status: number; rawBody: string; data: MagicBlockTransferResponse }> {
  const response = await fetch(`${getMagicBlockApi()}/v1/spl/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  let data: MagicBlockTransferResponse = {};
  if (rawBody) {
    try {
      data = JSON.parse(rawBody) as MagicBlockTransferResponse;
    } catch {
      // Keep the raw response for diagnostics; callers decide whether to fall back.
    }
  }

  return { ok: response.ok, status: response.status, rawBody, data };
}

// ── Token cache keyed by pubkey ───────────────────────────────────────────────
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getMbToken(keypair: Keypair): Promise<string> {
  const pubkey = keypair.publicKey.toBase58();
  const cached = tokenCache.get(pubkey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const cluster = getCluster();
  const magicBlockApi = getMagicBlockApi();

  // 1. Get challenge
  const challengeRes = await fetch(
    `${magicBlockApi}/v1/spl/challenge?pubkey=${pubkey}&cluster=${cluster}`
  );
  if (!challengeRes.ok) throw new Error(`MB challenge failed: ${challengeRes.status}`);
  const { challenge } = await challengeRes.json() as { challenge: string };

  // 2. Sign challenge with keypair
  const msgBytes = Buffer.from(challenge, "utf8");
  const sigBytes = nacl.sign.detached(msgBytes, keypair.secretKey);
  const signature = bs58.encode(sigBytes);

  // 3. Login → get token
  const loginRes = await fetch(`${magicBlockApi}/v1/spl/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, challenge, signature, cluster }),
  });
  if (!loginRes.ok) {
    const err = await loginRes.text();
    throw new Error(`MB login failed: ${loginRes.status} ${err}`);
  }
  const { token } = await loginRes.json() as { token: string };

  // Cache for 50 minutes (tokens typically last ~1h)
  tokenCache.set(pubkey, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
  return token;
}

// ── Config ────────────────────────────────────────────────────────────────────
export function isErConfigured(): boolean {
  return !!(process.env.SERVER_KEYPAIR && process.env.USDC_MINT);
}

export function isWithdrawConfigured(): boolean {
  return isErConfigured();
}

export type SolanaConfigSummary = {
  configured: boolean;
  cluster: string;
  rpcUrl: string | null;
  settlementSigner: string | null;
  custodyAuthority: string | null;
  custodyAta: string | null;
  usdcMint: string | null;
  sharedSignerAndCustodyAuthority: boolean;
};

function getRpcUrl(): string {
  const configuredRpc = process.env.SOLANA_RPC?.trim() || process.env.SOLANA_RPC_URL?.trim();
  if (configuredRpc) return configuredRpc;
  return getCluster() === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";
}

/**
 * Validates the current single-wallet devnet model without contacting Solana.
 * Stub mode is valid only when neither required chain variable is present.
 */
export function validateSolanaConfig(): SolanaConfigSummary {
  const cluster = getCluster();
  if (!SUPPORTED_CLUSTERS.has(cluster)) {
    throw new Error(
      `SOLANA_CLUSTER must be one of ${Array.from(SUPPORTED_CLUSTERS).join(", ")}; received "${cluster}"`
    );
  }

  const hasSigner = !!process.env.SERVER_KEYPAIR?.trim();
  const hasMint = !!process.env.USDC_MINT?.trim();
  if (!hasSigner && !hasMint) {
    return {
      configured: false,
      cluster,
      rpcUrl: null,
      settlementSigner: null,
      custodyAuthority: null,
      custodyAta: null,
      usdcMint: null,
      sharedSignerAndCustodyAuthority: true,
    };
  }
  if (!hasSigner || !hasMint) {
    throw new Error("SERVER_KEYPAIR and USDC_MINT must either both be set or both be unset");
  }

  let settlementSigner: Keypair;
  try {
    settlementSigner = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR!.trim()));
  } catch (error) {
    throw new Error(`SERVER_KEYPAIR is not a valid base58 Solana keypair: ${String(error)}`);
  }

  let usdcMint: PublicKey;
  try {
    usdcMint = new PublicKey(process.env.USDC_MINT!.trim());
  } catch (error) {
    throw new Error(`USDC_MINT is not a valid Solana public key: ${String(error)}`);
  }

  const custodyAuthority = settlementSigner.publicKey;
  const expectedCustodyAta = getAssociatedTokenAddressSync(usdcMint, custodyAuthority);
  let custodyAta = expectedCustodyAta;
  if (process.env.MERCHANT_USDC_ATA?.trim()) {
    try {
      custodyAta = new PublicKey(process.env.MERCHANT_USDC_ATA.trim());
    } catch (error) {
      throw new Error(`MERCHANT_USDC_ATA is not a valid Solana public key: ${String(error)}`);
    }
    if (!custodyAta.equals(expectedCustodyAta)) {
      throw new Error(
        `MERCHANT_USDC_ATA must be the canonical USDC ATA owned by SERVER_KEYPAIR (${expectedCustodyAta.toBase58()})`
      );
    }
  }

  let rpcUrl: URL;
  try {
    rpcUrl = new URL(getRpcUrl());
  } catch (error) {
    throw new Error(`SOLANA_RPC/SOLANA_RPC_URL is not a valid URL: ${String(error)}`);
  }
  if (rpcUrl.protocol !== "https:" && rpcUrl.protocol !== "http:") {
    throw new Error("SOLANA_RPC/SOLANA_RPC_URL must use http or https");
  }

  return {
    configured: true,
    cluster,
    rpcUrl: rpcUrl.toString(),
    settlementSigner: settlementSigner.publicKey.toBase58(),
    custodyAuthority: custodyAuthority.toBase58(),
    custodyAta: custodyAta.toBase58(),
    usdcMint: usdcMint.toBase58(),
    sharedSignerAndCustodyAuthority: true,
  };
}

function cfg() {
  // The current devnet deployment intentionally uses one key for transaction
  // fees and custody authority. Keep the roles explicit so they can be split
  // without changing facade or destination semantics.
  const settlementSigner = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR!));
  const custodyAuthority = settlementSigner.publicKey;
  const usdcMint = new PublicKey(process.env.USDC_MINT!);
  const custodyAta = process.env.MERCHANT_USDC_ATA
    ? new PublicKey(process.env.MERCHANT_USDC_ATA)
    : getAssociatedTokenAddressSync(usdcMint, custodyAuthority);
  return {
    usdcMint,
    custodyAuthority,
    custodyAta,
    base: new Connection(
      getRpcUrl(),
      "confirmed"
    ),
    settlementSigner,
  };
}

// ── Vault ─────────────────────────────────────────────────────────────────────
export async function getVaultBalance(): Promise<bigint> {
  const { custodyAta, base } = cfg();
  try {
    const acct = await getAccount(base, custodyAta);
    return acct.amount;
  } catch {
    return 0n;
  }
}

export function getVaultAddress(): { wallet: string; ata: string } {
  const { custodyAuthority, custodyAta } = cfg();
  return { wallet: custodyAuthority.toBase58(), ata: custodyAta.toBase58() };
}

// ── Facade ────────────────────────────────────────────────────────────────────
export async function createFacade(): Promise<{
  facadeAddress: string;
  keypairB58: string;
}> {
  const { usdcMint, base, settlementSigner } = cfg();
  const facade = Keypair.generate();
  const facadeAta = getAssociatedTokenAddressSync(usdcMint, facade.publicKey);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      settlementSigner.publicKey,
      facadeAta,
      facade.publicKey,
      usdcMint
    )
  );
  await sendAndConfirmTransaction(base, tx, [settlementSigner]);

  return {
    facadeAddress: facade.publicKey.toBase58(),
    keypairB58: bs58.encode(facade.secretKey),
  };
}

export async function getFacadeBalance(facadeAddress: string): Promise<bigint> {
  const { usdcMint, base } = cfg();
  try {
    const facadeAta = getAssociatedTokenAddressSync(usdcMint, new PublicKey(facadeAddress));
    const acct = await getAccount(base, facadeAta);
    return acct.amount;
  } catch {
    return 0n;
  }
}

/**
 * Settles facade → merchant vault privately via MagicBlock's Payments API.
 * Falls back to a plain on-chain SPL transfer if the MB API is unavailable.
 * Returns { sig, private: true/false } so callers know which path was used.
 */
export async function settleFacade(
  keypairB58: string,
  _facadeAddress: string
): Promise<{ sig: string; private: boolean }> {
  const { usdcMint, custodyAuthority, custodyAta, base, settlementSigner } = cfg();
  const facade = Keypair.fromSecretKey(bs58.decode(keypairB58));
  const facadeAtaPk = getAssociatedTokenAddressSync(usdcMint, facade.publicKey);

  const acct = await getAccount(base, facadeAtaPk);
  const amount = acct.amount;
  if (amount === 0n) throw new Error("facade ATA has zero balance");

  // ── Try MagicBlock private settlement first (requires ≥ 0.5 USDC for gasless) ──
  const MB_MIN = 500_000n; // 0.5 USDC in lamports
  if (amount < MB_MIN) {
    console.log(`[settle] amount ${amount} < MB minimum, skipping MB → plain SPL`);
  }
  if (amount >= MB_MIN) try {
    const token = await getMbToken(facade);

    const payload = {
      from: facade.publicKey.toBase58(),
      to: custodyAuthority.toBase58(),
      mint: usdcMint.toBase58(),
      amount: Number(amount),
      visibility: "private",
      fromBalance: "base",
      toBalance: "base",
      gasless: true,
      initAtasIfMissing: true,
      cluster: getCluster(),
    };
    console.log("[settle] MB transfer payload:", JSON.stringify(payload));

    const response = await requestMagicBlockTransfer(token, payload);
    console.log("[settle] MB response status:", response.status, "body:", response.rawBody);

    if (response.ok) {
      const data = response.data;

      // MB charges fees ON TOP of amount — if fee + amount > facade balance, retry with adjusted amount
      let txBase64 = data.transactionBase64;
      if (txBase64 && data.fees?.tokens) {
        const feeTokens = BigInt(data.fees.tokens);
        if (feeTokens >= amount) {
          console.warn("[settle] MB fee exceeds balance, falling back to SPL");
          txBase64 = undefined; // skip MB, fall through to SPL
        } else if (feeTokens > 0n) {
          const adjustedAmount = amount - feeTokens;
          console.log(`[settle] Adjusting MB amount by fee ${feeTokens}: ${amount} → ${adjustedAmount}`);
          const adjustedResponse = await requestMagicBlockTransfer(token, {
            ...payload,
            amount: Number(adjustedAmount),
          });
          if (adjustedResponse.ok) {
            txBase64 = adjustedResponse.data.transactionBase64 ?? txBase64;
          }
        }
      }

      // Sign the MB tx (crank pre-signed; we add facade sig only)
      if (txBase64) {
        const txBytes = Buffer.from(txBase64, "base64");
        const vtx = VersionedTransaction.deserialize(txBytes);
        const msgBytes = vtx.message.serialize();
        const facadeSig = nacl.sign.detached(msgBytes, facade.secretKey);
        vtx.addSignature(facade.publicKey, Buffer.from(facadeSig));
        const sig = await base.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
        await base.confirmTransaction(sig, "confirmed");
        // Verify the tx actually succeeded — confirmTransaction only checks inclusion, not execution
        const txCheck = await base.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        if (txCheck?.meta?.err) {
          console.warn("[settle] MB tx confirmed but execution failed:", JSON.stringify(txCheck.meta.err), "— falling back to SPL");
          throw new Error("MB tx execution failed: " + JSON.stringify(txCheck.meta.err));
        }
        console.log("[settle] MB private tx confirmed + verified:", sig);
        // Close facade ATA to reclaim rent after private settlement
        try {
          const closeTx = new Transaction().add(
            createCloseAccountInstruction(facadeAtaPk, settlementSigner.publicKey, facade.publicKey)
          );
          await sendAndConfirmTransaction(base, closeTx, [settlementSigner, facade]);
          console.log("[settle] facade ATA closed, rent reclaimed");
        } catch (closeErr) {
          console.warn("[settle] facade ATA close failed (non-critical):", closeErr);
        }
        return { sig, private: true };
      }

      const sig = data.signature ?? data.sig ?? data.txId ?? "mb-private";
      console.log("[settle] MagicBlock private transfer sig:", sig);
      return { sig, private: true };
    }

    console.warn("[settle] MB API failed, falling back:", response.status, response.rawBody);
  } catch (mbErr) {
    console.warn("[settle] MB API error, falling back:", mbErr);
  }

  // ── Fallback: plain on-chain SPL transfer ──
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      settlementSigner.publicKey, custodyAta, custodyAuthority, usdcMint
    ),
    createTransferInstruction(facadeAtaPk, custodyAta, facade.publicKey, amount),
    createCloseAccountInstruction(facadeAtaPk, settlementSigner.publicKey, facade.publicKey)
  );
  const sig = await sendAndConfirmTransaction(base, tx, [settlementSigner, facade]);
  console.log("[settle] fallback plain SPL transfer:", sig);
  return { sig, private: false };
}

// ── Withdraw ──────────────────────────────────────────────────────────────────
export async function withdrawFromVault(
  destination: string,
  amount: bigint
): Promise<string> {
  const { usdcMint, custodyAta, base, settlementSigner } = cfg();

  const acct = await getAccount(base, custodyAta);
  const available = acct.amount;
  if (available === 0n) throw new Error("vault is empty");
  const sendAmount = amount === 0n ? available : amount;
  if (sendAmount > available) throw new Error(`only ${Number(available) / 1e6} USDC available`);

  const destPk = new PublicKey(destination);
  const destAta = getAssociatedTokenAddressSync(usdcMint, destPk);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(settlementSigner.publicKey, destAta, destPk, usdcMint),
    createTransferInstruction(custodyAta, destAta, settlementSigner.publicKey, sendAmount)
  );
  const sig = await sendAndConfirmTransaction(base, tx, [settlementSigner]);
  return sig;
}
