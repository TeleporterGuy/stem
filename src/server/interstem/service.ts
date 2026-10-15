// Inter-Stem mail (docs/inter-stem-mail-design.md): this Stem's addresses,
// the relay connections that bring mail in, and the queue that sends it out.
//
// Inbound mail lands in the Inbox HELD: no agent, recall, capture or model
// sees it until the user releases it (mail store releaseExternalItems).
// Outbound mail is only ever the user's: their own replies, or a persona's
// draft they approved (router resolveSendDraft).
import { degrade } from '../degrade';
import { log } from '../log';
import type { InterStemStatus, MailConversation, MailExternal, MailItem, MailListResult } from '../../shared/types';
import {
  appendMailItem,
  createConversation,
  findExternalConversation,
  hasExternalEnvelope,
  readMail,
  setExternalStatus
} from '../workspace/mail';
import {
  b64,
  checkKeyBlob,
  edPrivate,
  fingerprint,
  makeKeyBlob,
  newId,
  normalizeAddress,
  open,
  rawPublic,
  seal,
  signEnvelope,
  solvePowAsync,
  unb64,
  validAddress,
  verifyEnvelope,
  type Cert,
  type Envelope
} from './proto';
import {
  AuthorityResolver,
  RelayError,
  ack,
  fetchCert,
  globalRelay,
  globalTofuAllowed,
  invite,
  keyStatus,
  listOp,
  lookupKey,
  mailStatus,
  postMail,
  register,
  relayInfo,
  setUnlisted,
  streamMail,
  verifyCode,
  wellKnown,
  type Authority,
  type Identity,
  type TxtLookup
} from './relay-client';
import { interStemStore, type InterStemState, type InterStemStore, type StoredContact } from './store';

/** What the service needs from the mail store — swappable so tests can run two Stems in one process. */
export interface InterStemMailPort {
  createConversation: typeof createConversation;
  appendMailItem: typeof appendMailItem;
  findExternalConversation: typeof findExternalConversation;
  hasExternalEnvelope: typeof hasExternalEnvelope;
  setExternalStatus: typeof setExternalStatus;
  readMail: typeof readMail;
}

const defaultMail: InterStemMailPort = {
  createConversation,
  appendMailItem,
  findExternalConversation,
  hasExternalEnvelope,
  setExternalStatus,
  readMail
};

/** The sealed inner mail, version 1. Stems agree on this; relays never see it. */
interface InnerV1 {
  v: 1;
  kind: 'mail';
  thread: string;
  subject?: string;
  body: string;
  sentAt: number;
}

const INNER_MAX_BODY = 1_000_000;
const OUTBOX_RETRY_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const OUTBOX_GIVE_UP_MS = 7 * 86_400_000;
const CERT_REFRESH_BEFORE_MS = 2 * 3_600_000;
const STATUS_WINDOW_MS = 8 * 86_400_000;

export interface InterStemOptions {
  store?: InterStemStore;
  mail?: InterStemMailPort;
  /** DNS TXT lookup (tests inject one). */
  txt?: TxtLookup;
  /** Called after anything the UI shows changed (status, contacts). */
  onChange?: () => void;
  now?: () => number;
}

export class InterStemService {
  private store: InterStemStore;
  private mail: InterStemMailPort;
  private resolver: AuthorityResolver;
  private onChange: () => void;
  private now: () => number;
  private streams = new Map<string, AbortController>();
  private connected = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private outboxRunning = false;
  private stopped = false;

  constructor(opts: InterStemOptions = {}) {
    this.store = opts.store ?? interStemStore();
    this.mail = opts.mail ?? defaultMail;
    this.onChange = opts.onChange ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.resolver = new AuthorityResolver(() => this.globalAuthority(), opts.txt);
  }

  // ---- lifecycle ----

