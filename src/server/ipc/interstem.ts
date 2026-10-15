import { registerServer } from './guard';
import type { InterStemService } from '../interstem/service';
import type { MailRouter } from '../mail/router';
import { releaseExternalItems } from '../workspace/mail';
import { isExternalAddress } from '../../shared/types';
import { normalizeAddress, validAddress } from '../interstem/proto';

/**
 * Inter-Stem mail (docs/inter-stem-mail-design.md): this Stem's addresses and
 * contacts, plus the mail actions only external conversations have — compose
 * to an address, release held mail to agents, ask a persona for a draft.
 */
export function registerInterStemIpc(deps: { service(): InterStemService | null; router(): MailRouter | null }): void {
  const service = (): InterStemService => {
    const s = deps.service();
    if (!s) throw new Error('Mail to other Stems is not running on this server.');
    return s;
  };
  const router = (): MailRouter => {
    const r = deps.router();
    if (!r) throw new Error('Mail is not ready yet — the backend is still starting.');
    return r;
  };
  registerServer('interstem:status', () => service().status());
  registerServer('interstem:addAddress', (_e, address: string) => service().addAddress(address));
  registerServer('interstem:verifyAddress', (_e, address: string, code: string) => service().verifyAddress(address, code));
  registerServer('interstem:checkLink', (_e, address: string) => service().checkLinkVerified(address));
  registerServer('interstem:removeAddress', (_e, address: string) => service().removeAddress(address));
  registerServer('interstem:setUnlisted', (_e, unlisted: boolean) => service().setUnlisted(unlisted));
  registerServer('interstem:contact', (_e, op: 'accept' | 'block' | 'unblock' | 'verify' | 'unverify' | 'ackKey', address: string) => {
    const s = service();
    switch (op) {
      case 'accept':
        return s.acceptContact(address);
      case 'block':
        return s.blockContact(address);
      case 'unblock':
        return s.unblockContact(address);
      case 'verify':
        return s.markVerified(address, true);
      case 'unverify':
        return s.markVerified(address, false);
      case 'ackKey':
        return s.acknowledgeKeyChange(address);
    }
  });
  registerServer('interstem:invite', async (_e, address: string) => {
    await service().invite(address);
    return { ok: true };
  });
  registerServer('mail:composeExternal', async (_e, input: { to: string; subject?: string; body: string; self?: string }) => {
    const to = normalizeAddress(String(input.to ?? ''));
    if (!validAddress(to) || !isExternalAddress(to)) throw new Error('Write the email address of the person to mail.');
    const self = input.self ? normalizeAddress(input.self) : await service().defaultSelf();
    if (!self) throw new Error('Connect one of your email addresses to Stem first (Settings → Mail).');
    return router().composeExternal({ to, self, subject: typeof input.subject === 'string' ? input.subject : '', body: String(input.body ?? '') });
  });
  registerServer('mail:release', (_e, conversationId: string, itemId: string) => releaseExternalItems(conversationId, itemId));
  registerServer('mail:draftExternal', (_e, conversationId: string, personaId: string, instructions?: string) =>
    router().draftExternal(conversationId, personaId, instructions ?? '')
  );
}
