import type { ModelSummary } from '../../shared/types';
import { EFFORT_LABELS } from '../modelLabels';

/** The reasoning levels a model offers, or none for a model that doesn't reason. */
export function effortsOf(models: ModelSummary[], resolved: string | null): string[] {
  return (resolved ? models.find((m) => m.id === resolved)?.supportedEfforts : undefined) ?? [];
}

/**
 * Drop an effort the resolved model cannot do.
 *
 * Levels are per-model, so one carried over from a previous pick is a setting
 * that reads as chosen and silently isn't — pi rejects it and the job runs at
 * the model's own default anyway. Clearing it says so.
 */
export function clampEffort(
  models: ModelSummary[],
  resolved: string | null,
  effort: string | null
): string | null {
  return effort && effortsOf(models, resolved).includes(effort) ? effort : null;
}

/**
 * How hard a background role may think, next to the model it will think with.
 *
 * A select rather than the segmented control the composer uses: this one carries
 * an extra option the composer has no need for — the empty one, meaning don't
 * specify at all — and six segments would not survive the 320px rail.
 *
 * `emptyLabel` names what that empty option actually falls through to, which
 * differs by role and is the whole point of the row: Background work has nothing
 * above it, so unset means "Model default", while the roles that follow it are
 * saying "Background work" instead. Naming both "Model default" would claim the
 * jobs under it ignore the level set one block up, which is the opposite of true.
 *
 * Hidden entirely for a model that doesn't reason, since there is nothing to
 * choose. A level saved against some earlier model still shows even when the
 * current one can't do it, because a setting you can see is one you can clear.
 */
export function EffortSelect({
  label,
  value,
  efforts,
  emptyLabel = 'Model default',
  onChange
}: {
  label: string;
  value: string | null;
  efforts: string[];
  emptyLabel?: string;
  onChange: (effort: string | null) => void;
}) {
  if (efforts.length === 0 && !value) return null;
  const orphaned = value && !efforts.includes(value) ? value : null;
  return (
    <label className="mp-effort">
      <span>Effort</span>
      <select
        className="ifield"
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{emptyLabel}</option>
        {efforts.map((e) => (
          <option key={e} value={e}>
            {EFFORT_LABELS[e] ?? e}
          </option>
        ))}
        {orphaned && (
          <option value={orphaned}>{EFFORT_LABELS[orphaned] ?? orphaned} — not on this model</option>
        )}
      </select>
    </label>
  );
}
