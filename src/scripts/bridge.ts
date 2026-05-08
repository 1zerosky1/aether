// =============================================================================
// bridge.ts — HTTP bridge between the React UI (Vite, :5173) and the
// existing offline-tx pipeline (QvacPipeline + SenderMobile).
//
// Why this exists:
//   The browser can't import @qvac/sdk (native bindings, fs, hyperswarm…),
//   so the UI POSTs the recorded audio here. This process holds the
//   long-lived SenderMobile instance, primes the durable nonce on startup
//   (the one ONLINE step), and then services every request from cached state.
//
// Endpoints:
//   GET  /health    liveness + cached-nonce + pubkeys
//   GET  /balance   sender's SPL token balance (rate-limit-tolerant)
//   GET  /events    Server-Sent Events stream of bridge logs (telemetry)
//   POST /parse     multipart audio (any browser format) → PaymentIntent JSON
//   POST /execute   PaymentIntent JSON → { signature, relayedTo, ... }
//
// CRITICAL: /parse transcodes the upload via ffmpeg to strict 16kHz / mono /
// s16le PCM WAV before handing the file to QVAC. Browser MediaRecorder emits
// webm/opus on Chromium (or ogg/vorbis on Firefox); whisper.cpp's bundled
// decoder silently produces empty transcripts on those, so the conversion
// step is mandatory.
//
// Run with:  PORT=3001 npm run bridge
// =============================================================================

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { SenderMobile, type PaymentIntent } from '../devices/SenderMobile';
import { loadKeystore } from '../lib/keystore';
import { TranscriptionEmptyError } from '../lib/qvacPipeline';
import { isSolanaRetryable, withRetry } from '../lib/retry';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.OSOV_BRIDGE_HOST ?? '0.0.0.0';
const RPC = process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet');
const SESSION_ID = process.env.OSOV_SESSION_ID ?? 'demo-session-001';

const WHISPER_MODEL = process.env.QVAC_WHISPER_MODEL ?? './models/ggml-tiny.en.bin';
const LLAMA_MODEL = process.env.QVAC_LLAMA_MODEL ?? './models/Llama-3.2-1B-Instruct-Q4_0.gguf';

const TOKEN_DECIMALS = 6;
const TOKEN_SYMBOL = 'USDC';

const TEMP_AUDIO_PATH = path.resolve(process.cwd(), 'temp-audio.wav');

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// ── SSE log fan-out ─────────────────────────────────────────────────────────

interface LogEvent {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const sseClients: Set<Response> = new Set();
const recentLogs: LogEvent[] = [];
const MAX_RECENT_LOGS = 200;

function broadcast(evt: LogEvent): void {
  recentLogs.push(evt);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.splice(0, recentLogs.length - MAX_RECENT_LOGS);
  }
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      // Client is gone; the 'close' handler will GC it.
    }
  }
}

