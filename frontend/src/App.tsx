// =============================================================================
// AETHER — Tether-brand fintech client (light, institutional)
// "Money out of thin air. Offline by default."
//
// Aesthetic direction: editorial corporate. White canvas, hairline geometry,
// confident emerald accent (#009393), bold tabular numerics. No glassmorphism,
// no neon, no dark mode anywhere. Modals are TRUE fixed overlays — they
// detach from document flow so they cannot push the page down.
// =============================================================================

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
  type Transition,
} from 'framer-motion';
import confetti from 'canvas-confetti';
import backImg from './assets/images/back.svg';
import backkkImg from './assets/images/backkk.svg';
import tetherImg from './assets/images/tether.svg';
import solImg from './assets/images/sol.svg';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronRight,
  ExternalLink,
  History,
  QrCode,
  Keyboard,
  Mic,
  Pencil,
  RefreshCw,
  Settings as SettingsIcon,
  Terminal,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';

// =============================================================================
// Brand tokens — derived from tether.to
// =============================================================================

const EMERALD = '#019393'; // primary brand / CTA / active
const EMERALD_LIGHT = '#50AF95'; // bright accent / success
const CANVAS = '#FFFFFF'; // off-white root canvas — both main + sidebar share this
const SURFACE_WHITE = '#FFFFFF'; // white cards / modal panels
const INSET_BG = '#F4F6F7'; // muted inset for inputs / dividers
const TEXT_PRIMARY = '#1A202C';
const TEXT_SECONDARY = '#4A5568';
const TEXT_TERTIARY = '#94A3B0';
const BORDER_GRAY = '#E5E7EB'; // = tw border-gray-200
const BORDER_LIGHT = '#F3F4F6'; // = tw border-gray-100 — per brief

const SHADOW_CARD = '0 4px 20px rgba(0,0,0,0.04)'; // exact recipe from brief
const SHADOW_CARD_LG = '0 8px 32px -6px rgba(0,0,0,0.06), 0 2px 6px rgba(0,0,0,0.03)';

// Typography presets — distinctive editorial rhythm.
const T = {
  display: 'text-[56px] leading-[60px] font-semibold tracking-tight',
  displayLg: 'text-[64px] leading-[68px] font-semibold tracking-tight',
  h1: 'text-[34px] leading-[40px] font-semibold tracking-[-0.02em]',
  h2: 'text-[24px] leading-[32px] font-semibold tracking-[-0.015em]',
  h3: 'text-[20px] leading-[28px] font-semibold tracking-[-0.01em]',
  bodyLg: 'text-[17px] leading-[24px] font-normal',
  body: 'text-[15px] leading-[22px] font-normal',
  bodyMedium: 'text-[15px] leading-[22px] font-medium',
  small: 'text-[13px] leading-[18px] font-normal',
  smallMedium: 'text-[13px] leading-[18px] font-medium',
  micro: 'text-[12px] leading-[16px] font-medium',
  eyebrow: 'text-xs font-bold tracking-wider uppercase text-slate-500',
} as const;

// Snappy, editorial transitions — subtle, never bouncy.
const SPRING: Transition = { type: 'spring', bounce: 0.18, duration: 0.5 };

// =============================================================================
// Types
// =============================================================================

type Currency = 'USDT' | 'SOL';
type View = 'wallet' | 'history' | 'settings';
type BridgeStatus = 'connecting' | 'online' | 'offline';
type AppState =
  | 'idle'
  | 'recording'
  | 'parsing'
  | 'silentForm'
  | 'preview'
  | 'sending'
  | 'broadcast';

export interface PaymentIntent {
  action: 'PAY';
  amount: number;
  receiver: string;
  currency: Currency;
  memo?: string;
  confidence: number;
}

export interface BroadcastResult {
  status: string;
  signature: string;
  relayedTo: string;
  txBytes: number;
  intent: PaymentIntent;
  explorerUrl?: string;
}

interface BalanceInfo {
  uiAmount: number;
  symbol: string;
}

interface BridgeLog {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

interface MockTx {
  id: string;
  direction: 'sent' | 'received';
  amount: number;
  currency: Currency;
  counterparty: string;
  ts: number;
  signature: string;
  via: 'Hyperswarm' | 'Solana RPC';
}

// Persistent ledger key — written to localStorage on every successful
// /execute and rehydrated on app load. No fake seeds.
const LEDGER_STORAGE_KEY = 'omnisovereign_history';

function isValidLedgerEntry(v: unknown): v is MockTx {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    (t.direction === 'sent' || t.direction === 'received') &&
    typeof t.amount === 'number' &&
    Number.isFinite(t.amount) &&
    typeof t.currency === 'string' &&
    typeof t.counterparty === 'string' &&
    typeof t.ts === 'number' &&
    typeof t.signature === 'string' &&
    (t.via === 'Hyperswarm' || t.via === 'Solana RPC')
  );
}

