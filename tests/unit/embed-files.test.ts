import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubAccessForLoad, pathAppearsInMessage, weightsFile, weightsPresent } from '../../src/server/recall/embed-files';

const REPO = 'Xenova/multilingual-e5-small';

function cacheWithWeights(root: string, repo = REPO): void {
  const dir = join(root, repo, 'onnx');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model_quantized.onnx'), 'fake');
}

describe('embed local files', () => {
  it('names the transformers.js weights file per dtype', () => {
    expect(weightsFile('q8')).toBe('model_quantized.onnx');
    expect(weightsFile('q4')).toBe('model_q4.onnx');
    expect(weightsFile('fp32')).toBe('model.onnx');
  });

  it('finds a cached q8 model and stays offline', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stem-embed-cache-'));
    cacheWithWeights(cacheDir);
    expect(weightsPresent(cacheDir, REPO, 'q8')).toBe(true);
    expect(hubAccessForLoad({ cacheDir, repo: REPO, dtype: 'q8' })).toEqual({
      allowRemoteModels: false,
      localModelPath: null
    });
  });

  it('uses the vendor dir and stays offline when the clone shipped weights', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stem-embed-empty-'));
    const bundledDir = mkdtempSync(join(tmpdir(), 'stem-embed-vendor-'));
    cacheWithWeights(bundledDir);
    expect(hubAccessForLoad({ cacheDir, bundledDir, repo: REPO, dtype: 'q8' })).toEqual({
      allowRemoteModels: false,
      localModelPath: bundledDir
    });
  });

  it('allows Hugging Face when neither cache nor vendor has weights', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'stem-embed-miss-'));
    expect(hubAccessForLoad({ cacheDir, bundledDir: cacheDir, repo: REPO, dtype: 'q8' })).toEqual({
      allowRemoteModels: true,
      localModelPath: null
    });
  });

  it('matches ONNX error paths with either slash', () => {
    const win = 'C:\\Users\\me\\AppData\\Roaming\\Stem\\embed-models\\Xenova\\multilingual-e5-small';
    const unixish = 'C:/Users/me/AppData/Roaming/Stem/embed-models/Xenova/multilingual-e5-small/onnx/model.onnx';
    expect(pathAppearsInMessage(unixish, win)).toBe(true);
    expect(pathAppearsInMessage('Protobuf parsing failed: ' + win, win)).toBe(true);
    expect(pathAppearsInMessage('other model', win)).toBe(false);
  });
});
