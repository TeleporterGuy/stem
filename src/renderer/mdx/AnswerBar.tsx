import { useSyncExternalStore } from 'react';
import { ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import type { FormHost, HostedForm } from './FormHost';

// The answer bar: sits against the view's input (above a chat's composer,
// under a mail's reply box) while a form there is waiting for answers. It
// counts the answers and holds the one Send button; the input next to it
// stays the input, for asking about a question or answering in words.

/** The form the bar answers: the newest unsent one on the page. */
function activeForm(forms: HostedForm[]): HostedForm | null {
  let best: HostedForm | null = null;
  for (const f of forms) {
    const el = f.el();
    if (!el) continue;
    const bestEl = best?.el();
    if (!best || !bestEl || bestEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = f;
  }
  return best;
}

export function AnswerBar({ host, running }: { host: FormHost; running: boolean }) {
  const forms = useSyncExternalStore(host.subscribe, host.forms, host.forms);
  const form = activeForm(forms);
  if (!form) return null;
  const { answered, total } = form;
  const sendLabel = answered === 0 || answered === total ? 'Send answers' : `Send ${answered} answer${answered === 1 ? '' : 's'}`;
  const Show = host.place === 'below' ? ArrowUpToLine : ArrowDownToLine;
  return (
    <div className={`answer-bar ${host.place}`} role="group" aria-label="Answers">
      <span className="answer-bar-dots" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`answer-bar-dot${i < answered ? ' on' : ''}`} />
        ))}
      </span>
      <span className="answer-bar-label">
        {answered} of {total} answered
      </span>
      <button type="button" className="icon-action sm" title="Show the questions" aria-label="Show the questions" onClick={form.reveal}>
        <Show size={13} />
      </button>
      <span className="answer-bar-spacer" />
      <button
        type="button"
        className="answer-bar-send"
        disabled={answered === 0 || running}
        title={running ? 'Wait for the current answer to finish' : undefined}
        onClick={form.send}
      >
        {sendLabel}
      </button>
    </div>
  );
}
