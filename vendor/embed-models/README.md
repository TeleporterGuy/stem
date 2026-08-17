# Bundled embedding models

Stem’s local memory search loads ONNX weights through transformers.js. On a
machine that can reach [Hugging Face](https://huggingface.co) they download
once into the app data folder (`embed-models/`). GitHub rejects files over
100 MB (and warns above 50 MB), so the default embedder is committed here
**gzipped and split into 45 MB parts**. Stem unpacks them into the app cache
on first launch and does not call the Hub when those files are present.

The default reranker is ~570 MB even compressed, so it is not in git — it
still downloads from Hugging Face when the network allows it.

## What is committed

```
vendor/embed-models/
  Xenova/multilingual-e5-small/config.json
  Xenova/multilingual-e5-small/tokenizer.json.gz
  Xenova/multilingual-e5-small/tokenizer_config.json
  Xenova/multilingual-e5-small/onnx/model_quantized.onnx.gz.00
  Xenova/multilingual-e5-small/onnx/model_quantized.onnx.gz.01
```

Rebuild the packs from a machine that already has a Stem cache:

```bash
npm run vendor:embed-models
```
