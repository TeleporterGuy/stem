import type {
  ModelSummary
} from '../../../shared/types';
import { FactsTab } from './FactsTab';
import { EpisodicTab } from './EpisodicTab';
import { useRememberedTab } from '../../hooks/useRememberedTab';
import type { ActiveFactsViewProps } from './shared';

const SUBS = ['facts', 'recall'] as const;

// Memory lives under the Brain icon as two sub-tabs: durable facts (Level 1) and
// the episodic recall store (Level 2, shown as metadata only — it's searched, not
// browsed). Mirrors the MCP + Skills sub-tab pattern below.
export function MemoryTab({ models, activeFacts }: { models: ModelSummary[]; activeFacts: ActiveFactsViewProps }) {
  const [sub, setSub] = useRememberedTab('stem.memory.sub', SUBS, 'facts');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'facts' ? 'active' : ''} onClick={() => setSub('facts')}>
          Facts
        </button>
        <button className={sub === 'recall' ? 'active' : ''} onClick={() => setSub('recall')}>
          Recall
        </button>
      </div>
      {sub === 'facts' ? <FactsTab models={models} activeFacts={activeFacts} /> : <EpisodicTab />}
    </div>
  );
}
