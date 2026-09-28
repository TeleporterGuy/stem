// Image generation through the user's ChatGPT subscription — the pure half of
// the `generate_image` bridge tool (stem-mcp-extension.mjs), shared with main.
//
// One image is one Codex Responses call: a short dispatcher turn on a text model
// the ChatGPT account accepts, with the hosted `image_generation` tool attached.
// Verified 2026-09-28: the tool's `model` field is ignored (the server picks the
// image model), and quality/background are not reliably honoured — so neither is
// ever sent. Never pin a model here; the dispatcher model comes from the user's
// own openai-codex model list, like pi-web-access's search model.

import { randomBytes } from 'node:crypto';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const IMAGE_TOOL_NAME = 'generate_image';
export const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];

const AUTH_CLAIM = 'https://api.openai.com/auth';
// Price tiers the dispatcher never needs; the numeric-aware sort keeps gpt-6.10
// ahead of gpt-6.9. Same preference as pi-web-access's search model.
const EXCLUDED_MODEL_SEGMENTS = new Set(['pro', 'ultra']);
const MODEL_PREFERENCE = [(id) => id.includes('terra'), (id) => /^gpt-\d+(\.\d+)?$/.test(id)];

const DISPATCHER_INSTRUCTIONS =
  'You are an image generation dispatcher. Call the image_generation tool exactly once to create the image ' +
  'the user describes; when reference images are attached, use them as the starting point. Do not write code ' +
  'and do not answer in text.';

/** The ChatGPT account id carried in a Codex access token (a JWT). */
export function accountIdFromJwt(token) {
  try {
    const part = String(token).split('.')[1];
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const id = payload && payload[AUTH_CLAIM] && payload[AUTH_CLAIM].chatgpt_account_id;
    return typeof id === 'string' && id.trim() ? id : null;
  } catch {
    return null;
  }
}

/**
 * The dispatcher models to try, best first: the chat's own model when it is an
 * openai-codex one, then the last model that worked, then the account's other
 * openai-codex models by the search-model preference. Only ever openai-codex —
 * the `openai` provider would bill an API key.
 */
export function dispatcherCandidates(ctxModel, available, lastGood) {
  const codex = (available || []).filter((m) => m && m.provider === 'openai-codex' && typeof m.id === 'string');
  const ranked = codex
    .filter((m) => !m.id.split('-').some((s) => EXCLUDED_MODEL_SEGMENTS.has(s)))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  const preferred = [];
  for (const prefers of MODEL_PREFERENCE) preferred.push(...ranked.filter((m) => prefers(m.id)));
  const order = [];
  if (ctxModel && ctxModel.provider === 'openai-codex') order.push(ctxModel);
  if (lastGood) order.push(...codex.filter((m) => m.id === lastGood));
  order.push(...preferred, ...ranked, ...codex);
  const seen = new Set();
  return order.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/** Request body for one image. `refs` are { mimeType, data (base64) }. */
export function buildImageRequest({ model, prompt, size, refs }) {
  const content = [{ type: 'input_text', text: `Generate this image: ${prompt}` }];
  for (const ref of refs || []) {
    content.push({ type: 'input_image', image_url: `data:${ref.mimeType};base64,${ref.data}` });
  }
  const tool = { type: 'image_generation', output_format: 'png' };
  if (size && size !== 'auto') tool.size = size;
  return {
    model,
    store: false,
    stream: true,
    instructions: DISPATCHER_INSTRUCTIONS,
    input: [{ role: 'user', content }],
    tools: [tool],
    tool_choice: 'auto',
    parallel_tool_calls: false
  };
}

export function codexHeaders(token, accountId) {
  return {
    Authorization: `Bearer ${token}`,
    'chatgpt-account-id': accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'pi',
    'content-type': 'application/json',
    accept: 'text/event-stream'
  };
}

/** An error the tool can explain to the model in plain words. */
export class ImageGenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Plain-sentence meaning of a non-200 answer from the Codex endpoint. */
export function httpError(status, body) {
  const text = String(body || '');
  if (status === 400 && /not supported|unsupported model|model/i.test(text)) {
    return new ImageGenError('model_rejected', `The ChatGPT account rejected the dispatcher model: ${text.slice(0, 200)}`);
  }
  if (status === 401 || status === 403) {
    return new ImageGenError('auth', 'The ChatGPT sign-in was not accepted. Ask the user to sign in with ChatGPT again (Settings → Models).');
  }
  if (status === 429 || /usage[_ ]limit|rate[_ ]limit|quota/i.test(text)) {
    return new ImageGenError('limit', "ChatGPT's image limit is reached for now. Tell the user and suggest trying again later.");
  }
  if (/moderation|content_policy|safety/i.test(text)) {
    return new ImageGenError('moderation', 'OpenAI declined to create this image (content policy). Tell the user; do not retry the same prompt.');
  }
  return new ImageGenError('http', `The image service answered ${status}: ${text.slice(0, 200)}`);
}

/**
 * Read the SSE stream of an image request; resolves { b64, revisedPrompt }.
 * Frames may split across chunks. `error` / `response.failed` events reject.
 */
export async function parseImageSse(body) {
  if (!body) throw new ImageGenError('empty', 'The image service sent no response.');
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (frame) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') return null;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return null;
    }
    if (event.type === 'error') {
      throw httpError(0, event.message || event.code || JSON.stringify(event));
    }
    if (event.type === 'response.failed') {
      throw httpError(0, (event.response && event.response.error && event.response.error.message) || 'The image request failed.');
    }
    const item = event.item;
    if (event.type === 'response.output_item.done' && item && item.type === 'image_generation_call') {
      if (!item.result) throw new ImageGenError('empty', 'The image finished without any picture data.');
      return { b64: item.result, revisedPrompt: item.revised_prompt || item.revisedPrompt || undefined };
    }
    return null;
  };
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const hit = handle(frame);
      if (hit) return hit;
    }
  }
  const tail = buffer.trim() ? handle(buffer) : null;
  if (tail) return tail;
  throw new ImageGenError('empty', 'The image service finished without creating an image.');
}