  /** Connect to every verified address's relay and start the timers. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectAll();
    this.timers.push(
      setInterval(() => void this.processOutbox(), 30_000),
      setInterval(() => void this.refreshCerts(), 30 * 60_000),
      setInterval(() => void this.pollStatuses(), 5 * 60_000)
    );
    for (const t of this.timers) t.unref?.();
    void this.processOutbox();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.streams.values()) c.abort();
    this.streams.clear();
    this.connected.clear();
  }

  // ---- authority ----

  private async globalAuthority(): Promise<Authority> {
    const g = globalRelay();
    if (Object.keys(g.keys).length) {
      return { relay: g.url, keys: Object.fromEntries(Object.entries(g.keys).map(([k, v]) => [k, unb64(v)])) };
    }
    // No keys shipped (development, or before the global relay is deployed):
    // trust the relay's /.well-known once and pin what it said — but only when
    // the operator pointed this Stem at a relay explicitly. A build that only
    // knows the default URL must ship its keys: a first fetch an attacker
    // could answer would let them certify every address on the global relay.
    if (!globalTofuAllowed()) throw new Error('The global relay is not available in this build yet.');
    const state = await this.store.read();
    let pinned = state.relayKeys[g.url];
    if (!pinned || !Object.keys(pinned).length) {
      const wk = await wellKnown(g.url);
      pinned = Object.fromEntries(wk.keys.map((k) => [k.kid, k.pub]));
      await this.store.update((s) => {
        s.relayKeys[g.url] = pinned!;
      });
    }
    return { relay: g.url, keys: Object.fromEntries(Object.entries(pinned).map(([k, v]) => [k, unb64(v)])) };
  }

  // ---- identity and addresses ----

  private identity(state: InterStemState, address?: string): Identity {
    const cert = address ? state.addresses.find((a) => a.address === address)?.cert : undefined;
    return { seed: state.identitySeed, ...(cert ? { cert } : {}) };
  }

  async status(): Promise<InterStemStatus> {
    const s = await this.store.read();
    return {
      addresses: s.addresses.map(({ address, state, relay }) => ({ address, state, relay })),
      unlisted: s.unlisted,
      fingerprint: fingerprint(rawPublic(edPrivate(s.identitySeed))),
      connected:
        s.addresses.some((a) => a.state === 'verified') &&
        [...new Set(s.addresses.filter((a) => a.state === 'verified').map((a) => a.relay))].every((r) =>
          this.connected.has(r)
        ),
      contacts: Object.values(s.contacts).map(({ address, state, keyFp, verifiedByUser, keyChanged, firstSeen }) => ({
        address,
        state,
        keyFp,
        firstSeen,
        ...(verifiedByUser ? { verifiedByUser } : {}),
        ...(keyChanged ? { keyChanged } : {})
      }))
    };
  }

  /** Ask the address's relay to email a code. */
  async addAddress(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    if (!validAddress(address)) throw new Error('That is not an email address.');
    const { relay } = await this.resolver.authority(address);
    const state = await this.store.read();
    const info = await relayInfo(relay);
    const keyB64 = b64(rawPublic(edPrivate(state.identitySeed)));
    const nonce = await solvePowAsync(address, keyB64, info.limits.powBits ?? 0);
    const blob = JSON.stringify(makeKeyBlob(state.identitySeed, state.encPriv));
    await register(relay, this.identity(state), address, blob, nonce);
    await this.store.update((s) => {
      const existing = s.addresses.find((a) => a.address === address);
      if (existing) {
        existing.relay = relay;
        if (existing.state !== 'verified') existing.state = 'pending';
      } else {
        s.addresses.push({ address, state: 'pending', relay, addedAt: this.now() });
      }
    });
    this.onChange();
    return this.status();
  }

