// Entry point: simulates the merchant's terminal (online).
// Listens on the session topic and broadcasts validated txs.
//
// Run BEFORE `npm run sender` so the sender has someone to dial.

import { clusterApiUrl, Connection } from '@solana/web3.js';
import { ReceiverTerminal } from '../devices/ReceiverTerminal';
import { loadKeystore } from '../lib/keystore';

const RPC = process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet');
const SESSION_ID = process.env.OSOV_SESSION_ID ?? 'demo-session-001';

async function main() {
  const ks = loadKeystore();
  const conn = new Connection(RPC, 'confirmed');

  const receiver = new ReceiverTerminal(conn, {
    sessionId: SESSION_ID,
    expectedNoncePubkey: ks.nonceAccount.publicKey,
  });

  await receiver.start({
    onListening: (topic) => {
      console.log(`[receiver] listening on topic ${topic.toString('hex').slice(0, 16)}...`);
      console.log(`[receiver] sessionId: ${SESSION_ID}`);
      console.log('[receiver] (Ctrl+C to exit)\n');
    },
    onResult: (r) => {
      console.log('\n[receiver] +++ broadcast OK +++');
      console.log(`  signature: ${r.signature}`);
      console.log(`  from peer: ${r.remotePubkey}`);
      console.log(`  size:      ${r.txBytes} bytes`);
      console.log(`  explorer:  https://explorer.solana.com/tx/${r.signature}?cluster=devnet\n`);
    },
    onError: (err, source) => {
      console.error(`[receiver] error from ${source ?? 'unknown'}: ${err.message}`);
    },
  });

  process.on('SIGINT', async () => {
    console.log('\n[receiver] shutting down...');
    await receiver.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[receiver] failed:', err.message ?? err);
  process.exit(1);
});
