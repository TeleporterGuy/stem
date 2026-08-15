import { describe, expect, it, vi } from 'vitest';
import { createSseParser, type SseBlock } from '../src/transport/sse';

/** Feed `text` one character at a time — the cruellest chunking there is. */
function drip(text: string, onBlock: (block: SseBlock) => void): void {
  const parser = createSseParser(onBlock);
  for (const char of text) parser.push(char);
}

describe('createSseParser', () => {
  it('reads a push frame as the server writes it', () => {
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push('id: abc.7\ndata: {"channel":"chats:changed","payload":null}\n\n');
    expect(blocks).toEqual([
      { id: 'abc.7', event: null, data: '{"channel":"chats:changed","payload":null}' }
    ]);
  });

  it('reads a control frame, which carries an event name and no id', () => {
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push('event: resync\ndata: {"head":"abc.99"}\n\n');
    expect(blocks).toEqual([{ id: null, event: 'resync', data: '{"head":"abc.99"}' }]);
  });

  it('does not care where the chunk boundaries fall', () => {
    const blocks: SseBlock[] = [];
    drip('id: e.1\ndata: one\n\nid: e.2\ndata: two\n\n', (block) => blocks.push(block));
    expect(blocks.map((b) => [b.id, b.data])).toEqual([
      ['e.1', 'one'],
      ['e.2', 'two']
    ]);
  });

  it('holds an incomplete block until its blank line arrives', () => {
    const onBlock = vi.fn();
    const parser = createSseParser(onBlock);
    parser.push('data: half');
    expect(onBlock).not.toHaveBeenCalled();
    parser.push(' a frame\n');
    expect(onBlock).not.toHaveBeenCalled();
    parser.push('\n');
    expect(onBlock).toHaveBeenCalledWith({ id: null, event: null, data: 'half a frame' });
  });

  it('surfaces the keepalive comment as an empty block', () => {
    // The reader counts every block as a sign of life, so a keepalive must not
    // be swallowed here — it is the only thing an idle stream sends.
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push(': keepalive\n\n');
    expect(blocks).toEqual([{ id: null, event: null, data: '' }]);
  });

  it('ignores the retry preamble the server opens with', () => {
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push('retry: 3000\n\n');
    expect(blocks).toEqual([{ id: null, event: null, data: '' }]);
  });

  it('joins multiple data fields with newlines', () => {
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push('data: first\ndata: second\n\n');
    expect(blocks[0].data).toBe('first\nsecond');
  });

  it('accepts a missing space after the field name, and CRLF endings', () => {
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push('id:x.1\r\ndata:{"channel":"a"}\r\n\r\n');
    expect(blocks).toEqual([{ id: 'x.1', event: null, data: '{"channel":"a"}' }]);
  });

  it('does not mistake a CRLF split across two chunks for the end of a block', () => {
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push('data: one\r\n\r');
    expect(blocks).toHaveLength(0);
    parser.push('\ndata: two\r\n\r\n');
    expect(blocks.map((b) => b.data)).toEqual(['one', 'two']);
  });

  it('keeps a colon inside a value', () => {
    const blocks: SseBlock[] = [];
    const parser = createSseParser((block) => blocks.push(block));
    parser.push('data: {"url":"https://example.com/x"}\n\n');
    expect(blocks[0].data).toBe('{"url":"https://example.com/x"}');
  });

  it('forgets a half-received block on reset', () => {
    const onBlock = vi.fn();
    const parser = createSseParser(onBlock);
    parser.push('data: abandoned\n');
    parser.reset();
    parser.push('\n');
    expect(onBlock).not.toHaveBeenCalled();
  });
});
