// Tiny exponential-backoff helper used across the engine + receiver. Pulled
// out so retry behaviour is consistent and unit-testable in isolation.

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

const DEFAULTS: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  isRetryable: () => true,
};

export async function withRetry<T>(
  op: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const cfg: RetryOptions = { ...DEFAULTS, ...opts };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === cfg.maxAttempts || !cfg.isRetryable(err)) throw err;
      const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * exp * 0.25;
      const delay = Math.floor(exp + jitter);
      cfg.onRetry?.(attempt, err, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Solana-aware retry classifier. Distinguishes transient network errors (worth
 * retrying) from terminal protocol errors (retrying just wastes time).
 *
 *   Terminal:
 *     - "blockhash not found"  → nonce already consumed; another relayer beat us
 *     - "already processed"    → success in disguise; caller should treat as ok
 *     - "insufficient funds"   → user error; no retry will help
 *     - "invalid signature"    → tampered tx; never retry
 *
 *   Transient: HTTP 429, ECONN*, socket hang up, fetch failed, timed out.
 */
export function isSolanaRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/blockhash not found/i.test(msg)) return false;
  if (/already processed/i.test(msg)) return false;
  if (/insufficient funds/i.test(msg)) return false;
  if (/invalid signature/i.test(msg)) return false;
  if (/transaction simulation failed/i.test(msg)) return false;
  if (/429/.test(msg)) return true;
  if (/rate limit/i.test(msg)) return true;
  if (/socket hang up/i.test(msg)) return true;
  if (/ECONN/i.test(msg)) return true;
  if (/timed?\s?out/i.test(msg)) return true;
  if (/fetch failed/i.test(msg)) return true;
  if (/network/i.test(msg)) return true;
  // Conservative default: retry once for unclassified errors. The cap on
  // maxAttempts keeps us from spinning forever.
  return true;
}
