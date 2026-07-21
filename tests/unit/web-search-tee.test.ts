// The bridge extension's web-search tee: extractWebSearchEvent turns raw provider
// Responses stream events (teed off the WebSocket/SSE transport) into the payloads
// forwarded to Stem. Pure function — the wrapping/emit paths are exercised live.
import { describe, expect, it } from 'vitest';
import { extractWebSearchEvent } from '../../src/main/pi/stem-mcp-extension.mjs';

describe('extractWebSearchEvent', () => {
  it('maps output_item.added web_search_call to a started payload', () => {
    expect(
      extractWebSearchEvent({
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress', action: { type: 'search', query: '' } }
      })
    ).toEqual({ phase: 'started', id: 'ws_1', query: undefined, status: 'in_progress' });
  });

  it('maps output_item.done to completed with the resolved query', () => {
    expect(
      extractWebSearchEvent({
        type: 'response.output_item.done',
        item: {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', query: 'weather bratislava' }
        }
      })
    ).toEqual({ phase: 'completed', id: 'ws_1', query: 'weather bratislava', status: 'completed' });
  });

  it('maps url_citation annotations to source payloads', () => {
    expect(
      extractWebSearchEvent({
        type: 'response.output_text.annotation.added',
        annotation: { type: 'url_citation', url: 'https://example.com/a', title: 'Example' }
      })
    ).toEqual({ phase: 'source', url: 'https://example.com/a', title: 'Example' });
  });

  it('sweeps url_citation annotations from a completed message item', () => {
    // The codex backend repeats every citation in the final message item's
    // content[].annotations; streamed annotation.added events are not reliable
    // on all transports, so the extractor must sweep the item too.
    expect(
      extractWebSearchEvent({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          id: 'msg_1',
          content: [
            {
              type: 'output_text',
              text: 'answer',
              annotations: [
                { type: 'url_citation', url: 'https://a.example', title: 'A', start_index: 10, end_index: 20 },
                { type: 'file_citation', file_id: 'f1' },
                { type: 'url_citation', url: 'https://b.example' }
              ]
            }
          ]
        }
      })
    ).toEqual([
      { phase: 'source', url: 'https://a.example', title: 'A' },
      { phase: 'source', url: 'https://b.example', title: undefined }
    ]);
  });

  it('returns null for a message item without citations', () => {
    expect(
      extractWebSearchEvent({
        type: 'response.output_item.done',
        item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }
      })
    ).toBeNull();
    expect(
      extractWebSearchEvent({
        type: 'response.output_item.added',
        item: { type: 'message', id: 'msg_1', content: [] }
      })
    ).toBeNull();
  });

  it('returns null for everything else', () => {
    expect(extractWebSearchEvent({ type: 'response.output_text.delta', delta: 'x' })).toBeNull();
    expect(extractWebSearchEvent({ type: 'response.output_item.added', item: { type: 'reasoning' } })).toBeNull();
    expect(extractWebSearchEvent({ type: 'response.output_text.annotation.added', annotation: { type: 'file_citation' } })).toBeNull();
    expect(extractWebSearchEvent(null)).toBeNull();
    expect(extractWebSearchEvent('nope')).toBeNull();
  });
});
