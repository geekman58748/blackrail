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
import { getDefaultConnection, withTimeout } from "./rpc-cache.js";

const DEFAULT_MB_API = "https://payments.magicblock.app";
const DEFAULT_CLUSTER = "devnet";
import { DEFAULT_USDC_MINT } from "./config.js";
const DEFAULT_VAULT_ATA = "B82AzAWZsvVUwW1iddK8H45E1rj6QKS36X9FPFtHmbjM";
const DEFAULT_SERVER_WALLET = "2QGJqSPWogpnrsrEagH4Mn28JjvuxMjrNMPbUst56j6Y";

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

function getRpcUrl(): string {
  return process.env.SOLANA_RPC?.trim() || process.env.SOLANA_RPC_URL?.trim() ||
    process.env.SOLAMA_RPC?.trim() ||
    (getCluster() === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
}

// ── Config ────────────────────────────────────────────────────────────────────

export function isWithdrawConfigured(): boolean {
  return !!process.env.SERVER_KEYPAIR;
}

function cfg() {
  if (!process.env.SERVER_KEYPAIR) {
    throw new Error("SERVER_KEYPAIR is required but not set");
  }
  const server = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR));
  const usdcMint = new PublicKey(process.env.USDC_MINT ?? DEFAULT_USDC_MINT);
  const merchantAta = new PublicKey(process.env.MERCHANT_USDC_ATA ?? DEFAULT_VAULT_ATA);
  const base = getDefaultConnection();
  return { server, usdcMint, merchantAta, base };
}

