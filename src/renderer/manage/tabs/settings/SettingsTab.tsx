import { useEffect, useRef } from 'react';
import { useRetrievalHealth } from '../../../hooks/useRetrievalHealth';
import { useRememberedTab } from '../../../hooks/useRememberedTab';
import { AppSettings } from './AppSettings';
import { FeaturesSettings } from './FeaturesSettings';
import { ServerSettings } from './ServerSettings';
import { ModelsSettings } from './ModelsSettings';
import type { ModelTabProps } from '../shared';
import { useManageIntent } from '../../intents';

/**
 * Settings, as four sub-tabs rather than one very long scroll.
 *
 * Ordered by how often you would want to change something: App is using Stem
 * day to day (the conversation, its look, keys, notifications), Features is
 * what it may do beyond answering (mail, commands, coding agents, computer
 * control), Server and Models are setup you do once and then forget. Only one sub-tab is mounted at a time, so
 * each loads the slice of settings it actually shows — cheap, and it means a
 * change made in another window is picked up simply by coming back.
 */
type Sub = 'app' | 'features' | 'server' | 'models';

const SUBS: { id: Sub; label: string }[] = [
  { id: 'app', label: 'App' },
  { id: 'features', label: 'Features' },
  { id: 'server', label: 'Server' },
  { id: 'models', label: 'Models' }
];

const SUB_IDS = SUBS.map((s) => s.id);

export function SettingsTab({
  models,
  modelId,
  onSelectModel,
  deadProvider,
  recallFocus
}: ModelTabProps & {
  deadProvider?: string | null;
  /** Bumped by the Memory tab's Review setup: land on Models with Memory recall open. */
  recallFocus?: number;
}) {
  // A new key since the Chat/App → App/Features rename (2026-09-27): under the
  // old one a remembered 'app' would now open Features.
  const [sub, setSub] = useRememberedTab<Sub>('stem.settings.tab', SUB_IDS, 'app');

  // A provider whose credential died is the one reason Settings gets opened
  // without being asked for — the rail grows a red dot and you click it. Landing
  // on the remembered sub-tab would hide the thing the dot is about, so a dead
  // sign-in pulls the panel to Models. Once, on the transition: reselecting
  // it every render would make the other sub-tabs unreachable until it's fixed.
  // An explicit jump (Quick Chat's browser-control Set up) is not undone by a
  // dead sign-in reported a moment after the panel opened.
  const askedAt = useRef(0);
  useEffect(() => {
    if (deadProvider && Date.now() - askedAt.current > 3_000) setSub('models');
  }, [deadProvider, setSub]);

  useEffect(() => {
    if (recallFocus) setSub('models');
  }, [recallFocus, setSub]);

  // Quick Chat's "Set up browser control" lands in Features. After the two
  // above: on a fresh mount theirs run too, and an explicit ask wins.
  useManageIntent(
    'browser-control',
    () => {
      askedAt.current = Date.now();
      setSub('features');
    },
    false
  );

  // The recall models live under Models now, so a failed one marks that segment
  // the way a dead sign-in does (the Memory rail keeps its own dot and banner).
  const retrievalBroken = useRetrievalHealth().broken;

  return (
    <div>
      <div className="seg-ctl">
        {SUBS.map(({ id, label }) => (
          <button key={id} className={sub === id ? 'active' : ''} onClick={() => setSub(id)}>
            {label}
            {id === 'models' && (deadProvider || retrievalBroken) && <span className="seg-alert-dot" />}
          </button>
        ))}
      </div>
      {sub === 'app' && <AppSettings models={models} />}
      {sub === 'features' && <FeaturesSettings />}
      {sub === 'server' && <ServerSettings />}
      {sub === 'models' && (
        <ModelsSettings
          models={models}
          modelId={modelId}
          onSelectModel={onSelectModel}
          deadProvider={deadProvider}
          recallFocus={recallFocus}
        />
      )}
    </div>
  );
}
