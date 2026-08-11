import { createHash } from "crypto";
import {
  ConnectionMagicRouter,
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

export const MIRAGE_VAULT_PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "D6au34Ft153B5ghrujVzTg4nGJFiitpePnoQ666JPzB7",
);

const INITIALIZE_INTENT = Buffer.from([105, 101, 174, 147, 104, 107, 35, 30]);
const DELEGATE_INTENT = Buffer.from([250, 23, 63, 197, 138, 162, 204, 219]);
const AUTHORIZE_RELEASE = Buffer.from([88, 158, 206, 44, 32, 193, 106, 215]);
const SETTLE = Buffer.from([175, 42, 185, 87, 144, 131, 102, 212]);
const SETTLEMENT_SEED = Buffer.from("settlement");
const RELEASED_OFFSET = 201;
const SETTLED_OFFSET = 202;

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function i64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

export function conditionalSessionId(sessionId: string): Buffer {
  return createHash("sha256").update(sessionId, "utf8").digest();
}

export function settlementIntentAddress(sessionId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, conditionalSessionId(sessionId)],
    MIRAGE_VAULT_PROGRAM_ID,
  )[0];
}

function instructionData(discriminator: Buffer, sessionId: string, ...args: Buffer[]): Buffer {
  return Buffer.concat([discriminator, conditionalSessionId(sessionId), ...args]);
}

export function buildInitializeIntentInstruction(input: {
  sessionId: string;
  operator: PublicKey;
  facade: PublicKey;
  merchant: PublicKey;
  mint: PublicKey;
  requiredAmount: bigint;
  expiresAt: Date;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MIRAGE_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: input.operator, isSigner: true, isWritable: true },
      { pubkey: input.facade, isSigner: false, isWritable: false },
      { pubkey: input.merchant, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: settlementIntentAddress(input.sessionId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData(
      INITIALIZE_INTENT,
      input.sessionId,
      u64(input.requiredAmount),
      i64(BigInt(Math.floor(input.expiresAt.getTime() / 1000))),
    ),
  });
}

export function buildDelegateIntentInstruction(
  sessionId: string,
  operator: PublicKey,
): TransactionInstruction {
  const intent = settlementIntentAddress(sessionId);
  return new TransactionInstruction({
    programId: MIRAGE_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: operator, isSigner: true, isWritable: true },
      {
        pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(intent, MIRAGE_VAULT_PROGRAM_ID),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: delegationRecordPdaFromDelegatedAccount(intent), isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPdaFromDelegatedAccount(intent), isSigner: false, isWritable: true },
      { pubkey: intent, isSigner: false, isWritable: true },
      { pubkey: MIRAGE_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: instructionData(DELEGATE_INTENT, sessionId),
  });
}

export function buildAuthorizeReleaseInstruction(input: {
  sessionId: string;
  operator: PublicKey;
  facade: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MIRAGE_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: input.operator, isSigner: true, isWritable: true },
      { pubkey: input.facade, isSigner: false, isWritable: false },
      { pubkey: settlementIntentAddress(input.sessionId), isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(input.mint, input.facade),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: instructionData(AUTHORIZE_RELEASE, input.sessionId),
  });
}

export function buildSettleInstruction(input: {
  sessionId: string;
  operator: PublicKey;
  facade: PublicKey;
  merchant: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MIRAGE_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: input.operator, isSigner: true, isWritable: true },
      { pubkey: input.facade, isSigner: true, isWritable: false },
      { pubkey: settlementIntentAddress(input.sessionId), isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(input.mint, input.facade),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: getAssociatedTokenAddressSync(input.mint, input.merchant),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: instructionData(SETTLE, input.sessionId),
  });
}