// ── MagicBlock token auth ─────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getMbToken(keypair: Keypair): Promise<string> {
  const pubkey = keypair.publicKey.toBase58();
  const cached = tokenCache.get(pubkey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const cluster = getCluster();
  const api = getMagicBlockApi();

  const challengeRes = await fetch(`${api}/v1/spl/challenge?pubkey=${pubkey}&cluster=${cluster}`);
  if (!challengeRes.ok) throw new Error(`MB challenge failed: ${challengeRes.status}`);
  const { challenge } = await challengeRes.json() as { challenge: string };

  const msgBytes = Buffer.from(challenge, "utf8");
  const sigBytes = nacl.sign.detached(msgBytes, keypair.secretKey);
  const signature = bs58.encode(sigBytes);

  const loginRes = await fetch(`${api}/v1/spl/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, challenge, signature, cluster }),
  });
  if (!loginRes.ok) throw new Error(`MB login failed: ${loginRes.status} ${await loginRes.text()}`);
  const { token } = await loginRes.json() as { token: string };

  tokenCache.set(pubkey, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
  return token;
}

async function requestMagicBlockTransfer(
  token: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status: number; rawBody: string; data: MagicBlockTransferResponse }> {
  const response = await fetch(`${getMagicBlockApi()}/v1/spl/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const rawBody = await response.text();
  let data: MagicBlockTransferResponse = {};
  if (rawBody) try { data = JSON.parse(rawBody); } catch {}
  return { ok: response.ok, status: response.status, rawBody, data };
}

// ── Facade (address generation) ───────────────────────────────────────────────

export async function createFacade(): Promise<{
  facadeAddress: string;
  keypairB58: string;
}> {
  // Generate a fresh ephemeral keypair for the facade.
  // We intentionally skip the on-chain ATA creation here — the
  // idempotent ATA instruction will be included when the buyer
  // pays and the settlement sweeps funds to the vault. This avoids
  // a blocking Solana RPC call (sendAndConfirmTransaction) that
  // hangs when devnet is rate-limited and causes 502s.
  const facade = Keypair.generate();

  return {
    facadeAddress: facade.publicKey.toBase58(),
    keypairB58: bs58.encode(facade.secretKey),
  };
}

export async function getFacadeBalance(facadeAddress: string): Promise<bigint> {
  const { usdcMint, base } = cfg();
  try {
    const facadeAta = getAssociatedTokenAddressSync(usdcMint, new PublicKey(facadeAddress));
    const acct = await withTimeout(getAccount(base, facadeAta));
    return acct.amount;
  } catch {
    return 0n;
  }
}

// ── Settlement ────────────────────────────────────────────────────────────────

export async function settleFacade(
  keypairB58: string,
  _facadeAddress: string,
  _sessionId: string,
  destinationAddress?: string,
  recipientPrivateKey?: string
): Promise<string> {
  const { server, usdcMint, base } = cfg();
  const merchantAta = destinationAddress
    ? getAssociatedTokenAddressSync(usdcMint, new PublicKey(destinationAddress))
    : getAssociatedTokenAddressSync(usdcMint, server.publicKey);
  const facade = Keypair.fromSecretKey(bs58.decode(keypairB58));
  const facadeAtaPk = getAssociatedTokenAddressSync(usdcMint, facade.publicKey);

  const acct = await withTimeout(getAccount(base, facadeAtaPk), 20_000, "facade balance check for settle");
  const amount = acct.amount;
  if (amount === 0n) throw new Error("facade ATA has zero balance");

  // Try MagicBlock private settlement first (requires >= 0.5 USDC for gasless)
  const MB_MIN = 500_000n;
  if (amount >= MB_MIN) {
    try {
      const token = await getMbToken(server);
      const destWallet = destinationAddress ? new PublicKey(destinationAddress) : server.publicKey;
      const payload = {
        from: facade.publicKey.toBase58(),
        to: destWallet.toBase58(),
        mint: usdcMint.toBase58(),
        amount: Number(amount),
        visibility: "private",
        fromBalance: "base",
        toBalance: "base",
        gasless: true,
        initAtasIfMissing: true,
        cluster: getCluster(),
      };

      const response = await requestMagicBlockTransfer(token, payload);
      if (response.ok) {
        let txBase64 = response.data.transactionBase64;

        // MB charges fees ON TOP — adjust amount if needed
        if (txBase64 && response.data.fees?.tokens) {
          const feeTokens = BigInt(response.data.fees.tokens);
          if (feeTokens >= amount) {
            txBase64 = undefined;
          } else if (feeTokens > 0n) {
            const adjustedResponse = await requestMagicBlockTransfer(token, {
              ...payload,
              amount: Number(amount - feeTokens),
            });
            if (adjustedResponse.ok) txBase64 = adjustedResponse.data.transactionBase64 ?? txBase64;
          }
        }

        if (txBase64) {
          const vtx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
          const facadeSig = nacl.sign.detached(vtx.message.serialize(), facade.secretKey);
          vtx.addSignature(facade.publicKey, Buffer.from(facadeSig));
          const sig = await base.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
          await withTimeout(base.confirmTransaction(sig, "confirmed"), 30_000, "MB tx confirm");

          const txCheck = await base.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          if (txCheck?.meta?.err) throw new Error("MB tx execution failed");

          // Close facade ATA to reclaim rent
          try {
            const closeTx = new Transaction().add(
              createCloseAccountInstruction(facadeAtaPk, server.publicKey, facade.publicKey)
            );
            await withTimeout(sendAndConfirmTransaction(base, closeTx, [server, facade]), 20_000, "close facade ATA");
          } catch {}

          // ── Auto-withdraw: pull funds from PER to recipient's base wallet ──
          // MB transfer lands funds in the recipient's ephemeral balance (PER).
          // The recipient must call /v1/spl/withdraw to commit them to base.
          // We do this automatically here using the recipient's decrypted key.
          if (recipientPrivateKey && destinationAddress) {
            try {
              const withdrawAmount = Number(amount) - Number(response.data.fees?.tokens ?? 0n);
              console.log(`[settle] MB auto-withdraw: owner=${destinationAddress} amount=${withdrawAmount}`);
              if (withdrawAmount > 0) {
                const withdrawRes = await fetch(`${getMagicBlockApi()}/v1/spl/withdraw`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    owner: destinationAddress,
                    mint: usdcMint.toBase58(),
                    amount: withdrawAmount,
                    idempotent: true,
                    cluster: getCluster(),
                  }),
                });
                const wdBody = await withdrawRes.text();
                console.log(`[settle] MB withdraw response: HTTP ${withdrawRes.status} body=${wdBody.slice(0, 200)}`);
                if (withdrawRes.ok) {
                  const wdData = JSON.parse(wdBody) as { transactionBase64?: string; sendTo?: string; requiredSigners?: string[] };
                  console.log(`[settle] MB withdraw tx: sendTo=${wdData.sendTo} signers=${JSON.stringify(wdData.requiredSigners)} ixCount=${wdData.transactionBase64 ? 'yes' : 'no'}`);
                  if (wdData.transactionBase64) {
                    const wdTx = VersionedTransaction.deserialize(Buffer.from(wdData.transactionBase64, "base64"));
                    const recipientKp = Keypair.fromSecretKey(bs58.decode(recipientPrivateKey));
                    console.log(`[settle] signing withdraw tx with key: ${recipientKp.publicKey.toBase58()}`);
                    const recipientSig = nacl.sign.detached(wdTx.message.serialize(), recipientKp.secretKey);
                    wdTx.addSignature(recipientKp.publicKey, Buffer.from(recipientSig));
                    const wdSig = await base.sendRawTransaction(wdTx.serialize(), { skipPreflight: true });
                    console.log(`[settle] MB withdraw tx submitted: ${wdSig}`);
                    await withTimeout(base.confirmTransaction(wdSig, "confirmed"), 30_000, "MB withdraw confirm");
                    console.log(`[settle] MB auto-withdraw CONFIRMED: ${wdSig}`);
                  }
                } else {
                  console.error(`[settle] MB withdraw FAILED: HTTP ${withdrawRes.status}`);
                }
              } else {
                console.warn(`[settle] withdrawAmount <= 0, skipping withdraw`);
              }
            } catch (wdErr) {
              console.error(`[settle] MB auto-withdraw EXCEPTION:`, wdErr);
            }
          } else {
            console.warn(`[settle] cannot auto-withdraw: recipientPrivateKey=${!!recipientPrivateKey} destinationAddress=${!!destinationAddress}`);
          }

          return sig;
        }
      }
    } catch (mbErr) {
      console.warn("[settle] MB API error, falling back to SPL:", mbErr);
    }
  }

  // Fallback: plain on-chain SPL transfer
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(server.publicKey, merchantAta, server.publicKey, usdcMint),
    createTransferInstruction(facadeAtaPk, merchantAta, facade.publicKey, amount),
    createCloseAccountInstruction(facadeAtaPk, server.publicKey, facade.publicKey)
  );
  return withTimeout(sendAndConfirmTransaction(base, tx, [server, facade]), 30_000, "SPL fallback transfer");
}

