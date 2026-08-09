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

/** The background jobs that carry an effort setting of their own. */
export type BackgroundRole = 'subject' | 'judge' | 'curator';

/**
 * How hard each background job thinks when nobody has said anything at all —
 * neither the job nor Background work above it.
 *
 * Not a pin: it is the last rung of the same chain, so setting Background work
 * still moves every job that hasn't been given a level of its own. What it
 * replaces is the old last rung, "whatever pi picks for the model", which for
 * most models is Medium — real reasoning spent on writing three words off your
 * first line, on every new chat, forever.
 *
 * A subject is extraction, not thought: `off` is the honest level for it, and on
 * a model that has no `off` pi clamps up to its lowest instead of failing. The
 * safety check is the same bargain with a floor under it — it is a judgement
 * about whether a command matches what you asked for, so it thinks a little, and
 * it thinks fast because it stands between you and every command you run.
 * Curation is left alone: it is editorial judgement over a whole library, and
 * the one background role worth the model's full attention.
 */
export const ROLE_EFFORT_FLOOR: Record<BackgroundRole, string | null> = {
  subject: 'off',
  judge: 'low',
  curator: null
};

/**
 * How hard a background job may think: its own level, else the shared Background
 * work one, else the job's floor above.
 *
 * Shared for the same reason the model chain is: the answer is shown as well as
 * used. An effort select left unset says underneath what it comes out as today,
 * and it has to reach the same conclusion the server does.
 */
export function resolveRoleEffort(
  role: BackgroundRole,
  pinned: string | null,
  backgroundEffort: string | null
): string | null {
  return pinned ?? backgroundEffort ?? ROLE_EFFORT_FLOOR[role];
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
