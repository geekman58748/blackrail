import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
import { AnchorProvider, Program, BN, Idl } from "@coral-xyz/anchor";
import {
  ConnectionMagicRouter,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import bs58 from "bs58";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

// ── Hardcoded devnet constants (non-secret, safe to commit) ───────────────────

const DEFAULT_USDC_MINT    = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_VAULT_ATA    = "B82AzAWZsvVUwW1iddK8H45E1rj6QKS36X9FPFtHmbjM";
const DEFAULT_SERVER_WALLET= "2QGJqSPWogpnrsrEagH4Mn28JjvuxMjrNMPbUst56j6Y";

/**
 * Program ID.
 *
 * Current on-chain:  D6au34Ft153B5ghrujVzTg4nGJFiitpePnoQ666JPzB7  (old build)
 * After anchor deploy: 4r8Gfqx4DbgRG5ZHpKjdJJsysx9iZ5wXxofdkQM1C9FD
 *
 * Set PROGRAM_ID env var on Railway to switch.
 */
const DEFAULT_PROGRAM_ID = "D6au34Ft153B5ghrujVzTg4nGJFiitpePnoQ666JPzB7";

// ── IDL loading ───────────────────────────────────────────────────────────────

function loadIdl(): Idl {
  // Try to load a file dropped in by the user (e.g. uploaded from anchor build)
  const overridePath = process.env.PROGRAM_IDL_PATH;
  if (overridePath) {
    try {
      return JSON.parse(readFileSync(overridePath, "utf8")) as Idl;
    } catch (e) {
      console.warn("[solana] IDL override not readable, falling back:", e);
    }
  }
  // Fall back to the IDL we maintain in-repo (derived from programs/mirage-vault/src/lib.rs)
  const idlPath = join(__dirname, "../idl/mirage_vault.json");
  return JSON.parse(readFileSync(idlPath, "utf8")) as Idl;
}

// ── Wallet adapter for AnchorProvider ────────────────────────────────────────

class NodeWallet {
  constructor(readonly payer: Keypair) {}
  async signTransaction(tx: Transaction): Promise<Transaction> {
    tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
    return txs.map((tx) => { tx.partialSign(this.payer); return tx; });
  }
  get publicKey() { return this.payer.publicKey; }
}

// ── Config ────────────────────────────────────────────────────────────────────

export function validateSolanaConfig(): { configured: boolean } {
  return { configured: isErConfigured() };
}

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
  const server    = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR));
  const usdcMint  = new PublicKey(process.env.USDC_MINT    ?? DEFAULT_USDC_MINT);
  const merchantAta = new PublicKey(process.env.MERCHANT_USDC_ATA ?? DEFAULT_VAULT_ATA);
  const programId = new PublicKey(process.env.PROGRAM_ID   ?? DEFAULT_PROGRAM_ID);
  const baseRpc   = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

  // ConnectionMagicRouter extends Connection and auto-routes transactions:
  // delegated accounts → ER, everything else → base chain.
  const connection = new ConnectionMagicRouter(baseRpc);
  const base       = connection as unknown as Connection; // for direct SPL calls

  const idl        = loadIdl();
  // Override the IDL address with the actual env-configured program ID
  const patchedIdl = { ...idl, address: programId.toBase58() };

  const provider   = new AnchorProvider(
    connection as unknown as Connection,
    new NodeWallet(server) as unknown as AnchorProvider["wallet"],
    { commitment: "confirmed", skipPreflight: false }
  );
  const program    = new Program(patchedIdl, provider);

  return { server, usdcMint, merchantAta, programId, base, program, provider };
}

// ── Intent PDA ────────────────────────────────────────────────────────────────

function sessionIdToBytes(sessionId: string): number[] {
  // sha256 the session ID string → 32 bytes deterministically
  return Array.from(createHash("sha256").update(sessionId).digest());
}

function intentPda(sessionIdBytes: number[], programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement"), Buffer.from(sessionIdBytes)],
    programId
  );
  return pda;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates a one-time facade keypair + USDC ATA for the buyer to pay into.
 * Also initialises the on-chain SettlementIntent and delegates it to the ER.
 */
