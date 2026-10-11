import { FactsTab } from './FactsTab';
import { EpisodicTab } from './EpisodicTab';
import { useRememberedTab } from '../../hooks/useRememberedTab';
import { useRetrievalHealth } from '../../hooks/useRetrievalHealth';
import type { ActiveFactsViewProps } from './shared';

const SUBS = ['facts', 'recall'] as const;

// Memory lives under the Brain icon as two sub-tabs: durable facts (Level 1) and
// the episodic recall store (Level 2, shown as metadata only — it's searched, not
// browsed). The second is labelled "Past chats": "recall" is our word for it,
// not the user's. The stored key stays 'recall' so a remembered choice survives.
// Which models memory runs on is configured in Settings → Models, not here.
export function MemoryTab({
  activeFacts,
  onOpenMail,
  onReviewRecall
}: {
  activeFacts: ActiveFactsViewProps;
  onOpenMail?: (conversationId: string) => void;
  /** Open Settings → Models at the Memory recall group. */
  onReviewRecall: () => void;
}) {
  const [sub, setSub] = useRememberedTab('stem.memory.sub', SUBS, 'facts');
  // Sub-tab echo of the rail's alert dot: the broken-model banner sits at the
  // top of Facts, so the marker keeps pointing once you're inside Memory.
  const retrievalBroken = useRetrievalHealth().broken;
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'facts' ? 'active' : ''} onClick={() => setSub('facts')}>
          Facts
          {retrievalBroken && <span className="seg-alert-dot" />}
        </button>
        <button className={sub === 'recall' ? 'active' : ''} onClick={() => setSub('recall')}>
          Past chats
        </button>
      </div>
      {sub === 'facts' ? (
        <FactsTab activeFacts={activeFacts} onOpenMail={onOpenMail} onReviewRecall={onReviewRecall} />
      ) : (
        <EpisodicTab />
      )}
    </div>
  );
}
