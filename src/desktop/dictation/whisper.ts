import { app } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { host, type WorkerTransport } from '../../server/host';
import { log } from '../../server/log';
import type { DictationLanguages, DictationUpdate } from '../../shared/types';
import type { WhisperInMessage, WhisperModelSpec, WhisperOutMessage } from './whisper-worker';

// Dictation off the Mac: Whisper on this computer's CPU (whisper-worker.ts),
// fed by the microphone the preload captures (16 kHz mono, see
// preload/dictation-capture.ts). Nothing leaves the machine; the model is
// downloaded once, on the first dictation, into this profile's state folder.
//
// Whisper has no streaming mode, so the live text is a re-transcription of
// the stretch being spoken: as soon as one decode finishes, the next starts on
// everything heard since the stretch began, which paces itself to the
// computer's speed. A stretch longer than SEGMENT_S is settled ("final") and
// a new one begins, so a decode never grows past Whisper's 30-second window.

const SAMPLE_RATE = 16_000;
const SEGMENT_S = 24;
/** Too little new speech to be worth another pass. */
const MIN_NEW_S = 0.4;
/** The worker (and the model in its memory) outlives a dictation by this much. */
const IDLE_MS = 5 * 60_000;

export type WhisperModelId = 'fast' | 'accurate';

/** The two models Settings offers: speed against accuracy (and download size). */
export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelSpec> = {
  // 240 MB; about a quarter of real time on a 6-core laptop CPU.
  fast: { repo: 'onnx-community/whisper-small', encoder: 'q8', decoder: 'q8' },
  // 730 MB; about 80% of real time on the same CPU, much better outside English.
  accurate: { repo: 'onnx-community/whisper-large-v3-turbo', encoder: 'q4', decoder: 'q4' }
};

/** Languages offered in Settings: Whisper's best-supported, by ISO 639-1 code. */
const LANGUAGES = [
  'en', 'sk', 'cs', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'hu', 'ro', 'bg', 'hr', 'sl', 'sr', 'uk', 'ru', 'el',
  'tr', 'sv', 'da', 'no', 'fi', 'et', 'lv', 'lt', 'ca', 'ar', 'he', 'hi', 'ja', 'ko', 'zh', 'vi', 'th', 'id', 'ms'
];

interface Session {
  id: number;
  language: string | null;
  /** Everything heard, in arrival order. */
  chunks: Float32Array[];
  samples: number;
  /** Where the stretch being re-transcribed begins (samples). */
  segmentStart: number;
  /** The settled text of earlier stretches. */
  finals: string[];
  /** The latest reading of the current stretch. */
  volatile: string;
  /** How far the last decode of this stretch reached (samples). */
  decodedTo: number;
  decoding: Promise<void> | null;
  stopped: boolean;
}

interface Deps {
  broadcast(update: DictationUpdate): void;
}

let worker: WorkerTransport | null = null;
let loaded: WhisperModelId | null = null;
let ready: Promise<void> | null = null;
let idle: NodeJS.Timeout | null = null;
let nextRequest = 1;
const pending = new Map<number, { resolve(text: string): void; reject(e: Error): void }>();
let onProgress: ((downloading: boolean) => void) | null = null;
let session: Session | null = null;
let sessionCount = 0;

function cacheDir(): string {
  return join(host().stateRoot(), 'speech-models');
}

function stopWorker(): void {
  worker?.kill();
  worker = null;
  loaded = null;
  ready = null;
  for (const [, p] of pending) p.reject(new Error('The speech model stopped.'));
  pending.clear();
}

function keepAlive(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (!session) stopWorker();
  }, IDLE_MS);
  idle.unref?.();
}

/** A worker with this model loaded, starting one (and the download) when needed. */
function ensureModel(model: WhisperModelId): Promise<void> {
  if (worker && loaded === model && ready) return ready;
  stopWorker();
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'dictation-worker.js');
  const w = host().forkWorker(entry, { serviceName: 'stem-dictation-worker' });
  worker = w;
  loaded = model;
  ready = new Promise<void>((resolve, reject) => {
    w.onMessage((raw) => {
      const m = raw as WhisperOutMessage;
      if (m.type === 'progress') onProgress?.(m.downloading);
      else if (m.type === 'ready') resolve();
      else if (m.type === 'load-failed') {
        log('dictation', 'the speech model did not load', { error: m.error });
        reject(new Error(`The speech model could not be loaded: ${m.error}`));
      } else if (m.type === 'text' || m.type === 'failed') {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.type === 'text') p?.resolve(m.text);
        else p?.reject(new Error(m.error));
      }
    });
    w.onExit((code) => {
      if (worker !== w) return;
      log('dictation', 'the speech worker exited', { code });
      reject(new Error('The speech model stopped.'));
      stopWorker();
    });
  });
  const load: WhisperInMessage = { type: 'load', spec: WHISPER_MODELS[model], cacheDir: cacheDir() };
  w.send(load);
  // A failed load must not stay cached as the answer for the next dictation.
  ready.catch(() => {
    if (worker === w) stopWorker();
  });
  return ready;
}