function log(msg: string, level: LogEvent['level'] = 'info'): void {
  const line = `[bridge] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  broadcast({ ts: Date.now(), level, msg });
}

// ── Audio transcoding ───────────────────────────────────────────────────────

/**
 * Transcode an arbitrary browser-recorded blob (webm/opus, ogg/vorbis, mp4/aac,
 * raw wav, …) into the exact PCM format whisper.cpp wants:
 *   16,000 Hz · mono · 16-bit signed little-endian · WAV container.
 *
 * Filter chain (mandatory — Chrome MediaRecorder ships extremely quiet WebM):
 *   1. highpass=f=80    → strip subsonic rumble that fires Whisper's VAD
 *                          and causes it to emit empty strings on speech that
 *                          immediately follows the rumble window.
 *   2. dynaudnorm       → frame-by-frame adaptive normalization, lifts quiet
 *                          mobile recordings to ~-0.4 dBFS without clipping
 *                          already-loud input. Battle-tested for voice.
 *   3. volume=4.0       → final brute-force gain (+12 dB). Some QVAC builds
 *                          still need a hot signal even after dynaudnorm.
 *                          dynaudnorm caps at peak=0.95 so clipping here is
 *                          bounded by alimiter below.
 *   4. alimiter=limit=0.97 → hard ceiling to keep the +12 dB stage from
 *                          producing ugly digital clipping.
 *
 * Without normalization, Whisper accepts the bytes but emits an empty
 * transcript on most browser captures. This is the single most important
 * line of code in the bridge.
 */
function transcodeToWhisperWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(16_000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .audioFilters([
        'highpass=f=80',
        'dynaudnorm=p=0.95:m=20:s=12',
        'volume=4.0',
        'alimiter=limit=0.97',
      ])
      .format('wav')
      .on('error', (err) => reject(new Error(`ffmpeg: ${err.message}`)))
      .on('end', () => resolve())
      .save(outputPath);
  });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function main() {
  log('Loading keystore + RPC connection...');
  const ks = loadKeystore();
  const conn = new Connection(RPC, 'confirmed');

  log(`FFmpeg binary: ${ffmpegInstaller.path}`);
  log('Constructing SenderMobile (will lazy-load QVAC models on first call)...');
  const sender = new SenderMobile(conn, ks.sender, {
    sessionId: SESSION_ID,
    nonceAccount: ks.nonceAccount.publicKey,
    token: { mint: ks.tokenMint.publicKey, decimals: TOKEN_DECIMALS, symbol: TOKEN_SYMBOL },
    handleResolver: new Map<string, PublicKey>([
      ['vendor.sol', ks.receiver.publicKey],
    ]),
    qvacModels: {
      whisperModelPath: WHISPER_MODEL,
      llamaModelPath: LLAMA_MODEL,
    },
    swarmTimeoutMs: 60_000,
  });

  log('Priming durable nonce snapshot (one-time ONLINE step)...');
  const snap = await sender.primeNonce();
  log(`Cached nonce: ${snap.nonce}`);
  log('Bridge is ready. Subsequent /execute calls run from cache (no RPC).');

  const senderAta = getAssociatedTokenAddressSync(
    ks.tokenMint.publicKey,
    ks.sender.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // ── Optimistic balance state ────────────────────────────────────────────
  // Offline-tx UX: durable-nonce transactions don't hit the chain until the
  // receiver broadcasts the relayed payload, so the on-chain ATA balance
  // lags reality. We seed an in-memory mirror once at startup, deduct
  // immediately on every successful /execute relay, and serve /balance
  // from the mirror so the UI updates instantly. A `?refresh=1` query
  // re-syncs from RPC if the operator wants ground truth.
  async function fetchOnChainBalance(): Promise<number> {
    try {
      const bal = await withRetry(
        () => conn.getTokenAccountBalance(senderAta, 'confirmed'),
        { isRetryable: isSolanaRetryable, maxAttempts: 4 },
      );
      return bal.value.uiAmount ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/could not find account/i.test(msg) || /Invalid param/i.test(msg)) {
        return 0;
      }
      throw err;
    }
  }

  log('Seeding optimistic balance from on-chain ATA...');
  let optimisticBalance = await fetchOnChainBalance();
  log(`Optimistic balance seeded: ${optimisticBalance} ${TOKEN_SYMBOL}`);

  const app = express();
  // Local-dev bridge: open CORS so Vite can connect from any port (5173,
  // 5174, …) and any host alias (localhost, 127.0.0.1, LAN IP for phone
  // testing). This service never binds to a public network in production —
  // it lives behind the user's lock screen alongside the UI.
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['*'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  });

  // ── GET /health ──────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      rpc: RPC,
      sessionId: SESSION_ID,
      nonce: snap.nonce,
      senderPubkey: ks.sender.publicKey.toBase58(),
      receiverPubkey: ks.receiver.publicKey.toBase58(),
      tokenMint: ks.tokenMint.publicKey.toBase58(),
    });
  });

  // ── GET /balance ─────────────────────────────────────────────────────
  // Serves the optimistic mirror so the UI reflects offline-tx deductions
  // instantly. ?refresh=1 forces a re-sync from RPC.
  app.get('/balance', async (req, res, next) => {
    try {
      if (req.query.refresh === '1' || req.query.refresh === 'true') {
        const fresh = await fetchOnChainBalance();
        log(`/balance refresh → ${fresh} ${TOKEN_SYMBOL} (was optimistic ${optimisticBalance})`);
        optimisticBalance = fresh;
      }
      res.json({
        uiAmount: optimisticBalance,
        symbol: TOKEN_SYMBOL,
        decimals: TOKEN_DECIMALS,
        ata: senderAta.toBase58(),
        owner: ks.sender.publicKey.toBase58(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /events (Server-Sent Events) ─────────────────────────────────
  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sseClients.add(res);

    for (const evt of recentLogs.slice(-50)) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({
        ts: Date.now(),
        level: 'info',
        msg: 'telemetry attached',
      } satisfies LogEvent)}\n\n`,
    );

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch { /* GC'd by close handler */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // ── POST /parse  (multipart audio → PaymentIntent) ───────────────────
  app.post('/parse', upload.single('audio'), async (req, res, next) => {
    let scratchInput: string | null = null;
    try {
      const file = req.file;
      if (!file || file.size === 0) {
        log('/parse rejected: no audio field', 'warn');
        res.status(400).json({
          error: 'Missing audio. POST multipart/form-data with field "audio".',
        });
        return;
      }
      log(
        `/parse received ${file.size} bytes (${file.mimetype || 'unknown mime'})`,
      );

      // Stage the upload to a temp file ffmpeg can read by path.
      const ext = pickInputExtension(file.mimetype, file.originalname);
      scratchInput = path.join(os.tmpdir(), `osov-upload-${Date.now()}${ext}`);
      await fs.promises.writeFile(scratchInput, file.buffer);

      log(`Transcoding audio → 16kHz mono PCM WAV (${TEMP_AUDIO_PATH})...`);
      const t0 = Date.now();
      await transcodeToWhisperWav(scratchInput, TEMP_AUDIO_PATH);
      const wavStat = await fs.promises.stat(TEMP_AUDIO_PATH);
      log(`Transcode OK in ${Date.now() - t0}ms (${wavStat.size} bytes WAV)`);

      log('QVAC: loading Whisper model...');
      const intent = await sender.analyzeIntentWithQVAC(TEMP_AUDIO_PATH);
      log(
        `Intent parsed: ${intent.amount} ${intent.currency} → ${intent.receiver} ` +
        `(confidence ${(intent.confidence * 100).toFixed(0)}%)`,
      );
      res.json(intent);
    } catch (err) {
      // Whisper produced no usable transcript → 422 with actionable copy.
      // The frontend toasts the message and resets to 'idle' (no fake intent).
      if (err instanceof TranscriptionEmptyError) {
        log(`/parse: ${err.message}`, 'warn');
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    } finally {
      if (scratchInput) {
        fs.promises.unlink(scratchInput).catch(() => { /* best-effort */ });
      }
    }
  });

  // ── POST /execute  (PaymentIntent JSON → broadcast result) ───────────
  app.post('/execute', async (req, res, next) => {
    try {
      const intent = parseIntentFromBody(req.body);
      log(
        `/execute confirmed: ${intent.amount} ${intent.currency} → ${intent.receiver}`,
      );
      log('Building offline tx with cached durable nonce...');
      log('P2P: joining Hyperswarm topic, finding peers...');
      const result = await sender.executeIntent(intent);
      log(`P2P: relayed ${result.txBytes} bytes to peer ${result.relayedTo}...`);
      log(`Solana signature (visible on Explorer once receiver broadcasts):`);
      log(`  ${result.signature}`);

      // Optimistic deduction — only after the relay succeeds. The on-chain
      // balance won't drop until the receiver broadcasts; this keeps the UI
      // honest about what's been promised even if not yet settled.
      const previous = optimisticBalance;
      optimisticBalance = Math.max(0, +(optimisticBalance - intent.amount).toFixed(TOKEN_DECIMALS));
      log(`Optimistic balance: ${previous} → ${optimisticBalance} ${TOKEN_SYMBOL}`);

      res.json({
        status: 'broadcast-relayed',
        signature: result.signature,
        relayedTo: result.relayedTo,
        txBytes: result.txBytes,
        intent: result.intent,
        explorerUrl: explorerUrlFor(result.signature, RPC),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Error handler ────────────────────────────────────────────────────
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    log(message, 'error');
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    res.status(500).json({ error: message });
  });

  // Bind to 0.0.0.0 so the UI can connect via localhost OR 127.0.0.1 OR the
  // LAN IP (useful for testing on a phone on the same Wi-Fi). Binding only
  // to 'localhost' resolves to ::1 on Node 18+ which Vite's fetch can't
  // always reach, surfacing as a silent "Failed to fetch" in the browser.
  app.listen(PORT, HOST, () => {
    log(`Listening on http://${HOST}:${PORT} (CORS: open · methods GET/POST/OPTIONS)`);
    log('Endpoints:');
    log('  GET  /health');
    log('  GET  /balance');
    log('  GET  /events     (Server-Sent Events)');
    log('  POST /parse      (multipart, field "audio" — any browser format)');
    log('  POST /execute    (application/json, body = PaymentIntent)');
  });

  process.on('SIGINT', async () => {
    log('Shutting down (SIGINT)...');
    await sender.shutdown();
    process.exit(0);
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pickInputExtension(mime: string | undefined, original: string | undefined): string {
  if (original && /\.[a-z0-9]+$/i.test(original)) {
    return original.slice(original.lastIndexOf('.'));
  }
  if (!mime) return '.bin';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('mpeg')) return '.mp3';
  if (mime.includes('wav') || mime.includes('wave')) return '.wav';
  return '.bin';
}

function parseIntentFromBody(body: unknown): PaymentIntent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Body must be a JSON object describing the PaymentIntent');
  }
  const o = body as Record<string, unknown>;
  if (o.action !== 'PAY') {
    throw new Error(`Unsupported intent action: ${JSON.stringify(o.action)}`);
  }
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) {
    throw new Error(`Invalid amount: ${JSON.stringify(o.amount)}`);
  }
  if (typeof o.receiver !== 'string' || o.receiver.trim().length === 0) {
    throw new Error(`Invalid receiver: ${JSON.stringify(o.receiver)}`);
  }
  if (typeof o.currency !== 'string') {
    throw new Error(`Invalid currency: ${JSON.stringify(o.currency)}`);
  }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) {
    throw new Error(`Invalid confidence: ${JSON.stringify(o.confidence)}`);
  }
  return {
    action: 'PAY',
    amount: o.amount,
    receiver: o.receiver,
    currency: o.currency,
    memo: typeof o.memo === 'string' ? o.memo : undefined,
    confidence: o.confidence,
  };
}

function explorerUrlFor(signature: string, rpc: string): string {
  if (rpc.includes('devnet')) {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  }
  if (rpc.includes('testnet')) {
    return `https://explorer.solana.com/tx/${signature}?cluster=testnet`;
  }
  if (rpc.includes('localhost') || rpc.includes('127.0.0.1')) {
    return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
  }
  return `https://explorer.solana.com/tx/${signature}`;
}

main().catch((err) => {
  console.error('[bridge] fatal:', err.message ?? err);
  process.exit(1);
});
