// One-time provisioning, run online. Creates / verifies:
//   - Sender, receiver, nonce-account, mint keypairs
//   - Funded sender wallet (devnet airdrop, with clear fallback message if
//     rate-limited — operators inject SENDER_SECRET_KEY and re-run)
//   - Initialized durable nonce account
//   - SPL token mint with 6 decimals (USDC-like)
//   - Sender's ATA, with 1000 tokens minted in
//
// Idempotent: safe to re-run. Skips any step whose on-chain state already
// matches what we'd create. Persists everything to .poc-state.json.

import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import {
  KEYSTORE_PATH,
  loadKeystoreFromEnv,
  loadKeystoreFromFile,
  PocKeystore,
  saveKeystoreToFile,
} from '../lib/keystore';

const RPC = process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet');
const TOKEN_DECIMALS = 6;
const INITIAL_TOKEN_SUPPLY_UI = 1000;
const REQUIRED_SOL = 1;

async function ensureFunded(conn: Connection, kp: Keypair): Promise<void> {
  const balance = await conn.getBalance(kp.publicKey);
  if (balance >= REQUIRED_SOL * LAMPORTS_PER_SOL) {
    console.log(`[ok] sender funded with ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    return;
  }
  console.log(`     trying devnet airdrop for ${kp.publicKey.toBase58()}...`);
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('[ok] airdrop succeeded');
  } catch (err) {
    throw new Error(
      `\nAirdrop failed: ${(err as Error).message}\n\n` +
      `Devnet airdrops are heavily rate-limited. To proceed:\n` +
      `  1. Generate a keypair locally:\n` +
      `       solana-keygen new --outfile sender.json --no-bip39-passphrase\n` +
      `  2. Fund it via https://faucet.solana.com or another faucet.\n` +
      `  3. Re-run setup with the secret injected:\n` +
      `       SENDER_SECRET_KEY="$(cat sender.json)" npm run setup\n` +
      `\n` +
      `You can also point at any RPC by setting SOLANA_RPC_URL.\n`,
    );
  }
}

async function ensureNonceAccount(
  conn: Connection,
  payer: Keypair,
  nonceKp: Keypair,
): Promise<void> {
  const existing = await conn.getAccountInfo(nonceKp.publicKey);
  if (existing) {
    console.log(`[ok] nonce account ${nonceKp.publicKey.toBase58()} already exists`);
    return;
  }
  console.log('     creating durable nonce account...');
  const rentExempt = await conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: nonceKp.publicKey,
      lamports: rentExempt,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({
      noncePubkey: nonceKp.publicKey,
      authorizedPubkey: payer.publicKey,
    }),
  );
  await sendAndConfirmTransaction(conn, tx, [payer, nonceKp]);
  console.log('[ok] nonce account initialized');
}

async function ensureMint(
  conn: Connection,
  payer: Keypair,
  mintKp: Keypair,
): Promise<PublicKey> {
  const existing = await conn.getAccountInfo(mintKp.publicKey);
  if (existing) {
    console.log(`[ok] mint ${mintKp.publicKey.toBase58()} already exists`);
    return mintKp.publicKey;
  }
  console.log('     creating SPL token mint...');
  const mint = await createMint(
    conn,
    payer,
    payer.publicKey,
    null,
    TOKEN_DECIMALS,
    mintKp,
  );
  console.log(`[ok] mint created: ${mint.toBase58()}`);
  return mint;
}

async function ensureSenderTokens(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey,
): Promise<void> {
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  const required = BigInt(INITIAL_TOKEN_SUPPLY_UI) * BigInt(10 ** TOKEN_DECIMALS);
  if (ata.amount >= required) {
    console.log(
      `[ok] sender ATA already holds ${Number(ata.amount) / 10 ** TOKEN_DECIMALS} tokens`,
    );
    return;
  }
  console.log(`     minting ${INITIAL_TOKEN_SUPPLY_UI} tokens to sender ATA...`);
  await mintTo(
    conn,
    payer,
    mint,
    ata.address,
    payer.publicKey,
    Number(required),
  );
  console.log(`[ok] minted ${INITIAL_TOKEN_SUPPLY_UI} tokens`);
}

async function main() {
  console.log(`Setup against ${RPC}\n`);
  const conn = new Connection(RPC, 'confirmed');

  const fromEnv = loadKeystoreFromEnv();
  const fromFile = loadKeystoreFromFile();

  const ks: PocKeystore = {
    sender:        fromEnv.sender        ?? fromFile.sender        ?? Keypair.generate(),
    receiver:      fromEnv.receiver      ?? fromFile.receiver      ?? Keypair.generate(),
    nonceAccount:  fromEnv.nonceAccount  ?? fromFile.nonceAccount  ?? Keypair.generate(),
    tokenMint:     fromEnv.tokenMint     ?? fromFile.tokenMint     ?? Keypair.generate(),
  };

  console.log('Keys:');
  console.log(`  sender:        ${ks.sender.publicKey.toBase58()}`);
  console.log(`  receiver:      ${ks.receiver.publicKey.toBase58()}`);
  console.log(`  nonce account: ${ks.nonceAccount.publicKey.toBase58()}`);
  console.log(`  token mint:    ${ks.tokenMint.publicKey.toBase58()}\n`);

  await ensureFunded(conn, ks.sender);
  await ensureNonceAccount(conn, ks.sender, ks.nonceAccount);
  const mint = await ensureMint(conn, ks.sender, ks.tokenMint);
  await ensureSenderTokens(conn, ks.sender, mint);

  saveKeystoreToFile(ks);
  console.log(`\n[done] state written to ${KEYSTORE_PATH}`);
  console.log(`        sender:   https://explorer.solana.com/address/${ks.sender.publicKey.toBase58()}?cluster=devnet`);
  console.log(`        receiver: https://explorer.solana.com/address/${ks.receiver.publicKey.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
