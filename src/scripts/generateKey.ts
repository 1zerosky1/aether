// Throwaway helper: prints a fresh Solana keypair so you can fund the
// pubkey via a web faucet, then inject the secret via SENDER_SECRET_KEY.
//
// DEVNET ONLY. The secret is printed in plaintext — never reuse this
// keypair on mainnet.

import { Keypair } from '@solana/web3.js';

const kp = Keypair.generate();
const pubkey = kp.publicKey.toBase58();
const secretJson = JSON.stringify(Array.from(kp.secretKey));

console.log('Public key (paste into faucet):');
console.log(`  ${pubkey}`);
console.log('');
console.log('Faucets:');
console.log(`  https://faucet.solana.com/?address=${pubkey}`);
console.log(`  https://solfaucet.com`);
console.log('');
console.log('Secret key (JSON byte-array — keep private):');
console.log(`  ${secretJson}`);
console.log('');
console.log('Inject and re-run setup (bash):');
console.log(`  SENDER_SECRET_KEY='${secretJson}' npm run setup`);
console.log('');
console.log('Inject and re-run setup (PowerShell):');
console.log(`  $env:SENDER_SECRET_KEY='${secretJson}'; npm run setup`);