  async verifyAddress(raw: string, code: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    const state = await this.store.read();
    const entry = state.addresses.find((a) => a.address === address);
    if (!entry) throw new Error('Add the address first.');
    let cert: Cert;
    try {
      cert = await verifyCode(entry.relay, this.identity(state), address, code.trim());
    } catch (err) {
      if (err instanceof RelayError && err.code === 'invalid_code')
        throw new Error('That code is not right, or it expired.');
      throw err;
    }
    await this.store.update((s) => {
      const e = s.addresses.find((a) => a.address === address);
      if (e) Object.assign(e, { state: 'verified', cert });
    });
    if (state.unlisted)
      await setUnlisted(entry.relay, this.identity(state), true).catch((e) =>
        degrade('interstem', 'could not set unlisted on a new relay', e)
      );
    await this.connectAll();
    this.onChange();
    return this.status();
  }

  /**
   * The user confirmed through the email link instead of typing the code:
   * the relay already bound the address, so fetching a certificate succeeds.
   */
  async checkLinkVerified(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    const state = await this.store.read();
    const entry = state.addresses.find((a) => a.address === address);
    if (!entry) throw new Error('Add the address first.');
    const cert = await fetchCert(entry.relay, this.identity(state), address);
    await this.store.update((s) => {
      const e = s.addresses.find((a) => a.address === address);
      if (e) Object.assign(e, { state: 'verified', cert });
    });
    await this.connectAll();
    this.onChange();
    return this.status();
  }

  async removeAddress(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    await this.store.update((s) => {
      s.addresses = s.addresses.filter((a) => a.address !== address);
    });
    await this.connectAll();
    this.onChange();
    return this.status();
  }

  async setUnlisted(unlisted: boolean): Promise<InterStemStatus> {
    const state = await this.store.read();
    for (const relay of new Set(state.addresses.filter((a) => a.state === 'verified').map((a) => a.relay))) {
      await setUnlisted(relay, this.identity(state), unlisted);
    }
    await this.store.update((s) => {
      s.unlisted = unlisted;
    });
    this.onChange();
    return this.status();
  }

  /** Our verified address to send from when the user has several: the first. */
  async defaultSelf(): Promise<string | null> {
    const s = await this.store.read();
    return s.addresses.find((a) => a.state === 'verified')?.address ?? null;
  }

  private async refreshCerts(force = false): Promise<void> {
    const state = await this.store.read();
    for (const a of state.addresses) {
      if (a.state !== 'verified') continue;
      if (!force && a.cert && a.cert.exp - this.now() > CERT_REFRESH_BEFORE_MS) continue;
      try {
        const cert = await fetchCert(a.relay, this.identity(state), a.address);
        await this.store.update((s) => {
          const e = s.addresses.find((x) => x.address === a.address);
          if (e) e.cert = cert;
        });
      } catch (err) {
        if (err instanceof RelayError && (err.code === 'not_your_address' || err.code === 'not_registered')) {
          // Another device verified this address since: this key no longer holds it.
          await this.store.update((s) => {
            const e = s.addresses.find((x) => x.address === a.address);
            if (e) e.state = 'pending';
            delete e?.cert;
          });
          degrade('interstem', `lost ${a.address}: another device holds it now`, err);
          this.onChange();
        } else {
          degrade('interstem', 'could not refresh a sender certificate', err);
        }
      }
    }
  }

  private async freshCert(address: string): Promise<Identity> {
    let state = await this.store.read();
    const entry = state.addresses.find((a) => a.address === address && a.state === 'verified');
    if (!entry) throw new Error(`${address} is not verified on this Stem.`);
    if (!entry.cert || entry.cert.exp - this.now() < CERT_REFRESH_BEFORE_MS) {
      await this.refreshCerts(true);
      state = await this.store.read();
    }
    const id = this.identity(state, address);
    if (!id.cert) throw new Error(`No certificate for ${address}.`);
    return id;
  }

  // ---- inbound ----