/** Width and height from a PNG's IHDR chunk, or null when it isn't a PNG. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function newImageId() {
  return `img_${randomBytes(5).toString('hex')}`;
}

// A user message's own images get ids through a context block main adds to the
// prompt (stripped from the chat on replay like the other stem context fences).
export const IMAGES_MARKER_RE = /<!--stem:images ids="([^"]*)"-->/;

export function parseImagesMarker(text) {
  const m = typeof text === 'string' ? IMAGES_MARKER_RE.exec(text) : null;
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n')
    : '';
}

function imagesOf(content) {
  return Array.isArray(content) ? content.filter((p) => p && p.type === 'image' && p.data) : [];
}

/** The stemImage record of a generate_image tool result message, or null. */
export function stemImageOf(message) {
  if (!message || message.role !== 'toolResult' || message.toolName !== IMAGE_TOOL_NAME || message.isError) return null;
  const img = message.details && message.details.stemImage;
  return img && typeof img.id === 'string' ? img : null;
}

/**
 * Find an image by id among session entries (or bare messages): a generated one
 * in a generate_image tool result, or a user attachment named by the images
 * marker (ids in attachment order). Returns { mimeType, data } or null.
 */
export function findImageInEntries(entries, id) {
  for (const entry of entries || []) {
    const message = entry && entry.type === 'message' ? entry.message : entry;
    if (!message) continue;
    const gen = stemImageOf(message);
    if (gen && gen.id === id) {
      const img = imagesOf(message.content)[0];
      if (img) return { mimeType: img.mimeType || gen.mime || 'image/png', data: img.data };
    }
    if (message.role === 'user') {
      const ids = parseImagesMarker(textOf(message.content));
      const at = ids.indexOf(id);
      if (at !== -1) {
        const img = imagesOf(message.content)[at];
        if (img) return { mimeType: img.mimeType || 'image/png', data: img.data };
      }
    }
  }
  return null;
}

/** Every image id the entries can resolve, oldest first (for "unknown id" errors). */
export function knownImageIds(entries) {
  const ids = [];
  for (const entry of entries || []) {
    const message = entry && entry.type === 'message' ? entry.message : entry;
    if (!message) continue;
    const gen = stemImageOf(message);
    if (gen) ids.push(gen.id);
    if (message.role === 'user') ids.push(...parseImagesMarker(textOf(message.content)));
  }
  return ids;
}

/**
 * The context the model sees keeps the pixels of only the newest `keep`
 * generated images (plus every one made after the last user message); older
 * ones become a one-line stub. The session file keeps every byte, so an old
 * image stays usable through `references`.
 */
export function stubOldImages(messages, keep = 3) {
  if (!Array.isArray(messages)) return messages;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  const generated = [];
  messages.forEach((m, i) => {
    if (stemImageOf(m) && imagesOf(m.content).length) generated.push(i);
  });
  const keepIdx = new Set(generated.slice(-keep));
  for (const i of generated) if (i > lastUser) keepIdx.add(i);
  let changed = false;
  const out = messages.map((m, i) => {
    if (!generated.includes(i) || keepIdx.has(i)) return m;
    changed = true;
    const id = stemImageOf(m).id;
    const content = m.content.filter((p) => !(p && p.type === 'image'));
    content.push({ type: 'text', text: `[image ${id} — no longer shown; pass "${id}" in generate_image references to use it]` });
    return { ...m, content };
  });
  return changed ? out : messages;
}