export async function createAndDelegateFacade(
  sessionId: string,
  amountUsdc: number,
  expiresAt: Date
): Promise<{ facadeAddress: string; keypairB58: string }> {
  const { server, usdcMint, merchantAta, programId, base, program } = cfg();
  const facade = Keypair.generate();
  const facadeAta = getAssociatedTokenAddressSync(usdcMint, facade.publicKey);

  // ── 1. Create facade USDC ATA on base chain ──────────────────────────────
  const createAtaIx = createAssociatedTokenAccountInstruction(
    server.publicKey,
    facadeAta,
    facade.publicKey,
    usdcMint
  );
  const ataTx = new Transaction().add(createAtaIx);
  await sendAndConfirmTransaction(base, ataTx, [server]);

  // ── 2. Initialize the SettlementIntent PDA ──────────────────────────────
  const sessionIdBytes = sessionIdToBytes(sessionId);
  const intent         = intentPda(sessionIdBytes, programId);
  const requiredLamports = BigInt(Math.round(amountUsdc * 1_000_000)); // USDC 6dp

  try {
    await (program.methods as any)
      .initialize_intent(
        sessionIdBytes,
        new BN(requiredLamports.toString()),
        new BN(Math.floor(expiresAt.getTime() / 1000))
      )
      .accounts({
        operator:      server.publicKey,
        facade:        facade.publicKey,
        merchant:      merchantAta, // merchant ATA owner is the vault
        mint:          usdcMint,
        intent,
        system_program: SystemProgram.programId,
      })
      .signers([server])
      .rpc();
    console.log(`[solana] initializeIntent ok — intent PDA: ${intent.toBase58()}`);
  } catch (err) {
    // Non-fatal: if the intent already exists or program call fails, we still
    // have a working facade ATA for the plain-SPL fallback path.
    console.warn("[solana] initializeIntent failed (will use plain-SPL fallback):", err);
    return {
      facadeAddress: facade.publicKey.toBase58(),
      keypairB58:    bs58.encode(facade.secretKey),
    };
  }

  // ── 3. Delegate the intent PDA to the ER ─────────────────────────────────
  const buffer            = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(intent, programId);
  const delegationRecord  = delegationRecordPdaFromDelegatedAccount(intent);
  const delegationMetadata= delegationMetadataPdaFromDelegatedAccount(intent);

  try {
    await (program.methods as any)
      .delegate_intent(sessionIdBytes)
      .accounts({
        operator:          server.publicKey,
        intent,
        owner_program:     programId,
        buffer,
        delegation_record: delegationRecord,
        delegation_metadata: delegationMetadata,
        delegation_program: DELEGATION_PROGRAM_ID,
        system_program:    SystemProgram.programId,
      })
      .signers([server])
      .rpc();
    console.log(`[solana] delegateIntent ok — intent delegated to ER`);
  } catch (err) {
    console.warn("[solana] delegateIntent failed:", err);
    // Continue — authorizeRelease / settle will detect the undelegated state
  }

  return {
    facadeAddress: facade.publicKey.toBase58(),
    keypairB58:    bs58.encode(facade.secretKey),
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
    const facadeAta    = getAssociatedTokenAddressSync(usdcMint, facadeWallet);
    const acct         = await getAccount(base, facadeAta);
    return acct.amount;
  } catch {
    return 0n;
  }
}

/**
 * Settles a payment session via MagicBlock:
 *   1. authorizeRelease on the ER (verifies facade balance privately)
 *   2. settle on base chain (transfers USDC facade→vault, closes facade ATA)
 *
 * Falls back to plain SPL transfer if the Anchor flow fails.
 */
export async function settleFacade(
  keypairB58: string,
  facadeAddress: string,
  sessionId: string
): Promise<string> {
  const { server, usdcMint, merchantAta, programId, base, program } = cfg();
  const facade      = Keypair.fromSecretKey(bs58.decode(keypairB58));
  const facadeWallet= new PublicKey(facadeAddress);
  const facadeAta   = getAssociatedTokenAddressSync(usdcMint, facadeWallet);

  // Check balance first
  const acct  = await getAccount(base, facadeAta);
  const amount = acct.amount;
  if (amount === 0n) throw new Error("facade ATA is empty — payment not received");

  const sessionIdBytes = sessionIdToBytes(sessionId);
  const intent         = intentPda(sessionIdBytes, programId);

  // ── Step 1: authorize_release on the ER ───────────────────────────────────
  // ConnectionMagicRouter detects 'intent' is delegated → routes to ER
  let anchorSettleOk = false;
  try {
    await (program.methods as any)
      .authorize_release(sessionIdBytes)
      .accounts({
        operator:      server.publicKey,
        facade:        facadeWallet,
        intent,
        facade_ata:    facadeAta,
        magic_context: MAGIC_CONTEXT_ID,
        magic_program: MAGIC_PROGRAM_ID,
      })
      .signers([server])
      .rpc();
    console.log(`[solana] authorizeRelease ok on ER`);

    // Give the ER a moment to commit the intent state back to base chain
    await new Promise((r) => setTimeout(r, 3000));

    // ── Step 2: settle on base chain ────────────────────────────────────────
    const settleSig = await (program.methods as any)
      .settle(sessionIdBytes)
      .accounts({
        operator:     server.publicKey,
        facade:       facadeWallet,
        intent,
        facade_ata:   facadeAta,
        merchant_ata: merchantAta,
        token_program: TOKEN_PROGRAM_ID,
      })
      .signers([server, facade])
      .rpc();
    console.log(`[solana] settle ok — tx: ${settleSig}`);
    anchorSettleOk = true;
    return settleSig;
  } catch (err) {
    console.warn("[solana] Anchor settle flow failed, using plain-SPL fallback:", err);
  }

  if (anchorSettleOk) {
    // Should not reach here but satisfies TypeScript
    throw new Error("unexpected state");
  }

  // ── Plain-SPL fallback (no MagicBlock privacy) ───────────────────────────
  console.log("[solana] falling back to plain SPL transfer");
  const tx = new Transaction().add(
    createTransferInstruction(
      facadeAta,
      merchantAta,
      facadeWallet,
      amount,
      [],
      TOKEN_PROGRAM_ID
    ),
    createCloseAccountInstruction(
      facadeAta,
      server.publicKey,
      facadeWallet,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  return sendAndConfirmTransaction(base, tx, [server, facade]);
}

// ── Vault helpers ─────────────────────────────────────────────────────────────

export function getVaultAddress(): { wallet: string; ata: string } {
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
    ata:    process.env.MERCHANT_USDC_ATA ?? DEFAULT_VAULT_ATA,
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
  const acct      = await getAccount(base, merchantAta);
  const available = acct.amount;
  if (available === 0n) throw new Error("vault is empty");
  const sendAmount = amount === 0n ? available : amount;
  if (sendAmount > available)
    throw new Error(`only ${Number(available) / 1e6} USDC available`);

  const destPk  = new PublicKey(destination);
  const destAta = getAssociatedTokenAddressSync(usdcMint, destPk);

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(server.publicKey, destAta, destPk, usdcMint),
    createTransferInstruction(merchantAta, destAta, server.publicKey, sendAmount)
  );
  return sendAndConfirmTransaction(base, tx, [server]);
}
