// Write-time duplicate detection for skill creates. Two gates: name+description
// (how the skill is framed) and the `## Steps` text (the procedure itself). The
// second one exists because of a real miss — the 08-11 pair ran the same yt-dlp
// caption pipeline under two framings and scored 0.824 against a 0.94 gate — so
// these cases pin the behaviour that gate was added for, and equally the two ways
// it must NOT behave: never blocking a genuinely different procedure, and never
// blocking at all when embeddings are unavailable.
//
// Uses a throwaway skills dir (STEM_SKILLS_DIR) because the first gate persists
// its vectors to a sidecar there, and a fake embedder in the shape of the one in
// skills-inject.test.ts: every text is assigned a cosine against the draft
// directly, so a case states the similarity it wants instead of reverse-
// engineering one.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillsDir = join(tmpdir(), `stem-skills-dedup-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { SKILL_BODY_DUP_COSINE, SKILL_DUP_COSINE, findDuplicateSkill } from '../../src/server/skills/dedup';

/** A unit vector whose cosine against the draft's [1,0] is exactly `c`. */
function unit(c: number): Float32Array {
  return Float32Array.from([c, Math.sqrt(Math.max(0, 1 - c * c))]);
}

/**
 * Fake embeddings client. `cosine(text)` says how similar that text is to the
 * draft; the draft's own texts return 1 and land on [1,0].
 */
function fakeEmbeddings(cosine: (text: string) => number, model = 'fake-embed-v1') {
  return {
    available: async () => true,
    modelId: async () => model,
    embed: async (texts: string[]) => texts.map((t) => unit(cosine(t)))
  };
}

const YTDLP_STEPS = `## Steps
1. Run \`yt-dlp --skip-download --write-auto-sub --sub-lang en "$VIDEO_URL"\`.
2. If it fails with ENOENT, pass an absolute output path — the relative one is
   resolved against pi's cwd, not yours.
3. Read the .vtt file and strip the timestamps.`;

const FASTMAIL_STEPS = `## Steps
1. Open the Fastmail search box and type \`from:*@\${DOMAIN}\`.
2. Sort by date and read the newest thread.`;

function body(steps: string, when = 'When the user asks about a video.'): string {
  return `## When to use\n${when}\n\n${steps}\n\n## Verification\nThe answer quotes the source.`;
}

/** A library record in the shape findDuplicateSkill is handed by listSkillRecords(). */
function record(slug: string, description: string, steps: string) {
  return { slug, name: slug, description, body: body(steps) };
}

beforeEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

describe('the name+description gate', () => {
  const draft = {
    name: 'extract-video-captions',
    description: 'Pull the caption text out of a video.',
    body: body(YTDLP_STEPS)
  };

  it('blocks a draft that is framed almost identically to an existing skill', async () => {
    const hit = await findDuplicateSkill(
      draft,
      [record('extract-video-transcript', 'Pull the caption text from a video.', YTDLP_STEPS)],
      fakeEmbeddings((t) => (t.startsWith(draft.name) ? 1 : 0.96))
    );
    expect(hit).toMatchObject({ slug: 'extract-video-transcript', via: 'name' });
    expect(hit!.cosine).toBeGreaterThanOrEqual(SKILL_DUP_COSINE);
  });

  it('never blocks the skill the draft would be updating', async () => {
    // Same slug means this is a patch, and resembling yourself is not a defect.
    const same = await findDuplicateSkill(
      draft,
      [record(draft.name, draft.description, YTDLP_STEPS)],
      fakeEmbeddings(() => 1)
    );
    expect(same).toBeNull();
  });
});

