// Attachment classification, at the one boundary the user can feel: whether the
// thing they attached actually reaches the model. The PDF branch earns the
// tests — a PDF used to be silently dropped as "unsupported", and the regression
// mode (extraction quietly failing and falling back to the skip note) produces
// a turn that reads as though the feature never existed.
import { describe, expect, it } from 'vitest';
import { resolveAttachments } from '../../src/server/pi/attachments';
import { makePdf } from './make-pdf';

describe('resolveAttachments and PDFs', () => {
  it('inlines a PDF text layer as a fenced block', async () => {
    const pdf = makePdf([
      ['Prodigy ISA overview', 'Chapter 1: registers'],
      ['Chapter 2: instruction encoding']
    ]);
    const resolved = await resolveAttachments([
      { name: 'isa-manual.pdf', dataBase64: pdf.toString('base64') }
    ]);
    expect(resolved.rejected).toHaveLength(0);
    expect(resolved.images).toHaveLength(0);
    expect(resolved.textBlocks).toHaveLength(1);
    expect(resolved.textBlocks[0]).toContain('Attached file: isa-manual.pdf');
    expect(resolved.textBlocks[0]).toContain('Prodigy ISA overview');
    expect(resolved.textBlocks[0]).toContain('instruction encoding');
    expect(resolved.textBlocks[0]).not.toContain('truncated');
  });

  it('classifies by the mime type when the name has no extension', async () => {
    const pdf = makePdf([['Untitled but still a PDF']]);
    const resolved = await resolveAttachments([
      { name: 'scan-2026', mime: 'application/pdf', dataBase64: pdf.toString('base64') }
    ]);
    expect(resolved.textBlocks[0]).toContain('Untitled but still a PDF');
  });

  it('rejects a PDF that cannot be parsed', async () => {
    // The bytes a .pdf name most often lies about: something that is not a PDF
    // at all. Must land in `rejected` (the user is told), not throw a turn.
    const resolved = await resolveAttachments([
      { name: 'broken.pdf', dataBase64: Buffer.from('not really a pdf\0').toString('base64') }
    ]);
    expect(resolved.rejected).toEqual(['broken.pdf']);
    expect(resolved.textBlocks).toHaveLength(0);
  });

  it('rejects a well-formed PDF with no text layer', async () => {
    // An image-only scan parses fine and extracts nothing; with no OCR there is
    // nothing to inline, and pretending otherwise would attach an empty block.
    const resolved = await resolveAttachments([
      { name: 'scan.pdf', dataBase64: makePdf([[]]).toString('base64') }
    ]);
    expect(resolved.rejected).toEqual(['scan.pdf']);
    expect(resolved.textBlocks).toHaveLength(0);
  });
});
