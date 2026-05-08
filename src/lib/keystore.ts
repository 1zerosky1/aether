// Injectable keypair loading, so the rest of the system never embeds secrets
// directly. Two sources:
//
//   1. Env vars (highest precedence): SENDER_SECRET_KEY, RECEIVER_SECRET_KEY,
//      NONCE_ACCOUNT_SECRET_KEY, TOKEN_MINT_SECRET_KEY.
//      Format: JSON byte-array (the format `solana-keygen new` writes). This
//      is the path operators take when devnet airdrops are rate-limited and
//      they need to inject a pre-funded wallet.
//
//   2. .poc-state.json on disk (fallback, for local dev convenience).
//
// In a React Native build the file path swaps for expo-secure-store /
// react-native-keychain — the env-var path is unchanged for CI/setup scripts.

import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

export interface PocKeystore {
  sender: Keypair;
  receiver: Keypair;
  nonceAccount: Keypair;
  tokenMint: Keypair;
}

const STATE_PATH = path.join(process.cwd(), '.poc-state.json');

interface SerializedKeystore {
  sender: number[];
  receiver: number[];
  nonceAccount: number[];
  tokenMint: number[];
}

const ENV_MAP = {
  sender: 'SENDER_SECRET_KEY',
  receiver: 'RECEIVER_SECRET_KEY',
  nonceAccount: 'NONCE_ACCOUNT_SECRET_KEY',
  tokenMint: 'TOKEN_MINT_SECRET_KEY',
} as const satisfies Record<keyof PocKeystore, string>;

function decodeSecretBytes(raw: string, envName: string): Uint8Array {
  let bytes: number[];
  try {
    bytes = JSON.parse(raw.trim());
  } catch {
    throw new Error(
      `${envName} must be a JSON byte-array (e.g. "[12,34,...]"), the format ` +
      `produced by \`solana-keygen new --outfile key.json --no-bip39-passphrase\``,
    );
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`${envName}: expected 64-byte secret key array, got ${bytes.length}`);
  }
  return Uint8Array.from(bytes);
}

export function loadKeystoreFromEnv(): Partial<PocKeystore> {
  const out: Partial<PocKeystore> = {};
  for (const [field, envName] of Object.entries(ENV_MAP) as Array<[keyof PocKeystore, string]>) {
    const raw = process.env[envName];
    if (!raw) continue;
    out[field] = Keypair.fromSecretKey(decodeSecretBytes(raw, envName));
  }
  return out;
}

export function loadKeystoreFromFile(): Partial<PocKeystore> {
  if (!fs.existsSync(STATE_PATH)) return {};
  let parsed: SerializedKeystore;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${STATE_PATH}: ${(err as Error).message}`);
  }
  return {
    sender: Keypair.fromSecretKey(Uint8Array.from(parsed.sender)),
    receiver: Keypair.fromSecretKey(Uint8Array.from(parsed.receiver)),
    nonceAccount: Keypair.fromSecretKey(Uint8Array.from(parsed.nonceAccount)),
    tokenMint: Keypair.fromSecretKey(Uint8Array.from(parsed.tokenMint)),
  };
}

export function loadKeystore(): PocKeystore {
  const env = loadKeystoreFromEnv();
  const file = loadKeystoreFromFile();
  const merged: Partial<PocKeystore> = { ...file, ...env };

  const missing: string[] = [];
  for (const k of Object.keys(ENV_MAP) as Array<keyof PocKeystore>) {
    if (!merged[k]) missing.push(`${k} (${ENV_MAP[k]})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing keypairs: ${missing.join(', ')}.\n` +
      `Provision them with \`npm run setup\` or inject via env vars.`,
    );
  }
  return merged as PocKeystore;
}

export function saveKeystoreToFile(ks: PocKeystore): void {
  const ser: SerializedKeystore = {
    sender: Array.from(ks.sender.secretKey),
    receiver: Array.from(ks.receiver.secretKey),
    nonceAccount: Array.from(ks.nonceAccount.secretKey),
    tokenMint: Array.from(ks.tokenMint.secretKey),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(ser, null, 2));
}

export const KEYSTORE_PATH = STATE_PATH;
