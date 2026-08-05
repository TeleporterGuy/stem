/**
 * Stem-style security gate for Pi bash tool calls.
 *
 * INSTALL: copy this folder to ~/.pi/agent/extensions/security-gate/
 * then Reload Pi config in Pendant.
 *
 * IMPORTS: adjust package names to match your Pi install. Newer Pi uses
 * @earendil-works/pi-coding-agent and @earendil-works/pi-ai; older trees used
 * @mariozechner/*. Look at another working extension's imports and match them.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { complete } from '@earendil-works/pi-ai';

import { loadAllowlist, saveAllowlist } from './allowlist.ts';
import { buildJudgePrompt, classify, parseJudgeVerdict } from './policy.ts';

const JUDGE_TIMEOUT_MS = 60_000;

type ApprovalMode = 'assisted' | 'manual' | 'yolo';

function approvalMode(): ApprovalMode {
  // Optional: read ~/.pi/agent/settings.json → securityGate.approvalMode
  // Default assisted (Stem's default).
  return 'assisted';
}

/** Best-effort: last user message text for intent-aware judging. */
function latestUserIntent(ctx: { sessionManager: { getBranch?: () => unknown[]; buildContextEntries?: () => unknown[] } }): string | undefined {
  try {
    const entries =
      (typeof ctx.sessionManager.getBranch === 'function'
        ? ctx.sessionManager.getBranch()
        : ctx.sessionManager.buildContextEntries?.()) ?? [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
      const msg = e?.type === 'message' ? e.message : (e as { role?: string; content?: unknown });
      if (!msg || msg.role !== 'user') continue;
      const content = msg.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((c): c is { type: string; text: string } => !!c && typeof c === 'object' && (c as { type?: string }).type === 'text')
          .map((c) => c.text)
          .join('\n');
        if (text.trim()) return text;
      }
    }
  } catch {
    // Intent is optional — judge without it.
  }
  return undefined;
}

function verdictLine(
  judgeVerdict: 'unsafe' | 'unsure' | 'failed' | null,
  judgeReason?: string
): string {
  const base =
    judgeVerdict === 'unsafe'
      ? 'The safety check flagged this command as potentially unsafe'
      : judgeVerdict === 'failed'
        ? 'The automatic safety check could not run'
        : judgeVerdict === 'unsure'
          ? 'The safety check could not tell whether this command is safe'
          : 'Manual approval is on — commands only run when you allow them';
  return judgeReason ? `${base}: ${judgeReason}` : `${base}.`;
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event)) return;

    const command = (event.input.command ?? '').trim();
    if (!command) {
      return { block: true, reason: 'Provide a command to run.' };
    }

    const mode = approvalMode();
    if (mode === 'yolo') return; // allow

    const allowlist = loadAllowlist();
    const cls = classify(command, allowlist);
    if (cls.tier === 'run') return; // tier 1

    let judgeVerdict: 'unsafe' | 'unsure' | 'failed' | null = null;
    let judgeReason: string | undefined;

    if (mode === 'assisted') {
      try {
        const model = ctx.model;
        if (!model) {
          judgeVerdict = 'failed';
          judgeReason = 'no model was available to run it';
        } else {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok || !auth.apiKey) {
            judgeVerdict = 'failed';
            judgeReason = 'no model was available to run it';
          } else {
            ctx.ui.notify?.('Checking command safety…', 'info');
            const intent = latestUserIntent(ctx);
            const prompt = buildJudgePrompt(command, ctx.cwd, intent);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
            try {
              const response = await complete(
                model,
                {
                  messages: [
                    {
                      role: 'user',
                      content: [{ type: 'text', text: prompt }],
                      timestamp: Date.now()
                    }
                  ]
                },
                {
                  apiKey: auth.apiKey,
                  headers: auth.headers,
                  signal: controller.signal,
                  maxTokens: 64
                }
              );
              const text = (response.content ?? [])
                .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
                .map((c: { text?: string }) => c.text)
                .join('\n');
              const parsed = parseJudgeVerdict(text);
              if (parsed.verdict === 'safe') return; // tier 2 pass
              judgeVerdict = parsed.verdict;
              judgeReason = parsed.reason;
            } finally {
              clearTimeout(timer);
            }
          }
        }
      } catch (e) {
        judgeVerdict = 'failed';
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        judgeReason = msg.includes('abort') || msg.includes('timed')
          ? 'it did not answer in time'
          : undefined;
      }
    }

    // Tier 3 — user decides (Pendant supports ui.select in RPC).
    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          `Command requires approval (no UI). Add a prefix to ~/.pi/agent/.security-gate-allowlist ` +
          `or run interactively in Pendant. Command: ${command}`
      };
    }

    const explanation = [
      verdictLine(judgeVerdict, judgeReason),
      '',
      command,
      `in ${ctx.cwd}`
    ].join('\n');

    const options: string[] = ['Allow once'];
    if (cls.prefixes.length) {
      options.push(`Always allow ${cls.prefixes.map((p) => `“${p}”`).join(', ')}`);
    }
    options.push('Deny');

    const choice = await ctx.ui.select(explanation, options);
    if (!choice || choice === 'Deny') {
      return { block: true, reason: 'The user declined to run this command.' };
    }
    if (choice.startsWith('Always allow') && cls.prefixes.length) {
      saveAllowlist(cls.prefixes);
    }
    // Allow once / always → fall through (do not block)
  });
}
