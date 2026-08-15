import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";

// ── Hardcoded devnet constants (non-secret, safe to commit) ───────────────────

const DEFAULT_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_VAULT_ATA = "B82AzAWZsvVUwW1iddK8H45E1rj6QKS36X9FPFtHmbjM";
const DEFAULT_SERVER_WALLET = "2QGJqSPWogpnrsrEagH4Mn28JjvuxMjrNMPbUst56j6Y";

// ── Config ────────────────────────────────────────────────────────────────────

export function validateSolanaConfig(): { configured: boolean } {
  return { configured: isErConfigured() };
}

/** Only SERVER_KEYPAIR is truly required — the other values have safe defaults. */
export function isErConfigured(): boolean {
  return !!process.env.SERVER_KEYPAIR;
}

export function isWithdrawConfigured(): boolean {
  return !!process.env.SERVER_KEYPAIR;
}

function cfg() {
  if (!process.env.SERVER_KEYPAIR) {
    throw new Error("SERVER_KEYPAIR is required but not set");
  }
  const server = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR));
  const usdcMint = new PublicKey(process.env.USDC_MINT ?? DEFAULT_USDC_MINT);
  const merchantAta = new PublicKey(
    process.env.MERCHANT_USDC_ATA ?? DEFAULT_VAULT_ATA
  );
  const base = new Connection(
    process.env.SOLANA_RPC ?? "https://api.devnet.solana.com",
    "confirmed"
  );
  return { server, usdcMint, merchantAta, base };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates a one-time facade keypair + USDC ATA for the buyer to pay into.
 * The facade keypair is returned (base58) so the server can sign the
 * settlement transfer later.
 */
export async function createAndDelegateFacade(
  _sessionId: string,
  _amountUsdc: number,
  _expiresAt: Date
): Promise<{ facadeAddress: string; keypairB58: string }> {
  const { server, usdcMint, base } = cfg();
  const facade = Keypair.generate();
  const facadeAta = getAssociatedTokenAddressSync(usdcMint, facade.publicKey);

  // Create the ATA so the buyer can send USDC to it immediately
  const createAtaIx = createAssociatedTokenAccountInstruction(
    server.publicKey, // fee payer
    facadeAta,
    facade.publicKey,
    usdcMint
  );

  const tx = new Transaction().add(createAtaIx);
  await sendAndConfirmTransaction(base, tx, [server]);

  // Return the WALLET address (facade.publicKey), not the ATA address.
  // Solana wallets automatically resolve the ATA when sending SPL tokens to
  // a wallet address, so this looks like a normal Solana address to payers.
  // The ATA is derived internally whenever we need to read or sweep funds.
  return {
    facadeAddress: facade.publicKey.toBase58(),
    keypairB58: bs58.encode(facade.secretKey),
  };
}

/**
 * Reads the facade ATA balance from base chain.
 * facadeAddress is the WALLET address — ATA is derived from it.
 */
export async function getFacadeBalance(facadeAddress: string): Promise<bigint> {
  const { base, usdcMint } = cfg();
  try {
    const facadeWallet = new PublicKey(facadeAddress);
    const facadeAta = getAssociatedTokenAddressSync(usdcMint, facadeWallet);
    const acct = await getAccount(base, facadeAta);
    return acct.amount;
  } catch {
    return 0n;
  }
}

/**
 * Settles a payment session:
 *   1. Transfer USDC from facade ATA → vault ATA
 *   2. Close facade ATA (rent back to server)
 *
 * facadeAddress is the WALLET address — ATA is derived from it.
 * Both the server and the facade keypair sign — the server pays fees,
 * the facade authorises the transfer out of its ATA.
 */
export async function settleFacade(
  keypairB58: string,
  facadeAddress: string,
  _sessionId: string
): Promise<string> {
  const { server, merchantAta, base, usdcMint } = cfg();
  const facade = Keypair.fromSecretKey(bs58.decode(keypairB58));
  const facadeAtaPk = getAssociatedTokenAddressSync(usdcMint, facade.publicKey);

  // How much is in the facade?
  const acct = await getAccount(base, facadeAtaPk);
  const amount = acct.amount;
  if (amount === 0n) throw new Error("facade ATA is empty — payment not received");

  const tx = new Transaction().add(
    // Transfer all USDC from facade → vault
    createTransferInstruction(
      facadeAtaPk,
      merchantAta,
      facade.publicKey, // owner of the facade ATA
      amount,
      [],
      TOKEN_PROGRAM_ID
    ),
    // Close the facade ATA, rent goes back to server
    createCloseAccountInstruction(
      facadeAtaPk,
      server.publicKey, // rent destination
      facade.publicKey, // owner
      [],
      TOKEN_PROGRAM_ID
    )
  );

  return sendAndConfirmTransaction(base, tx, [server, facade]);
}

// ── Vault helpers ─────────────────────────────────────────────────────────────

export function getVaultAddress(): { wallet: string; ata: string } {
  // Read from env or fall back to hardcoded devnet defaults.
  // SERVER_KEYPAIR is the real secret; derive the wallet from it if set.
  let walletAddress = DEFAULT_SERVER_WALLET;
  try {
    if (process.env.SERVER_KEYPAIR) {
      walletAddress = Keypair.fromSecretKey(
        bs58.decode(process.env.SERVER_KEYPAIR)
      ).publicKey.toBase58();
    }
  } catch { /* use default */ }

  return {
    wallet: walletAddress,
    ata: process.env.MERCHANT_USDC_ATA ?? DEFAULT_VAULT_ATA,
  };
}

export async function getVaultBalance(): Promise<bigint> {
  const { base, merchantAta } = cfg();
  const acct = await getAccount(base, merchantAta);
  return acct.amount;
}

export async function withdrawFromVault(
  destination: string,
  amount: bigint
): Promise<string> {
  const { usdcMint, merchantAta, base, server } = cfg();
  const acct = await getAccount(base, merchantAta);
  const available = acct.amount;
  if (available === 0n) throw new Error("vault is empty");
  const sendAmount = amount === 0n ? available : amount;
  if (sendAmount > available)
    throw new Error(`only ${Number(available) / 1e6} USDC available`);

  const destPk = new PublicKey(destination);
  const destAta = getAssociatedTokenAddressSync(usdcMint, destPk);

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      server.publicKey,
      destAta,
      destPk,
      usdcMint
    ),
    createTransferInstruction(merchantAta, destAta, server.publicKey, sendAmount)
  );
  return sendAndConfirmTransaction(base, tx, [server]);
}
