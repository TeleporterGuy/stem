import { useEffect, useState } from 'react';
import { Wand2, RefreshCw } from 'lucide-react';
import type {
  ModelSummary,
  SkillSummary
} from '../../../shared/types';
import { ModelPicker } from '../../ui/ModelPicker';
import { holdFullSpin } from './shared';

export function SkillsTab({ models }: { models: ModelSummary[] }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [tidying, setTidying] = useState(false);
  const [collecting, setCollecting] = useState(false);
  // null => use the backend default model for the curator.
  const [curatorModel, setCuratorModel] = useState<string | null>(null);
  useEffect(() => {
    window.stem.listSkills().then(setSkills);
    window.stem.getSettings().then((s) => setCuratorModel(s.skills.model));
    // Refresh when the assistant auto-creates/patches a skill or the curator runs.
    return window.stem.onSkillsChanged(() => {
      window.stem.listSkills().then(setSkills);
    });
  }, []);

  function selectCuratorModel(id: string | null) {
    setCuratorModel(id);
    window.stem.updateSkillsSettings({ model: id }).then((s) => setCuratorModel(s.skills.model));
  }

  async function toggle(slug: string, enabled: boolean) {
    setSkills(await window.stem.setSkillEnabled(slug, enabled));
  }

  async function tidy() {
    setTidying(true);
    try {
      setSkills(await holdFullSpin(window.stem.curateSkills()));
    } finally {
      setTidying(false);
    }
  }

  // "Collect now": rerun the skill distiller over the whole chat backlog (not just
  // a list refresh) — the returned list already reflects anything it wrote.
  async function collect() {
    setCollecting(true);
    try {
      setSkills(await holdFullSpin(window.stem.distillSkillsNow()));
    } finally {
      setCollecting(false);
    }
  }

  // Stem auto-authors and tidies skills; a manual "Tidy up" runs the curator now.
  const hasAgentSkills = skills.some((s) => s.source === 'agent');

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
          <button
            className="link-btn icon-only"
            onClick={collect}
            disabled={collecting}
            data-label={collecting ? 'Collecting…' : 'Collect now'}
            aria-label="Scan recent chats for new skills now"
          >
            <RefreshCw size={15} className={collecting ? 'spin' : undefined} />
          </button>
        </span>
      </div>
      {skills.length === 0 ? (
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

      <div className="grp-head">Curator model</div>
      <div className="formgroup">
        <ModelPicker
          models={models}
          value={curatorModel}
          onChange={selectCuratorModel}
          emptyLabel="Default (recommended)"
          ariaLabel="Skills curator model"
        />
        <p className="muted">
          Runs the background skills curator — merging duplicate skills, sharpening sloppy ones, and
          archiving stale ones. Separate from the memory model so you can give curation a stronger
          model. New skills are still written by the model you chat with; this only affects upkeep.
        </p>
      </div>
    </div>
  );
}