  private async connectAll(): Promise<void> {
    if (this.stopped) return;
    const state = await this.store.read();
    const relays = new Set(state.addresses.filter((a) => a.state === 'verified').map((a) => a.relay));
    for (const [relay, ctl] of this.streams) {
      if (!relays.has(relay)) {
        ctl.abort();
        this.streams.delete(relay);
        this.connected.delete(relay);
      }
    }
    for (const relay of relays) if (!this.streams.has(relay)) this.connect(relay);
  }

  private connect(relay: string): void {
    const ctl = new AbortController();
    this.streams.set(relay, ctl);
    void (async () => {
      let backoff = 1_000;
      while (!ctl.signal.aborted && !this.stopped) {
        try {
          const state = await this.store.read();
          this.connected.add(relay);
          this.onChange();
          backoff = 1_000;
          await streamMail(relay, this.identity(state), (env) => this.receive(relay, env), ctl.signal);
        } catch (err) {
          if (ctl.signal.aborted) break;
          degrade('interstem', `relay stream to ${relay} dropped`, err);
        }
        this.connected.delete(relay);
        this.onChange();
        if (ctl.signal.aborted || this.stopped) break;
        await new Promise((r) => setTimeout(r, backoff).unref?.());
        backoff = Math.min(backoff * 2, 60_000);
      }
    })();
  }

  /** One envelope from the relay: verify it ourselves, file it held, ack it. */
  async receive(relay: string, env: Envelope): Promise<void> {
    const state = await this.store.read();
    const id = this.identity(state);
    const ours = state.addresses.find((a) => a.address === env.to && a.state === 'verified');
    const done = () => ack(relay, id, [env.id]);
    if (!ours) {
      // Mail for an address this key no longer holds: not ours to read.
      log('interstem', 'acked mail for an address this Stem does not hold', { to: env.to });
      return done();
    }
    if (await this.mail.hasExternalEnvelope(env.id)) return done();
    const checked = await verifyEnvelope(env, this.now(), this.resolver.issuerKeys());
    if ('error' in checked) {
      degrade('interstem', `dropped mail from ${env.from}: ${checked.error}`, new Error(checked.error));
      return done();
    }
    // The certificate was checked as of the envelope's own timestamp (held
    // mail arrives late). Once it has expired that timestamp is only the
    // sender's word, so ask their home relay whether the key is still theirs:
    // a stolen, replaced key can't backdate mail past its replacement.
    if (this.now() >= env.cert.exp) {
      const stillTheirs = await keyStatus(env.cert.issuer, env.from, env.cert.keyFp).catch((e) => {
        degrade('interstem', 'could not check a late envelope’s key with its home relay', e);
        return null;
      });
      if (stillTheirs === false) {
        degrade('interstem', `dropped late mail from ${env.from}: that key is no longer theirs`, new Error('stale key'));
        return done();
      }
      // Can't confirm it: fail closed. Not acked, so the relay keeps it and
      // offers it again on the next connection (for as long as it holds mail).
      if (stillTheirs === null) return;
    }
    const contact = state.contacts[env.from];
    if (contact?.state === 'blocked') return done();

    let inner: InnerV1 | null = null;
    let unsupported = false;
    try {
      const plain = open(state.encPriv, checked.sealed, env.id, env.from, env.to);
      const parsed = JSON.parse(plain.toString('utf8')) as Partial<InnerV1> & { v?: number };
      if (
        parsed.v === 1 &&
        parsed.kind === 'mail' &&
        typeof parsed.body === 'string' &&
        /^[0-9a-f]{32}$/.test(parsed.thread ?? '')
      ) {
        inner = {
          v: 1,
          kind: 'mail',
          thread: parsed.thread!,
          body: parsed.body.slice(0, INNER_MAX_BODY),
          sentAt: typeof parsed.sentAt === 'number' ? parsed.sentAt : env.ts,
          ...(typeof parsed.subject === 'string' ? { subject: parsed.subject.slice(0, 300) } : {})
        };
      } else {
        unsupported = true;
      }
    } catch (err) {
      degrade('interstem', `could not open mail from ${env.from}`, err);
      return done();
    }

    const signer = b64(checked.signer);
    const keyFp = fingerprint(checked.signer);
    let keyChanged = false;
    await this.store.update((s) => {
      const c = s.contacts[env.from];
      if (!c) {
        s.contacts[env.from] = { address: env.from, state: 'request', authKey: signer, keyFp, firstSeen: this.now() };
      } else if (c.authKey !== signer) {
        keyChanged = true;
        c.keyChanged = true;
        c.pendingAuthKey = signer;
        delete c.pendingEncKey;
      }
    });

    const thread = inner?.thread ?? newId();
    let conversation: MailConversation | null = await this.mail.findExternalConversation(thread, env.from, env.to);
    const body = inner?.body ?? 'This mail was sent by a newer version of Stem. Update Stem to read it.';
    if (!conversation) {
      conversation = await this.mail.createConversation(inner?.subject ?? '', [], body, {
        external: { address: env.from, thread, self: env.to }
      });
    }
    const external: MailExternal = {
      envelopeId: env.id,
      held: true,
      ...(keyChanged ? { keyChanged: true } : {}),
      ...(unsupported ? { unsupported: true } : {})
    };
    await this.mail.appendMailItem({
      conversationId: conversation.id,
      from: env.from,
      to: ['user'],
      body,
      ...(inner?.subject ? { subject: inner.subject } : {}),
      external
    });
    await done();
    this.onChange();
  }

