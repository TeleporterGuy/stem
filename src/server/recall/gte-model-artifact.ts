/**
 * The "Stem GTE Memory" choice in the model picker. Stored in settings, so it
 * stays fixed across model releases; the weights behind it are pinned below.
 */
export const GTE_FACT_PILOT_ID = 'gte-memory-20260905-epoch2';
/**
 * The release those weights come from, and the folder they download into. A
 * new release gets a new folder, so a half-finished download never mixes two
 * releases' files; the previous folder is pruned (recall/retired-models.ts).
 * 20261021 continues the September epoch2 weights with skill-selection
 * training, holding fact scores to epoch2 (Hub model card; docs/gte-memory-pilot.md).
 */
export const GTE_MODEL_VERSION = 'gte-memory-20261021';
export const GTE_MODEL_REPO = 'join3r/stem-gte-memory';
export const GTE_MODEL_REVISION = '57a55b5ab5ec0532d21405489ef0f61d6edbcd45';

export interface GteModelArtifact {
  repo: string;
  revision: string;
  files: Readonly<Record<string, { sha256: string; size: number }>>;
}

export const GTE_MODEL_ARTIFACT: GteModelArtifact = {
  repo: GTE_MODEL_REPO,
  revision: GTE_MODEL_REVISION,
  files: {
    'config.json': { sha256: '01a3c997ee3f9ebdf250fa01086487f336ce573a46ad24cbb0a249e22eaf98b6', size: 1586 },
    'tokenizer.json': { sha256: '3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20', size: 17082734 },
    'tokenizer_config.json': { sha256: '6f00514620aff01ba8b7291b2394e98daca5be264cb743805232d9ae27494b2a', size: 1340 },
    'special_tokens_map.json': { sha256: '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835', size: 964 },
    'onnx/model_quantized.onnx': { sha256: '1e88d816d1cefef69a7b43df3bb2dabdb92a21b0e3ce92cd6ceb0e753fcda74f', size: 341032790 },
    'LICENSE': { sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', size: 11358 },
    'NOTICE': { sha256: '8d7ae557f6eb6160b731cc353d4360c27caf87cf997542a177491e9085e86ff6', size: 2154 }
  }
};

export const GTE_FACT_PILOT_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GTE_MODEL_ARTIFACT.files)
    .filter(([file]) => file !== 'LICENSE' && file !== 'NOTICE')
    .map(([file, { sha256 }]) => [file, sha256])
);
