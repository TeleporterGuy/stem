import type { ChatBackend } from '../backend/types';
import type { ScheduledTask } from '../../shared/types';
import { memoryRunOf } from '../workspace/settings';

// One-off repair for tasks from before runs had threads of their own. Those
// prompts were written for a run that could read the chat it lived in — "as
// discussed", "compare with the earlier reports in this conversation", "the
// page above" — and a run that starts blind cannot honour any of it. This
// reads the chat the task was scheduled from and asks the memory model for a
// prompt that carries everything itself. Best-effort and quiet: a task it
// cannot rewrite keeps its prompt and is named in the mail the pass sends.

/** Enough of the chat to recover what the prompt leaned on; newest kept. */
const TRANSCRIPT_CHARS = 40_000;
/** A rewrite is a prompt, not an essay. */
const MAX_PROMPT_CHARS = 4_000;
const TIMEOUT_MS = 90_000;

/** Nothing worth reading: a chat of one line, or none. */
const MIN_TRANSCRIPT_CHARS = 40;

export function rewriteInstructions(prompt: string, transcript: string): string {
  return [
    'You are rewriting the instruction of a scheduled task in a personal assistant app.',
    'Until now every run of the task executed INSIDE the chat below, so the instruction could refer to it ("as discussed", "compare with earlier reports in this conversation", "the page above").',
    'From now on every run starts in a fresh, empty thread: it sees ONLY the instruction, plus the user\'s general memory. It cannot see this chat.',
    '',
    'Rewrite the instruction so it stands entirely on its own. Rules:',
    '- Keep the task\'s purpose, scope, schedule-related wording, output format and tone exactly; do not add new duties or drop any.',
    '- Replace every reference to the conversation with the concrete thing it referred to, taken from the chat: names, URLs, paths, criteria, thresholds, the current conclusion or baseline to compare against, and what "new" means relative to it.',
    '- Where the old instruction says to compare with earlier reports or to avoid repeating past findings, state the baseline explicitly (what was already known as of the chat) and tell the run to report only what is new relative to that baseline.',
    '- Anything the run should surface goes through the notify_user tool, which reaches the user as mail with the run\'s final reply attached; if the old instruction says to "post in this conversation" or similar, say "call notify_user and put the report in your final reply" instead.',
    '- Write in the second person, as an instruction to the run. No preamble, no headings about what you changed, no quotes around the result.',
    `- At most ${MAX_PROMPT_CHARS} characters.`,
    '',
    'Output ONLY the rewritten instruction.',
    '',
    '=== CURRENT INSTRUCTION ===',
    prompt,
    '',
    '=== THE CHAT IT WAS SCHEDULED FROM (oldest first; earlier part may be cut) ===',
    transcript
  ].join('\n');
}

/**
 * The chat as the model should see it: user and assistant turns, oldest first,
 * cut from the front to fit. A scheduled run's own collapsed turns in that chat
 * are part of what the prompt leaned on ("earlier reports"), so they stay.
 */
export function transcriptOf(messages: { role: string; content: string }[]): string {
  const lines = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`);
  let text = lines.join('\n\n');
  if (text.length > TRANSCRIPT_CHARS) text = `[…earlier part of the chat cut…]\n${text.slice(text.length - TRANSCRIPT_CHARS)}`;
  return text;
}

/** The model's answer as a prompt, or null when it is not one. */
export function acceptRewrite(raw: string, original: string): string | null {
  let text = raw.trim();
  // A model that wraps the answer anyway.
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (text.length < 20 || text.length > MAX_PROMPT_CHARS * 1.5) return null;
  if (text === original.trim()) return null;
  return text;
}

/**
 * A self-contained prompt for `task`, or null when the chat is unreadable or
 * too thin to rewrite from, or the model gave nothing usable. Never rejects.
 */
export async function rewriteTaskPrompt(runtime: ChatBackend, task: ScheduledTask): Promise<string | null> {
  try {
    const { messages } = await runtime.readThread(task.threadId);
    const transcript = transcriptOf(messages);
    if (transcript.length < MIN_TRANSCRIPT_CHARS) return null;
    const run = await memoryRunOf((s) => s.memory.model);
    const answer = await runtime.complete(rewriteInstructions(task.prompt, transcript), {
      model: run.model,
      effort: run.effort,
      timeoutMs: TIMEOUT_MS
    });
    return acceptRewrite(answer, task.prompt);
  } catch {
    // quiet: the caller mails the user which tasks it could not rewrite; the
    // prompt stays as it was and the task keeps running on it.
    return null;
  }
}
