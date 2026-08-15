import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
import { createHash } from "crypto";

// ── Program IDs ───────────────────────────────────────────────────────────────

export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "D6au34Ft153B5ghrujVzTg4nGJFiitpePnoQ666JPzB7"
);

const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);
const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111"
);
const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111"
);

// ── PDA derivations ───────────────────────────────────────────────────────────

const SETTLEMENT_SEED = Buffer.from("settlement");

/** Derives the SettlementIntent PDA from the 32-byte session ID. */
function intentPda(sessionBytes: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, sessionBytes],
    PROGRAM_ID
  );
}

/** Pads a hex session ID string to 32 bytes. */
function sessionIdToBytes(sessionId: string): Uint8Array {
  const hex = sessionId.replace(/-/g, "").padEnd(64, "0").slice(0, 64);
  return Buffer.from(hex, "hex");
}

// Delegation PDAs (derived from the delegation program)
function delegationRecord(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("delegation"), account.toBytes()],
    DELEGATION_PROGRAM_ID
  )[0];
}
function delegationMetadata(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("delegation-metadata"), account.toBytes()],
    DELEGATION_PROGRAM_ID
  )[0];
}
function delegateBuffer(account: PublicKey): PublicKey {
  // buffer PDA is derived with the ownerProgram (our deployed program)
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buffer"), account.toBytes()],
    PROGRAM_ID
  )[0];
}

// ── Anchor instruction discriminators ────────────────────────────────────────
// sha256("global:<instruction_name>")[0:8]

function disc(name: string): Buffer {
  return Buffer.from(
    createHash("sha256").update(`global:${name}`).digest()
  ).subarray(0, 8);
}

// ── Instruction builders ──────────────────────────────────────────────────────

/** initialize_intent: creates the SettlementIntent PDA on base chain. */
function buildInitializeIntent(
  operator: PublicKey,
  facade: PublicKey,
  merchant: PublicKey,
  mint: PublicKey,
  intent: PublicKey,
  sessionBytes: Uint8Array,
  requiredAmount: bigint,
  expiresAt: bigint
): TransactionInstruction {
  // Args: session_id [u8;32] | required_amount u64 | expires_at i64
  const data = Buffer.alloc(8 + 32 + 8 + 8);
  disc("initialize_intent").copy(data, 0);
  Buffer.from(sessionBytes).copy(data, 8);
  data.writeBigUInt64LE(requiredAmount, 40);
  data.writeBigInt64LE(expiresAt, 48);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: operator, isSigner: true, isWritable: true },
      { pubkey: facade, isSigner: false, isWritable: false },
      { pubkey: merchant, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: intent, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * delegate_intent: delegates the SettlementIntent PDA to the ER.
 *
 * The #[delegate] macro in ephemeral_rollups_sdk appends these accounts
 * after the original context accounts (operator + intent):
 *   owner_program, buffer, delegation_record, delegation_metadata,
 *   delegation_program, system_program
 */
function buildDelegateIntent(
  operator: PublicKey,
  intent: PublicKey,
  bump: number,
  sessionBytes: Uint8Array,
  validator: PublicKey
): TransactionInstruction {
  // Args: session_id [u8;32]
  const data = Buffer.alloc(8 + 32);
  disc("delegate_intent").copy(data, 0);
  Buffer.from(sessionBytes).copy(data, 8);

  const buffer = delegateBuffer(intent);
  const record = delegationRecord(intent);
  const metadata = delegationMetadata(intent);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: operator, isSigner: true, isWritable: true },
      { pubkey: intent, isSigner: false, isWritable: true },
      // Appended by #[delegate] macro
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },       // owner_program
      { pubkey: buffer, isSigner: false, isWritable: true },            // delegate buffer
      { pubkey: record, isSigner: false, isWritable: true },            // delegation_record
      { pubkey: metadata, isSigner: false, isWritable: true },          // delegation_metadata
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false }, // delegation_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * authorize_release: verifies facade balance inside the ER, marks intent
 * as released, then calls commit_and_undelegate_accounts to bring the
 * intent account back to base chain. Send to the ER connection.
 */
