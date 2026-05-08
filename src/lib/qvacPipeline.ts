// =============================================================================
// QvacPipeline — the actual QVAC SDK integration.
//
// Single point of contact with @qvac/sdk. The SDK exposes a *functional* API
// from the package main entry — there are no `Whisper` / `Llama` classes, and
// the `/llamacpp-completion` and `/whispercpp-transcription` subpaths are NOT
// in the package's exports map (only `/plugin` suffixes are public). Get this
// wrong and Node throws ERR_PACKAGE_PATH_NOT_EXPORTED at startup.
//
// API surface used here (all from '@qvac/sdk' main entry):
//   loadModel({ modelSrc, modelType, modelConfig? }) → Promise<modelId>
//   unloadModel({ modelId })                         → Promise<void>
//   transcribe({ modelId, audioChunk })              → Promise<string>
//   completion({ modelId, history, stream, ... })    → { text: Promise<string>, ... }
//
// Two enterprise-grade properties this module guarantees:
//
//   1. SEQUENTIAL MODEL LIFECYCLE — Whisper is unloaded BEFORE Llama is
//      loaded, so peak RAM ≈ max(whisper_model, llama_model), not sum. On a
//      4 GB phone with whisper-tiny (~75 MB) + Llama-3.2-1B-Q4 (~700 MB) that
//      bound is the difference between "works" and "OOM kill". try/finally
//      guarantees unload on error paths too.
//
//   2. BULLETPROOF JSON OUTPUT — five layers of defense, since this SDK
//      version has no GBNF `grammar` parameter to physically constrain the
//      sampler:
//        a. system prompt with explicit negative constraints + schema
//        b. three few-shot examples (PAY, PAY-with-memo, NONE)
//        c. temperature 0.1 (near-greedy) + low predict budget
//        d. stop sequences for chat-template artifacts (set at load time —
//           stop_sequences belongs in LLM modelConfig, not generationParams)
//        e. post-process: strip markdown fences, extract first balanced {…},
//           strict per-field type/range validation
// =============================================================================

import { loadModel, unloadModel, transcribe, completion } from '@qvac/sdk';
import * as fs from 'fs';
import * as path from 'path';
import type { PaymentIntent } from '../devices/SenderMobile';

export interface QvacModelPaths {
  /** Quantized whisper.cpp model — e.g. ggml-tiny.en.bin (~75 MB). */
  whisperModelPath: string;
  /** Quantized llama.cpp gguf model — e.g. Llama-3.2-1B-Instruct-Q4_0.gguf (~700 MB). */
  llamaModelPath: string;
}

export interface QvacPipelineOptions {
  models: QvacModelPaths;
  /** CPU threads for whisper. SDK default if unset. */
  whisperThreads?: number;
  /** Whisper source language hint. "auto" detects per-clip. */
  language?: string;
  /** Llama context window. 2048 is plenty for transcript + JSON intent. */
  contextSize?: number;
  /** Llama GPU layer offload. 0 = CPU only (most portable). */
  gpuLayers?: number;
}

// ── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an offline financial intent parser running on a mobile device.
Extract the payment instruction from the user's transcribed speech and emit it as a single JSON object on one line.

Output rules (non-negotiable):
- Output ONLY a single JSON object. Nothing else.
- No markdown. No code fences. No prose. No explanations.
- Use the exact keys and value types shown below.
- "confidence" is your own [0,1] estimate of how sure you are about the parse.

Schema:
{"action":"PAY","amount":<number>,"receiver":<string>,"currency":<"USDC"|"USDT"|"SOL">,"memo":<optional string>,"confidence":<number 0..1>}

Examples:

input: "Send fifty USDC to the vendor"
output: {"action":"PAY","amount":50,"receiver":"vendor.sol","currency":"USDC","confidence":0.95}

input: "Pay 12.5 USDT to alice.sol for coffee"
output: {"action":"PAY","amount":12.5,"receiver":"alice.sol","currency":"USDT","memo":"coffee","confidence":0.9}

input: "What time is it"
output: {"action":"NONE","amount":0,"receiver":"","currency":"USDC","confidence":0.0}

