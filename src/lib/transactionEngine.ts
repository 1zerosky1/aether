// =============================================================================
// TransactionEngine — the offline-first heart of OmniSovereign Pillar 1.
//
// Responsibilities:
//   1. Refresh + cache durable-nonce snapshots while connectivity is available.
//   2. Build SPL token transfers offline from a cached snapshot — zero RPC.
//   3. Provide a static, RPC-free validator the receiver runs before broadcast.
//
// Threading: NOT thread-safe. Each pillar (offline payment, document auditor,
// dead-man switch) gets its own instance so refresh races stay scoped.
//
// Where WDK plugs in:
//   - The `sender: Keypair` would come from @tetherto/wdk-wallet-solana
//     deriving from a seed in the device's secure enclave (m/44'/501'/0'/0').
//   - When WDK ships durable-nonce-aware gasless transfers, the
//     nonceAdvance + ATA-create + transferChecked block here gets replaced
//     wholesale by the WDK builder. The receiver-side validator stays the same.
// =============================================================================

import {
  Commitment,
  Connection,
  Keypair,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { isSolanaRetryable, withRetry } from './retry';

export interface NonceSnapshot {
  /** Address of the on-chain nonce account. */
  noncePubkey: PublicKey;
  /** Authority allowed to advance the nonce. Must equal the offline signer. */
  authorityPubkey: PublicKey;
  /** Cached nonce value — fills the slot of `recentBlockhash` on offline txs. */
  nonce: string;
  /** ms epoch the snapshot was fetched. Soft staleness signal only — durable
   *  nonces remain valid until consumed, not until they expire. */
  fetchedAt: number;
}

export interface SplTokenConfig {
  mint: PublicKey;
  decimals: number;
  /** Optional human label used only in logs / errors. */
  symbol?: string;
}

export interface OfflineTransferRequest {
  sender: Keypair;
  receiverOwner: PublicKey;
  /** UI-denominated amount, e.g. 1.5 USDC. Engine handles decimal scaling. */
  amountUiUnits: number;
  token: SplTokenConfig;
  nonceSnapshot: NonceSnapshot;
}

export interface EngineOptions {
  commitment?: Commitment;
  /** Soft TTL after which we *recommend* a refresh; the cache is still usable. */
  nonceCacheTtlMs?: number;
}

const DEFAULT_OPTIONS: Required<EngineOptions> = {
  commitment: 'confirmed',
  nonceCacheTtlMs: 5 * 60 * 1000,
};

// SystemProgram instruction enum discriminator for AdvanceNonceAccount.
// Used by the static validator to confirm the first instruction follows our
// durable-nonce convention without having to decode the full instruction.
const SYSTEM_INSTRUCTION_ADVANCE_NONCE = 4;

// Solana wire-format max single-packet tx size. Hard cap on accepted payloads
// (anti-DoS). Anything bigger is either malformed or hostile.
const SOLANA_MAX_TX_BYTES = 1232;

export class TransactionEngine {
  private readonly opts: Required<EngineOptions>;
  private snapshot: NonceSnapshot | null = null;

  constructor(
    private readonly connection: Connection,
    opts: EngineOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  // ── Online: refresh / cache management ──────────────────────────────────

  /**
   * Pull the current nonce value from the chain and cache it locally. Call any
   * time the device has network — on app launch, on Wi-Fi connect, after a
   * successful broadcast (since we just consumed the cached value).
   */
  async refreshNonceSnapshot(
    noncePubkey: PublicKey,
    authorityPubkey: PublicKey,
  ): Promise<NonceSnapshot> {
    const info = await withRetry(
      () => this.connection.getAccountInfo(noncePubkey, this.opts.commitment),
      {
        isRetryable: isSolanaRetryable,
        maxAttempts: 4,
      },
    );
    if (!info) {
      throw new Error(
        `Nonce account ${noncePubkey.toBase58()} not found on chain. ` +
        `Run the setup script before going offline.`,
      );
    }
    const parsed = NonceAccount.fromAccountData(info.data);
    if (!parsed.authorizedPubkey.equals(authorityPubkey)) {
      throw new Error(
        `Nonce account authority mismatch: chain says ` +
        `${parsed.authorizedPubkey.toBase58()}, expected ${authorityPubkey.toBase58()}.`,
      );
    }
    this.snapshot = {
      noncePubkey,
      authorityPubkey,
      nonce: parsed.nonce,
      fetchedAt: Date.now(),
    };
    return this.snapshot;
  }

  getCachedSnapshot(): NonceSnapshot | null {
    return this.snapshot;
  }

  isCacheStale(): boolean {
    if (!this.snapshot) return true;
    return Date.now() - this.snapshot.fetchedAt > this.opts.nonceCacheTtlMs;
  }

  // ── Offline: signed-tx construction (zero RPC) ──────────────────────────

  /**
   * Build and sign an SPL token transfer with no network access.
   *
   * Instruction layout (order matters):
   *   [0] SystemProgram.advanceNonceAccount       ← MUST be first for durable nonces
   *   [1] AssociatedToken.createIdempotent        ← cheap if exists, ~2k lamports otherwise
   *   [2] Token.transferChecked                   ← decimals-validated transfer
   */
  buildOfflineSplTransfer(req: OfflineTransferRequest): Buffer {
    const { sender, receiverOwner, amountUiUnits, token, nonceSnapshot } = req;

    if (!nonceSnapshot.authorityPubkey.equals(sender.publicKey)) {
      throw new Error(
        'Nonce authority must equal sender pubkey for the single-sig flow used here.',
      );
    }
    if (!Number.isFinite(amountUiUnits) || amountUiUnits <= 0) {
      throw new Error(`Transfer amount must be positive finite, got ${amountUiUnits}`);
    }
    if (token.decimals < 0 || token.decimals > 18) {
      throw new Error(`Implausible token decimals: ${token.decimals}`);
    }

    // Convert UI amount → raw token units. BigInt to avoid float drift on
    // values like 0.1 * 1e9.
    const rawAmount = BigInt(Math.round(amountUiUnits * 10 ** token.decimals));
    if (rawAmount <= 0n) {
      throw new Error(`Amount rounds to zero raw units at ${token.decimals} decimals`);
    }

    const senderAta = getAssociatedTokenAddressSync(
      token.mint,
      sender.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const receiverAta = getAssociatedTokenAddressSync(
      token.mint,
      receiverOwner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction();

    // [0] Durable-nonce contract: advance MUST be instruction[0], must
    // reference the same account whose nonce we used as recentBlockhash, and
    // must be signed by the nonce authority. Runtime rejects with
    // "blockhash not found" otherwise. This advance is also our replay
    // protection — the nonce rotates atomically when the tx lands.
    tx.add(
      SystemProgram.nonceAdvance({
        noncePubkey: nonceSnapshot.noncePubkey,
        authorizedPubkey: nonceSnapshot.authorityPubkey,
      }),
    );

    // [1] Idempotent ATA create. We can't query "does this ATA exist?"
    // offline, so we always include the create. If it already exists this is
    // a no-op (~minimal CU). If not, the sender pays ~2,039,280 lamports of
    // rent for the new account. Production WDK would cache "ATA known to
    // exist for (mint, owner)" markers and skip this when safe.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        sender.publicKey,
        receiverAta,
        receiverOwner,
        token.mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );

    // [2] transferChecked over legacy transfer because the runtime verifies
    // the decimals against the mint. Catches a class of UI bugs where the
    // app would otherwise send 1,000,000 instead of 1.0 USDC.
    tx.add(
      createTransferCheckedInstruction(
        senderAta,
        token.mint,
        receiverAta,
        sender.publicKey,
        rawAmount,
        token.decimals,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );

    // The "durable" trick: stuff the cached nonce into the slot where a
    // recent blockhash would normally go. The runtime treats them
    // interchangeably *given* the AdvanceNonceAccount above proves we own a
    // fresh value.
    tx.recentBlockhash = nonceSnapshot.nonce;
    tx.feePayer = sender.publicKey;

    // Pure ed25519 signing. No RPC, no clock sync, no network entropy.
    // On a real device WDK would prompt for biometric unlock and call into
    // the secure enclave instead of using a raw Keypair here.
    tx.sign(sender);

    if (!tx.verifySignatures()) {
      throw new Error('Local signature verification failed — refusing to emit tx');
    }

    return tx.serialize();
  }

  // ── Static: receiver-side validator ─────────────────────────────────────

  /**
   * RPC-free validator the receiver runs BEFORE broadcasting. Catches:
   *   - garbage / truncated / oversized buffers
   *   - txs that don't follow our durable-nonce convention
   *   - missing or invalid signatures
   *   - txs that don't reference the expected nonce account (when configured)
   *
   * Returns the parsed Transaction so the caller can read sigs / instructions.
   * Throws with a descriptive message on any failure — receiver should log and
   * drop the connection rather than waste an RPC call.
   */
  static validateRawTransaction(
    buf: Buffer | Uint8Array,
    opts: { expectedNoncePubkey?: PublicKey; maxBytes?: number } = {},
  ): Transaction {
    const maxBytes = opts.maxBytes ?? SOLANA_MAX_TX_BYTES;
    if (!(buf instanceof Uint8Array)) {
      throw new Error('Payload is not a Buffer/Uint8Array');
    }
    if (buf.length === 0) throw new Error('Empty payload');
    if (buf.length > maxBytes) {
      throw new Error(
        `Payload exceeds Solana max tx size (${buf.length} > ${maxBytes} bytes)`,
      );
    }

    let tx: Transaction;
    try {
      tx = Transaction.from(buf);
    } catch (err) {
      throw new Error(`Malformed transaction: ${(err as Error).message}`);
    }

    if (tx.instructions.length === 0) throw new Error('Transaction has no instructions');
    if (tx.signatures.length === 0) throw new Error('Transaction has no signatures');
    if (tx.signatures.some((s) => s.signature === null)) {
      throw new Error('Transaction has unsigned required signers');
    }

    // Convention check: first instruction MUST be SystemProgram.AdvanceNonce.
    // This is what makes the durable-nonce contract work; receivers should
    // drop anything that doesn't follow it (it can't have come from an honest
    // OSov sender).
    const first = tx.instructions[0];
    if (!first.programId.equals(SystemProgram.programId)) {
      throw new Error(
        'First instruction is not SystemProgram (expected AdvanceNonceAccount for durable-nonce flow)',
      );
    }
    if (first.data.length < 4) {
      throw new Error('First instruction data too short to contain SystemProgram discriminator');
    }
    const discriminator = first.data.readUInt32LE(0);
    if (discriminator !== SYSTEM_INSTRUCTION_ADVANCE_NONCE) {
      throw new Error(
        `First instruction is not AdvanceNonceAccount (discriminator ${discriminator}, expected ${SYSTEM_INSTRUCTION_ADVANCE_NONCE})`,
      );
    }
    if (opts.expectedNoncePubkey) {
      const noncePubkey = first.keys[0]?.pubkey;
      if (!noncePubkey || !noncePubkey.equals(opts.expectedNoncePubkey)) {
        throw new Error(
          `Nonce account in tx (${noncePubkey?.toBase58() ?? 'missing'}) does not ` +
          `match expected (${opts.expectedNoncePubkey.toBase58()})`,
        );
      }
    }

    if (!tx.verifySignatures()) {
      throw new Error('Cryptographic signature verification failed');
    }

    return tx;
  }
}
