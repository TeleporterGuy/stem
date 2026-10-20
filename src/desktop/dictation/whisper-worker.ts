// Utility-process entry for dictation off the Mac: Whisper through
// transformers.js on onnxruntime-node's CPU provider, the same stack the
// recall embedder runs (server/recall/embed-worker.ts). A process of its own
// so a decode never stalls the main process, and so its memory goes away with
// it. Talks to desktop/dictation/whisper.ts over process.parentPort.
//
// This file must stay free of Electron imports beyond the ambient parentPort.

export interface WhisperModelSpec {
  /** HF repo with transformers.js-compatible ONNX weights. */
  repo: string;
  encoder: 'q4' | 'q8' | 'fp16' | 'fp32';
  decoder: 'q4' | 'q8' | 'fp16' | 'fp32';
}

export type WhisperInMessage =
  | { type: 'load'; spec: WhisperModelSpec; cacheDir: string }
  | { type: 'transcribe'; id: number; audio: Float32Array; language: string | null };

export type WhisperOutMessage =
  | { type: 'progress'; downloading: boolean }
  | { type: 'ready' }
  | { type: 'load-failed'; error: string }
  | { type: 'text'; id: number; text: string }
  | { type: 'failed'; id: number; error: string };

type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

const port = process.parentPort as NonNullable<typeof process.parentPort>;
let asr: Asr | null = null;

const post = (m: WhisperOutMessage): void => port.postMessage(m);

async function load(spec: WhisperModelSpec, cacheDir: string): Promise<void> {
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    let announced = false;
    asr = (await pipeline('automatic-speech-recognition', spec.repo, {
      dtype: { encoder_model: spec.encoder, decoder_model_merged: spec.decoder },
      // A file being fetched (not read from the cache) means a first use: say so once.
      progress_callback: (p: { status?: string }) => {
        if (!announced && p.status === 'download') {
          announced = true;
          post({ type: 'progress', downloading: true });
        }
      }
    })) as unknown as Asr;
    post({ type: 'ready' });
  } catch (e) {
    post({ type: 'load-failed', error: e instanceof Error ? e.message : String(e) });
  }
}

async function transcribe(id: number, audio: Float32Array, language: string | null): Promise<void> {
  if (!asr) {
    post({ type: 'failed', id, error: 'The speech model is not loaded.' });
    return;
  }
  try {
    const out = await asr(audio, {
      task: 'transcribe',
      // Null lets Whisper tell the language from the speech.
      ...(language ? { language } : {}),
      chunk_length_s: 30,
      return_timestamps: false
    });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    post({ type: 'text', id, text });
  } catch (e) {
    post({ type: 'failed', id, error: e instanceof Error ? e.message : String(e) });
  }
}

port.on('message', (event: { data: WhisperInMessage }) => {
  const m = event.data;
  if (m.type === 'load') void load(m.spec, m.cacheDir);
  else if (m.type === 'transcribe') void transcribe(m.id, m.audio, m.language);
});