Now parse the next input. Output ONLY the JSON object.`;

// Stop tokens for the LLM. Set at load time via modelConfig.stop_sequences —
// the per-call generationParams schema doesn't accept stop_sequences in this
// SDK version, only sampler params (temp/top_p/top_k/predict/seed/penalties).
const STOP_SEQUENCES = ['\n\n', '\ninput:', '<|eot|>', '<|eot_id|>', '</s>'];

// Distinct error class so the bridge can route empty-transcript failures to a
// 4xx response with actionable copy, instead of a generic 500.
export class TranscriptionEmptyError extends Error {
  readonly code = 'TRANSCRIPTION_EMPTY';
  constructor(message = 'Could not understand audio. Please speak English clearly.') {
    super(message);
    this.name = 'TranscriptionEmptyError';
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export class QvacPipeline {
  constructor(private readonly opts: QvacPipelineOptions) {
    if (!fs.existsSync(opts.models.whisperModelPath)) {
      throw new Error(`Whisper model not found at ${opts.models.whisperModelPath}`);
    }
    if (!fs.existsSync(opts.models.llamaModelPath)) {
      throw new Error(`Llama model not found at ${opts.models.llamaModelPath}`);
    }
  }

  /**
   * Audio file → PaymentIntent in two sequential model lifecycles.
   * Whisper is fully unloaded before Llama loads — peak memory matters.
   *
   * If Whisper returns no usable text we surface a TranscriptionEmptyError
   * rather than fabricating an intent — the demo must reflect what the user
   * actually said, never a hardcoded fallback.
   */
  async run(audioPath: string): Promise<PaymentIntent> {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const extractedText = await this.transcribeAudio(audioPath);
    const transcript = (extractedText ?? '').trim();

    if (transcript.length === 0) {
      console.warn('[qvac] Whisper returned no usable text — refusing to fabricate intent');
      throw new TranscriptionEmptyError();
    }

    console.log(`[qvac] transcript: "${transcript}"`);
    return this.parseIntent(transcript);
  }

  // ── Stage 1: speech-to-text ───────────────────────────────────────────

  private async transcribeAudio(audioPath: string): Promise<string> {
    // English-only models (any *.en.bin) MUST NOT use language='auto' — the
    // language-detection head reads a token that isn't in the EN-only vocab
    // and whisper.cpp returns an empty transcript silently. Force 'en' when
    // the filename ends in .en.bin, otherwise honour the explicit option.
    const modelPath = this.opts.models.whisperModelPath.toLowerCase();
    const isEnglishOnlyModel = /\.en\.bin$/.test(modelPath);
    const language = this.opts.language ?? (isEnglishOnlyModel ? 'en' : 'auto');
    console.log(
      `[qvac] Whisper language=${language} (model=${path.basename(this.opts.models.whisperModelPath)})`,
    );

    const modelId = await loadModel({
      modelSrc: this.opts.models.whisperModelPath,
      modelType: 'whispercpp-transcription',
      modelConfig: {
        language,
        ...(this.opts.whisperThreads !== undefined
          ? { n_threads: this.opts.whisperThreads }
          : {}),
      },
    });

    try {
      // The TS types say `transcribe()` returns Promise<string>, but early
      // SDK builds have been observed to return a wrapper object instead
      // (`{ text }`, `{ segments: [...] }`, etc.) or to silently return ""
      // when the audio decode pipeline succeeds but the model emits nothing.
      // Log the raw shape so we can see exactly what came back, then coerce
      // it into a string via a tolerant extractor.
      const rawTranscript: unknown = await transcribe({
        modelId,
        audioChunk: audioPath,
      });
      console.log('[qvac] Raw Whisper output:', rawTranscript);
      return coerceWhisperOutputToText(rawTranscript);
    } finally {
      // CRITICAL: unload before Llama is loaded so peak RAM stays bounded by
      // the larger model, not the sum. try/finally guarantees release on
      // error paths too.
      await unloadModel({ modelId }).catch(() => { /* best-effort */ });
    }
  }

  // ── Stage 2: text → structured intent ─────────────────────────────────

  private async parseIntent(transcript: string): Promise<PaymentIntent> {
    const modelId = await loadModel({
      modelSrc: this.opts.models.llamaModelPath,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: this.opts.contextSize ?? 2048,
        gpu_layers: this.opts.gpuLayers ?? 0,
        // stop_sequences live on the model config, not on generationParams.
        stop_sequences: STOP_SEQUENCES,
      },
    });

    let raw: string;
    try {
      const result = completion({
        modelId,
        stream: false,
        history: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `input: "${escapeForPrompt(transcript)}"\noutput:`,
          },
        ],
        generationParams: {
          temp: 0.1,
          predict: 256,
        },
      });
      // completion() returns synchronously with promises on it; await `text`
      // for the full concatenated response (no need to drain tokenStream).
      raw = await result.text;
    } finally {
      await unloadModel({ modelId }).catch(() => { /* best-effort */ });
    }

    return parseIntentJson(raw, transcript);
  }
}

// ── Defensive parsing ───────────────────────────────────────────────────────

/**
 * Tolerant extractor for whatever shape transcribe() actually returned.
 * Handles: plain string, { text }, { transcript }, { result },
 * { segments: [{ text }, ...] }. Anything else → empty string so the caller
 * raises TranscriptionEmptyError instead of guessing an intent.
 */
function coerceWhisperOutputToText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw == null) return '';
  if (typeof raw !== 'object') return '';

  const o = raw as Record<string, unknown>;
  if (typeof o.text === 'string') return o.text.trim();
  if (typeof o.transcript === 'string') return o.transcript.trim();
  if (typeof o.result === 'string') return o.result.trim();

  if (Array.isArray(o.segments)) {
    const joined = o.segments
      .map((seg) => {
        if (typeof seg === 'string') return seg;
        if (seg && typeof seg === 'object' && typeof (seg as { text?: unknown }).text === 'string') {
          return (seg as { text: string }).text;
        }
        return '';
      })
      .join(' ')
      .trim();
    if (joined.length > 0) return joined;
  }

  return '';
}

function escapeForPrompt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * Parse the LLM output. Strips markdown fences, extracts the first balanced
 * {…} block, JSON.parse, then per-field type validation.
 */
function parseIntentJson(raw: string, transcriptForError: string): PaymentIntent {
  const fenceStripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const jsonStr = extractFirstJsonObject(fenceStripped);
  if (!jsonStr) {
    throw new Error(
      `LLM output contains no JSON object. Transcript: "${transcriptForError}". ` +
      `Raw: ${raw.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(
      `LLM emitted malformed JSON: ${(err as Error).message}\nRaw: ${jsonStr}`,
    );
  }

  return validateIntent(parsed, transcriptForError);
}

