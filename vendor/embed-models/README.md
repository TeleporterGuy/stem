# Bundled embedding models

Stem’s local memory search loads ONNX weights through transformers.js. On a
machine that can reach [Hugging Face](https://huggingface.co) they download
once into the app data folder (`embed-models/`). On a machine that cannot
(typical company laptop), copy this folder from a machine that already has
them — Stem will load from here and will not call the Hub.

GitHub rejects files over 100 MB, so the `.onnx` files are **not** in git.
Copy the directory itself (USB, OneDrive, a zip next to the clone).

## What to copy

From a Stem that has already downloaded models:

| OS | Source |
|---|---|
| macOS | `~/Library/Application Support/Stem/embed-models/` |
| Windows | `%APPDATA%\Stem\embed-models\` |
| Linux | `~/.config/Stem/embed-models/` |

Drop the contents here so the layout looks like:

```
vendor/embed-models/
  Xenova/multilingual-e5-small/onnx/model_quantized.onnx
  onnx-community/bge-reranker-v2-m3-ONNX/onnx/model_quantized.onnx
  …
```

Or from the repo root on the machine that already has a cache:

```bash
node scripts/vendor-embed-models.mjs
```

The default embedder is ~120 MB; the default reranker is ~570 MB. Copy at
least `Xenova/multilingual-e5-small` or the Memory tab stays on keyword search.

After copying, restart Stem. Hugging Face is not required.