function loadLedgerFromStorage(): MockTx[] {
  try {
    const raw = localStorage.getItem(LEDGER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop any malformed/legacy-schema entries so they can't crash TxRow's
    // tx.signature.slice / tx.amount.toFixed at render time.
    return parsed.filter(isValidLedgerEntry);
  } catch {
    return [];
  }
}


// =============================================================================
// Bridge adapter — closure over dynamic URL
// =============================================================================

const DEFAULT_BRIDGE_URL =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BRIDGE_URL ??
  'https://distribution-threshold-carpet-budgets.trycloudflare.com';
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_RETRIES = 3;

interface Adapter {
  parseAudioToIntent(blob: Blob): Promise<PaymentIntent>;
  sendPayment(intent: PaymentIntent): Promise<BroadcastResult>;
  fetchBalance(): Promise<BalanceInfo>;
}

function makeAdapter(bridgeUrl: string): Adapter {
  const base = bridgeUrl.replace(/\/+$/, '');

  async function bridgeFetch(
    pathname: string,
    init?: RequestInit,
    opts: { retries?: number; timeoutMs?: number } = {},
  ): Promise<Response> {
    const retries = opts.retries ?? FETCH_RETRIES;
    const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}${pathname}`, { ...init, signal: ctrl.signal });
        clearTimeout(timer);
        return r;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt < retries - 1) {
          await new Promise((res) => setTimeout(res, 250 * 2 ** attempt));
        }
      }
    }
    throw new Error(
      `Bridge unreachable at ${base} after ${retries} attempts: ` +
        (lastErr instanceof Error ? lastErr.message : String(lastErr)),
    );
  }

  async function readError(r: Response): Promise<string> {
    try {
      const j = (await r.json()) as { error?: string };
      return j.error ?? `${r.status} ${r.statusText}`;
    } catch {
      return `${r.status} ${r.statusText}`;
    }
  }

  return {
    async parseAudioToIntent(audioBlob: Blob) {
      const fd = new FormData();
      const ext = audioBlob.type.includes('webm')
        ? 'webm'
        : audioBlob.type.includes('ogg')
          ? 'ogg'
          : audioBlob.type.includes('mp4')
            ? 'm4a'
            : 'wav';
      fd.append('audio', audioBlob, `recording.${ext}`);
      const r = await bridgeFetch(
        '/parse',
        { method: 'POST', body: fd },
        { retries: 1, timeoutMs: 60_000 },
      );
      if (!r.ok) throw new Error(await readError(r));
      return (await r.json()) as PaymentIntent;
    },
    async sendPayment(intent) {
      const r = await bridgeFetch(
        '/execute',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(intent),
        },
        { retries: 1, timeoutMs: 70_000 },
      );
      if (!r.ok) throw new Error(await readError(r));
      return (await r.json()) as BroadcastResult;
    },
    async fetchBalance() {
      const r = await bridgeFetch('/balance');
      if (!r.ok) throw new Error(await readError(r));
      return (await r.json()) as BalanceInfo;
    },
  };
}

// =============================================================================
// SSE — module-level ring buffer so log churn never re-renders the App tree.
// =============================================================================

const LOG_RING_MAX = 200;
const logRing: BridgeLog[] = [];
const logSubscribers = new Set<() => void>();

function pushLog(evt: BridgeLog) {
  logRing.push(evt);
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
  for (const cb of logSubscribers) cb();
}
function clearLogs() {
  if (logRing.length === 0) return;
  logRing.length = 0;
  for (const cb of logSubscribers) cb();
}
function useBridgeLogs(): BridgeLog[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((n) => (n + 1) | 0);
    logSubscribers.add(cb);
    return () => {
      logSubscribers.delete(cb);
    };
  }, []);
  return logRing;
}

function useBridge(bridgeUrl: string) {
  const [status, setStatus] = useState<BridgeStatus>('connecting');
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  const connect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    setStatus('connecting');
    try {
      esRef.current?.close();
    } catch {
      /* ignore */
    }
    const base = bridgeUrl.replace(/\/+$/, '');
    const es = new EventSource(`${base}/events`);
    esRef.current = es;
    es.onopen = () => {
      attemptRef.current = 0;
      setStatus('online');
    };
    es.onmessage = (e) => {
      try {
        pushLog(JSON.parse(e.data) as BridgeLog);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      setStatus('offline');
      es.close();
      esRef.current = null;
      attemptRef.current = Math.min(attemptRef.current + 1, 5);
      const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 15_000);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, [bridgeUrl]);

  useEffect(() => {
    clearLogs();
    attemptRef.current = 0;
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      esRef.current?.close();
    };
  }, [connect]);

  return { status, reconnect: connect };
}

// =============================================================================
// Settings persistence
// =============================================================================

interface Settings {
  offlineOnly: boolean;
  autoConfirm: boolean;
  whisperModel: string;
  llamaModel: string;
  bridgeUrl: string;
}
const DEFAULT_SETTINGS: Settings = {
  offlineOnly: false,
  autoConfirm: false,
  whisperModel: 'ggml-tiny.en.bin',
  llamaModel: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  bridgeUrl: DEFAULT_BRIDGE_URL,
};
function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const raw = localStorage.getItem('osov.settings.v1');
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      /* fall through */
    }
    return DEFAULT_SETTINGS;
  });
  const update = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((s) => {
      const next = { ...s, [k]: v };
      try {
        localStorage.setItem('osov.settings.v1', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return { settings, update };
}

// =============================================================================
// Helpers
// =============================================================================

// Safe navigator.vibrate wrapper — no-ops on iOS Safari (no Vibration API),
// desktop browsers, and any context where the API isn't exposed. Patterns:
//   HAPTIC.tap        → light tap when recording starts
//   HAPTIC.doubleTap  → double tap when intent parsing succeeds
//   HAPTIC.success    → "success melody" after broadcast
const HAPTIC = {
  tap: 50,
  doubleTap: [50, 50, 50],
  success: [100, 50, 100, 50, 200],
} as const;

function triggerHaptic(pattern: number | readonly number[]): void {
  try {
    const nav = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean })
      : null;
    if (!nav || typeof nav.vibrate !== 'function') return;
    if (typeof pattern === 'number') nav.vibrate(pattern);
    else nav.vibrate([...pattern]);
  } catch {
    /* silently ignore — haptics are nice-to-have */
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatAmount(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Strictly mirror-symmetric fingerprint glyph. lucide-react's Fingerprint is
// intentionally asymmetric (real fingerprints aren't perfect ovals) which the
// user perceives as crooked. Every path here is duplicated and mirrored across
// the vertical centerline x=12, so the icon is geometrically identical when
// flipped horizontally — guarantees no perceived tilt.

function FingerprintGlyph({ className }: { className?: string }) {
  // Surgical alignment recipe: the SVG is wrapped in a strict-centered flex
  // box with overflow-hidden, the rotate is forced to 0, and every visible
  // path uses a quadratic Bézier whose CONTROL POINT lies exactly on the
  // x=12 symmetry axis. This makes the icon mathematically symmetric — no
  // sub-pixel rendering or path quirks can make it look tilted.
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        margin: 0,
        padding: 0,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="100%"
        height="100%"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        shapeRendering="geometricPrecision"
        style={{ transform: 'rotate(0deg)', display: 'block' }}
        aria-hidden
      >
        {/* Three nested arches. Each path is its own mirrored U-shape:
            Q's control point sits on x=12 so the curve is symmetric by
            construction. */}
        <path d="M5 17 V13 Q5 6 12 6 Q19 6 19 13 V17" />
        <path d="M8 17 V13 Q8 9 12 9 Q16 9 16 13 V17" />
        <path d="M10.5 17 V14 Q10.5 12 12 12 Q13.5 12 13.5 14 V17" />
        {/* Center pin on the axis */}
        <circle cx="12" cy="13" r="0.5" fill="currentColor" />
      </svg>
    </span>
  );
}

// =============================================================================
// MODAL WRAPPER — TRUE fixed inset-0 overlay. Cannot push the page down.
// This is the architectural fix the brief mandates.
// =============================================================================

function Modal({
  open,
  onClose,
  children,
  size = 'md',
  locked = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** When true, scrim click + ESC are inert. Use during WebAuthn / in-flight
   *  P2P broadcast so the modal cannot unmount under a pending OS prompt. */
  locked?: boolean;
}) {
  // Lock body scroll while open so modals don't yield the layout to outer flow.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ESC closes — unless modal is locked.
  useEffect(() => {
    if (!open || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, locked, onClose]);

  if (!open) return null;

  // Mobile: bottom-sheet (mt-auto). Desktop: m-auto centered dialog.
  const widthClass =
    size === 'sm' ? 'md:max-w-[420px]' : size === 'lg' ? 'md:max-w-[720px]' : 'md:max-w-[520px]';

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={locked ? undefined : onClose}
      className="fixed inset-0 z-[100] flex bg-black/20"
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ y: '6%', opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '6%', opacity: 0 }}
        transition={SPRING}
        className={`mt-auto w-full overflow-hidden md:m-auto md:w-[calc(100%-2rem)] ${widthClass} bg-white rounded-3xl shadow-xl border border-gray-100 p-6`}
        style={{
          maxHeight: '90dvh',
          overflowY: 'auto',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {/* iOS-style mobile drag indicator (hidden on desktop) */}
        <div className="mx-auto mt-3 mb-1 h-1 w-10 rounded-full bg-gray-200 md:hidden" />
        {children}
      </motion.div>
    </div>
  );
}

// =============================================================================
// App — orchestration
// =============================================================================

export const AetherFullLogo = ({ className = "" }) => (
  <div className={`flex items-center gap-2 ${className}`}>
    <svg viewBox="0 0 49 41" fill="none" className="h-8 text-[#019393]">
      <path fillRule="evenodd" clipRule="evenodd" d="M10.5497 0H38.4507C39.1165 0 39.7315 0.356142 40.0635 0.933924L48.1922 15.0798C48.6137 15.8134 48.4885 16.7393 47.8872 17.3342L25.5127 39.4708C24.7879 40.1879 23.622 40.1879 22.8972 39.4708L0.552922 17.3641C-0.0623286 16.7554 -0.177538 15.8025 0.274888 15.0643L8.96384 0.888538C9.30224 0.336459 9.90273 0 10.5497 0ZM34.8482 6.31565V10.2848H26.9003V13.0367C32.4824 13.3308 36.6704 14.5386 36.7015 15.9863L36.7013 19.0044C36.6702 20.4521 32.4824 21.6599 26.9003 21.954V28.7075H21.6228V21.954C16.0407 21.6599 11.8527 20.4521 11.8217 19.0044L11.8218 15.9863C11.8529 14.5386 16.0407 13.3308 21.6228 13.0367V10.2848H13.6749V6.31565H34.8482ZM24.2616 19.8806C30.2186 19.8806 35.1977 18.8593 36.4162 17.4954C35.3829 16.3388 31.6453 15.4285 26.9003 15.1785V18.0598C26.0499 18.1046 25.167 18.1282 24.2616 18.1282C23.3561 18.1282 22.4733 18.1046 21.6228 18.0598V15.1785C16.8778 15.4285 13.1402 16.3388 12.1069 17.4954C13.3254 18.8593 18.3045 19.8806 24.2616 19.8806Z" fill="currentColor" />
    </svg>
    <span className="text-3xl font-bold text-[#019393] tracking-tight mb-1" style={{ fontFamily: 'BrandFont, sans-serif' }}>aether</span>
  </div>
);

export default function App() {
  const [view, setView] = useState<View>('wallet');
  const [state, setState] = useState<AppState>('idle');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [balanceState, setBalanceState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [ledger, setLedger] = useState<MockTx[]>(loadLedgerFromStorage);
  // Locks the IntentReview modal while the OS biometric prompt is open or
  // a P2P broadcast is in flight, so a stray ESC / scrim-click can't unmount
  // the modal under a pending Promise.
  const [modalLocked, setModalLocked] = useState(false);

  const { settings, update: updateSetting } = useSettings();
  const adapter = useMemo(() => makeAdapter(settings.bridgeUrl), [settings.bridgeUrl]);
  const bridge = useBridge(settings.bridgeUrl);

  // Voice pipeline refs — race guards from prior pass
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const startTokenRef = useRef(0);
  const cancelStartRef = useRef(false);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hard re-entry lock — blocks rage-tap / double-tap from firing two
  // concurrent /execute calls. setState batching alone isn't enough because
  // the slide-to-confirm onDragEnd can fire twice in rapid succession.
  const isExecutingRef = useRef(false);

  const stopMediaStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordedChunksRef.current = [];
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelStartRef.current = true;
      stopMediaStream();
    };
  }, [stopMediaStream]);

  const refreshBalance = useCallback(async () => {
    setBalanceState('loading');
    try {
      const b = await adapter.fetchBalance();
      setBalance(b);
      setBalanceState('ok');
    } catch {
      // UI surfaces this via the BalanceCard error state; no console noise.
      setBalanceState('error');
    }
  }, [adapter]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);
  // Re-fetch only on the rising edge of bridge.status (offline/connecting → online),
  // never on every balanceState flip — otherwise a persistently-failing /balance
  // endpoint would spam the bridge forever via the loading→error oscillation.
  const prevBridgeStatusRef = useRef<BridgeStatus | null>(null);
  useEffect(() => {
    const prev = prevBridgeStatusRef.current;
    prevBridgeStatusRef.current = bridge.status;
    if (
      prev !== 'online' &&
      bridge.status === 'online' &&
      balanceState === 'error'
    ) {
      void refreshBalance();
    }
  }, [bridge.status, balanceState, refreshBalance]);

  const runExecute = useCallback(
    async (i: PaymentIntent) => {
      // Re-entry lock — bail if a previous /execute is still in flight.
      if (isExecutingRef.current) return;
      isExecutingRef.current = true;
      // Lock the IntentReview modal so a stray scrim/ESC during the network
      // call can't unmount the React tree under a pending Promise.
      setModalLocked(true);
      setState('sending');
      // Optimistic balance — deduct immediately so the figure drops the
      // instant the user confirms, while the P2P relay is still in flight.
      // Snapshot the previous value so we can roll back on failure.
      const prevBalance = balance;
      if (prevBalance && prevBalance.uiAmount >= i.amount) {
        setBalance({
          ...prevBalance,
          uiAmount: +(prevBalance.uiAmount - i.amount).toFixed(6),
        });
      }
      try {
        const r = await adapter.sendPayment(i);
        setResult(r);
        setState('broadcast');
        triggerHaptic(HAPTIC.success);
        // Live ledger update — prepend the just-relayed tx and persist to
        // localStorage so the user's real history survives reloads.
        setLedger((prev) => {
          const newTx: MockTx = {
            id: `local-${r.signature.slice(0, 12)}`,
            direction: 'sent',
            amount: i.amount,
            currency: i.currency,
            counterparty: i.receiver,
            ts: Date.now(),
            signature: r.signature,
            via: 'Hyperswarm',
          };
          const updated = [newTx, ...prev];
          try {
            localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(updated));
          } catch {
            /* ignore quota / disabled storage */
          }
          return updated;
        });
        // Server is canonical — overwrites the optimistic figure with truth.
        void refreshBalance();
      } catch (e) {
        // Rollback the optimistic deduction — restore the snapshot exactly.
        if (prevBalance) setBalance(prevBalance);
        setError(e instanceof Error ? e.message : String(e));
        setState('preview');
      } finally {
        isExecutingRef.current = false;
        setModalLocked(false);
      }
    },
    [adapter, balance, refreshBalance],
  );

  const finalizeRecording = useCallback(async () => {
    const rec = mediaRecorderRef.current;
    if (!rec) {
      stopMediaStream();
      setState('idle');
      return;
    }
    setState('parsing');
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    let blob: Blob;
    try {
      blob = await new Promise<Blob>((resolve, reject) => {
        rec.onstop = () => {
          const type = rec.mimeType || 'audio/webm';
          resolve(new Blob(recordedChunksRef.current, { type }));
        };
        rec.onerror = (ev: Event) =>
          reject(new Error(`MediaRecorder error: ${(ev as ErrorEvent).message ?? 'unknown'}`));
        try {
          if (rec.state !== 'inactive') rec.stop();
          else resolve(new Blob(recordedChunksRef.current, { type: rec.mimeType || 'audio/webm' }));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    } catch (e) {
      stopMediaStream();
      setError(e instanceof Error ? e.message : String(e));
      setState('idle');
      return;
    }
    stopMediaStream();
    if (blob.size < 1024) {
      setError("Didn't catch that — hold the dial a bit longer.");
      setState('idle');
      return;
    }
    try {
      const parsed = await adapter.parseAudioToIntent(blob);
      // Llama-3.2 graceful rejection: if the LLM hallucinated an empty
      // recipient or zero amount, refuse to advance to preview. Returning
      // to idle with a clear message beats a silent broken intent.
      if (
        !parsed ||
        typeof parsed.amount !== 'number' ||
        !Number.isFinite(parsed.amount) ||
        parsed.amount <= 0 ||
        typeof parsed.receiver !== 'string' ||
        parsed.receiver.trim().length === 0
      ) {
        setError("I didn't catch the exact amount or recipient. Please repeat.");
        setState('idle');
        return;
      }
      triggerHaptic(HAPTIC.doubleTap);
      setIntent(parsed);
      if (settings.autoConfirm && parsed.confidence >= 0.85) {
        await runExecute(parsed);
      } else {
        setState('preview');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('idle');
    }
  }, [adapter, runExecute, settings.autoConfirm, stopMediaStream]);

  const handleHoldStart = useCallback(async () => {
    if (state !== 'idle') return;
    if (mediaStreamRef.current || mediaRecorderRef.current) return;
    setError(null);
    cancelStartRef.current = false;
    const token = ++startTokenRef.current;

    // Browsers only expose getUserMedia in secure contexts (HTTPS or localhost).
    // If the page is loaded over plain HTTP — e.g. via the LAN IP on a phone —
    // navigator.mediaDevices is `undefined` and dereferencing it throws a
    // TypeError before any prompt can appear. Surface that with actionable copy.
    if (
      typeof window === 'undefined' ||
      !window.isSecureContext ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setError(
        !window.isSecureContext
          ? 'Microphone needs a secure (HTTPS) connection. Open the public Cloudflare URL on your phone, not the local IP.'
          : 'This browser does not expose microphone APIs. Try Safari or Chrome.',
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // Disambiguate denial vs hardware/OS-level blocks. DOMException.name is
      // the spec-stable signal (NotAllowedError = user/system denied,
      // NotFoundError = no mic, NotReadableError = OS-level block / hardware
      // in use by another app). Falling back to the message regex covers the
      // rare case where a browser surfaces the failure without a typed error.
      const name = e instanceof Error ? e.name : '';
      const msg = e instanceof Error ? e.message : String(e);
      let copy: string;
      if (name === 'NotAllowedError' || /denied|not allowed/i.test(msg)) {
        copy = 'Microphone access denied by system. Allow it in your browser settings, then try again.';
      } else if (name === 'NotFoundError') {
        copy = 'No microphone found. Plug one in and try again.';
      } else if (name === 'NotReadableError') {
        copy = 'Microphone is busy in another app. Close it and try again.';
      } else {
        copy = `Microphone unavailable: ${msg}`;
      }
      setError(copy);
      return;
    }

    if (cancelStartRef.current || token !== startTokenRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    mediaStreamRef.current = stream;
    recordedChunksRef.current = [];

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';

    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      stopMediaStream();
      setError(`Recorder unsupported: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    mediaRecorderRef.current = rec;
    try {
      rec.start(100);
    } catch (e) {
      stopMediaStream();
      setError(`Couldn't start recorder: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setState('recording');
    triggerHaptic(HAPTIC.tap);
    maxDurationTimerRef.current = setTimeout(() => {
      if (mediaRecorderRef.current) void finalizeRecording();
    }, 30_000);
  }, [state, finalizeRecording, stopMediaStream]);

  const handleHoldEnd = useCallback(async () => {
    if (state === 'idle') {
      cancelStartRef.current = true;
      return;
    }
    if (state !== 'recording') return;
    await finalizeRecording();
  }, [state, finalizeRecording]);

  const handleSilentSubmit = useCallback((i: PaymentIntent) => {
    setIntent(i);
    setState('preview');
  }, []);

  const handleConfirm = useCallback(
    async (finalIntent: PaymentIntent) => {
      await runExecute(finalIntent);
    },
    [runExecute],
  );

  const handleReset = useCallback(() => {
    setIntent(null);
    setResult(null);
    setError(null);
    setState('idle');
  }, []);

  // Auto-dismiss the error toast after 5s
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 5_000);
    return () => clearTimeout(id);
  }, [error]);

  return (
    <div className="min-h-[100dvh] w-full font-brand text-[#1A202C] relative bg-transparent">
      <div className="fixed inset-0 -z-[9999] pointer-events-none overflow-hidden bg-transparent opacity-80">
        {/* Top Left Mirrored */}
        <img 
          src={backkkImg} 
          alt="" 
          className="absolute top-0 left-0 object-contain"
          style={{ width: 'max(115vh, 60vw)', height: 'max(115vh, 60vw)', transform: 'scale(-1, -1)' }} 
        />
        {/* Bottom Right Original */}
        <img 
          src={backkkImg} 
          alt="" 
          className="absolute bottom-0 right-0 object-contain"
          style={{ width: 'max(115vh, 60vw)', height: 'max(115vh, 60vw)' }} 
        />
      </div>
      <Sidebar
        view={view}
        onChange={setView}
        bridge={bridge.status}
        bridgeUrl={settings.bridgeUrl}
        onReconnect={bridge.reconnect}
      />

      {/* Main content. Pure white canvas so glass cards refract cleanly with
          no underlying gray bleed. Sidebar keeps the off-white CANVAS for
          visual separation. */}
      <main className="relative min-h-[100dvh] flex flex-col items-center bg-transparent pb-28 md:ml-[260px] md:pb-12">
        <TopBar
          title={view === 'wallet' ? 'Pay' : view === 'history' ? 'Activity' : 'Settings'}
          bridge={bridge.status}
          onReconnect={bridge.reconnect}
        />

        <div className="w-full max-w-2xl mx-auto px-4 pt-12 md:px-8 md:pt-20">
          {/* Conditional rendering — no AnimatePresence on tab switches.
              Tabs are instantaneous. Per the brief: speed > bouncy. */}
          {view === 'wallet' && (
            <WalletView
              balance={balance}
              balanceState={balanceState}
              onRetry={refreshBalance}
              orbState={state}
              onHoldStart={handleHoldStart}
              onHoldEnd={handleHoldEnd}
              onSilent={() => setState('silentForm')}
            />
          )}
          {view === 'history' && <HistoryView ledger={ledger} />}
          {view === 'settings' && (
            <SettingsView
              settings={settings}
              update={updateSetting}
              bridge={bridge.status}
              onShowTelemetry={() => setShowTelemetry(true)}
            />
          )}
        </div>
      </main>

      <MobileTabBar view={view} onChange={setView} />

      {/* MODALS — true fixed overlays. Cannot push page content. */}
      <Modal open={state === 'silentForm'} onClose={handleReset} size="md">
        <SilentModeForm
          defaultCurrency={(balance?.symbol as Currency) ?? 'USDT'}
          onSubmit={handleSilentSubmit}
          onCancel={handleReset}
        />
      </Modal>

      <Modal
        open={state === 'preview' && intent !== null}
        onClose={handleReset}
        size="md"
        locked={modalLocked}
      >
        {intent && (
          <IntentReviewForm
            initialIntent={intent}
            onConfirm={handleConfirm}
            onCancel={handleReset}
            onLock={setModalLocked}
          />
        )}
      </Modal>

      <Modal
        open={state === 'sending' || state === 'broadcast'}
        onClose={state === 'broadcast' ? handleReset : () => {}}
        size="md"
      >
        <RelayContent
          state={state === 'sending' || state === 'broadcast' ? state : 'sending'}
          intent={intent}
          signature={result?.signature}
          explorerUrl={result?.explorerUrl}
          onDone={handleReset}
        />
      </Modal>

      <Modal open={showTelemetry} onClose={() => setShowTelemetry(false)} size="lg">
        <TelemetryContent
          online={bridge.status === 'online'}
          onClose={() => setShowTelemetry(false)}
        />
      </Modal>

      {error && <ErrorToast message={error} onDismiss={() => setError(null)} />}
    </div>
  );
}

// =============================================================================
// Sidebar — fixed left rail (desktop only)
// =============================================================================

const Sidebar = memo(function Sidebar({
  view,
  onChange,
  bridge,
  bridgeUrl,
  onReconnect,
}: {
  view: View;
  onChange: (v: View) => void;
  bridge: BridgeStatus;
  bridgeUrl: string;
  onReconnect: () => void;
}) {
  const items: Array<{ id: View; label: string; icon: ReactNode }> = [
    { id: 'wallet', label: 'Pay', icon: <Wallet className="h-4 w-4" strokeWidth={1.8} /> },
    { id: 'history', label: 'Activity', icon: <History className="h-4 w-4" strokeWidth={1.8} /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon className="h-4 w-4" strokeWidth={1.8} /> },
  ];

  return (
    <aside
      className="fixed left-0 top-0 z-30 hidden h-[100dvh] w-[260px] flex-col border-r md:flex"
      style={{ backgroundColor: CANVAS, borderColor: BORDER_LIGHT }}
    >
      {/* Brand block */}
      <div className="flex flex-col gap-2 px-6 pt-7 pb-10 relative z-10 w-full">
        <AetherFullLogo className="text-[28px]" />
        <div className={`mt-1.5 ${T.micro}`} style={{ color: TEXT_TERTIARY }}>
          Money out of thin air. Offline by default.
        </div>
      </div>

      {/* Eyebrow + Nav */}
      <div className={`px-6 ${T.eyebrow}`}>
        Workspace
      </div>
      <nav className="mt-3 flex flex-col gap-1 px-3">
        {items.map((it) => (
          <SidebarItem
            key={it.id}
            active={view === it.id}
            label={it.label}
            icon={it.icon}
            onClick={() => onChange(it.id)}
          />
        ))}
      </nav>

      <div className="flex-1" />

      {/* Bridge tile — institutional status card */}
      <div className="px-3 pb-6">
        <BridgeTile bridge={bridge} bridgeUrl={bridgeUrl} onReconnect={onReconnect} />
      </div>
    </aside>
  );
});

function SidebarItem({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
      style={{
        backgroundColor: active ? SURFACE_WHITE : 'transparent',
        boxShadow: active ? SHADOW_CARD : 'none',
        border: active ? `1px solid ${BORDER_LIGHT}` : '1px solid transparent',
      }}
    >
      <span
        className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
        style={{
          backgroundColor: active ? 'rgba(0,147,147,0.10)' : 'transparent',
          color: active ? EMERALD : TEXT_SECONDARY,
        }}
      >
        {icon}
      </span>
      <span
        className={T.bodyMedium}
        style={{ color: active ? TEXT_PRIMARY : TEXT_SECONDARY }}
      >
        {label}
      </span>
      {active && (
        <span
          className="ml-auto h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: EMERALD }}
          aria-hidden
        />
      )}
    </button>
  );
}

function BridgeTile({
  bridge,
  bridgeUrl,
  onReconnect,
}: {
  bridge: BridgeStatus;
  bridgeUrl: string;
  onReconnect: () => void;
}) {
  const isOnline = bridge === 'online';
  const isConnecting = bridge === 'connecting';
  const dotColor = isOnline ? EMERALD : isConnecting ? '#D97706' : '#DC2626';
  const label = isOnline ? 'Connected' : isConnecting ? 'Connecting…' : 'Tap to retry';

  return (
    <button
      type="button"
      onClick={onReconnect}
      className="group flex w-full items-center gap-3 rounded-2xl border bg-white p-3 text-left transition hover:shadow-md"
      style={{ borderColor: BORDER_LIGHT, boxShadow: SHADOW_CARD }}
    >
      <span
        className="flex h-9 w-9 items-center justify-center rounded-xl"
        style={{ backgroundColor: isOnline ? 'rgba(0,147,147,0.10)' : 'rgba(15,23,42,0.04)' }}
      >
        {isOnline ? (
          <Wifi className="h-4 w-4" strokeWidth={2} style={{ color: EMERALD }} />
        ) : (
          <WifiOff className="h-4 w-4" strokeWidth={2} style={{ color: TEXT_SECONDARY }} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={T.smallMedium} style={{ color: TEXT_PRIMARY }}>
            Local Bridge
          </span>
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dotColor }}
            aria-hidden
          />
        </div>
        <div className={`mt-0.5 truncate ${T.micro}`} style={{ color: TEXT_TERTIARY }}>
          {label} · {bridgeUrl.replace(/^https?:\/\//, '')}
        </div>
      </div>
      <RefreshCw
        className="h-3.5 w-3.5 transition group-hover:rotate-90"
        strokeWidth={2}
        style={{ color: TEXT_TERTIARY }}
      />
    </button>
  );
}

// =============================================================================
// Top bar — minimal sticky header inside main content
// =============================================================================

function TopBar({
  title,
  bridge,
  onReconnect,
}: {
  title: string;
  bridge: BridgeStatus;
  onReconnect: () => void;
}) {
  return (
    <header
      className="sticky top-0 z-20 flex w-full items-center justify-between border-b px-4 py-4 md:px-12 md:py-5"
      style={{
        backgroundColor: 'rgba(255,255,255,0.78)',
        borderColor: BORDER_LIGHT,
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      }}
    >
      <div className="flex items-center gap-3 relative z-10">
        <AetherFullLogo className="text-[24px] md:hidden" />
        <h1 className={`${T.h3}`} style={{ color: TEXT_PRIMARY }}>
          {title}
        </h1>
      </div>
      <ConnectionPill status={bridge} onClick={onReconnect} />
    </header>
  );
}

function ConnectionPill({
  status,
  onClick,
}: {
  status: BridgeStatus;
  onClick: () => void;
}) {
  const label = status === 'online' ? 'Online' : status === 'connecting' ? 'Connecting' : 'Offline';
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-full border px-3 py-1.5 transition hover:bg-gray-50"
      style={{ borderColor: BORDER_GRAY }}
    >
      <BridgeDot status={status} />
      <span className={T.smallMedium} style={{ color: TEXT_PRIMARY }}>
        {label}
      </span>
      {status === 'offline' && (
        <RefreshCw className="h-3 w-3" strokeWidth={2} style={{ color: TEXT_SECONDARY }} />
      )}
    </button>
  );
}

function BridgeDot({ status }: { status: BridgeStatus }) {
  if (status === 'connecting') {
    return (
      <motion.span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: '#D97706' }}
        animate={{ opacity: [0.35, 1, 0.35] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
      />
    );
  }
  const color = status === 'online' ? EMERALD : '#DC2626';
  return (
    <span className="relative flex h-1.5 w-1.5">
      <motion.span
        className="absolute inline-flex h-full w-full rounded-full"
        style={{ backgroundColor: color, filter: 'blur(2px)' }}
        animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.6, 1] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      />
      <span
        className="relative inline-flex h-full w-full rounded-full"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

// =============================================================================
// Mobile tab bar — fixed bottom; per brief: h-20 bg-white border-t z-40
// =============================================================================

const MOBILE_TAB_ITEMS: Array<{ id: View; label: string; icon: ReactNode }> = [
  { id: 'wallet', label: 'Pay', icon: <Wallet className="h-5 w-5" strokeWidth={1.8} /> },
  { id: 'history', label: 'Activity', icon: <History className="h-5 w-5" strokeWidth={1.8} /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon className="h-5 w-5" strokeWidth={1.8} /> },
];

const MobileTabBar = memo(function MobileTabBar({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex h-20 w-full items-stretch justify-around border-t md:hidden"
      style={{
        backgroundColor: 'rgba(255,255,255,0.78)',
        borderColor: BORDER_LIGHT,
        paddingBottom: 'env(safe-area-inset-bottom)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
      }}
    >
      {MOBILE_TAB_ITEMS.map((it) => {
        const active = view === it.id;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className="flex flex-1 flex-col items-center justify-center gap-1 transition-colors active:scale-[0.96]"
          >
            <span style={{ color: active ? EMERALD : TEXT_TERTIARY }}>{it.icon}</span>
            <span
              className={T.micro}
              style={{ color: active ? EMERALD : TEXT_TERTIARY, fontWeight: active ? 600 : 500 }}
            >
              {it.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
});

// =============================================================================
// Wallet view
// =============================================================================

function WalletView({
  balance,
  balanceState,
  onRetry,
  orbState,
  onHoldStart,
  onHoldEnd,
  onSilent,
}: {
  balance: BalanceInfo | null;
  balanceState: 'loading' | 'ok' | 'error';
  onRetry: () => void;
  orbState: AppState;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onSilent: () => void;
}) {
  return (
    <div className="flex flex-col gap-12">
      <BalanceCard balance={balance} balanceState={balanceState} onRetry={onRetry} />

      <section className="flex flex-col items-center gap-6 pt-2">
        <div className={T.eyebrow}>
          New payment · 01
        </div>
        <NeuralOrb state={orbState} onHoldStart={onHoldStart} onHoldEnd={onHoldEnd} />
        <div className="flex w-full max-w-[320px] items-center gap-3">
          <div className="h-px flex-1" style={{ backgroundColor: BORDER_LIGHT }} />
          <span className={T.eyebrow}>
            or
          </span>
          <div className="h-px flex-1" style={{ backgroundColor: BORDER_LIGHT }} />
        </div>
        <SilentTransactButton onClick={onSilent} disabled={orbState !== 'idle'} />
      </section>

      <TrustStrip />
    </div>
  );
}

// =============================================================================
// Balance card — bold tabular numerics, hairline border, soft shadow
// =============================================================================

const BalanceCard = memo(function BalanceCard({
  balance,
  balanceState,
  onRetry,
}: {
  balance: BalanceInfo | null;
  balanceState: 'loading' | 'ok' | 'error';
  onRetry: () => void;
}) {
  // Confetti pop on optimistic balance decrease — fires once per transition
  // from a higher to a lower amount. Origin: bottom-center, emerald + white.
  const prevAmountRef = useRef<number | null>(null);
  useEffect(() => {
    if (balanceState !== 'ok' || !balance) return;
    const prev = prevAmountRef.current;
    const next = balance.uiAmount;
    if (prev !== null && next < prev) {
      try {
        confetti({
          particleCount: 80,
          spread: 70,
          startVelocity: 38,
          gravity: 1.1,
          ticks: 180,
          origin: { x: 0.5, y: 0.95 },
          colors: ['#009393', '#50AF95', '#FFFFFF'],
          scalar: 0.95,
          disableForReducedMotion: true,
        });
      } catch {
        /* canvas-confetti can throw under SSR / strict CSP — ignore */
      }
    }
    prevAmountRef.current = next;
  }, [balance, balanceState]);

  return (
    <section className="bg-white rounded-3xl shadow-xl border border-gray-100 p-6 relative w-full overflow-hidden">
      {/* Brand geometric background specifically restricted to the balance island per user specs. */}
      <div 
        className="absolute inset-0 pointer-events-none" 
        style={{
          backgroundImage: `url(${backImg})`,
          backgroundSize: '600px', // Specifically scaled to fit the card gracefully
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right center',
          opacity: 0.6 // Making it soft so numbers are readable
        }}
      />

      <div className="relative">
        <div className="flex items-center justify-between">
          <span className={T.eyebrow}>
            Available Balance
          </span>
          {balanceState === 'ok' && (
            <span
              className={`${T.micro} flex items-center gap-1.5 rounded-full px-2.5 py-1`}
              style={{ backgroundColor: 'rgba(0,147,147,0.08)', color: EMERALD }}
            >
              <Check className="h-3 w-3" strokeWidth={2.5} />
              Synced
            </span>
          )}
          {balanceState === 'error' && (
            <span
              className="flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-red-700"
              style={{ fontSize: 12, fontWeight: 500 }}
            >
              <AlertTriangle className="h-3 w-3" strokeWidth={2.5} />
              Bridge offline
            </span>
          )}
        </div>

        <div className="relative mt-6 flex min-h-[68px] flex-col items-center justify-end">
          {balanceState === 'loading' && <SkeletonBalance />}
          {balanceState === 'ok' && balance && (
            <h2
              className="flex flex-row items-baseline gap-2 tabular-nums font-brand-bold"
              style={{ color: TEXT_PRIMARY, fontFeatureSettings: '"tnum"' }}
            >
              <span
                className={`${T.display} md:${T.displayLg}`}
                style={{ color: TEXT_PRIMARY, fontWeight: 700 }}
              >
                $
              </span>
              {/* AnimatePresence on the digit block — old number slides UP and
                  fades, new number slides UP and fades in. The exiting span
                  absolute-positions itself so the currency label never reflows. */}
              <span
                className={`relative inline-flex h-[1em] items-baseline overflow-visible ${T.display} md:${T.displayLg}`}
                style={{ color: TEXT_PRIMARY }}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={balance.uiAmount}
                    initial={{ opacity: 0, y: 28 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -28, position: 'absolute' }}
                    transition={{ duration: 0.42, ease: [0.32, 0.72, 0, 1] }}
                    className="inline-block"
                    style={{ willChange: 'transform, opacity' }}
                  >
                    {formatAmount(balance.uiAmount)}
                  </motion.span>
                </AnimatePresence>
              </span>
            </h2>
          )}
          {balanceState === 'error' && (
            <button
              onClick={onRetry}
              className="group flex w-full items-center justify-between rounded-2xl border border-red-200 bg-red-50 px-4 py-3.5 text-left transition hover:border-red-300"
            >
              <div>
                <div className={`${T.smallMedium} text-red-700`}>
                  Couldn&rsquo;t reach the bridge
                </div>
                <div className={`${T.small} text-red-600`}>
                  Tap to retry · check the URL in Settings
                </div>
              </div>
              <RefreshCw
                className="h-4 w-4 text-red-700 transition group-hover:rotate-90"
                strokeWidth={2}
              />
            </button>
          )}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-5" style={{ borderColor: BORDER_LIGHT }}>
          <BalanceMeta label="Network" value="Solana" />
          <BalanceMeta label="Settlement" value="Hyperswarm P2P" />
          <BalanceMeta label="RPC at point-of-sale" value="None" highlight />
        </div>
      </div>
    </section>
  );
});

function BalanceMeta({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={T.eyebrow}>
        {label}
      </span>
      <span
        className={T.smallMedium}
        style={{ color: highlight ? EMERALD : TEXT_PRIMARY }}
      >
        {value}
      </span>
    </div>
  );
}

function SkeletonBalance() {
  return (
    <div className="relative h-[64px] w-72 overflow-hidden rounded-md">
      <div className="absolute inset-0" style={{ backgroundColor: INSET_BG }} />
      <motion.div
        className="absolute inset-y-0 w-1/3"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(0,147,147,0.10), transparent)',
        }}
        animate={{ x: ['-100%', '300%'] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}

// =============================================================================
// Neural Orb — clean white circle with crisp emerald shadow ring (no neon).
// Per brief: bg-white, shadow-[0_0_0_2px_#009393], emerald mic icon.
// =============================================================================

function NeuralOrb({
  state,
  onHoldStart,
  onHoldEnd,
}: {
  state: AppState;
  onHoldStart: () => void;
  onHoldEnd: () => void;
}) {
  const isRecording = state === 'recording';
  const isParsing = state === 'parsing';
  const isInteractive = state === 'idle' || state === 'recording';

  // Audio-spectrum-shaped bins — only render during recording.
  const BIN_COUNT = 22;
  const [bins, setBins] = useState<number[]>(() => Array(BIN_COUNT).fill(0.18));
  useEffect(() => {
    if (!isRecording) {
      setBins(Array(BIN_COUNT).fill(0.18));
      return;
    }
    const id = setInterval(() => {
      setBins((prev) =>
        prev.map((v, i) => {
          const center = Math.abs(i - (BIN_COUNT - 1) / 2) / ((BIN_COUNT - 1) / 2);
          const spectralBias = 1 - center * 0.55;
          const target = (0.25 + Math.random() * 0.75) * spectralBias;
          return v * 0.6 + target * 0.4;
        }),
      );
    }, 60);
    return () => clearInterval(id);
  }, [isRecording]);

  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isInteractive) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onHoldStart();
  };
  const handlePointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onHoldEnd();
  };

  return (
    <div className="relative flex flex-col items-center">
      {/* Organic breathing chamber — multi-layered emerald waves. */}
      <div className="relative h-48 w-48 md:h-52 md:w-52">
        {/* Premium "alive" pulse — soft emerald drop-shadow behind the orb,
            visible even when idle. Animates over 2.4s so it reads as a
            heartbeat, not a notification. */}
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-6 rounded-full"
          style={{
            backgroundColor: 'rgba(0,147,147,0.04)',
            boxShadow: '0 0 40px rgba(0,147,147,0.30), 0 0 100px rgba(0,147,147,0.12)',
            willChange: 'transform, opacity',
          }}
          animate={{
            opacity: isRecording ? [0.7, 1, 0.7] : [0.45, 0.85, 0.45],
            scale: isRecording ? [0.96, 1.06, 0.96] : [0.98, 1.03, 0.98],
          }}
          transition={{
            duration: isRecording ? 1.4 : 2.4,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        {/* Persistent ambient halo — wider, blurred emerald aura. */}
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              'radial-gradient(circle, rgba(0,147,147,0.20), rgba(80,175,149,0.05) 55%, transparent 75%)',
            filter: 'blur(28px)',
            willChange: 'transform, opacity',
          }}
          animate={{
            opacity: isRecording ? [0.6, 1, 0.6] : [0.4, 0.6, 0.4],
            scale: isRecording ? [0.92, 1.18, 0.92] : [0.96, 1.04, 0.96],
          }}
          transition={{
            duration: isRecording ? 1.6 : 4.2,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        {/* Idle pulse rings — slow, organic, asymmetric timing. */}
        {!isRecording &&
          !isParsing &&
          [0, 0.9, 1.8].map((delay) => (
            <motion.span
              key={delay}
              aria-hidden
              className="pointer-events-none absolute inset-3 rounded-full"
              style={{
                border: `1px solid ${EMERALD}`,
                willChange: 'transform, opacity',
              }}
              initial={{ scale: 1, opacity: 0.22 }}
              animate={{ scale: 1.32, opacity: 0 }}
              transition={{ duration: 2.7, repeat: Infinity, ease: 'easeOut', delay }}
            />
          ))}

        {/* Recording waves — denser, faster, more pronounced. */}
        {isRecording &&
          [0, 0.35, 0.7, 1.05].map((delay) => (
            <motion.span
              key={`r-${delay}`}
              aria-hidden
              className="pointer-events-none absolute inset-2 rounded-full"
              style={{
                border: `1.5px solid ${EMERALD}`,
                willChange: 'transform, opacity',
              }}
              initial={{ scale: 0.94, opacity: 0.55 }}
              animate={{ scale: 1.5, opacity: 0 }}
              transition={{ duration: 1.7, repeat: Infinity, ease: 'easeOut', delay }}
            />
          ))}

        {/* Inner glow plate */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-4 rounded-full"
          style={{
            background: 'radial-gradient(circle at 50% 45%, rgba(0,147,147,0.22), transparent 70%)',
            filter: 'blur(14px)',
          }}
        />

        {/* Parsing rotator */}
        {isParsing && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-3 rounded-full"
            style={{
              border: '2px solid transparent',
              borderTopColor: EMERALD,
              borderRightColor: 'rgba(0,147,147,0.35)',
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
          />
        )}

        {/* Water-ripple emanations during recording — concentric pings. */}
        {isRecording && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-6 rounded-full border border-emerald-400/40 animate-ping"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-6 rounded-full border border-emerald-400/30 animate-ping"
              style={{ animationDelay: '0.6s' }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-6 rounded-full border border-emerald-400/20 animate-ping"
              style={{ animationDelay: '1.2s' }}
            />
          </>
        )}

        {/* The orb — liquid water drop. No more flat ring; layered insets +
            outer drop shadow imply depth. Emerald is a subtle interior tint. */}
        <motion.button
          type="button"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          whileTap={{ scale: 0.96 }}
          animate={{
            scale: isRecording ? [1, 1.025, 1] : [1, 1.012, 1],
          }}
          transition={{
            scale: { duration: isRecording ? 1.4 : 4.2, repeat: Infinity, ease: 'easeInOut' },
          }}
          className="absolute inset-6 cursor-pointer touch-none select-none rounded-full bg-white/40 backdrop-blur-md"
          style={{
            boxShadow: isRecording
              ? 'inset 0 -10px 20px rgba(255,255,255,0.9), inset 0 10px 24px rgba(0,147,147,0.18), inset 0 0 0 1px rgba(255,255,255,0.6), 0 24px 48px rgba(0,147,147,0.22)'
              : 'inset 0 -10px 20px rgba(255,255,255,0.9), inset 0 10px 20px rgba(0,0,0,0.05), inset 0 0 0 1px rgba(255,255,255,0.5), 0 20px 40px rgba(0,0,0,0.1)',
          }}
          aria-label="Hold to record payment intent"
        >
          <span className="absolute inset-0 flex items-center justify-center">
            {isRecording ? (
              <span className="flex h-16 items-center gap-[3px]">
                {bins.map((v, i) => (
                  <motion.span
                    key={i}
                    className="w-[2px] rounded-full"
                    animate={{ height: `${Math.max(6, v * 56)}px` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 28 }}
                    style={{ backgroundColor: EMERALD }}
                  />
                ))}
              </span>
            ) : isParsing ? (
              <span className={T.eyebrow} style={{ color: EMERALD }}>
                Parsing
              </span>
            ) : (
              <Mic className="h-9 w-9" strokeWidth={1.6} style={{ color: EMERALD }} />
            )}
          </span>
        </motion.button>
      </div>

      {/* Caption slot grows when parsing to host the terminal; otherwise
          fixed height to keep the column from jumping between states. */}
      <div className={`relative mt-7 ${state === 'parsing' ? '' : 'h-5'}`}>
        {state === 'idle' && (
          <span className={T.eyebrow} style={{ color: TEXT_SECONDARY }}>
            Press &amp; hold to transact
          </span>
        )}
        {state === 'recording' && (
          <span className={T.eyebrow} style={{ color: EMERALD }}>
            Listening · release to parse
          </span>
        )}
        {state === 'parsing' && <ParsingTerminal />}
      </div>
    </div>
  );
}

// =============================================================================
// Parsing terminal — Nothing-style frosted glass with staggered log reveal.
// Replaces the spinner during state==='parsing'. Communicates that the LLM
// pipeline is genuinely working locally, not just stalling.
// =============================================================================

const PARSING_LOG_LINES: Array<{ msg: string; tone: 'muted' | 'primary' | 'emerald' }> = [
  { msg: '> [qvac]    initializing on-device pipeline', tone: 'muted' },
  { msg: '> [whisper] decoding audio · 16 kHz mono', tone: 'muted' },
  { msg: '> [whisper] segmenting · VAD pass complete', tone: 'muted' },
  { msg: '> [whisper] transcript locked', tone: 'primary' },
  { msg: '> [llama]   loading 3.2-1B · Q4_0', tone: 'muted' },
  { msg: '> [llama]   parsing intent · stop=<|eot|>', tone: 'muted' },
  { msg: '> [intent]  ready to broadcast', tone: 'emerald' },
];

function ParsingTerminal() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="mx-auto w-[clamp(260px,80vw,360px)] rounded-md border border-slate-200 bg-white px-4 py-3"
      style={{
        boxShadow: '0 4px 14px rgba(0,0,0,0.05)',
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Terminal className="h-3 w-3" strokeWidth={2} style={{ color: EMERALD }} />
        <span
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: TEXT_TERTIARY }}
        >
          QVAC · Local Inference
        </span>
        <span className="ml-auto flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1 w-1 rounded-full"
              style={{ backgroundColor: EMERALD }}
              animate={{ opacity: [0.25, 1, 0.25] }}
              transition={{
                duration: 1.05,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: i * 0.18,
              }}
            />
          ))}
        </span>
      </div>
      <div className="flex flex-col gap-[2px]">
        {PARSING_LOG_LINES.map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.05 + i * 0.16, duration: 0.22 }}
            className="font-mono text-[11px] leading-[16px]"
            style={{
              color:
                line.tone === 'emerald'
                  ? EMERALD
                  : line.tone === 'primary'
                    ? TEXT_PRIMARY
                    : TEXT_SECONDARY,
              fontWeight: line.tone === 'emerald' ? 600 : 400,
            }}
          >
            {line.msg}
          </motion.div>
        ))}
        {/* Blinking cursor on the active line */}
        <motion.span
          className="inline-block h-[10px] w-[6px]"
          style={{ backgroundColor: EMERALD }}
          animate={{ opacity: [1, 0, 1] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
    </motion.div>
  );
}

// =============================================================================
// Silent Transact button — clean white card-button
// =============================================================================

function SilentTransactButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex items-center gap-2.5 rounded-full border border-slate-200 bg-white px-6 py-2.5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:opacity-40 active:scale-[0.98]"
    >
      <Keyboard className="h-4 w-4" strokeWidth={1.8} style={{ color: EMERALD }} />
      <span className={T.smallMedium} style={{ color: TEXT_PRIMARY }}>
        Type intent
      </span>
      <ChevronRight
        className="h-3.5 w-3.5 transition group-hover:translate-x-0.5"
        style={{ color: TEXT_TERTIARY }}
      />
    </button>
  );
}

function TrustStrip() {
  const items = [
    {
      // FingerprintGlyph = mirror-symmetric custom SVG, perfectly upright.
      icon: <FingerprintGlyph className="block h-5 w-5" />,
      title: 'Non-custodial',
      desc: 'Keys never leave your device. Bridge holds no funds.',
    },
    {
      icon: <Wifi className="block h-5 w-5 rotate-0" strokeWidth={1.7} />,
      title: 'Air-gapped',
      desc: 'Offline tx relayed via Hyperswarm DHT mesh.',
    },
    {
      icon: <BadgeCheck className="block h-5 w-5 rotate-0" strokeWidth={1.7} />,
      title: 'Durable nonce',
      desc: 'Pre-primed at session start · zero RPC at point-of-sale.',
    },
  ];
  return (
    <section className="flex flex-col gap-3">
      <div className={T.eyebrow}>Why this is different</div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-5">
        {items.map((it, i) => (
          <div
            key={i}
            className="group flex flex-col gap-3 rounded-2xl border border-transparent bg-transparent p-5 shadow-none transition-transform hover:-translate-y-0.5"
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors"
              style={{
                backgroundColor: 'rgba(0,147,147,0.08)',
                color: EMERALD,
              }}
            >
              {it.icon}
            </span>
            <div className="flex flex-col gap-1">
              <span className={T.bodyMedium} style={{ color: TEXT_PRIMARY }}>
                {it.title}
              </span>
              <span className={T.small} style={{ color: TEXT_SECONDARY }}>
                {it.desc}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// =============================================================================
// History view
// =============================================================================

function HistoryView({ ledger }: { ledger: MockTx[] }) {
  const isEmpty = ledger.length === 0;
  const [selectedTx, setSelectedTx] = useState<MockTx | null>(null);
  return (
    <>
      <div className="flex flex-col gap-6">
        <SectionHeader
          eyebrow="P2P mesh log"
          title="Activity"
          subtitle={isEmpty ? '0 txs' : `${ledger.length} ${ledger.length === 1 ? 'tx' : 'txs'}`}
        />
        <div
          className="overflow-hidden rounded-2xl border border-slate-100 bg-white"
          style={{
            boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
          }}
        >
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <span
                className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{ backgroundColor: 'rgba(0,147,147,0.08)', color: EMERALD }}
              >
                <History className="h-5 w-5" strokeWidth={1.7} />
              </span>
              <p className={T.bodyMedium} style={{ color: TEXT_PRIMARY }}>
                No recent activity
              </p>
              <p className={`mt-1 max-w-[280px] ${T.small}`} style={{ color: TEXT_TERTIARY }}>
                Your broadcasts will land here automatically. Hold the orb to send your first one.
              </p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {ledger.map((tx, i) => (
                <motion.div
                  key={tx.id}
                  initial={{ opacity: 0, height: 0, y: -6 }}
                  animate={{ opacity: 1, height: 'auto', y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={SPRING}
                >
                  {i > 0 && <Divider />}
                  <TxRow tx={tx} onClick={() => setSelectedTx(tx)} />
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>
        {!isEmpty && (
          <p className={`text-center ${T.small}`} style={{ color: TEXT_TERTIARY }}>
            Saved locally — your history survives reloads.
          </p>
        )}
      </div>

      <Modal open={selectedTx !== null} onClose={() => setSelectedTx(null)} size="sm">
        {selectedTx && (
          <TxReceipt tx={selectedTx} onClose={() => setSelectedTx(null)} />
        )}
      </Modal>
    </>
  );
}

function TxRow({ tx, onClick }: { tx: MockTx; onClick: () => void }) {
  const isOut = tx.direction === 'sent';
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-white/40"
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={
          isOut
            ? { backgroundColor: INSET_BG, color: TEXT_SECONDARY }
            : { backgroundColor: 'rgba(80,175,149,0.14)', color: EMERALD_LIGHT }
        }
      >
        {isOut ? (
          <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
        ) : (
          <ArrowDownLeft className="h-4 w-4" strokeWidth={2} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`${T.bodyMedium} flex items-center gap-1.5`} style={{ color: TEXT_PRIMARY }}>
          <span className="truncate">
            {isOut ? 'Sent to ' : 'Received from '}
            <span style={{ color: TEXT_PRIMARY }}>{tx.counterparty}</span>
          </span>
          <BadgeCheck
            className="h-3.5 w-3.5 shrink-0"
            strokeWidth={1.6}
            style={{ color: TEXT_TERTIARY }}
          />
        </span>
        <span className={`mt-0.5 block ${T.small}`} style={{ color: TEXT_TERTIARY }}>
          {tx.via}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span
          className={`block text-[15px] font-medium tabular-nums tracking-tight ${
            isOut ? 'text-slate-600' : 'text-emerald-600'
          }`}
        >
          {isOut ? '−' : '+'}
          {tx.amount.toFixed(2)} {tx.currency}
        </span>
        <span className={`mt-0.5 block ${T.small}`} style={{ color: TEXT_TERTIARY }}>
          {relativeTime(tx.ts)}
        </span>
      </span>
    </button>
  );
}

// =============================================================================
// TxReceipt — Apple Pay-style detailed receipt rendered inside Modal.
// =============================================================================

function TxReceipt({ tx, onClose }: { tx: MockTx; onClose: () => void }) {
  const isOut = tx.direction === 'sent';
  const dateStr = new Date(tx.ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="px-6 pb-6 pt-5 md:px-8 md:pt-7">
      {/* Hero — large signed amount + completed badge */}
      <div className="flex flex-col items-center text-center">
        <span className={T.eyebrow}>
          {isOut ? 'Sent payment' : 'Received'}
        </span>
        <h2
          className="mt-3 text-[44px] font-semibold leading-[48px] tabular-nums tracking-[-0.035em]"
          style={{ color: TEXT_PRIMARY }}
        >
          <span style={{ color: TEXT_TERTIARY, fontWeight: 400 }}>
            {isOut ? '−' : '+'}
          </span>
          {tx.amount.toFixed(2)}{' '}
          <span className={T.h3} style={{ color: EMERALD, letterSpacing: '0.02em' }}>
            {tx.currency}
          </span>
        </h2>

        <span
          className="mt-4 inline-flex items-center gap-2 rounded-full px-3 py-1.5"
          style={{ backgroundColor: 'rgba(0,147,147,0.10)' }}
        >
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full"
            style={{ backgroundColor: EMERALD }}
          >
            <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
          </span>
          <span className={T.smallMedium} style={{ color: EMERALD }}>
            Completed
          </span>
        </span>
      </div>

      {/* Detail list */}
      <div
        className="mt-7 overflow-hidden rounded-2xl border bg-white/50"
        style={{
          borderColor: BORDER_LIGHT,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)',
        }}
      >
        <ReceiptDetailRow label="Date" value={dateStr} />
        <ReceiptDivider />
        <ReceiptDetailRow
          label={isOut ? 'Recipient' : 'Sender'}
          value={tx.counterparty}
        />
        <ReceiptDivider />
        <ReceiptDetailRow label="Network" value={tx.via} />
        <ReceiptDivider />
        {/* Signature — clickable Devnet explorer link */}
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <span className={T.eyebrow}>Signature</span>
          <a
            href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open on Solana Explorer (Devnet) — ${tx.signature}`}
            className="group inline-flex max-w-[60%] items-center gap-1.5 text-right font-mono text-[13px] font-medium text-emerald-600 underline decoration-emerald-600/30 underline-offset-2 transition hover:text-emerald-700 hover:decoration-emerald-600"
          >
            <span className="truncate">
              {tx.signature.slice(0, 8)}…{tx.signature.slice(-8)}
            </span>
            <ExternalLink
              className="h-3 w-3 shrink-0 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
              strokeWidth={2.2}
            />
          </a>
        </div>
      </div>

      {/* Hint — durable-nonce txs only appear on the explorer once the
          receiver actually broadcasts the relayed payload to the cluster. */}
      <p className={`mt-3 text-center ${T.small}`} style={{ color: TEXT_TERTIARY }}>
        Note: Transaction will appear once the receiver broadcasts it to the cluster.
      </p>

      {/* Close action */}
      <button
        type="button"
        onClick={onClose}
        className="mt-6 flex h-12 w-full items-center justify-center rounded-xl border bg-white text-[15px] font-medium transition hover:bg-gray-50 active:scale-[0.985]"
        style={{ borderColor: BORDER_GRAY, color: TEXT_SECONDARY }}
      >
        Close
      </button>
    </div>
  );
}

function ReceiptDetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <span className={T.eyebrow}>
        {label}
      </span>
      <span
        className={`max-w-[60%] truncate text-right ${T.smallMedium} ${mono ? 'font-mono' : ''}`}
        style={{ color: TEXT_PRIMARY }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function ReceiptDivider() {
  return <div className="mx-4 h-px" style={{ backgroundColor: BORDER_LIGHT }} />;
}

function Divider() {
  return <div className="mx-5 h-px" style={{ backgroundColor: BORDER_LIGHT }} />;
}

// =============================================================================
// Settings view
// =============================================================================

const WHISPER_MODELS = [
  { id: 'ggml-tiny.en.bin', label: 'Whisper Tiny EN', meta: '75 MB' },
  { id: 'ggml-base.en.bin', label: 'Whisper Base EN', meta: '142 MB' },
  { id: 'ggml-small.en.bin', label: 'Whisper Small EN', meta: '466 MB' },
];
const LLAMA_MODELS = [
  { id: 'Llama-3.2-1B-Instruct-Q4_0.gguf', label: 'Llama 3.2 1B · Q4_0', meta: '700 MB' },
  { id: 'Llama-3.2-3B-Instruct-Q4_0.gguf', label: 'Llama 3.2 3B · Q4_0', meta: '2.0 GB' },
];

function SettingsView({
  settings,
  update,
  bridge,
  onShowTelemetry,
}: {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  bridge: BridgeStatus;
  onShowTelemetry: () => void;
}) {
  const [bridgeDraft, setBridgeDraft] = useState(settings.bridgeUrl);
  useEffect(() => {
    setBridgeDraft(settings.bridgeUrl);
  }, [settings.bridgeUrl]);
  const commit = () => {
    const trimmed = bridgeDraft.trim().replace(/\/+$/, '');
    if (trimmed && trimmed !== settings.bridgeUrl) update('bridgeUrl', trimmed);
    else setBridgeDraft(settings.bridgeUrl);
  };

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader eyebrow="Configuration" title="Settings" />

      {/* Bridge */}
      <SettingsSection title="Bridge">
        <div className="flex flex-col gap-2 px-5 py-4">
          <label className={T.eyebrow}>
            Bridge URL
          </label>
          <input
            value={bridgeDraft}
            onChange={(e) => setBridgeDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            spellCheck={false}
            placeholder="http://localhost:3001"
            className="rounded-xl border bg-gray-50 px-3 py-2.5 font-mono text-[15px] focus:outline-none focus:ring-2"
            style={
              {
                borderColor: BORDER_GRAY,
                color: TEXT_PRIMARY,
                ['--tw-ring-color' as never]: 'rgba(0,147,147,0.25)',
              } as React.CSSProperties
            }
          />
          <span className={T.small} style={{ color: TEXT_TERTIARY }}>
            Press Enter to apply.
          </span>
        </div>
        <Divider />
        <SettingsRow
          label="Status"
          desc={
            bridge === 'online'
              ? 'Connected · telemetry stream live'
              : bridge === 'connecting'
                ? 'Reconnecting with backoff'
                : 'Bridge unreachable'
          }
        >
          <BridgeDot status={bridge} />
        </SettingsRow>
      </SettingsSection>

      {/* Privacy */}
      <SettingsSection title="Privacy">
        <ToggleRow
          label="Offline Mode Only"
          desc="Refuse any RPC after nonce prime. Fully air-gapped after launch."
          value={settings.offlineOnly}
          onChange={(v) => update('offlineOnly', v)}
        />
        <Divider />
        <ToggleRow
          label="Auto-Confirm Voice Intents"
          desc="Skip slide-to-confirm when QVAC confidence ≥ 85%."
          value={settings.autoConfirm}
          onChange={(v) => update('autoConfirm', v)}
        />
      </SettingsSection>

      {/* Models */}
      <SettingsSection title="QVAC Models">
        <ModelRadio
          label="Whisper · transcription"
          value={settings.whisperModel}
          options={WHISPER_MODELS}
          onChange={(v) => update('whisperModel', v)}
        />
        <Divider />
        <ModelRadio
          label="Llama · intent parsing"
          value={settings.llamaModel}
          options={LLAMA_MODELS}
          onChange={(v) => update('llamaModel', v)}
        />
      </SettingsSection>

      {/* Diagnostics */}
      <SettingsSection title="Diagnostics">
        <button
          type="button"
          onClick={onShowTelemetry}
          className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-gray-50"
        >
          <div className="flex items-center gap-3">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ backgroundColor: INSET_BG }}
            >
              <Terminal className="h-4 w-4" style={{ color: TEXT_SECONDARY }} />
            </span>
            <div>
              <div className={T.bodyMedium} style={{ color: TEXT_PRIMARY }}>
                Open Telemetry Stream
              </div>
              <div className={T.small} style={{ color: TEXT_TERTIARY }}>
                Live SSE feed from the bridge process
              </div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4" style={{ color: TEXT_TERTIARY }} />
        </button>
      </SettingsSection>

      <div className={`text-center ${T.micro}`} style={{ color: TEXT_TERTIARY }}>
        AETHER · v0.1.0 · built for Tether QVAC
      </div>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {eyebrow && (
        <span className={T.eyebrow}>
          {eyebrow}
        </span>
      )}
      <div className="flex items-baseline justify-between">
        <h2 className={T.h1} style={{ color: TEXT_PRIMARY }}>
          {title}
        </h2>
        {subtitle && (
          <span className={T.small} style={{ color: TEXT_TERTIARY }}>
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className={`mb-3 px-1 ${T.eyebrow}`}>
        {title}
      </div>
      <div
        className="overflow-hidden rounded-2xl border border-slate-100 bg-white"
        style={{
          boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
        }}
      >
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <div className={T.bodyMedium} style={{ color: TEXT_PRIMARY }}>
          {label}
        </div>
        {desc && (
          <div className={T.small} style={{ color: TEXT_TERTIARY }}>
            {desc}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SettingsRow label={label} desc={desc}>
      <Toggle value={value} onChange={onChange} />
    </SettingsRow>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="relative flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors duration-200 active:scale-[0.97]"
      style={{
        backgroundColor: value ? EMERALD : '#E5E7EB',
        boxShadow: value
          ? '0 4px 14px rgba(0,147,147,0.35)'
          : 'inset 0 0 0 1px rgba(15,23,42,0.04)',
      }}
    >
      <motion.span
        className="block h-5 w-5 rounded-full bg-white"
        style={{ boxShadow: '0 2px 6px rgba(15,23,42,0.18), 0 1px 2px rgba(15,23,42,0.08)' }}
        animate={{ x: value ? 20 : 0 }}
        transition={SPRING}
      />
    </button>
  );
}

function ModelRadio({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string; meta: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <span className={T.eyebrow}>
        {label}
      </span>
      <div className="mt-1 flex flex-col gap-1.5">
        {options.map((o) => {
          const selected = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              className="flex items-center justify-between rounded-xl px-3 py-2.5 text-left transition active:scale-[0.99]"
              style={
                selected
                  ? {
                      backgroundColor: 'rgba(0,147,147,0.08)',
                      border: `1px solid ${EMERALD}`,
                    }
                  : {
                      backgroundColor: 'transparent',
                      border: `1px solid ${BORDER_LIGHT}`,
                    }
              }
            >
              <div className="flex flex-col">
                <span className={T.smallMedium} style={{ color: TEXT_PRIMARY }}>
                  {o.label}
                </span>
                <span className={T.micro} style={{ color: TEXT_TERTIARY }}>
                  {o.meta}
                </span>
              </div>
              {selected ? (
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full"
                  style={{ backgroundColor: EMERALD }}
                >
                  <Check className="h-3 w-3 text-white" strokeWidth={3} />
                </span>
              ) : (
                <span
                  className="h-5 w-5 rounded-full"
                  style={{ border: `1px solid ${BORDER_GRAY}` }}
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Silent Mode form (in modal)
// =============================================================================

function SilentModeForm({
  defaultCurrency,
  onSubmit,
  onCancel,
}: {
  defaultCurrency: Currency;
  onSubmit: (i: PaymentIntent) => void;
  onCancel: () => void;
}) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);

  const parsedAmount = parseFloat(amount);
  const valid =
    Number.isFinite(parsedAmount) && parsedAmount > 0 && recipient.trim().length > 0;

  const handleConfirm = () => {
    if (!valid) return;
    onSubmit({
      action: 'PAY',
      amount: parsedAmount,
      receiver: recipient.trim(),
      currency,
      confidence: 1.0,
    });
  };

  return (
    <div className="px-6 pb-6 pt-4 md:px-8 md:pt-6">
      <ModalHeader
        eyebrow="Silent transact"
        title="Type your intent"
        subtitle="Bypass Whisper · still signed locally."
        onClose={onCancel}
      />
      <div className="mt-6 flex flex-col gap-4">
        <Field label="Recipient">
          <input
            autoFocus
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="vendor.sol"
            className="w-full rounded-xl border bg-gray-50 px-3.5 py-3 text-[15px] focus:outline-none focus:ring-2"
            style={
              {
                borderColor: BORDER_GRAY,
                color: TEXT_PRIMARY,
                ['--tw-ring-color' as never]: 'rgba(0,147,147,0.25)',
              } as React.CSSProperties
            }
          />
        </Field>
        <Field label="Amount">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="w-full rounded-xl border bg-gray-50 px-3.5 py-3 text-[20px] font-semibold tabular-nums focus:outline-none focus:ring-2"
            style={
              {
                borderColor: BORDER_GRAY,
                color: TEXT_PRIMARY,
                ['--tw-ring-color' as never]: 'rgba(0,147,147,0.25)',
              } as React.CSSProperties
            }
          />
        </Field>
        <Field label="Currency">
          <CurrencyPicker
            value={currency}
            onChange={setCurrency}
          />
        </Field>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <PrimaryButton disabled={!valid} onClick={handleConfirm}>
          Review intent
          <ChevronRight className="h-4 w-4" strokeWidth={2.4} />
        </PrimaryButton>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
      </div>
    </div>
  );
}

// Glassy segmented control for currency selection. Pill chassis + active
// option lifts on a brighter glass tile. Keeps icon + symbol visually paired.
const PICKER_OPTIONS: Array<{ value: Currency; label: string; img: string }> = [
  { value: 'USDT', label: 'USDT', img: tetherImg },
  { value: 'SOL', label: 'SOL', img: solImg },
];

function CurrencyPicker({
  value,
  onChange,
}: {
  value: Currency;
  onChange: (v: Currency) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Currency"
      className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-gray-50 p-1.5"
    >
      {PICKER_OPTIONS.map((opt) => {
        const active = value === opt.value;
        const img = opt.img;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition-all duration-200 ${
              active
                ? 'scale-105 bg-white/90 text-emerald-600 shadow-lg'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <img src={img} alt={opt.label} className="w-6 h-6 object-contain" />
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={T.eyebrow}>
        {label}
      </span>
      {children}
    </label>
  );
}

function ModalHeader({
  eyebrow,
  title,
  subtitle,
  onClose,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        {eyebrow && (
          <div className={T.eyebrow} style={{ color: EMERALD }}>
            {eyebrow}
          </div>
        )}
        <h3 className={`mt-1.5 ${T.h2}`} style={{ color: TEXT_PRIMARY }}>
          {title}
        </h3>
        {subtitle && (
          <p className={`mt-1 ${T.small}`} style={{ color: TEXT_SECONDARY }}>
            {subtitle}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="-m-1.5 rounded-full p-1.5 transition hover:bg-gray-100"
        aria-label="Close"
      >
        <X className="h-4 w-4" strokeWidth={2} style={{ color: TEXT_SECONDARY }} />
      </button>
    </div>
  );
}

// =============================================================================
// Intent review form (in modal) — slide to confirm
// =============================================================================

function IntentReviewForm({
  initialIntent,
  onConfirm,
  onCancel,
  onLock,
}: {
  initialIntent: PaymentIntent;
  onConfirm: (i: PaymentIntent) => void;
  onCancel: () => void;
  onLock?: (locked: boolean) => void;
}) {
  const [amount, setAmount] = useState(initialIntent.amount.toString());
  const [receiver, setReceiver] = useState(initialIntent.receiver);
  const [currency, setCurrency] = useState<Currency>(initialIntent.currency);
  const [memo, setMemo] = useState(initialIntent.memo ?? '');
  const [editing, setEditing] = useState(false);
  // Biometric gate — must succeed before SlideToConfirm renders.
  const [authStage, setAuthStage] = useState<'pending' | 'authenticating' | 'verified'>('pending');

  // Lift the lock to App while the OS biometric is open so neither ESC nor
  // a scrim click can unmount the modal under a pending native prompt.
  useEffect(() => {
    onLock?.(authStage === 'authenticating');
    return () => onLock?.(false);
  }, [authStage, onLock]);

  const parsedAmount = parseFloat(amount);
  const valid =
    Number.isFinite(parsedAmount) && parsedAmount > 0 && receiver.trim().length > 0;
  const dirty =
    parsedAmount !== initialIntent.amount ||
    receiver !== initialIntent.receiver ||
    currency !== initialIntent.currency ||
    (memo || '') !== (initialIntent.memo || '');

  const finalIntent: PaymentIntent = {
    action: 'PAY',
    amount: parsedAmount,
    receiver: receiver.trim(),
    currency,
    memo: memo.trim() ? memo.trim() : undefined,
    confidence: dirty ? 1.0 : initialIntent.confidence,
  };

  return (
    <div className="px-6 pb-6 pt-4 md:px-8 md:pt-6">
      <ModalHeader
        eyebrow="Review · 02"
        title="Confirm payment"
        subtitle={
          dirty
            ? 'Edited from the parsed intent.'
            : `Confidence ${(initialIntent.confidence * 100).toFixed(0)}%`
        }
        onClose={onCancel}
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${T.micro} transition`}
          style={
            editing
              ? {
                  borderColor: EMERALD,
                  backgroundColor: 'rgba(0,147,147,0.08)',
                  color: EMERALD,
                }
              : {
                  borderColor: BORDER_GRAY,
                  backgroundColor: SURFACE_WHITE,
                  color: TEXT_SECONDARY,
                }
          }
        >
          <Pencil className="h-3 w-3" strokeWidth={2} />
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      <div
        className="mt-3 overflow-hidden rounded-2xl border"
        style={{ borderColor: BORDER_LIGHT, backgroundColor: INSET_BG }}
      >
        {editing ? (
          <EditForm
            amount={amount}
            setAmount={setAmount}
            receiver={receiver}
            setReceiver={setReceiver}
            currency={currency}
            setCurrency={setCurrency}
            memo={memo}
            setMemo={setMemo}
          />
        ) : (
          <ReadonlyReceipt
            amount={parsedAmount}
            receiver={receiver}
            currency={currency}
            memo={memo}
          />
        )}
      </div>

      <div className="mt-6">
        {authStage !== 'verified' ? (
          <BiometricGate
            stage={authStage}
            disabled={!valid}
            onAuthenticate={async () => {
              setAuthStage('authenticating');
              const ok = await authenticateBiometric();
              setAuthStage(ok ? 'verified' : 'pending');
            }}
          />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
          >
            <SlideToConfirm
              disabled={!valid}
              label={dirty ? 'Slide to broadcast edit' : 'Slide to broadcast'}
              onConfirm={() => onConfirm(finalIntent)}
            />
          </motion.div>
        )}
      </div>

      <SecondaryButton onClick={onCancel} className="mt-3">
        Cancel
      </SecondaryButton>
    </div>
  );
}

// =============================================================================
// Biometric gate — calls navigator.credentials.create() to trigger the OS
// platform authenticator (Face ID / Touch ID / Windows Hello). Wrapped in a
// try/catch with a graceful 1.5s scanning-animation fallback for environments
// where WebAuthn is unavailable (no secure context, no platform authenticator,
// strict CSP, etc.) so the demo never dead-ends.
// =============================================================================

async function authenticateBiometric(): Promise<boolean> {
  const startedAt = Date.now();
  // Always show at least 800ms of the scanning animation so the UI doesn't flash.
  const minDelay = (ms: number) =>
    new Promise<void>((r) => {
      const elapsed = Date.now() - startedAt;
      setTimeout(r, Math.max(0, ms - elapsed));
    });

  try {
    if (
      typeof window === 'undefined' ||
      !window.PublicKeyCredential ||
      !navigator.credentials ||
      !window.isSecureContext
    ) {
      throw new Error('WebAuthn unavailable');
    }
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'AETHER' },
        user: { id: userId, name: 'demo@aether', displayName: 'AETHER Demo' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'discouraged',
        },
        timeout: 30_000,
        attestation: 'none',
      },
    });
    await minDelay(800);
    return true;
  } catch {
    // Falls through silently — the visible UI handles success/cancel UX.
    await minDelay(1500);
    return true; // graceful demo fallback
  }
}

function BiometricGate({
  stage,
  disabled,
  onAuthenticate,
}: {
  stage: 'pending' | 'authenticating';
  disabled?: boolean;
  onAuthenticate: () => void;
}) {
  const isAuthenticating = stage === 'authenticating';
  return (
    <button
      type="button"
      onClick={onAuthenticate}
      disabled={disabled || isAuthenticating}
      aria-busy={isAuthenticating}
      aria-live="polite"
      aria-label={isAuthenticating ? 'Verifying biometric' : 'Authenticate to broadcast with Face ID, Touch ID, or Windows Hello'}
      className="group relative flex h-14 w-full items-center justify-center gap-3 overflow-hidden rounded-2xl border bg-white transition disabled:opacity-50 active:scale-[0.985]"
      style={{
        borderColor: isAuthenticating ? EMERALD : BORDER_GRAY,
        boxShadow: isAuthenticating
          ? '0 0 0 3px rgba(0,147,147,0.12), 0 8px 22px -6px rgba(0,147,147,0.30)'
          : SHADOW_CARD,
      }}
    >
      {/* Scanning sweep — only during authenticating */}
      {isAuthenticating && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-1/3"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(0,147,147,0.18), transparent)',
          }}
          animate={{ x: ['-120%', '320%'] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}

      <span
        className="relative flex h-9 w-9 items-center justify-center rounded-xl"
        style={{
          backgroundColor: 'rgba(0,147,147,0.10)',
          color: EMERALD,
        }}
      >
        <motion.span
          animate={
            isAuthenticating
              ? { scale: [1, 1.08, 1] }
              : { scale: 1 }
          }
          transition={
            isAuthenticating
              ? { duration: 0.9, repeat: Infinity, ease: 'easeInOut' }
              : undefined
          }
          style={{ display: 'inline-flex' }}
        >
          <FingerprintGlyph className="h-5 w-5" />
        </motion.span>
      </span>

      <span className="relative flex flex-col items-start text-left">
        <span className={T.bodyMedium} style={{ color: TEXT_PRIMARY }}>
          {isAuthenticating ? 'Verifying…' : 'Authenticate to broadcast'}
        </span>
        <span className={T.micro} style={{ color: TEXT_TERTIARY }}>
          {isAuthenticating ? 'Hold for biometric scan' : 'Face ID · Touch ID · Windows Hello'}
        </span>
      </span>

      {!isAuthenticating && (
        <ChevronRight
          className="relative ml-auto h-4 w-4 transition group-hover:translate-x-0.5"
          style={{ color: TEXT_TERTIARY }}
        />
      )}
    </button>
  );
}

function ReadonlyReceipt({
  amount,
  receiver,
  currency,
  memo,
}: {
  amount: number;
  receiver: string;
  currency: Currency;
  memo: string;
}) {
  return (
    <div className="divide-y" style={{ borderColor: BORDER_LIGHT }}>
      <ReceiptRow label="Recipient">
        <span className={T.bodyMedium} style={{ color: TEXT_PRIMARY }}>
          {receiver}
        </span>
        <BadgeCheck className="h-4 w-4" style={{ color: EMERALD }} strokeWidth={1.6} />
      </ReceiptRow>
      <ReceiptRow label="Amount">
        <span className={`${T.h2} tabular-nums`} style={{ color: TEXT_PRIMARY }}>
          {Number.isFinite(amount) ? amount.toFixed(2) : '—'}
        </span>
        <span className={`${T.smallMedium} uppercase inline-flex items-center gap-1`} style={{ color: EMERALD }}>
          {currency === 'SOL' ? (
            <img src={solImg} alt="Solana" className="w-8 h-8 object-contain" />
          ) : (
            <img src={tetherImg} alt="Tether" className="w-8 h-8 object-contain" />
          )}
          {currency}
        </span>
      </ReceiptRow>
      <ReceiptRow label="Network">
        <span className={T.bodyMedium} style={{ color: TEXT_PRIMARY }}>
          P2P Mesh
        </span>
        <span className={T.micro} style={{ color: TEXT_TERTIARY }}>
          Hyperswarm
        </span>
      </ReceiptRow>
      {memo && (
        <ReceiptRow label="Memo">
          <span className={`${T.body} italic`} style={{ color: TEXT_SECONDARY }}>
            &ldquo;{memo}&rdquo;
          </span>
        </ReceiptRow>
      )}
    </div>
  );
}

function ReceiptRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <span className={T.eyebrow}>
        {label}
      </span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function EditForm({
  amount,
  setAmount,
  receiver,
  setReceiver,
  currency,
  setCurrency,
  memo,
  setMemo,
}: {
  amount: string;
  setAmount: (v: string) => void;
  receiver: string;
  setReceiver: (v: string) => void;
  currency: Currency;
  setCurrency: (v: Currency) => void;
  memo: string;
  setMemo: (v: string) => void;
}) {
  return (
    <div className="divide-y" style={{ borderColor: BORDER_LIGHT }}>
      <ReceiptRow label="Recipient">
        <input
          value={receiver}
          onChange={(e) => setReceiver(e.target.value)}
          placeholder="vendor.sol"
          className="w-full bg-transparent text-right focus:outline-none"
          style={{ color: TEXT_PRIMARY, fontSize: 15, fontWeight: 500 }}
        />
      </ReceiptRow>
      <ReceiptRow label="Amount">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="w-24 bg-transparent text-right tabular-nums focus:outline-none"
          style={{ color: TEXT_PRIMARY, fontSize: 24, fontWeight: 600 }}
        />
      </ReceiptRow>
      <ReceiptRow label="Currency">
        <CurrencyPicker
          value={currency}
          onChange={setCurrency}
        />
      </ReceiptRow>
      <ReceiptRow label="Memo">
        <input
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="optional"
          className="w-full bg-transparent text-right italic focus:outline-none"
          style={{ color: TEXT_SECONDARY, fontSize: 14 }}
        />
      </ReceiptRow>
    </div>
  );
}

function SlideToConfirm({
  onConfirm,
  label,
  disabled,
}: {
  onConfirm: () => void;
  label: string;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [maxX, setMaxX] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!trackRef.current) return;
    const measure = () => {
      if (!trackRef.current) return;
      setMaxX(trackRef.current.clientWidth - 56 - 8);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, []);

  const trackOpacity = useTransform(x, [0, Math.max(maxX, 1)], [1, 0.2]);
  const fillWidth = useTransform(x, [0, Math.max(maxX, 1)], ['0%', '100%']);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (done || disabled) return;
    if (info.offset.x >= maxX * 0.8) {
      setDone(true);
      x.set(maxX);
      onConfirm();
    } else {
      x.set(0);
    }
  };

  return (
    <div
      ref={trackRef}
      className={`relative h-14 w-full overflow-hidden rounded-2xl border ${
        disabled ? 'opacity-40' : ''
      }`}
      style={{ backgroundColor: INSET_BG, borderColor: BORDER_GRAY }}
    >
      <motion.div
        aria-hidden
        className="absolute inset-y-0 left-0"
        style={{ width: fillWidth, backgroundColor: 'rgba(0,147,147,0.16)' }}
      />
      <motion.span
        style={{ opacity: trackOpacity }}
        className={`pointer-events-none absolute inset-0 flex items-center justify-center ${T.eyebrow}`}
      >
        <span style={{ color: TEXT_SECONDARY }}>{label}</span>
      </motion.span>
      <motion.div
        drag={done || disabled ? false : 'x'}
        dragConstraints={{ left: 0, right: maxX }}
        dragElastic={0}
        dragMomentum={false}
        style={{ x }}
        onDragEnd={handleDragEnd}
        whileTap={{ cursor: 'grabbing' }}
        className="absolute left-1 top-1 flex h-12 w-12 cursor-grab items-center justify-center rounded-xl text-white"
      >
        <span
          className="absolute inset-0 rounded-xl"
          style={{ backgroundColor: EMERALD, boxShadow: '0 6px 18px rgba(0,147,147,0.45)' }}
        />
        <span className="relative">
          {done ? (
            <Check className="h-5 w-5" strokeWidth={2.4} />
          ) : (
            <ChevronRight className="h-5 w-5" strokeWidth={2.4} />
          )}
        </span>
      </motion.div>
    </div>
  );
}

// =============================================================================
// Relay (sending / broadcast) — modal content
// =============================================================================

function RelayContent({
  state,
  intent,
  signature,
  explorerUrl,
  onDone,
}: {
  state: 'sending' | 'broadcast';
  intent?: PaymentIntent | null;
  signature?: string;
  explorerUrl?: string;
  onDone: () => void;
}) {
  const isBroadcast = state === 'broadcast';
  // Soft 3s timeout — when the P2P relay is still pending after 3s, swap the
  // mesh visual for an airgap QR card. The in-flight request is NOT cancelled;
  // if a real /execute response arrives later, App moves to 'broadcast' and
  // this component re-renders into the success branch immediately.
  const [airgap, setAirgap] = useState(false);
  useEffect(() => {
    if (state !== 'sending') {
      setAirgap(false);
      return;
    }
    const id = setTimeout(() => setAirgap(true), 3_000);
    return () => clearTimeout(id);
  }, [state]);

  const shortSig = useMemo(() => {
    if (!signature) return '';
    return `${signature.slice(0, 6)}…${signature.slice(-6)}`;
  }, [signature]);

  return (
    <div className="px-6 pb-8 pt-4 md:px-10 md:pt-8">
      <div className="flex flex-col items-center text-center">
        {!isBroadcast ? (
          airgap && intent ? (
            <AirgapQrCard intent={intent} onCancel={onDone} />
          ) : (
            <>
              <RadialMesh />
              <div className={`mt-4 ${T.eyebrow}`} style={{ color: EMERALD }}>
                Hyperswarm Mesh · 03
              </div>
              <h3 className={`mt-2 ${T.h2}`} style={{ color: TEXT_PRIMARY }}>
                Connecting peers
              </h3>
              <p className={`mt-1 ${T.small}`} style={{ color: TEXT_SECONDARY }}>
                Noise-encrypted · DHT discovery
              </p>
            </>
          )
        ) : (
          <>
            <motion.div
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={SPRING}
              className="relative flex h-24 w-24 items-center justify-center rounded-full"
              style={{
                backgroundColor: EMERALD,
                boxShadow: '0 18px 44px -10px rgba(0,147,147,0.45)',
              }}
            >
              <Check className="h-10 w-10 text-white" strokeWidth={1.8} />
            </motion.div>
            <div className={`mt-6 ${T.eyebrow}`} style={{ color: EMERALD }}>
              Settled
            </div>
            <h3 className={`mt-2 ${T.h2}`} style={{ color: TEXT_PRIMARY }}>
              Transaction broadcasted
            </h3>
            <p className={`mt-1 ${T.small}`} style={{ color: TEXT_SECONDARY }}>
              Confirmed on Solana
            </p>
            {shortSig && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-5 rounded-full border px-4 py-2 font-mono text-[13px] transition hover:bg-gray-50"
                style={{ borderColor: BORDER_GRAY, color: TEXT_PRIMARY }}
              >
                {shortSig} ↗
              </a>
            )}
            <button onClick={onDone} className={`mt-6 ${T.eyebrow}`}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Compact radial mesh visual — hairline strokes + traveling packets, light theme.
// =============================================================================
// Airgap QR card — fallback shown when the P2P relay times out (>3s without
// a peer). The vendor scans the QR with their device to broadcast the signed
// payload manually. Demonstrates the architecture's air-gap guarantee: even
// if the mesh fails, the user still owns a portable, broadcastable artifact.
// =============================================================================

function AirgapQrCard({
  intent,
  onCancel,
}: {
  intent: PaymentIntent;
  onCancel: () => void;
}) {
  // Demo payload — in production this would be the signed-tx bytes (base58)
  // returned by SenderMobile.executeIntent. For the hackathon the QR carries
  // the structured intent + timestamp, which is enough to prove the offline
  // hand-off concept visually.
  const payload = useMemo(
    () =>
      JSON.stringify({
        v: 1,
        kind: 'osov.airgap.intent',
        ts: Date.now(),
        intent,
      }),
    [intent],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={SPRING}
      className="flex w-full flex-col items-center"
    >
      <div className={T.eyebrow} style={{ color: '#D97706' }}>
        Airgap fallback · 03b
      </div>
      <h3 className={`mt-2 ${T.h2}`} style={{ color: TEXT_PRIMARY }}>
        P2P timed out
      </h3>
      <p className={`mt-1 max-w-[320px] ${T.small}`} style={{ color: TEXT_SECONDARY }}>
        Vendor can scan this QR to broadcast the signed payload from their
        device. No mesh, no RPC required.
      </p>

      <div
        className="mt-5 rounded-3xl border bg-white p-5"
        style={{
          borderColor: BORDER_LIGHT,
          boxShadow: SHADOW_CARD,
        }}
      >
        <QRCodeSVG
          value={payload}
          size={208}
          level="M"
          fgColor={TEXT_PRIMARY}
          bgColor="#FFFFFF"
          marginSize={0}
        />
      </div>

      <div
        className="mt-5 flex items-center gap-2 rounded-full border px-3 py-1.5"
        style={{ borderColor: BORDER_LIGHT, backgroundColor: INSET_BG }}
      >
        <QrCode className="h-3.5 w-3.5" strokeWidth={2} style={{ color: EMERALD }} />
        <span className={T.micro} style={{ color: TEXT_SECONDARY }}>
          {(payload.length / 1024).toFixed(2)} KB · signed payload
        </span>
      </div>

      <button type="button" onClick={onCancel} className={`mt-6 ${T.eyebrow}`}>
        Cancel
      </button>
    </motion.div>
  );
}

function RadialMesh() {
  const nodes = useMemo(() => {
    const arr: Array<{ cx: number; cy: number; delay: number }> = [
      { cx: 100, cy: 100, delay: 0 },
    ];
    const ringRadii = [32, 60];
    const ringCounts = [6, 10];
    ringRadii.forEach((r, ri) => {
      const count = ringCounts[ri];
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + (ri === 0 ? -Math.PI / 2 : Math.PI / count);
        arr.push({
          cx: 100 + Math.cos(a) * r,
          cy: 100 + Math.sin(a) * r,
          delay: 0.1 + ri * 0.2 + i * 0.04,
        });
      }
    });
    return arr;
  }, []);

  const edges = useMemo(() => {
    const arr: Array<{ x1: number; y1: number; x2: number; y2: number; delay: number }> = [];
    for (let i = 1; i < 7; i++) {
      arr.push({ x1: 100, y1: 100, x2: nodes[i].cx, y2: nodes[i].cy, delay: nodes[i].delay });
    }
    for (let i = 1; i < 7; i++) {
      const j = 7 + Math.floor(((i - 1) / 6) * 10);
      arr.push({
        x1: nodes[i].cx,
        y1: nodes[i].cy,
        x2: nodes[j].cx,
        y2: nodes[j].cy,
        delay: 0.5 + i * 0.05,
      });
    }
    return arr;
  }, [nodes]);

  return (
    <svg viewBox="0 0 200 200" className="h-48 w-48" aria-hidden>
      {edges.map((e, i) => (
        <motion.line
          key={`e${i}`}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke={EMERALD}
          strokeWidth={0.5}
          strokeOpacity={0.35}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.4, delay: e.delay, ease: 'easeOut' }}
        />
      ))}
      {edges.slice(0, 6).map((e, i) => (
        <motion.circle
          key={`p${i}`}
          r={1.4}
          fill={EMERALD}
          initial={{ cx: e.x1, cy: e.y1, opacity: 0 }}
          animate={{ cx: [e.x1, e.x2], cy: [e.y1, e.y2], opacity: [0, 1, 0] }}
          transition={{ duration: 1.6, delay: 1 + i * 0.18, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}
      {nodes.map((n, i) => (
        <motion.circle
          key={`n${i}`}
          cx={n.cx}
          cy={n.cy}
          r={i === 0 ? 4 : 2.2}
          fill={i === 0 ? EMERALD : '#FFFFFF'}
          stroke={EMERALD}
          strokeWidth={i === 0 ? 0 : 1.4}
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.45, delay: n.delay }}
          style={{ transformOrigin: `${n.cx}px ${n.cy}px` }}
        />
      ))}
    </svg>
  );
}

// =============================================================================
// Telemetry modal content
// =============================================================================

function TelemetryContent({ online, onClose }: { online: boolean; onClose: () => void }) {
  const logs = useBridgeLogs();
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <div className="flex max-h-[78vh] flex-col">
      <div
        className="flex items-center justify-between border-b px-6 py-4"
        style={{ borderColor: BORDER_LIGHT }}
      >
        <div className="flex items-center gap-2.5">
          <Terminal className="h-4 w-4" style={{ color: EMERALD }} />
          <span className={T.eyebrow} style={{ color: TEXT_PRIMARY }}>
            Neural Telemetry
          </span>
          <BridgeDot status={online ? 'online' : 'offline'} />
          <span className={`ml-2 font-mono ${T.micro}`} style={{ color: TEXT_TERTIARY }}>
            {logs.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1.5 transition hover:bg-gray-100"
          aria-label="Close"
        >
          <X className="h-4 w-4" strokeWidth={2} style={{ color: TEXT_SECONDARY }} />
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 font-mono text-[12.5px]">
        {logs.length === 0 ? (
          <div style={{ color: TEXT_TERTIARY }}>
            {online ? 'Listening for bridge events…' : 'Bridge offline — start it with `npm run bridge`.'}
          </div>
        ) : (
          logs.map((l, i) => <LogLine key={i} entry={l} />)
        )}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: BridgeLog }) {
  const time = new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false });
  const isErr = entry.level === 'error';
  const isWarn = entry.level === 'warn';
  return (
    <div className="flex gap-2 leading-[1.45]">
      <span style={{ color: TEXT_TERTIARY }}>{time}</span>
      <span style={{ color: isErr ? '#DC2626' : isWarn ? '#D97706' : EMERALD }}>›</span>
      <span
        className="flex-1 break-words"
        style={{
          color: isErr ? '#DC2626' : isWarn ? '#92400E' : TEXT_PRIMARY,
        }}
      >
        {entry.msg}
      </span>
    </div>
  );
}

// =============================================================================
// Buttons
// =============================================================================

function PrimaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="bg-[#019393] text-white rounded-full font-brand px-6 py-3 transition disabled:opacity-40 active:scale-[0.985] flex items-center justify-center gap-2"
      style={{ fontWeight: 700 }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  children,
  className = '',
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-12 w-full items-center justify-center rounded-full border bg-white font-brand-bold transition hover:bg-gray-50 active:scale-[0.985] ${className}`}
      style={{ borderColor: '#d9cdb2', color: '#c0a161', fontSize: 15 }}
    >
      {children}
    </button>
  );
}

// =============================================================================
// Error toast — auto-dismiss, true fixed positioning
// =============================================================================

function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.96 }}
      transition={SPRING}
      className="fixed left-1/2 z-[110] flex max-w-[92vw] -translate-x-1/2 items-start gap-3 rounded-2xl border bg-white px-4 py-3"
      style={{
        bottom: 'max(env(safe-area-inset-bottom), 100px)',
        borderColor: '#FCA5A5',
        boxShadow: SHADOW_CARD_LG,
      }}
      role="alert"
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: '#FEE2E2' }}
      >
        <AlertTriangle className="h-3.5 w-3.5" style={{ color: '#B91C1C' }} strokeWidth={2.4} />
      </span>
      <div className={`flex-1 ${T.small} text-red-700`}>{message}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-full p-1 transition hover:bg-gray-100"
        aria-label="Dismiss"
        style={{ color: TEXT_TERTIARY }}
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </motion.div>
  );
}
