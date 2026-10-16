// The organization policy for inter-Stem mail (src/server/interstem/policy.ts):
// what the file says, and that nothing outside it reaches a relay.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MailExternal, MailItem } from '../../src/shared/types';
import { addressUsable, loadPolicy, parsePolicy, PolicyError, type InterStemPolicy } from '../../src/server/interstem/policy';
import { b64 } from '../../src/server/interstem/proto';
import { AuthorityResolver } from '../../src/server/interstem/relay-client';
import { InterStemService, type InterStemMailPort } from '../../src/server/interstem/service';
import { interStemStore } from '../../src/server/interstem/store';

const KEY = b64(Buffer.alloc(32, 7));
const ACME = JSON.stringify({
  interStem: {
    domains: ['Acme.com'],
    relay: 'https://stem-relay.acme.com/',
    relayKeys: [`k1:${KEY}`]
  }
});

describe('parsePolicy', () => {
  it('reads off, restricted and no restriction', () => {
    expect(parsePolicy('{"interStem":{"enabled":false}}')).toEqual({
      mode: 'off'
    });
    expect(parsePolicy('{}')).toEqual({ mode: 'open' });
    expect(parsePolicy('{"interStem":{"domains":["acme.com"]}}')).toEqual({
      mode: 'restricted',
      domains: ['acme.com']
    });
    const p = parsePolicy(ACME);
    expect(p.mode === 'restricted' && p.relay?.url).toBe('https://stem-relay.acme.com');
    expect(p.mode === 'restricted' && p.domains).toEqual(['acme.com']);
  });

  it('turns mail off when the file is broken, never open', () => {
    for (const bad of [
      'not json',
      '{"interStem":"yes"}',
      '{"interStem":{"enabled":"no"}}',
      '{"interStem":{"domains":[]}}',
      '{"interStem":{"domains":["acme.com"],"relay":"https://r.acme.com"}}',
      '{"interStem":{"domains":["acme.com"],"relay":"https://r.acme.com","relayKeys":["k1:short"]}}',
      '{"interStem":{"relay":"https://r.acme.com"}}'
    ]) {
      expect(parsePolicy(bad), bad).toEqual({ mode: 'off' });
    }
  });
});

describe('loadPolicy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stem-policy-'));

  it('is open without a file or STEM_POLICY', () => {
    expect(loadPolicy(join(dir, 'missing.json'), {})).toEqual({ mode: 'open' });
  });

  it('takes STEM_POLICY when there is no file, and the file over it', () => {
    expect(
      loadPolicy(join(dir, 'missing.json'), {
        STEM_POLICY: '{"interStem":{"enabled":false}}'
      })
    ).toEqual({
      mode: 'off'
    });
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{"interStem":{"domains":["acme.com"]}}');
    expect(loadPolicy(file, { STEM_POLICY: '{}' })).toEqual({
      mode: 'restricted',
      domains: ['acme.com']
    });
  });

  it('is off when the path exists but is not a readable file', () => {
    expect(loadPolicy(dir, {})).toEqual({ mode: 'off' });
  });
});

describe('authority under a policy', () => {
  const global = async () => ({
    relay: 'https://relay.stem.example',
    keys: {}
  });
  const record = (relay: string) => [[`v=stem1; relay=${relay}; k=k1:${KEY}`]];
  const resolver = (policy: InterStemPolicy, txt = async () => record('https://relay.beta.com')) =>
    new AuthorityResolver(global, txt, undefined, () => policy);

  it('pins the organization relay and refuses everyone else', async () => {
    const r = resolver(parsePolicy(ACME));
    expect((await r.authority('ann@acme.com')).relay).toBe('https://stem-relay.acme.com');
    await expect(r.authority('bob@gmail.com')).rejects.toBeInstanceOf(PolicyError);
    // A refused sender's certificate verifies against nobody.
    expect(await r.issuerKeys()('bob@gmail.com')).toEqual({
      issuer: '',
      keys: {}
    });
  });

  it('never falls back to the global relay for an allowed domain without a record', async () => {
    const noRecord = async () => {
      throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
    };
    const r = resolver({ mode: 'restricted', domains: ['acme.com', 'beta.com'] }, noRecord);
    await expect(r.authority('ann@acme.com')).rejects.toThrow(/no Stem relay of its own/);
    const withRecord = resolver({ mode: 'restricted', domains: ['beta.com'] });
    expect((await withRecord.authority('cy@beta.com')).relay).toBe('https://relay.beta.com');
  });

  it('refuses every address when off', async () => {
    await expect(resolver({ mode: 'off' }).authority('ann@acme.com')).rejects.toThrow(/turned off/);
  });
});

describe('InterStemService under a policy', () => {
  function service(policy: InterStemPolicy) {
    const dir = mkdtempSync(join(tmpdir(), 'stem-policy-svc-'));
    const items: MailItem[] = [{ id: 'i1', at: 1, body: 'hi', external: {} } as unknown as MailItem];
    const conversations = [
      {
        id: 'c1',
        external: {
          address: 'bob@gmail.com',
          thread: 't',
          self: 'ann@acme.com'
        }
      }
    ];
    const mail = {
      readMail: async () => ({ conversations, items }),
      setExternalStatus: async (itemId: string, patch: Partial<MailExternal>) => {
        const it = items.find((i) => i.id === itemId);
        if (it) it.external = { ...it.external, ...patch };
      }
    } as unknown as InterStemMailPort;
    const noNet = async () => {
      throw new Error('DNS must not be asked');
    };
    const svc = new InterStemService({
      store: interStemStore(join(dir, 'interstem.json')),
      mail,
      txt: noNet,
      policy: () => policy
    });
    return { svc, items };
  }

  it('refuses to add an address outside the policy', async () => {
    const { svc } = service(parsePolicy(ACME));
    await expect(svc.addAddress('me@gmail.com')).rejects.toThrow(/only allows Stem mail with acme.com/);
    await expect(service({ mode: 'off' }).svc.addAddress('me@acme.com')).rejects.toThrow(/turned off/);
  });

  it('fails a send outside the policy at once instead of queueing it', async () => {
    const { svc, items } = service(parsePolicy(ACME));
    await svc.send('c1', 'i1');
    expect(items[0].external).toMatchObject({ status: 'failed' });
    expect(items[0].external?.error).toMatch(/acme.com/);
  });

  it('reports the policy to the settings screen', async () => {
    expect((await service({ mode: 'off' }).svc.status()).policy).toEqual({
      mode: 'off'
    });
    expect((await service(parsePolicy(ACME)).svc.status()).policy).toEqual({
      mode: 'restricted',
      domains: ['acme.com']
    });
    expect((await service({ mode: 'open' }).svc.status()).policy).toBeUndefined();
  });
});

describe('addressUsable', () => {
  const G = 'https://relay.stem.example';
  it('never uses an address left on the global relay under a restriction', () => {
    const p: InterStemPolicy = { mode: 'restricted', domains: ['acme.com'] };
    expect(addressUsable(p, 'ann@acme.com', G, G)).toBe(false);
    expect(addressUsable(p, 'ann@acme.com', 'https://relay.acme.com', G)).toBe(true);
    expect(addressUsable(parsePolicy(ACME), 'ann@acme.com', 'https://relay.acme.com', G)).toBe(false);
    expect(addressUsable({ mode: 'open' }, 'ann@acme.com', G, G)).toBe(true);
  });
});
