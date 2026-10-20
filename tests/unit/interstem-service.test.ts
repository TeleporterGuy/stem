// Two Stems talking through the real Go relay (relay/). Skipped when Go is
// not installed. Each Stem gets its own interstem store and an in-memory mail
// port, so both live in this one process.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailConversation, MailExternal, MailItem, MailListResult } from '../../src/shared/types';
import { InterStemService, type InterStemMailPort } from '../../src/server/interstem/service';
import { interStemStore } from '../../src/server/interstem/store';

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const relayDir = join(__dirname, '../../relay');
let relay: ChildProcess | undefined;
let relayLog = '';
let relayUrl = '';

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, what: string, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v as T;
    } catch {
      // keep waiting
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function lastCode(address: string): string | undefined {
  const re = new RegExp(`mail to ${address.replace(/[.]/g, '\\.')}:[\\s\\S]*?code (?:to connect \\S+ to Stem )?is (\\d{6})`, 'g');
  let m: RegExpExecArray | null;
  let code: string | undefined;
  while ((m = re.exec(relayLog))) code = m[1];
  return code;
}

/** A minimal in-memory stand-in for the mail store. */
function memoryMail(): InterStemMailPort & { conversations: MailConversation[]; items: MailItem[] } {
  const conversations: MailConversation[] = [];
  const items: MailItem[] = [];
  const result = (): MailListResult => ({ conversations, items, inbox: { baseline: 0, entries: {} } });
  return {
    conversations,
    items,
    async createConversation(subject, participants, _body, opts = {}) {
      const c: MailConversation = {
        id: randomUUID(),
        subject,
        participants,
        sessions: {},
        ...(opts.external ? { external: opts.external } : {}),
        status: 'idle',
        exchangeCount: 0,
        sendCounts: {},
        updatedAt: Date.now(),
        userUpdatedAt: 0,
        userSentAt: 0,
        createdAt: Date.now()
      };
      conversations.push(c);
      return c;
    },
    async appendMailItem(input) {
      const fields = { ...input } as Partial<typeof input>;
      delete fields.guard;
      delete fields.staleIfUserSentAfter;
      items.push({ ...fields, id: randomUUID(), at: input.at ?? Date.now() } as MailItem);
      return result();
    },
    async findExternalConversation(thread, address, self) {
      return conversations.find((c) => c.external?.thread === thread && c.external.address === address && c.external.self === self) ?? null;
    },
    async hasExternalEnvelope(id) {
      return items.some((i) => i.external?.envelopeId === id);
    },
    async setExternalStatus(itemId, patch: Partial<MailExternal>) {
      const item = items.find((i) => i.id === itemId);
      if (item) item.external = { ...item.external, ...patch };
      return result();
    },
    async readMail() {
      return result();
    }
  };
}

const noDns = async () => {
  throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
};

function makeStem(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `stem-is-${name}-`));
  const mail = memoryMail();
  const svc = new InterStemService({ store: interStemStore(join(dir, 'interstem.json')), mail, txt: noDns });
  return { svc, mail };
}

async function verify(stem: ReturnType<typeof makeStem>, address: string): Promise<void> {
  await stem.svc.addAddress(address);
  const code = await waitFor(() => lastCode(address), `code for ${address}`);
  await stem.svc.verifyAddress(address, code);
}

async function startConversation(stem: ReturnType<typeof makeStem>, self: string, to: string, body: string) {
  const conv = await stem.mail.createConversation('Podcast', [], body, {
    external: { address: to, thread: randomUUID().replace(/-/g, ''), self }
  });
  await stem.mail.appendMailItem({ conversationId: conv.id, from: 'user', to: [to], body, external: { status: 'queued' } });
  const item = stem.mail.items.at(-1)!;
  await stem.svc.send(conv.id, item.id);
  return { conv, item };
}

