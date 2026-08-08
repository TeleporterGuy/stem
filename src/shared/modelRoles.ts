import type { ExecSettings, ModelSummary } from './types';

/**
 * Which model actually runs each job, when the setting for it says "default".
 *
 * Shared rather than server-only because the answer is now shown, not just used:
 * a picker sitting on "Default (recommended)" tells you underneath which model
 * that is today. The renderer must reach the same conclusion the server does, or
 * the note is a lie the moment the two drift.
 */

// Cheap-model markers, in preference order, for the auto judge pick. Names only —
// ModelSummary carries no price or tier, so this is the whole signal there is.
const CHEAP_MARKERS = ['haiku', 'mini', 'nano', 'flash', 'lite', 'spark', 'fast', 'small', 'turbo'];

/**
 * The app-level default model — what a `null` model setting resolves to for the
 * background jobs (memory, skills curation, chat subjects). The backend marks it
 * on the model list it publishes, so this is a read, not a second guess at the
 * rule.
 */
export function appDefaultModel(models: ModelSummary[]): string | null {
  return models.find((m) => m.isDefault)?.id ?? null;
}

/**
 * Resolve the judge model: the explicit setting wins; otherwise the
 * cheapest-looking model of the current provider (Anthropic → Haiku-class, etc.).
 *
 * When that provider publishes no cheap-tier name, fall back to a model we know
 * is signed in rather than null: null makes complete() use its built-in
 * openai-codex default, which fails with "No API key" for anyone signed in only
 * to another provider. The judge then runs on the chat's own model — correct but
 * not cheap, which is why Settings says so rather than promising "cheapest".
 */
export function resolveJudgeModel(
  settings: Pick<ExecSettings, 'judgeModel'>,
  models: ModelSummary[],
  currentModel: string | null
): string | null {
  if (settings.judgeModel) return settings.judgeModel;
  const provider = currentModel?.split('/')[0] ?? models.find((m) => m.isDefault)?.provider ?? null;
  const pool = provider ? models.filter((m) => m.provider === provider) : models;
  for (const marker of CHEAP_MARKERS) {
    const hit = pool.find((m) => m.id.toLowerCase().includes(marker));
    if (hit) return hit.id;
  }
  // `provider` is derived from currentModel whenever there is one, so this is
  // already a same-provider pick; pool/models only matter when there is not.
  return currentModel ?? pool.find((m) => m.isDefault)?.id ?? pool[0]?.id ?? null;
}
