import type { MailItem, Persona } from '../../shared/types';
import { degrade } from '../degrade';
import { personaKeepsAnswers, saveStandingAnswer } from '../workspace/persona-memory';

// A code persona's standing answers, captured from the mail flow. The relay
// hands the coding agent's question to the user in its reply mail; the user's
// next mail in that conversation is the answer. Recording that pair (question
// as title, answer as body) is what lets the relay answer the same question
// itself next time — see standingAnswersBlock in preamble.ts.
//
// Deterministic on purpose: no model decides what "the question" was. The
// question is read off the agent's own verbatim reply (MailItem.agentReplies,
// the source the user checked the relay against), and only a reply whose
// closing paragraph asks something counts. A long user mail is a new
// assignment, not an answer, and is left alone.

/** A user mail longer than this is a brief, not an answer to a question. */
export const MAX_ANSWER_CHARS = 600;
/** How much of a question the title keeps; matches the note title cap. */
const MAX_QUESTION_CHARS = 120;

/**
 * The question the coding agent's reply ends on, or null when it ends on a
 * statement. The last paragraph's last question sentence, one line.
 */
export function questionAskedIn(agentReply: string): string | null {
  const paragraphs = agentReply
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const last = paragraphs[paragraphs.length - 1];
  if (!last || !last.includes('?')) return null;
  // Sentences: split after . ! ? — then keep the last one that asks.
  const sentences = last.split(/(?<=[.!?])\s+/).filter(Boolean);
  const question = [...sentences].reverse().find((s) => s.endsWith('?')) ?? last;
  const trimmed = question.replace(/^[-*•\d.)\s]+/, '').trim();
  return trimmed ? trimmed.slice(0, MAX_QUESTION_CHARS) : null;
}

/**
 * Capture the user's reply as a standing answer when the conversation's last
 * item is the code persona's relay of a question. Never rejects: a capture
 * that fails costs one question asked again next time, not the reply.
 */
export async function captureStandingAnswer(args: {
  persona: Persona;
  /** The conversation's items so far, oldest first, before the user's reply is appended. */
  items: MailItem[];
  reply: string;
}): Promise<void> {
  if (!personaKeepsAnswers(args.persona)) return;
  const answer = args.reply.trim();
  if (!answer || answer.length > MAX_ANSWER_CHARS) return;
  const last = args.items[args.items.length - 1];
  if (!last || last.from !== args.persona.id || !last.agentReplies?.length) return;
  const question = questionAskedIn(last.agentReplies[last.agentReplies.length - 1]);
  if (!question) return;
  try {
    await saveStandingAnswer(args.persona.id, question, answer);
  } catch (e) {
    degrade('mail', 'did not record a standing answer', e);
  }
}
