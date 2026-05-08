// =============================================================================
// SenderMobile — simulates the offline tourist's phone.
//
// Flow:
//   1. (online, one-time) primeNonce()  — pull the durable nonce from RPC.
//   2. mic captures audio  →  analyzeIntentWithQVAC()  →  PaymentIntent
//   3. handleResolver maps "vendor.sol" → on-chain PublicKey  (WDK in prod)
//   4. TransactionEngine builds + signs the SPL transfer offline
//   5. Hyperswarm dials the receiver on the session topic; we push the
//      framed payload over the encrypted Noise channel and exit.
//
// During steps 2-5 the device makes ZERO Solana RPC calls. That's the point.
//
// Hyperswarm caveat for the demo: DHT discovery still needs *some* internet
// (the phone briefly hits a bootstrap node). Truly air-gapped relay would
// swap the transport to BLE / Wi-Fi Direct — same architecture, different
// bytes-on-the-wire. For the hackathon demo we're proving the offline
// *Solana* path, not the offline *physical* path.
// =============================================================================

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import Hyperswarm from 'hyperswarm';
import { createHash } from 'crypto';
import {
  NonceSnapshot,
  SplTokenConfig,
  TransactionEngine,
} from '../lib/transactionEngine';
import { QvacModelPaths, QvacPipeline } from '../lib/qvacPipeline';

/**
 * What the local QVAC pipeline extracts from a voice clip.
 * Produced by QvacPipeline.run(): whisper.cpp transcribes → llama.cpp parses
 * the transcript into this strict schema using grammar-constrained sampling.
 */
export interface PaymentIntent {
  action: 'PAY';
  amount: number;
  /** Human-readable handle. Resolved to PublicKey via the handleResolver. */
  receiver: string;
  /** One of "USDC" | "USDT" | "SOL". Validated by the pipeline. */
  currency: string;
  memo?: string;
  /** LLM confidence [0,1]. Below the threshold we'd prompt the user. */
  confidence: number;
}

export interface SenderConfig {
  /**
   * Shared with the receiver out-of-band (printed on the merchant's screen,
   * scanned via QR/NFC). Both sides hash it to derive the swarm topic.
   */
  sessionId: string;
  token: SplTokenConfig;
  nonceAccount: PublicKey;
  /**
   * Maps human handles → on-chain owner. In production this is WDK's
   * `name@tether.me` resolver, with a local cache for offline use.
   */
  handleResolver: Map<string, PublicKey>;
  /** Local QVAC model paths — passed through to the pipeline. */
  qvacModels: QvacModelPaths;
  /** Hard cap on time we'll wait for the receiver to appear on the swarm. */
  swarmTimeoutMs?: number;
  /** Confidence below this triggers a UI confirm step in production. */
  intentConfidenceThreshold?: number;
}

export interface PaymentResult {
  intent: PaymentIntent;
  txBytes: number;
  /** Hex prefix of the receiver's Hyperswarm public key — useful for logs. */
  relayedTo: string;
  /**
   * Base58-encoded ed25519 signature of the signed transaction. Solana uses
   * the first signature as the canonical tx ID — this is what the receiver
   * will broadcast and what shows up on Solana Explorer.
   */
  signature: string;
}

export class SenderMobile {
  private readonly engine: TransactionEngine;
  private readonly qvac: QvacPipeline;
  private swarm: Hyperswarm | null = null;

  constructor(
    connection: Connection,
    private readonly senderKeypair: Keypair,
    private readonly cfg: SenderConfig,
  ) {
    this.engine = new TransactionEngine(connection);
    this.qvac = new QvacPipeline({ models: cfg.qvacModels });
  }

  /**
   * ONLINE step. Must run while the device has internet, before going dark.
   * Caches the nonce snapshot inside the engine.
   */
  async primeNonce(): Promise<NonceSnapshot> {
    return this.engine.refreshNonceSnapshot(
      this.cfg.nonceAccount,
      this.senderKeypair.publicKey,
    );
  }

  /**
   * Real QVAC pipeline: WAV/MP3 file → whisper.cpp transcript → llama.cpp
   * structured intent extraction. Sequential model lifecycle keeps peak RAM
   * bounded by the larger of the two models, not the sum.
   *
   * Delegated to QvacPipeline (the only file in this codebase that touches
   * @qvac/sdk directly). If the SDK API drifts, only that file changes.
   */
  async analyzeIntentWithQVAC(audioPath: string): Promise<PaymentIntent> {
    if (typeof audioPath !== 'string' || audioPath.length === 0) {
      throw new Error('audioPath must be a non-empty string');
    }
    return this.qvac.run(audioPath);
  }

