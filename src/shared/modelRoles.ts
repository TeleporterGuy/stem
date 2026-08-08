import type { DefaultsSettings, ExecSettings, ModelSummary } from './types';

/**
 * Which model actually runs each job, when its own setting is left unset.
 *
 * One chain for the background roles: a role's own pin, else the shared
 * background model, else the model you chat with. Memory takes the short version
 * of it — see {@link resolveMemoryModel}. Shared rather than server-only because
 * the answer is shown as well as used — a picker left unset says underneath what
 * it resolves to today, and the renderer has to reach the same conclusion the
 * server does or the note is a lie the moment the two drift.
 */

/**
 * The app-level default model — what "the model you chat with" resolves to. The
 * backend marks it on the model list it publishes, so this is a read, not a
 * second guess at the rule.
 */
export function appDefaultModel(models: ModelSummary[]): string | null {
  return models.find((m) => m.isDefault)?.id ?? null;
}

/**
 * What memory runs on: its own pin, else the model you chat with — skipping the
 * shared background model entirely.
 *
 * Every other background role is one you can safely make cheap. This one reads a
 * whole transcript plus everything already remembered, and a model that cannot
 * hold that doesn't fail loudly; it replies with truncated nonsense and memory
 * stops learning without saying so. Routing it through Background work would
 * mean the one setting whose whole purpose is "make the background cheap" also
 * quietly degrades the one role that can't take it.
 */
export function resolveMemoryModel(pinned: string | null, mainModel: string | null): string | null {
  return pinned ?? mainModel;
}

/**
 * What a background role runs on: its own pin, else the shared background model,
 * else the model you chat with.
 *
 * This used to guess — it scored model NAMES for "haiku", "mini", "flash" and
 * picked the cheapest-looking one of the current provider. pi's catalog carries
 * no price, tier or size, so that was the only signal available, and it was a
 * bad one: it happily picked a mini variant over a newer small model that was
 * both cheaper and better, and every catalog change was a fresh chance to be
 * wrong. Stem now says what it is doing instead of guessing, and Settings →
 * Models offers one place to point every background job at a cheaper model on
 * purpose.
 */
export function resolveBackgroundModel(
  pinned: string | null,
  backgroundModel: string | null,
  mainModel: string | null
): string | null {
  return pinned ?? backgroundModel ?? mainModel;
}

/**
 * Resolve the judge model for the command safety check.
 *
 * Falls back through the same chain as every other background role, and only
 * then to a model we know is signed in: passing null on to complete() would use
 * its built-in constant, which fails with "No API key" for anyone signed in to a
 * single other provider.
 */
export function resolveJudgeModel(
  settings: Pick<ExecSettings, 'judgeModel'>,
  defaults: Pick<DefaultsSettings, 'backgroundModel'>,
  models: ModelSummary[],
  currentModel: string | null
): string | null {
  return (
    resolveBackgroundModel(settings.judgeModel, defaults.backgroundModel, currentModel) ??
    appDefaultModel(models) ??
    models[0]?.id ??
    null
  );
}