describe('the Steps gate', () => {
  // The 08-11 duplicate, reconstructed: one turn framed the job as "get the
  // details of a video", the other as "get its transcript", and both wrote down
  // the same yt-dlp pipeline. Framing is what the first gate reads, so it saw
  // 0.824 and passed the draft. The procedure is identical.
  const draft = {
    name: 'extract-youtube-video-details',
    description: 'Get the metadata, chapters and captions for a YouTube video.',
    body: body(YTDLP_STEPS)
  };
  const existing = record(
    'extract-youtube-transcript',
    'Read what was said in a YouTube video by fetching its captions.',
    YTDLP_STEPS
  );

  /** Framings 0.82 apart; any text carrying the shared procedure sits at 1. */
  const framingApart = (t: string) => (t.includes('yt-dlp') ? 1 : t.startsWith(draft.name) ? 1 : 0.82);

  it('blocks two framings of one procedure that the first gate lets through', async () => {
    const hit = await findDuplicateSkill(draft, [existing], fakeEmbeddings(framingApart));
    expect(hit).toMatchObject({ slug: 'extract-youtube-transcript', via: 'body' });
    expect(hit!.cosine).toBeGreaterThanOrEqual(SKILL_BODY_DUP_COSINE);
  });

  it('passes a genuinely different procedure in the same domain', async () => {
    // The cost of a false positive here is a skill that should exist and does
    // not, which is worse than the near-duplicate the curator would merge later.
    const other = record('fastmail-search-sender-by-domain', 'Find mail from a domain.', FASTMAIL_STEPS);
    const hit = await findDuplicateSkill(
      draft,
      [other],
      fakeEmbeddings((t) => (t.includes('yt-dlp') || t.startsWith(draft.name) ? 1 : 0.4))
    );
    expect(hit).toBeNull();
  });

  it('skips records whose body was not passed rather than guessing from the framing', async () => {
    const projection = { slug: existing.slug, name: existing.name, description: existing.description };
    const hit = await findDuplicateSkill(draft, [projection], fakeEmbeddings(framingApart));
    expect(hit).toBeNull();
  });

  it('logs a near-miss instead of blocking it, so the threshold can be calibrated', async () => {
    // 0.93 was set by argument, not evidence. This warning is what turns it into
    // a distribution we can actually read a threshold off.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nearly = record(
      'extract-youtube-chapters',
      'Read what was said in a YouTube video by fetching its captions.',
      `${YTDLP_STEPS}\n4. Also grab the chapter list out of the description.`
    );
    const hit = await findDuplicateSkill(
      draft,
      [nearly],
      // Order matters: everything of the draft's sits at 1, and the
      // near-duplicate's Steps carry the shared pipeline too, so its own marker
      // has to be read before the pipeline's.
      fakeEmbeddings((t) =>
        t.startsWith(draft.name) ? 1 : t.includes('chapter list') ? 0.91 : t.includes('yt-dlp') ? 1 : 0.82
      )
    );
    expect(hit).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toContain('extract-youtube-chapters');
    expect(warn.mock.calls.flat().join(' ')).toContain('0.910');
  });
});

describe('degraded paths', () => {
  const draft = { name: 'a-new-skill', description: 'does a thing', body: body(YTDLP_STEPS) };
  const existing = [record('an-old-skill', 'does the same thing', YTDLP_STEPS)];

  it('blocks nothing when there is no embeddings client', async () => {
    // A missed duplicate is a tidy-up job; a blocked save is lost work.
    expect(await findDuplicateSkill(draft, existing, null)).toBeNull();
  });

  it('blocks nothing when the client is down or the embed throws', async () => {
    const down = { available: async () => false, modelId: async () => 'fake-embed-v1', embed: async () => [] };
    expect(await findDuplicateSkill(draft, existing, down)).toBeNull();

    const broken = {
      available: async () => true,
      modelId: async () => 'fake-embed-v1',
      embed: async () => {
        throw new Error('endpoint gone');
      }
    };
    expect(await findDuplicateSkill(draft, existing, broken)).toBeNull();
  });

  it('blocks nothing on an empty library or a draft with no body', async () => {
    expect(await findDuplicateSkill(draft, [], fakeEmbeddings(() => 1))).toBeNull();
    const bodyless = { name: draft.name, description: draft.description };
    const hit = await findDuplicateSkill(
      bodyless,
      existing,
      fakeEmbeddings((t) => (t.startsWith(draft.name) ? 1 : 0.5))
    );
    expect(hit).toBeNull();
  });
});