  /** End-to-end: voice file → intent → offline tx → P2P push. */
  async executePayment(audioPath: string): Promise<PaymentResult> {
    const intent = await this.analyzeIntentWithQVAC(audioPath);
    return this.executeIntent(intent);
  }

  /**
   * Same as executePayment(), but starting from an already-parsed PaymentIntent.
   * This is the path the bridge server takes: parse-voice returns the intent
   * to the UI, the user reviews + slides-to-confirm, then the UI POSTs the
   * approved intent back here. Skipping QVAC keeps the confirm step snappy
   * and gives the user a chance to veto bad parses.
   */
  async executeIntent(intent: PaymentIntent): Promise<PaymentResult> {
    const threshold = this.cfg.intentConfidenceThreshold ?? 0.7;
    if (intent.confidence < threshold) {
      throw new Error(
        `Intent confidence ${intent.confidence} below ${threshold} — would ` +
        `prompt user for explicit confirmation in production UI`,
      );
    }
    if (intent.action !== 'PAY') {
      throw new Error(`Unsupported intent action: ${intent.action}`);
    }
    const receiverOwner = this.cfg.handleResolver.get(intent.receiver);
    if (!receiverOwner) {
      throw new Error(`Cannot resolve receiver handle "${intent.receiver}"`);
    }
    const snapshot = this.engine.getCachedSnapshot();
    if (!snapshot) {
      throw new Error('No cached nonce snapshot — call primeNonce() while online first');
    }

    const txBuffer = this.engine.buildOfflineSplTransfer({
      sender: this.senderKeypair,
      receiverOwner,
      amountUiUnits: intent.amount,
      token: this.cfg.token,
      nonceSnapshot: snapshot,
    });

    // Pull the canonical Solana tx signature out of the signed buffer. The
    // first signature on a Solana tx IS its on-chain ID — once the receiver
    // broadcasts, this string is what shows up on Solana Explorer.
    const signature = extractTxSignature(txBuffer);

    const remotePubkey = await this.relayOverHyperswarm(txBuffer);

    return {
      intent,
      txBytes: txBuffer.length,
      relayedTo: remotePubkey.toString('hex').slice(0, 16),
      signature,
    };
  }

  // ── Internal: P2P transport ─────────────────────────────────────────────

  /**
   * Dial the receiver on the session topic and push the payload exactly once.
   * Returns the receiver's Hyperswarm public key on success.
   *
   * Wire format: 4-byte big-endian length prefix + payload. Lets the receiver
   * reassemble across TCP packet boundaries without ambiguity.
   *
   * The first 'connection' wins — sessionId acts as a shared secret so only
   * the intended receiver should ever announce on this topic. Production
   * would layer Noise mutual-auth on top, keyed off the WDK identity.
   */
  private async relayOverHyperswarm(payload: Buffer): Promise<Buffer> {
    const topic = topicFromSessionId(this.cfg.sessionId);
    const timeoutMs = this.cfg.swarmTimeoutMs ?? 30_000;

    this.swarm = new Hyperswarm();
    // We're the dialer — only client mode, don't announce ourselves.
    this.swarm.join(topic, { client: true, server: false });

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`No receiver discovered on topic within ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.swarm?.destroy().catch(() => { /* best-effort */ });
        this.swarm = null;
      };

      this.swarm!.on('connection', (conn) => {
        if (settled) {
          // Race: a second peer connected after we already finished. Drop.
          try { conn.destroy(); } catch { /* ignore */ }
          return;
        }

        const remote = conn.remotePublicKey;
        const framed = Buffer.alloc(4 + payload.length);
        framed.writeUInt32BE(payload.length, 0);
        payload.copy(framed, 4);

        conn.once('error', (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
        conn.once('close', () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(remote);
        });

        conn.write(framed, (err) => {
          if (err && !settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        });
        conn.end();
      });
    });
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

function extractTxSignature(signedTxBuffer: Buffer): string {
  const tx = Transaction.from(signedTxBuffer);
  const sig = tx.signatures[0]?.signature;
  if (!sig) {
    throw new Error('Signed transaction has no fee-payer signature — refusing to relay');
  }
  return bs58.encode(sig);
}
