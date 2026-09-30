// Forwarding a mail (shared/mail-forward.ts): the quote, the note over it, the
// stored images carried back out as sendable bytes, file attachments named
// rather than dropped — and a forward's subject is one the subject writer
// treats as the user's own.
import { describe, expect, it } from 'vitest';
import {
  FORWARD_MARKER,
  forwardAttachments,
  forwardBody,
  forwardCompose,
  forwardQuote,
  forwardSubject
} from '../../src/shared/mail-forward';
import { isMadeUpMailSubject } from '../../src/server/mail/subject';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const date = (at: number) => `@${at}`;

describe('forwardSubject', () => {
  it('prefixes once', () => {
    expect(forwardSubject('Deploy plan')).toBe('Fwd: Deploy plan');
    expect(forwardSubject('Fwd: Deploy plan')).toBe('Fwd: Deploy plan');
    expect(forwardSubject('FWD: Deploy plan')).toBe('FWD: Deploy plan');
  });
});

describe('forwardAttachments', () => {
  it('re-sends stored images from their data URLs and names what it cannot carry', () => {
    const { attachments, omitted } = forwardAttachments([
      { kind: 'image', name: 'shot.png', mime: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
      { kind: 'image', dataUrl: `data:image/jpeg;base64,${PNG}` },
      { kind: 'file', name: 'report.pdf' },
      // An image too big to keep a preview of was stored as a chip only.
      { kind: 'image', name: 'huge.heic' }
    ]);
    expect(attachments).toEqual([
      { name: 'shot.png', mime: 'image/png', dataBase64: PNG },
      { name: 'image-2.jpg', mime: 'image/jpeg', dataBase64: PNG }
    ]);
    expect(omitted).toEqual(['report.pdf', 'huge.heic']);
  });

  it('is empty for a mail with no attachments', () => {
    expect(forwardAttachments(undefined)).toEqual({ attachments: [], omitted: [] });
  });
});

describe('forwardQuote / forwardBody', () => {
  const source = {
    from: 'Verifier',
    to: ['User'],
    at: 42,
    subject: 'Deploy plan',
    body: '  Ship it **Thursday**.  ',
    attachments: [
      { kind: 'image' as const, name: 'a.png', dataUrl: `data:image/png;base64,${PNG}` },
      { kind: 'file' as const, name: 'notes.txt' }
    ]
  };

  it('quotes who, when, what and the body verbatim, and accounts for every attachment', () => {
    const quote = forwardQuote(source, date);
    expect(quote.split('\n').slice(0, 7)).toEqual([
      FORWARD_MARKER,
      'From: Verifier',
      'Date: @42',
      'Subject: Deploy plan',
      'To: User',
      '',
      'Ship it **Thursday**.'
    ]);
    expect(quote).toContain('Its image is attached to this mail.');
    expect(quote).toContain('only the name was kept: notes.txt');
  });

  it('puts the note above the quote, and sends the quote alone without one', () => {
    expect(forwardBody('  Can you check this?  ', 'Q')).toBe('Can you check this?\n\nQ');
    expect(forwardBody('   ', 'Q')).toBe('Q');
  });

  it('assembles an ordinary compose: new conversation, Fwd subject, carried images', () => {
    const carried = forwardAttachments(source.attachments).attachments;
    const input = forwardCompose({
      to: ['critic'],
      subject: forwardSubject(source.subject),
      note: 'Thoughts?',
      quote: forwardQuote(source, date),
      attachments: carried
    });
    expect(input.to).toEqual(['critic']);
    expect(input.subject).toBe('Fwd: Deploy plan');
    expect(input.body.startsWith(`Thoughts?\n\n${FORWARD_MARKER}\n`)).toBe(true);
    expect(input.attachments).toEqual([{ name: 'a.png', mime: 'image/png', dataBase64: PNG }]);
    expect('private' in input).toBe(false);
    expect(forwardCompose({ to: [], subject: 's', note: '', quote: 'q', private: true }).private).toBe(true);
  });

  it('gives a subject the subject writer never replaces', () => {
    const body = forwardBody('', forwardQuote(source, date));
    expect(isMadeUpMailSubject('Fwd: Deploy plan', [{ id: 'i', conversationId: 'c', from: 'user', to: ['critic'], body, at: 1 }])).toBe(false);
  });
});