function transcribe(audio: Float32Array, language: string | null): Promise<string> {
  const w = worker;
  if (!w) return Promise.reject(new Error('The speech model is not loaded.'));
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const m: WhisperInMessage = { type: 'transcribe', id, audio, language };
    w.send(m);
  });
}

/** The samples [from, to) of the session's audio, as one array. */
function slice(s: Session, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.max(0, to - from));
  let at = 0;
  let filled = 0;
  for (const c of s.chunks) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + c.length);
    if (end > start) {
      out.set(c.subarray(start - at, end - at), filled);
      filled += end - start;
    }
    at += c.length;
    if (at >= to) break;
  }
  return out;
}

const heard = (s: Session): string => [...s.finals, s.volatile].filter(Boolean).join(' ');

/** One more pass over the current stretch, then another while speech keeps coming. */
function pump(s: Session, deps: Deps): void {
  if (s.decoding || s.stopped || loaded === null || !worker) return;
  if (s.samples - s.decodedTo < MIN_NEW_S * SAMPLE_RATE) return;
  const to = s.samples;
  const settle = to - s.segmentStart >= SEGMENT_S * SAMPLE_RATE;
  s.decoding = transcribe(slice(s, s.segmentStart, to), s.language)
    .then((text) => {
      if (session !== s) return;
      if (settle) {
        if (text) s.finals.push(text);
        s.volatile = '';
        s.segmentStart = to;
      } else {
        s.volatile = text;
      }
      s.decodedTo = to;
      deps.broadcast({ session: s.id, final: s.finals.join(' '), volatile: s.volatile ? ` ${s.volatile}` : '' });
    })
    .catch((e: unknown) => log('dictation', 'a live pass failed', { error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      s.decoding = null;
      pump(s, deps);
    });
}

/** Whisper's code for a locale, or null to let it tell the language from the speech. */
function languageOf(locale: string | null): string | null {
  const code = (locale || app.getLocale()).split(/[-_]/)[0]?.toLowerCase() ?? '';
  return LANGUAGES.includes(code) ? code : null;
}

export function whisperLanguages(): DictationLanguages {
  const names = new Intl.DisplayNames([app.getLocale() || 'en'], { type: 'language' });
  const languages = LANGUAGES.map((id) => ({ id, name: names.of(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name));
  const current = (app.getLocale().split('-')[0] ?? 'en').toLowerCase();
  return { available: true, languages, current: LANGUAGES.includes(current) ? current : 'en' };
}

/** Listening starts at once (the preload is already capturing); resolves when the model is ready. */
export async function startWhisper(locale: string | null, model: WhisperModelId, deps: Deps): Promise<{ session: number; locale: string }> {
  cancelWhisper();
  const s: Session = {
    id: ++sessionCount,
    language: languageOf(locale),
    chunks: [],
    samples: 0,
    segmentStart: 0,
    finals: [],
    volatile: '',
    decodedTo: 0,
    decoding: null,
    stopped: false
  };
  session = s;
  onProgress = (downloading) => {
    if (downloading && session === s) deps.broadcast({ session: s.id, final: '', volatile: '', downloading: true });
  };
  try {
    await ensureModel(model);
  } catch (e) {
    if (session === s) session = null;
    throw e;
  }
  if (session !== s) throw new Error('Dictation was stopped before it started.');
  pump(s, deps);
  return { session: s.id, locale: s.language ?? '' };
}

/** A block of 16 kHz mono samples from the preload's capture. */
export function whisperAudio(samples: Float32Array, deps: Deps): void {
  const s = session;
  if (!s || s.stopped) return;
  s.chunks.push(samples);
  s.samples += samples.length;
  if (ready && loaded) pump(s, deps);
}

/** Everything heard: the live pass finishes, and one last pass reads the rest of the stretch. */
export async function stopWhisper(): Promise<string> {
  const s = session;
  if (!s) return '';
  s.stopped = true;
  try {
    await s.decoding;
    if (worker && s.samples > s.segmentStart && s.samples > s.decodedTo) {
      s.volatile = await transcribe(slice(s, s.segmentStart, s.samples), s.language);
    }
    return heard(s);
  } finally {
    if (session === s) session = null;
    keepAlive();
  }
}

export function cancelWhisper(): void {
  if (session) session.stopped = true;
  session = null;
  keepAlive();
}

export function closeWhisper(): void {
  cancelWhisper();
  stopWorker();
}
