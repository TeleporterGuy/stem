// The effort row in Settings → Models: which levels it offers, what the empty
// option promises, and when it refuses to appear at all.
//
// Rendered with react-dom/server rather than driven, because everything worth
// asserting here is in the markup — the option list IS the contract. The bugs
// this guards are all the quiet kind: a level offered on a model that cannot do
// it (pi clamps it and the job runs at some other depth, while the setting reads
// as chosen), an empty option that names the wrong fallback, and a saved level
// that becomes unreachable because the control hid itself.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelSummary } from '../../src/shared/types';
import { clampEffort, effectiveEffort, EffortSelect, effortsOf } from '../../src/renderer/ui/EffortSelect';

function model(id: string, supportedEfforts: string[]): ModelSummary {
  return {
    id,
    displayName: id,
    description: 'test',
    provider: 'test',
    providerName: 'Test',
    supportedEfforts,
    defaultEffort: supportedEfforts[0] ?? 'medium',
    serviceTiers: [],
    isDefault: false
  };
}

const MODELS = [model('x/thinker', ['off', 'low', 'medium', 'high']), model('x/plain', [])];

/** The option list as [value, label] pairs, in the order the select shows them. */
function options(html: string): Array<[string, string]> {
  return [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
}

describe('effortsOf / clampEffort', () => {
  it('answers with the resolved model’s levels, and nothing for one that does not reason', () => {
    expect(effortsOf(MODELS, 'x/thinker')).toEqual(['off', 'low', 'medium', 'high']);
    expect(effortsOf(MODELS, 'x/plain')).toEqual([]);
    // A role resolving to nothing (unpinned, no fallback yet) and one naming a
    // model that has since left the catalog both answer the same way: no levels
    // to offer, rather than a stale list from whoever asked last.
    expect(effortsOf(MODELS, null)).toEqual([]);
    expect(effortsOf(MODELS, 'x/uninstalled')).toEqual([]);
  });

  it('drops a level the newly-chosen model cannot do', () => {
    // Switching a role's model must not leave a level behind that pi will refuse:
    // the job would run at the model's own depth while the setting claimed
    // otherwise, which is the exact failure the row exists to prevent.
    expect(clampEffort(MODELS, 'x/thinker', 'high')).toBe('high');
    expect(clampEffort(MODELS, 'x/thinker', 'xhigh')).toBeNull();
    expect(clampEffort(MODELS, 'x/plain', 'high')).toBeNull();
    expect(clampEffort(MODELS, 'x/thinker', null)).toBeNull();
  });
});

describe('effectiveEffort', () => {
  it('answers with the level pi will actually land on', () => {
    // A floor is chosen for a JOB, not for a model, so the model it lands on may
    // not have it — and pi clamps to the nearest level at or above the one asked
    // for rather than refusing. Reporting the asked-for level would make the note
    // wrong in precisely the case it exists for.
    expect(effectiveEffort(['off', 'low', 'high'], 'low')).toBe('low');
    expect(effectiveEffort(['low', 'medium', 'high'], 'off')).toBe('low');
    expect(effectiveEffort(['off', 'low'], 'high')).toBe('low');
    // Nothing to clamp against, and nothing asked for.
    expect(effectiveEffort([], 'off')).toBe('off');
    expect(effectiveEffort(['low'], null)).toBeNull();
  });
});

describe('EffortSelect', () => {
  it('offers the model’s levels under an empty option that names what it falls back to', () => {
    // Quick tasks has nothing above it, so unset means the model's own
    // default; the roles under it are following Quick tasks, and saying
    // "Model default" there would claim they ignore the level set one block up.
    const group = renderToStaticMarkup(
      createElement(EffortSelect, {
        label: 'Quick tasks effort',
        value: null,
        efforts: ['off', 'low', 'medium', 'high'],
        onChange: () => undefined
      })
    );
    expect(options(group)).toEqual([
      ['', 'Model default'],
      ['off', 'Off'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High']
    ]);

    const role = renderToStaticMarkup(
      createElement(EffortSelect, {
        label: 'Safety-check effort',
        value: null,
        efforts: ['low'],
        emptyLabel: 'Quick tasks',
        onChange: () => undefined
      })
    );
    expect(options(role)[0]).toEqual(['', 'Quick tasks']);
  });

  it('keeps showing a saved level the current model cannot do, marked as such', () => {
    // A setting you can see is one you can clear. Hiding it would strand the
    // value in settings.json with no way to reach it from the app.
    const html = renderToStaticMarkup(
      createElement(EffortSelect, {
        label: 'Skills effort',
        value: 'xhigh',
        efforts: ['low', 'medium'],
        emptyLabel: 'Quick tasks',
        onChange: () => undefined
      })
    );
    expect(options(html)).toContainEqual(['xhigh', 'X-High — not on this model']);
    expect(html).toContain('selected');
  });

  it('says what the empty option comes out as, and only while it is the choice', () => {
    // The cheap defaults are invisible otherwise: "Quick tasks" is itself
    // unset out of the box, so the row would name a rung and stop, leaving the
    // reader to walk the chain to find that subjects run with reasoning off.
    const render = (value: string | null, resolved: string | null): string =>
      renderToStaticMarkup(
        createElement(EffortSelect, {
          label: 'Subject effort',
          value,
          efforts: ['off', 'low', 'medium'],
          emptyLabel: 'Quick tasks',
          resolved,
          onChange: () => undefined
        })
      );
    expect(render(null, 'off')).toContain('uses Off');
    // A role with no floor of its own lands on the model's own depth, and says so
    // rather than going quiet, which would read as "nothing happens here".
    expect(render(null, null)).toContain('uses the model’s own default');
    // Chosen level: the select itself is the answer, so the line would only
    // repeat it — or, worse, contradict it while the save is in flight.
    expect(render('medium', 'off')).not.toContain('uses');
  });

  it('renders nothing at all for a model that does not reason', () => {
    expect(
      renderToStaticMarkup(
        createElement(EffortSelect, {
          label: 'Subject effort',
          value: null,
          efforts: [],
          emptyLabel: 'Quick tasks',
          onChange: () => undefined
        })
      )
    ).toBe('');
  });
});