/**
 * Walks the string tracking string-literal state and brace depth so we can
 * cleanly extract the first balanced {…} block even if surrounded by junk.
 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const VALID_CURRENCIES = ['USDC', 'USDT', 'SOL'] as const;
type Currency = typeof VALID_CURRENCIES[number];

function validateIntent(obj: unknown, transcript: string): PaymentIntent {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Intent JSON is not an object');
  }
  const o = obj as Record<string, unknown>;

  if (o.action === 'NONE') {
    throw new Error(
      `LLM classified the input as a non-payment instruction. Transcript: "${transcript}"`,
    );
  }
  if (o.action !== 'PAY') {
    throw new Error(`Invalid action: ${JSON.stringify(o.action)}`);
  }
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) {
    throw new Error(`Invalid amount: ${JSON.stringify(o.amount)}`);
  }
  if (typeof o.receiver !== 'string' || o.receiver.trim().length === 0) {
    throw new Error(`Invalid receiver: ${JSON.stringify(o.receiver)}`);
  }
  if (typeof o.currency !== 'string' || !(VALID_CURRENCIES as readonly string[]).includes(o.currency)) {
    throw new Error(`Invalid currency: ${JSON.stringify(o.currency)}`);
  }
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) {
    throw new Error(`Invalid confidence: ${JSON.stringify(o.confidence)}`);
  }
  if (o.memo !== undefined && typeof o.memo !== 'string') {
    throw new Error(`Invalid memo: ${JSON.stringify(o.memo)}`);
  }

  return {
    action: 'PAY',
    amount: o.amount,
    receiver: o.receiver,
    currency: o.currency as Currency,
    memo: typeof o.memo === 'string' ? o.memo : undefined,
    confidence: o.confidence,
  };
}
