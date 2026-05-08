// Entry point: simulates the offline tourist's phone.
// Run AFTER `npm run setup` and AFTER `npm run receiver` is listening.
//
// Required env (or use the defaults in the code):
//   QVAC_WHISPER_MODEL  path to a quantized whisper.cpp model (.bin / .gguf)
//   QVAC_LLAMA_MODEL    path to a quantized llama.cpp gguf model
//   OSOV_AUDIO_PATH     path to the WAV/MP3 voice clip to process
//
// Optional:
//   SOLANA_RPC_URL      default: devnet
//   OSOV_SESSION_ID     default: demo-session-001 — must match receiver

import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js';
import { SenderMobile } from '../devices/SenderMobile';
import { loadKeystore } from '../lib/keystore';

const RPC = process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet');
const SESSION_ID = process.env.OSOV_SESSION_ID ?? 'demo-session-001';

const WHISPER_MODEL = process.env.QVAC_WHISPER_MODEL ?? './models/ggml-tiny.en.bin';
const LLAMA_MODEL = process.env.QVAC_LLAMA_MODEL ?? './models/Llama-3.2-1B-Instruct-Q4_0.gguf';
const AUDIO_PATH = process.env.OSOV_AUDIO_PATH ?? './mock-audio.wav';

async function main() {
  const ks = loadKeystore();
  const conn = new Connection(RPC, 'confirmed');

  const sender = new SenderMobile(conn, ks.sender, {
    sessionId: SESSION_ID,
    nonceAccount: ks.nonceAccount.publicKey,
    token: { mint: ks.tokenMint.publicKey, decimals: 6, symbol: 'USDC' },
    handleResolver: new Map<string, PublicKey>([
      ['vendor.sol', ks.receiver.publicKey],
    ]),
    qvacModels: {
      whisperModelPath: WHISPER_MODEL,
      llamaModelPath: LLAMA_MODEL,
    },
    swarmTimeoutMs: 60_000,
  });

  try {
    console.log('[sender] priming nonce snapshot (ONLINE step)...');
    const snap = await sender.primeNonce();
    console.log(`[sender] cached nonce: ${snap.nonce}`);
    console.log('[sender] (you may now imagine the wifi cable being unplugged)\n');

    console.log(`[sender] running QVAC pipeline on ${AUDIO_PATH}`);
    console.log(`[sender]   whisper model: ${WHISPER_MODEL}`);
    console.log(`[sender]   llama model:   ${LLAMA_MODEL}`);
    console.log('[sender]   (load whisper → transcribe → unload → load llama → parse → unload)\n');

    const result = await sender.executePayment(AUDIO_PATH);

    console.log('\n[sender] payment relayed:');
    console.log(`  intent:    ${JSON.stringify(result.intent)}`);
    console.log(`  tx size:   ${result.txBytes} bytes`);
    console.log(`  peer id:   ${result.relayedTo}...`);
    console.log('\n[sender] watch the receiver terminal for broadcast confirmation.');
  } finally {
    await sender.shutdown();
  }
}

main().catch((err) => {
  console.error('[sender] failed:', err.message ?? err);
  process.exit(1);
});
