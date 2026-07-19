import { useState } from 'react';
import type {
  ModelSummary
} from '../../../shared/types';
import { FactsTab } from './FactsTab';
import { EpisodicTab } from './EpisodicTab';
import type { ActiveFactsViewProps } from './shared';

// Memory lives under the Brain icon as two sub-tabs: durable facts (Level 1) and
// the episodic recall store (Level 2, shown as metadata only — it's searched, not
// browsed). Mirrors the MCP + Skills sub-tab pattern below.
export function MemoryTab({ models, activeFacts }: { models: ModelSummary[]; activeFacts: ActiveFactsViewProps }) {
  const [sub, setSub] = useState<'facts' | 'recall'>('facts');
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