function buildAuthorizeRelease(
  operator: PublicKey,
  facade: PublicKey,
  intent: PublicKey,
  facadeAta: PublicKey,
  sessionBytes: Uint8Array
): TransactionInstruction {
  // Args: _session_id [u8;32]
  const data = Buffer.alloc(8 + 32);
  disc("authorize_release").copy(data, 0);
  Buffer.from(sessionBytes).copy(data, 8);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: operator, isSigner: true, isWritable: true },
      { pubkey: facade, isSigner: false, isWritable: false },
      { pubkey: intent, isSigner: false, isWritable: true },
      { pubkey: facadeAta, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * settle: transfers facade ATA → merchant ATA and closes the facade ATA.
 * Runs on base chain after authorize_release has committed back.
 */
function buildSettle(
  operator: PublicKey,
  facade: PublicKey,
  intent: PublicKey,
  facadeAta: PublicKey,
  merchantAta: PublicKey,
  sessionBytes: Uint8Array
): TransactionInstruction {
  // Args: _session_id [u8;32]
  const data = Buffer.alloc(8 + 32);
  disc("settle").copy(data, 0);
  Buffer.from(sessionBytes).copy(data, 8);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: operator, isSigner: true, isWritable: true },
      { pubkey: facade, isSigner: true, isWritable: false },  // facade signs
      { pubkey: intent, isSigner: false, isWritable: true },  // closed → operator
      { pubkey: facadeAta, isSigner: false, isWritable: true },
      { pubkey: merchantAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── Config ────────────────────────────────────────────────────────────────────

export function validateSolanaConfig(): { configured: boolean } {
  return { configured: isErConfigured() };
}

export function isErConfigured(): boolean {
  return !!(
    process.env.SERVER_KEYPAIR &&
    process.env.MERCHANT_USDC_ATA &&
    process.env.USDC_MINT
  );
}

function cfg() {
  return {
    usdcMint: new PublicKey(process.env.USDC_MINT!),
    merchantAta: new PublicKey(process.env.MERCHANT_USDC_ATA!),
    validator: new PublicKey(
      process.env.ER_VALIDATOR ?? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
    ),
    base: new Connection(
      process.env.SOLANA_RPC ?? "https://api.devnet.solana.com",
      "confirmed"
    ),
    er: new Connection(
      process.env.ER_RPC ?? "https://devnet.magicblock.app",
      {
        commitment: "confirmed",
        wsEndpoint: process.env.ER_WS ?? "wss://devnet.magicblock.app",
      }
    ),
    server: Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR!)),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates a facade ATA and registers a SettlementIntent PDA on-chain,
 * then delegates the intent to the ER validator.
 *
 * Flow: create facade ATA → initialize_intent → delegate_intent
 */
export async function createAndDelegateFacade(
  sessionId: string,
  amountUsdc: number,
  expiresAt: Date
): Promise<{ facadeAddress: string; keypairB58: string }> {
  const { usdcMint, merchantAta, validator, base, server } = cfg();
  const facade = Keypair.generate();
  const facadeAta = getAssociatedTokenAddressSync(usdcMint, facade.publicKey);
  const sessionBytes = sessionIdToBytes(sessionId);
  const [intent, bump] = intentPda(sessionBytes);

  const requiredAmount = BigInt(Math.round(amountUsdc * 1_000_000));
  const expiresAtUnix = BigInt(Math.floor(expiresAt.getTime() / 1000));

  // 1. Create facade ATA
  const createAtaIx = createAssociatedTokenAccountInstruction(
    server.publicKey,
    facadeAta,
    facade.publicKey,
    usdcMint
  );

  // 2. initialize_intent PDA
  const initIx = buildInitializeIntent(
    server.publicKey,
    facade.publicKey,
    server.publicKey, // merchant = server (vault owner)
    usdcMint,
    intent,
    sessionBytes,
    requiredAmount,
    expiresAtUnix
  );

  // 3. delegate_intent PDA to ER — single transaction
  const delegateIx = buildDelegateIntent(
    server.publicKey,
    intent,
    bump,
    sessionBytes,
    validator
  );

  const tx = new Transaction().add(createAtaIx, initIx, delegateIx);
  await sendAndConfirmTransaction(base, tx, [server]);

  return {
    facadeAddress: facadeAta.toBase58(),
    keypairB58: bs58.encode(facade.secretKey),
  };
}

/**
 * Reads the facade ATA balance. Checks the ER first (in case the buyer's
 * payment is still in ER state), falling back to base chain.
 */
export async function getFacadeBalance(facadeAddress: string): Promise<bigint> {
  const { er, base } = cfg();
  try {
    const acct = await getAccount(er, new PublicKey(facadeAddress));
    if (acct.amount > 0n) return acct.amount;
  } catch { /* fall through */ }
  try {
    const acct = await getAccount(base, new PublicKey(facadeAddress));
    return acct.amount;
  } catch {
    return 0n;
  }
}

/**
 * Settles a payment session via the Anchor program.
 *
 * Flow:
 *   1. authorize_release → sent to ER (verifies facade balance, marks
 *      intent.released = true, commits intent back to base chain)
 *   2. Poll base chain until intent is visible (released = true)
 *   3. settle → sent to base chain (transfers facade ATA → merchant ATA,
 *      closes facade ATA, closes intent PDA)
 */
export async function settleFacade(
  keypairB58: string,
  facadeAddress: string,
  sessionId: string
): Promise<string> {
  const { usdcMint, merchantAta, base, er, server } = cfg();
  const facade = Keypair.fromSecretKey(bs58.decode(keypairB58));
  const facadeAtaPk = new PublicKey(facadeAddress);
  const sessionBytes = sessionIdToBytes(sessionId);
  const [intent] = intentPda(sessionBytes);

  // 1. authorize_release on ER — balance check + commit intent back to base
  const authIx = buildAuthorizeRelease(
    server.publicKey,
    facade.publicKey,
    intent,
    facadeAtaPk,
    sessionBytes
  );
  const authTx = new Transaction().add(authIx);
  await sendAndConfirmTransaction(er, authTx, [server]);

  // 2. Wait for the intent to be visible on base chain (commit propagation)
  const intentData = await pollIntentReleased(base, intent);
  if (!intentData) throw new Error("intent did not commit to base chain in time");

  // 3. settle on base chain — transfer facade ATA → merchant ATA + close
  const settleIx = buildSettle(
    server.publicKey,
    facade.publicKey,
    intent,
    facadeAtaPk,
    merchantAta,
    sessionBytes
  );
  const settleTx = new Transaction().add(settleIx);
  const sig = await sendAndConfirmTransaction(base, settleTx, [server, facade]);
  return sig;
}

/**
 * Polls the base chain until the SettlementIntent account shows
 * released = true (byte offset 201 in the borsh-serialised account).
 * Returns the account info or null if timeout.
 */
async function pollIntentReleased(
  connection: Connection,
  intent: PublicKey,
  maxAttempts = 20,
  delayMs = 1500
): Promise<Buffer | null> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const info = await connection.getAccountInfo(intent);
      if (info && info.data.length >= 202) {
        const released = info.data[201]; // bool at offset 201
        if (released === 1) return info.data as unknown as Buffer;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// ── Vault helpers (unchanged) ─────────────────────────────────────────────────

export function isWithdrawConfigured(): boolean {
  return !!(
    process.env.SERVER_KEYPAIR &&
    process.env.MERCHANT_USDC_ATA &&
    process.env.USDC_MINT
  );
}

export function getVaultAddress(): { wallet: string; ata: string } {
  const { server, merchantAta } = cfg();
  return { wallet: server.publicKey.toBase58(), ata: merchantAta.toBase58() };
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