describe.skipIf(!hasGo)('inter-Stem mail through the real relay', () => {
  const vlado = makeStem('vlado');
  const martin = makeStem('martin');

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'stem-relay-'));
    const bin = join(work, 'stem-relay');
    execFileSync('go', ['build', '-o', bin, './cmd/stem-relay'], { cwd: relayDir, stdio: 'inherit' });
    const port = 20000 + Math.floor(Math.random() * 20000);
    relayUrl = `http://127.0.0.1:${port}`;
    writeFileSync(
      join(work, 'relay.toml'),
      `url = "${relayUrl}"\nglobal = true\ndata_dir = "${join(work, 'data')}"\nlisten = "127.0.0.1:${port}"\n` +
        `[limits]\npow_bits = 4\n[invites]\nenabled = true\n`
    );
    relay = spawn(bin, ['serve', '-config', join(work, 'relay.toml')], { stdio: ['ignore', 'pipe', 'pipe'] });
    relay.stdout!.on('data', (d) => (relayLog += d));
    relay.stderr!.on('data', (d) => (relayLog += d));
    process.env.STEM_GLOBAL_RELAY_URL = relayUrl;
    // A plain-http relay on loopback: test only.
    process.env.STEM_INTERSTEM_INSECURE = '1';
    delete process.env.STEM_GLOBAL_RELAY_KEYS;
    await waitFor(async () => (await fetch(`${relayUrl}/v1/info`)).ok || undefined, 'relay to start');
    await verify(vlado, 'vlado@gmail.test');
    await verify(martin, 'martin@gmail.test');
    await vlado.svc.start();
    await martin.svc.start();
  }, 120_000);

  afterAll(() => {
    vlado.svc.stop();
    martin.svc.stop();
    relay?.kill();
    delete process.env.STEM_GLOBAL_RELAY_URL;
    delete process.env.STEM_INTERSTEM_INSECURE;
  });

  it('delivers a first mail held, as a Request, and the reply back into the same conversation', async () => {
    const { conv, item } = await startConversation(vlado, 'vlado@gmail.test', 'martin@gmail.test', 'Shall we record on Sunday?');
    expect(item.external?.status).toBe('sent');

    const got = await waitFor(() => martin.mail.items.find((i) => i.from === 'vlado@gmail.test'), 'martin to receive');
    expect(got.body).toBe('Shall we record on Sunday?');
    expect(got.external?.held).toBe(true);
    const mConv = martin.mail.conversations.find((c) => c.id === got.conversationId)!;
    expect(mConv.external).toMatchObject({ address: 'vlado@gmail.test', self: 'martin@gmail.test', thread: conv.external!.thread });
    expect(mConv.subject).toBe('Podcast');
    expect((await martin.svc.status()).contacts.find((c) => c.address === 'vlado@gmail.test')?.state).toBe('request');

    // Vlado wrote first, so to him Martin is a contact already.
    expect((await vlado.svc.status()).contacts.find((c) => c.address === 'martin@gmail.test')?.state).toBe('accepted');

    await martin.svc.acceptContact('vlado@gmail.test');
    await martin.mail.appendMailItem({ conversationId: mConv.id, from: 'user', to: ['vlado@gmail.test'], body: 'Sunday works.', external: { status: 'queued' } });
    await martin.svc.send(mConv.id, martin.mail.items.at(-1)!.id);

    const reply = await waitFor(() => vlado.mail.items.find((i) => i.from === 'martin@gmail.test'), 'vlado to receive the reply');
    expect(reply.conversationId).toBe(conv.id);
    expect(reply.external?.held).toBe(true);

    // Martin allowed Vlado, so Vlado may learn his first mail was delivered.
    await vlado.svc.pollStatuses();
    expect(vlado.mail.items.find((i) => i.id === item.id)?.external?.status).toBe('delivered');
  }, 30_000);

  it('says unreachable for an address nobody holds', async () => {
    const { item } = await startConversation(vlado, 'vlado@gmail.test', 'nobody@gmail.test', 'Hello?');
    const now = vlado.mail.items.find((i) => i.id === item.id)!;
    expect(now.external?.status).toBe('unreachable');
  }, 30_000);

  it('stops sending when a contact’s key changes until the user acknowledges it', async () => {
    const laptop2 = makeStem('martin2');
    await verify(laptop2, 'martin@gmail.test');
    await laptop2.svc.start();
    const { item } = await startConversation(vlado, 'vlado@gmail.test', 'martin@gmail.test', 'Are you there?');
    expect(vlado.mail.items.find((i) => i.id === item.id)?.external?.status).toBe('key-changed');
    expect((await vlado.svc.status()).contacts.find((c) => c.address === 'martin@gmail.test')?.keyChanged).toBe(true);

    await vlado.svc.acknowledgeKeyChange('martin@gmail.test');
    expect(vlado.mail.items.find((i) => i.id === item.id)?.external?.status).toBe('sent');
    const got = await waitFor(() => laptop2.mail.items.find((i) => i.body === 'Are you there?'), 'the new laptop to receive');
    expect(got.external?.held).toBe(true);
    // The old laptop lost the address and gets nothing new.
    expect(martin.mail.items.some((i) => i.body === 'Are you there?')).toBe(false);
    laptop2.svc.stop();
  }, 30_000);
});