// ── Vault ─────────────────────────────────────────────────────────────────────

export function getVaultAddress(): { wallet: string; ata: string } {
  let walletAddress = DEFAULT_SERVER_WALLET;
  try {
    if (process.env.SERVER_KEYPAIR) {
      walletAddress = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR)).publicKey.toBase58();
    }
  } catch {}
  return { wallet: walletAddress, ata: process.env.MERCHANT_USDC_ATA ?? DEFAULT_VAULT_ATA };
}

export async function getVaultBalance(): Promise<bigint> {
  const { merchantAta, base } = cfg();
  try {
    const acct = await withTimeout(getAccount(base, merchantAta));
    return acct.amount;
  } catch {
    return 0n;
  }
}

export async function withdrawFromVault(destination: string, amount: bigint): Promise<string> {
  const { server, usdcMint, merchantAta, base } = cfg();
  const acct = await withTimeout(getAccount(base, merchantAta), 8_000, "vault balance check");
  const available = acct.amount;
  if (available === 0n) throw new Error("vault is empty");
  const sendAmount = amount === 0n ? available : amount;
  if (sendAmount > available) throw new Error(`only ${Number(available) / 1e6} USDC available`);

  const destPk = new PublicKey(destination);
  const destAta = getAssociatedTokenAddressSync(usdcMint, destPk);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(server.publicKey, destAta, destPk, usdcMint),
    createTransferInstruction(merchantAta, destAta, server.publicKey, sendAmount)
  );
  return sendAndConfirmTransaction(base, tx, [server]);
}
