import { useEffect, useState } from 'react';
import { Wand2 } from 'lucide-react';
import type {
  DefaultsSettings,
  ModelSummary,
  SkillsMode,
  SkillSummary
} from '../../../shared/types';
import { useOffline } from '../../hooks/useServerReachable';
import { InfoTip } from '../../ui/InfoTip';
import { appDefaultModel, resolveSkillsModel } from '../../../shared/modelRoles';
import { ModelPicker } from '../../ui/ModelPicker';
import { createJobStore, holdFullSpin, useJob } from './shared';

// Module-level so a running tidy pass survives the tab unmounting: leave for
// another tab mid-run and come back, and the button is still spinning — and the
// outcome message still lands — instead of the pass silently vanishing.
const tidyJob = createJobStore();

export function SkillsTab({ models }: { models: ModelSummary[] }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  // Skills live on the server. With it unreachable this list is empty because we
  // could not ask, which is not the same thing as having none — and "No skills
  // yet" is a sentence that would quietly tell someone their skills are gone.
  const offline = useOffline();
  const { running: tidying, msg: tidyMsg } = useJob(tidyJob);
  // null => skills work follows the model you chat with (see Settings → Models).
  const [skillsModel, setSkillsModel] = useState<string | null>(null);
  const [mode, setMode] = useState<SkillsMode>('ask');
  // What "Same as main" resolves to — the model you chat with.
  const [defaults, setDefaults] = useState<DefaultsSettings>({
    model: null,
    backgroundModel: null,
    backgroundEffort: null
  });
  useEffect(() => {
    window.stem.getSettings().then((s) => {
      setSkillsModel(s.skills.model);
      setMode(s.skills.mode);
      setDefaults(s.defaults);
    });
    // Refresh when the assistant auto-creates/patches a skill or the curator runs.
    return window.stem.onSkillsChanged(() => {
      window.stem.listSkills().then(setSkills);
    });
  }, []);
  // The list load rides the tidy flag rather than mount alone: a pass that ends
  // while this tab is away has no component to hand its result to, so re-read
  // when the flag drops. (Runs on mount too, whatever the flag says — that is
  // the initial load.)
  useEffect(() => {
    window.stem.listSkills().then(setSkills);
  }, [tidying]);

  function selectSkillsModel(id: string | null) {
    setSkillsModel(id);
    window.stem.updateSkillsSettings({ model: id }).then((s) => setSkillsModel(s.skills.model));
  }

  function selectMode(next: SkillsMode) {
    setMode(next);
    window.stem.updateSkillsSettings({ mode: next }).then((s) => setMode(s.skills.mode));
  }

  async function toggle(slug: string, enabled: boolean) {
    setSkills(await window.stem.setSkillEnabled(slug, enabled));
  }

  function tidy() {
    tidyJob.start(async () => {
      try {
        const r = await holdFullSpin(window.stem.curateSkills());
        // A pass that merged nothing and one that merged three both end with the
        // list simply redrawn, so say which happened — otherwise the only way to
        // tell is to have memorised the library beforehand.
        // "90 days" is ARCHIVE_AFTER_DAYS in server/skills/lifecycle.ts, spelled out
        // here rather than plumbed through IPC: it is a sentence, not a setting.
        const retired = r.expired ? `, retired ${r.expired} unused >90 days` : '';
        return r.merged + r.archived + r.expired === 0
          ? 'No duplicate or stale skills found'
          : `Merged ${r.merged}, archived ${r.archived}${retired} — archived skills stay on disk and can be switched back on above.`;
      } catch {
        return 'Tidy up failed — try again.';
      }
    });
  }

  // There is no "Collect now" button: nothing accumulates to collect. Skills are
  // written at the end of the turn that earned them, so the only manual action
  // left here is the curator's "Tidy up".
  const hasAgentSkills = skills.some((s) => s.source === 'agent');

  // "Jun 12", with the year added once it isn't this year's date.
  function formatDay(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  function usageLabel(s: SkillSummary): string {
    if (!s.useCount) return 'never used';
    const day = s.lastUsedAt ? formatDay(s.lastUsedAt) : '';
    return `used ${s.useCount}×${day ? ` · last ${day}` : ''}`;
  }

  return (
    <div>
      <div className="grp-head with-actions">
        Skills
        <span className="memory-view-actions">
          {hasAgentSkills && (
            <button
              className="link-btn icon-only"
              onClick={tidy}
              disabled={tidying}
              data-label={tidying ? 'Tidying…' : 'Tidy up'}
              aria-label="Tidy up: merge duplicates and archive stale auto-created skills"
            >
              <Wand2 size={15} className={tidying ? 'spin' : undefined} />
            </button>
          )}
        </span>
      </div>
      {tidyMsg && <p className="muted">{tidyMsg}</p>}
      {skills.length === 0 && offline ? (
        <p className="muted">Your skills live on Stem’s server, which can’t be reached right now.</p>
      ) : skills.length === 0 ? (
        <p className="muted">No skills yet. Stem saves reusable procedures it works out, or you can drop a SKILL.md folder into the skills directory.</p>
      ) : (
        <div className="group">
          {skills.map((s) => (
            <div key={s.slug} className="group-row">
              <span className="row-main">
                <strong>
                  {s.name}
                  {s.source === 'agent' && (
                    <span className="muted" style={{ marginLeft: 6, fontWeight: 400, fontSize: '0.8em' }}>
                      auto{s.version && s.version > 1 ? ` · v${s.version}` : ''}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 6, fontWeight: 400, fontSize: '0.8em' }}>
                    {usageLabel(s)}
                  </span>
                </strong>
                <em>{s.description}</em>
              </span>
              <button
                className={`switch${s.enabled ? ' on' : ''}`}
                role="switch"
                aria-checked={s.enabled}
                aria-label={s.name}
                onClick={() => toggle(s.slug, !s.enabled)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="grp-head grp-head-row">
        Saving skills
        <InfoTip label="About saving skills">
          <strong>Only when I ask</strong> — Stem never saves a skill on its own. It can still
          suggest one in its reply, and it saves it if you say yes. <strong>Ask first</strong> —
          Stem proposes a skill and you approve it in a card. <strong>Save automatically</strong> —
          Stem saves what it learns and tells you here.
        </InfoTip>
      </div>
      <div className="formgroup">
        <div className="seg-ctl">
          <button className={mode === 'off' ? 'active' : ''} onClick={() => selectMode('off')}>
            Only when I ask
          </button>
          <button className={mode === 'ask' ? 'active' : ''} onClick={() => selectMode('ask')}>
            Ask first
          </button>
          <button className={mode === 'auto' ? 'active' : ''} onClick={() => selectMode('auto')}>
            Save automatically
          </button>
        </div>
        {/* The part people read the wrong way round: all three values constrain
            Stem's own initiative, never a request the user made out loud. */}
        <p className="muted">
          Asking Stem to save a skill always works, whichever of these you pick — the setting only
          limits what Stem does unprompted.
        </p>
      </div>

      <div className="grp-head grp-head-row">
        Skills model
        <InfoTip label="About the skills model">
          Does all the model-driven skills work: writes a new skill (or improves an existing one)
          after a turn that earned it, handles /learn, and runs the tidy-up pass that merges
          duplicates. Writing a skill is judgment work, so left unset it follows the model you chat
          with — never the cheap Quick tasks model. Retiring skills unused for 90 days is a plain
          clock and uses no model.
        </InfoTip>
      </div>
      <div className="formgroup">
        <ModelPicker
          models={models}
          value={skillsModel}
          onChange={selectSkillsModel}
          emptyLabel="Same as main"
          ariaLabel="Skills model"
          resolvedDefault={resolveSkillsModel(null, defaults.model ?? appDefaultModel(models))}
        />
      </div>
    </div>
  );
}