function chainConfig() {
  const baseRpc = process.env.SOLANA_RPC?.trim()
    || process.env.SOLANA_RPC_URL?.trim()
    || "https://api.devnet.solana.com";
  const routerRpc = process.env.MAGICBLOCK_ROUTER_RPC?.trim();
  if (!routerRpc) throw new Error("MAGICBLOCK_ROUTER_RPC is required for conditional settlement");
  const operator = Keypair.fromSecretKey(bs58.decode(process.env.SERVER_KEYPAIR!));
  const mint = new PublicKey(process.env.USDC_MINT!);
  return {
    base: new Connection(baseRpc, "confirmed"),
    router: new ConnectionMagicRouter(routerRpc, "confirmed"),
    operator,
    merchant: operator.publicKey,
    mint,
  };
}

export async function initializeConditionalIntent(input: {
  sessionId: string;
  facadeAddress: string;
  requiredAmount: bigint;
  expiresAt: Date;
}): Promise<{ intentAddress: string; signature: string }> {
  const cfg = chainConfig();
  const intent = settlementIntentAddress(input.sessionId);
  const existing = await cfg.base.getAccountInfo(intent, "confirmed");
  if (existing?.owner.equals(MIRAGE_VAULT_PROGRAM_ID)) {
    return { intentAddress: intent.toBase58(), signature: "already-initialized" };
  }
  const ix = buildInitializeIntentInstruction({
    ...input,
    operator: cfg.operator.publicKey,
    facade: new PublicKey(input.facadeAddress),
    merchant: cfg.merchant,
    mint: cfg.mint,
  });
  const signature = await sendAndConfirmTransaction(cfg.base, new Transaction().add(ix), [cfg.operator]);
  return { intentAddress: intent.toBase58(), signature };
}

export async function delegateConditionalIntent(sessionId: string): Promise<string> {
  const cfg = chainConfig();
  const intent = settlementIntentAddress(sessionId);
  const existing = await cfg.base.getAccountInfo(intent, "confirmed");
  if (existing?.owner.equals(DELEGATION_PROGRAM_ID)) return "already-delegated";
  return sendAndConfirmTransaction(
    cfg.base,
    new Transaction().add(buildDelegateIntentInstruction(sessionId, cfg.operator.publicKey)),
    [cfg.operator],
  );
}

export async function authorizeConditionalRelease(input: {
  sessionId: string;
  facadeAddress: string;
}): Promise<string> {
  const cfg = chainConfig();
  const ix = buildAuthorizeReleaseInstruction({
    ...input,
    operator: cfg.operator.publicKey,
    facade: new PublicKey(input.facadeAddress),
    mint: cfg.mint,
  });
  return cfg.router.sendAndConfirmTransaction(new Transaction().add(ix), [cfg.operator], {
    commitment: "confirmed",
  });
}

export async function waitForReleasedIntent(sessionId: string, timeoutMs = 45_000): Promise<void> {
  const cfg = chainConfig();
  const intent = settlementIntentAddress(sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const account = await cfg.base.getAccountInfo(intent, "confirmed");
    if (
      account?.owner.equals(MIRAGE_VAULT_PROGRAM_ID)
      && account.data.length > SETTLED_OFFSET
      && account.data[RELEASED_OFFSET] === 1
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timed out waiting for intent ${intent.toBase58()} to commit and undelegate`);
}

export async function settleConditionalIntent(input: {
  sessionId: string;
  facadeKeypairB58: string;
}): Promise<string> {
  const cfg = chainConfig();
  const intent = settlementIntentAddress(input.sessionId);
  const account = await cfg.base.getAccountInfo(intent, "confirmed");
  if (!account) return "already-settled";
  if (!account.owner.equals(MIRAGE_VAULT_PROGRAM_ID)) {
    throw new Error("settlement intent has not returned to the base chain");
  }
  if (account.data.length > SETTLED_OFFSET && account.data[SETTLED_OFFSET] === 1) {
    return "already-settled";
  }
  const facade = Keypair.fromSecretKey(bs58.decode(input.facadeKeypairB58));
  const ix = buildSettleInstruction({
    sessionId: input.sessionId,
    operator: cfg.operator.publicKey,
    facade: facade.publicKey,
    merchant: cfg.merchant,
    mint: cfg.mint,
  });
  return sendAndConfirmTransaction(cfg.base, new Transaction().add(ix), [cfg.operator, facade]);
}