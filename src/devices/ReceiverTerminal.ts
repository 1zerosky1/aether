// =============================================================================
// ReceiverTerminal — simulates the merchant's terminal (or any internet-
// connected mesh node willing to act as a "blind relayer").
//
// Responsibilities:
//   1. Listen on the sessionId's topic via Hyperswarm.
//   2. Validate every incoming buffer locally BEFORE spending an RPC call
//      (anti-DoS: garbage payloads should never cost us a network request).
//   3. Submit valid txs with exponential-backoff retries.
//   4. Surface results via callbacks so the caller drives UI / logging.
//
// The receiver holds NO authority over the sender's funds. They cannot tamper
// with the buffer (would invalidate signatures) and cannot censor it
// indefinitely (any mesh node can submit it instead). This is the "blind
// relayer" model from the QVAC Holepunch design.
// =============================================================================

import {
  Connection,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import Hyperswarm from 'hyperswarm';
import { createHash } from 'crypto';
import { TransactionEngine } from '../lib/transactionEngine';
import { isSolanaRetryable, withRetry } from '../lib/retry';

/**
 * A durable-nonce tx MUST have `SystemProgram.advanceNonceAccount` as its
 * first instruction. Anything else is a regular recent-blockhash tx and will
 * preflight-fail with "Blockhash not found" if we send it via the durable
 * pipeline. Tolerant decode — if the instruction simply isn't a System
 * instruction we treat that as "not a nonce tx" rather than throwing.
 */
function isDurableNonceTransaction(tx: Transaction): boolean {
  const first = tx.instructions[0];
  if (!first) return false;
  if (!first.programId.equals(SystemProgram.programId)) return false;
  try {
    return SystemInstruction.decodeInstructionType(first) === 'AdvanceNonceAccount';
  } catch {
    return false;
  }
}

export interface ReceiverConfig {
  /** Same value the sender is using — both hash to the same swarm topic. */
  sessionId: string;
  /**
   * If set, the validator rejects any tx that doesn't reference exactly this
   * nonce account. Recommended in production — pins the receiver to "our"
   * users' OSov flow.
   */
  expectedNoncePubkey?: PublicKey;
  /** Hard size cap on accepted P2P payloads. Defaults to Solana max (1232). */
  maxPayloadBytes?: number;
  /** Inactivity timeout per peer connection — drop slow/stalled dialers. */
  perConnectionTimeoutMs?: number;
  /** Total wait for confirmation after broadcast. */
  confirmationTimeoutMs?: number;
}

export interface BroadcastResult {
  /** base58 signature, suitable for explorer links. */
  signature: string;
  /** Hex prefix of the dialer's Hyperswarm public key. */
  remotePubkey: string;
  txBytes: number;
}

export interface ReceiverHandlers {
  onResult: (r: BroadcastResult) => void;
  onError?: (err: Error, source?: string) => void;
  onListening?: (topic: Buffer) => void;
}

interface ResolvedConfig {
  sessionId: string;
  expectedNoncePubkey?: PublicKey;
  maxPayloadBytes: number;
  perConnectionTimeoutMs: number;
  confirmationTimeoutMs: number;
}

export class ReceiverTerminal {
  private swarm: Hyperswarm | null = null;
  private readonly cfg: ResolvedConfig;

  constructor(
    private readonly connection: Connection,
    cfg: ReceiverConfig,
  ) {
    this.cfg = {
      sessionId: cfg.sessionId,
      expectedNoncePubkey: cfg.expectedNoncePubkey,
      maxPayloadBytes: cfg.maxPayloadBytes ?? 1232,
      perConnectionTimeoutMs: cfg.perConnectionTimeoutMs ?? 15_000,
      confirmationTimeoutMs: cfg.confirmationTimeoutMs ?? 45_000,
    };
  }

  async start(handlers: ReceiverHandlers): Promise<void> {
    if (this.swarm) throw new Error('Already started');

    const topic = topicFromSessionId(this.cfg.sessionId);
    this.swarm = new Hyperswarm();
    const discovery = this.swarm.join(topic, { server: true, client: false });
    await discovery.flushed();
    handlers.onListening?.(topic);

    this.swarm.on('connection', (conn) => {
      const remote = conn.remotePublicKey.toString('hex').slice(0, 16);
      const chunks: Buffer[] = [];
      let bytesSeen = 0;
      let expectedLength: number | null = null;
      let settled = false;

      const stallTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { conn.destroy(new Error('Connection stalled')); } catch { /* ignore */ }
        handlers.onError?.(
          new Error(`Peer ${remote} stalled (no payload within ${this.cfg.perConnectionTimeoutMs}ms)`),
          remote,
        );
      }, this.cfg.perConnectionTimeoutMs);

      const finish = async (payload: Buffer | null, error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        try { conn.end(); } catch { /* best-effort */ }

        if (error) {
          handlers.onError?.(error, remote);
          return;
        }
        try {
          const result = await this.processPayload(payload!, remote);
          handlers.onResult(result);
        } catch (err) {
          handlers.onError?.(err as Error, remote);
        }
      };

      conn.on('data', (chunk: Buffer) => {
        if (settled) return;
        chunks.push(chunk);
        bytesSeen += chunk.length;

        if (expectedLength === null && bytesSeen >= 4) {
          const merged = Buffer.concat(chunks);
          expectedLength = merged.readUInt32BE(0);
          if (expectedLength <= 0 || expectedLength > this.cfg.maxPayloadBytes) {
            finish(null, new Error(
              `Declared payload length ${expectedLength} out of bounds ` +
              `(0, ${this.cfg.maxPayloadBytes}]`,
            ));
            return;
          }
        }
        if (expectedLength !== null && bytesSeen >= 4 + expectedLength) {
          const merged = Buffer.concat(chunks);
          const payload = merged.subarray(4, 4 + expectedLength);
          finish(payload, null);
        }
      });

      conn.on('error', (err: Error) => finish(null, err));
      conn.on('close', () => {
        if (!settled) finish(null, new Error('Connection closed before payload complete'));
      });
    });
  }

  /**
   * Validate-then-broadcast pipeline. Public so callers / tests can pump
   * payloads in directly without involving Hyperswarm.
   */
  async processPayload(payload: Buffer, source: string): Promise<BroadcastResult> {
    // STEP 1 — local validation. Reject malformed/spam before touching RPC.
    // Throws on any failure; receiver loop converts to onError.
    const tx = TransactionEngine.validateRawTransaction(payload, {
      expectedNoncePubkey: this.cfg.expectedNoncePubkey,
      maxBytes: this.cfg.maxPayloadBytes,
    });

    // STEP 2 — broadcast with retries + wait for confirmation.
    const signature = await this.broadcastWithRetry(payload, tx);
    await this.waitForConfirmation(signature);

    return { signature, remotePubkey: source, txBytes: payload.length };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async broadcastWithRetry(rawTx: Buffer, parsed: Transaction): Promise<string> {
    // STEP 0 — sanity-check we're broadcasting a durable-nonce tx, not a
    // recent-blockhash tx. The first instruction on the tx must be
    // `SystemProgram.advanceNonceAccount` for durable nonces. If that's
    // missing, refuse — preflight would fail with "Blockhash not found"
    // and burn a slot for nothing.
    if (!isDurableNonceTransaction(parsed)) {
      throw new Error(
        'Refusing to broadcast: tx is not a durable-nonce transaction (instr[0] must be advanceNonceAccount).',
      );
    }
    // Recover the signature from the signed tx bytes for logging — gives the
    // operator a stable handle even before the cluster ack returns.
    const expectedSig = parsed.signatures[0]?.signature
      ? bs58.encode(parsed.signatures[0].signature)
      : '<unsigned>';
    console.log(
      `[receiver] Attempting Durable Nonce broadcast for signature: ${expectedSig}`,
    );
    return withRetry(
      async () => {
        try {
          // skipPreflight: true is mandatory for durable-nonce txs. Preflight
          // simulates against the cluster's recent blockhash, but durable
          // nonces commit against the nonce account's stored blockhash —
          // preflight will reject with "Blockhash not found" even when the
          // tx is valid. preflightCommitment is set so that *if* the runtime
          // ever does evaluate it, it uses the same level we confirm at.
          return await this.connection.sendRawTransaction(rawTx, {
            skipPreflight: true,
            preflightCommitment: 'confirmed',
            maxRetries: 0, // we manage retries ourselves
          });
        } catch (err) {
          // "Already processed" means the tx landed via another relayer or
          // an earlier attempt of ours — treat as success. We can recover
          // the signature directly from the signed tx bytes.
          if (err instanceof Error && /already processed/i.test(err.message)) {
            const firstSig = parsed.signatures[0]?.signature;
            if (firstSig) return bs58.encode(firstSig);
          }
          throw err;
        }
      },
      {
        maxAttempts: 5,
        baseDelayMs: 600,
        maxDelayMs: 8_000,
        isRetryable: isSolanaRetryable,
        onRetry: (attempt, err, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(`  [retry ${attempt}] ${msg.slice(0, 100)} — sleeping ${delayMs}ms`);
        },
      },
    );
  }

  /**
   * Polling-based confirmation. We can't use the lastValidBlockHeight strategy
   * because durable-nonce txs use a nonce in the recentBlockhash slot — it
   * doesn't have normal expiry semantics, so the strategy form misbehaves.
   */
  private async waitForConfirmation(sig: string): Promise<void> {
    const deadline = Date.now() + this.cfg.confirmationTimeoutMs;
    while (Date.now() < deadline) {
      const status = await withRetry(
        () => this.connection.getSignatureStatus(sig, { searchTransactionHistory: false }),
        { isRetryable: isSolanaRetryable, maxAttempts: 3, baseDelayMs: 400 },
      );
      const v = status.value;
      if (v?.err) {
        throw new Error(`Tx ${sig} failed on chain: ${JSON.stringify(v.err)}`);
      }
      if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') {
        return;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(
      `Confirmation timeout (${this.cfg.confirmationTimeoutMs}ms) for ${sig}`,
    );
  }

  async shutdown(): Promise<void> {
    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }
  }
}

function topicFromSessionId(sessionId: string): Buffer {
  return createHash('sha256').update(`osov:v1:${sessionId}`).digest();
}