  // ---- contacts ----

  private async ownRelays(): Promise<{ relay: string; id: Identity }[]> {
    const state = await this.store.read();
    return [...new Set(state.addresses.filter((a) => a.state === 'verified').map((a) => a.relay))].map((relay) => ({
      relay,
      id: this.identity(state)
    }));
  }

  /** Accept a Request (or anyone we mailed): they may reach us and see delivery. */
  async acceptContact(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    for (const { relay, id } of await this.ownRelays()) await listOp(relay, id, 'allow', address);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (c) c.state = 'accepted';
    });
    this.onChange();
    return this.status();
  }

  async blockContact(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    for (const { relay, id } of await this.ownRelays()) {
      await listOp(relay, id, 'unallow', address).catch((e) =>
        degrade('interstem', 'could not unallow a blocked contact', e)
      );
      await listOp(relay, id, 'block', address);
    }
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (c) c.state = 'blocked';
      else s.contacts[address] = { address, state: 'blocked', authKey: '', keyFp: '', firstSeen: this.now() };
    });
    this.onChange();
    return this.status();
  }

  async unblockContact(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    for (const { relay, id } of await this.ownRelays()) await listOp(relay, id, 'unblock', address);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (c) c.state = 'request';
    });
    this.onChange();
    return this.status();
  }

  /** The user compared fingerprints in person. */
  async markVerified(raw: string, verified: boolean): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (!c) return false;
      c.verifiedByUser = verified || undefined;
      if (!verified) delete c.verifiedByUser;
    });
    this.onChange();
    return this.status();
  }

  /** Adopt a contact's new key after the user saw the change notice. */
  async acknowledgeKeyChange(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (!c?.keyChanged) return false;
      if (c.pendingAuthKey) {
        c.authKey = c.pendingAuthKey;
        c.keyFp = fingerprint(unb64(c.pendingAuthKey));
      }
      c.encKey = c.pendingEncKey;
      if (!c.encKey) delete c.encKey;
      delete c.pendingAuthKey;
      delete c.pendingEncKey;
      delete c.keyChanged;
      delete c.verifiedByUser; // a new key is a new person until checked again
    });
    // Sends that stopped on the change go out now, to the adopted key.
    const { items } = await this.mail.readMail();
    for (const item of items) {
      if (item.external?.status === 'key-changed' && item.to.includes(address))
        await this.send(item.conversationId, item.id);
    }
    this.onChange();
    return this.status();
  }

  /** Ask their relay to invite an address that isn't reachable. Always "ok". */
  async invite(raw: string, from?: string): Promise<void> {
    const address = normalizeAddress(raw);
    const self = from ?? (await this.defaultSelf());
    if (!self) throw new Error('Verify one of your addresses first.');
    const { relay } = await this.resolver.authority(address);
    await invite(relay, await this.freshCert(self), address);
  }

  // ---- outbound ----

  /** Queue the user's item for sending; progress lands on the item. */
  async send(conversationId: string, itemId: string): Promise<void> {
    const { conversations, items } = await this.mail.readMail();
    const conversation = conversations.find((c) => c.id === conversationId);
    const item = items.find((i) => i.id === itemId);
    if (!conversation?.external || !item) return;
    const { address, thread, self } = conversation.external;
    const inner: InnerV1 = {
      v: 1,
      kind: 'mail',
      thread,
      body: item.body,
      sentAt: item.at,
      ...(conversation.subject ? { subject: conversation.subject } : {})
    };
    await this.store.update((s) => {
      s.outbox = s.outbox.filter((o) => o.mailItemId !== itemId);
      s.outbox.push({
        id: newId(),
        mailItemId: itemId,
        conversationId,
        from: self,
        to: address,
        inner: JSON.stringify(inner),
        tries: 0,
        nextAt: 0,
        createdAt: this.now()
      });
    });
    await this.mail.setExternalStatus(itemId, { status: 'queued' });
    await this.processOutbox();
  }

  /** Send everything due. One pass at a time. */
  async processOutbox(): Promise<void> {
    if (this.outboxRunning) return;
    this.outboxRunning = true;
    try {
      const state = await this.store.read();
      for (const entry of state.outbox.filter((o) => o.nextAt <= this.now())) {
        // quiet: a thrown send is retried below, and the retry path degrades with the error.
        const outcome = await this.sendOne(entry).catch((err: unknown) => ({ retry: true as const, error: err }));
        if ('done' in outcome) {
          await this.store.update((s) => {
            s.outbox = s.outbox.filter((o) => o.id !== entry.id);
          });
          continue;
        }
        const giveUp = this.now() - (entry.createdAt ?? this.now()) > OUTBOX_GIVE_UP_MS;
        if (giveUp) {
          await this.mail.setExternalStatus(entry.mailItemId, {
            status: 'failed',
            error: 'Could not reach their relay for a week.'
          });
          await this.store.update((s) => {
            s.outbox = s.outbox.filter((o) => o.id !== entry.id);
          });
          continue;
        }
        degrade('interstem', `send to ${entry.to} will be retried`, outcome.error);
        await this.store.update((s) => {
          const o = s.outbox.find((x) => x.id === entry.id);
          if (o) {
            o.tries += 1;
            o.nextAt = this.now() + OUTBOX_RETRY_MS[Math.min(o.tries - 1, OUTBOX_RETRY_MS.length - 1)];
          }
        });
      }
    } finally {
      this.outboxRunning = false;
    }
  }

  private async recipientKey(
    to: string,
    id: Identity,
    relay: string
  ): Promise<{ enc: Buffer } | { status: 'unreachable' | 'key-changed' }> {
    const state = await this.store.read();
    const contact: StoredContact | undefined = state.contacts[to];
    if (contact?.keyChanged) return { status: 'key-changed' };
    const found = await lookupKey(relay, id, to);
    if (!found) return { status: 'unreachable' };
    const keys = checkKeyBlob(found.authKey, found.keyBlob);
    if (!keys) throw new Error(`${to}'s relay returned a key that does not check out.`);
    if (contact && contact.authKey && contact.authKey !== found.authKey) {
      await this.store.update((s) => {
        const c = s.contacts[to];
        if (!c) return;
        c.keyChanged = true;
        c.pendingAuthKey = found.authKey;
        c.pendingEncKey = b64(keys.encPub);
      });
      this.onChange();
      return { status: 'key-changed' };
    }
    await this.store.update((s) => {
      const c = s.contacts[to];
      if (c) c.encKey = b64(keys.encPub);
      else
        s.contacts[to] = {
          address: to,
          // We wrote to them first: a contact by our own choice.
          state: 'accepted',
          authKey: found.authKey,
          encKey: b64(keys.encPub),
          keyFp: fingerprint(keys.sigPub),
          firstSeen: this.now()
        };
    });
    return { enc: keys.encPub };
  }

  private async sendOne(
    entry: InterStemState['outbox'][number]
  ): Promise<{ done: true } | { retry: true; error: unknown }> {
    const id = await this.freshCert(entry.from);
    const { relay } = await this.resolver.authority(entry.to);
    const key = await this.recipientKey(entry.to, id, relay);
    if ('status' in key) {
      await this.mail.setExternalStatus(entry.mailItemId, {
        status: key.status,
        ...(key.status === 'unreachable'
          ? {
              error: `${entry.to} can't be reached through Stem: they aren't on Stem, or only accept mail from people they've written to.`
            }
          : { error: `${entry.to}'s key changed. Check it, then send again.` })
      });
      this.onChange();
      return { done: true };
    }
    const envelopeId = newId();
    const sealed = seal(key.enc, Buffer.from(entry.inner), envelopeId, entry.from, entry.to);
    const env = signEnvelope(
      { v: 1, id: envelopeId, ts: this.now(), from: entry.from, to: entry.to, cert: id.cert!, sealed: b64(sealed) },
      id.seed
    );
    try {
      await postMail(relay, env);
    } catch (err) {
      // quiet: every branch reports — a refusal on the item, a network error through the retry's degrade.
      if (err instanceof RelayError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        const why =
          err.code === 'queue_full'
            ? `${entry.to}'s mailbox on their relay is full.`
            : err.code === 'too_large'
              ? 'The mail is too large for their relay.'
              : `Their relay refused the mail (${err.code}).`;
        await this.mail.setExternalStatus(entry.mailItemId, { status: 'failed', error: why });
        return { done: true };
      }
      return { retry: true, error: err };
    }
    await this.mail.setExternalStatus(entry.mailItemId, { status: 'sent', envelopeId });
    // We wrote to them: they may reach us, and see what happened to their mail.
    for (const own of await this.ownRelays()) {
      await listOp(own.relay, own.id, 'allow', entry.to).catch((e) =>
        degrade('interstem', 'could not allow a recipient', e)
      );
    }
    await this.store.update((s) => {
      s.sent.push({ envelopeId, mailItemId: entry.mailItemId, from: entry.from, to: entry.to, at: this.now() });
    });
    return { done: true };
  }

  /** Learn delivery for recent sends (the relay only tells contacts who allowed us). */
  async pollStatuses(): Promise<void> {
    const state = await this.store.read();
    const live = state.sent.filter((e) => this.now() - e.at < STATUS_WINDOW_MS);
    const finished = new Set<string>();
    for (const e of live) {
      try {
        const id = await this.freshCert(e.from);
        const { relay } = await this.resolver.authority(e.to);
        const status = await mailStatus(relay, id, e.envelopeId);
        if (status === 'delivered' || status === 'expired') {
          await this.mail.setExternalStatus(e.mailItemId, { status });
          finished.add(e.envelopeId);
        }
      } catch (err) {
        degrade('interstem', 'could not check a delivery status', err);
      }
    }
    await this.store.update((s) => {
      s.sent = s.sent.filter((e) => !finished.has(e.envelopeId) && this.now() - e.at < STATUS_WINDOW_MS);
    });
  }
}

/** True when a held item must not reach any agent or model. */
export function isHeld(item: Pick<MailItem, 'external'>): boolean {
  return item.external?.held === true;
}

export type { MailListResult };
