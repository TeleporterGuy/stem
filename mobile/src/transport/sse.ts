// The SSE wire format, parsed by hand.
//
// The phone does not use EventSource for the same reason the desktop doesn't
// (src/desktop/proxy.ts): EventSource has no way to set a request header, and
// every route on Stem's transport but /pair wants `authorization: Bearer …`.
// Moving the credential into the query string to please the browser API would
// put it in every proxy log between here and the server, so the reader is
// hand-rolled over a streaming fetch instead and this file is the half of it
// that has nothing to do with sockets.
//
// Kept deliberately free of React, Expo and fetch so it can be unit-tested by
// feeding it strings — including strings split at the cruellest places, which is
// the whole point of a parser that reads from a network stream. A chunk boundary
// can land in the middle of a field name, between the two newlines that end a
// block, or between the \r and the \n of a CRLF, and none of those may lose a
// frame.
//
// Tolerant where the spec is and the desktop's reader is not: `data:x` (no
// space) and CRLF line endings both parse here. Stem's own server writes neither
// — it always writes `data: ` and bare LF — but this reader sits behind a
// reverse proxy on someone else's VPS, and being strict about a detail no
// producer depends on buys nothing.

/** One SSE block: everything between two blank lines. */
export interface SseBlock {
  /** Every `data:` field of the block, joined with newlines. '' when it had none. */
  data: string;
  /**
   * The `event:` name, or null for an ordinary push. This is the field that
   * makes a control frame structurally distinguishable from a `{channel, payload}`
   * push — see the comment on controlFrame() in src/server/transport/server.ts.
   */
  event: string | null;
  /** The `id:` bookmark, echoed back as Last-Event-ID on reconnect. Null when absent. */
  id: string | null;
}

export interface SseParser {
  /** Feed one decoded chunk of the response body. */
  push(chunk: string): void;
  /** Drop a half-received block. Called when a stream is replaced, never mid-block. */
  reset(): void;
}

/** Any of the three block separators SSE allows. */
const BLOCK_END = /\r\n\r\n|\n\n|\r\r/;

/** One field line: `name`, `name:value`, or `name: value`. */
const FIELD = /^([^:]*):?[ ]?(.*)$/;

/**
 * A parser that calls `onBlock` once per complete block, in arrival order.
 *
 * Blocks that carry no field at all (`: keepalive`, which is a comment, and the
 * `retry: 3000` preamble) still reach `onBlock` — with empty data and a null
 * event — because the reader above wants to know that *something* arrived: a
 * keepalive is the only proof a quiet stream is still alive, and dropping it
 * here would leave the stall timer with nothing to reset.
 */
export function createSseParser(onBlock: (block: SseBlock) => void): SseParser {
  let buffer = '';

  const parseBlock = (block: string): SseBlock => {
    const data: string[] = [];
    let event: string | null = null;
    let id: string | null = null;
    for (const rawLine of block.split(/\r\n|\n|\r/)) {
      // A leading colon is a comment, which includes the server's keepalive.
      if (rawLine.startsWith(':')) continue;
      const match = FIELD.exec(rawLine);
      if (!match) continue;
      const [, name, value] = match;
      if (name === 'data') data.push(value);
      else if (name === 'event') event = value;
      else if (name === 'id') id = value;
      // `retry:` is the server telling us its preferred backoff. Ours is the
      // desktop's (250ms doubling to 10s), which is strictly more eager than the
      // 3s the server suggests, so the field is read and discarded.
    }
    return { data: data.join('\n'), event, id };
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      for (;;) {
        const end = BLOCK_END.exec(buffer);
        if (!end) return;
        const block = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        onBlock(parseBlock(block));
      }
    },
    reset(): void {
      buffer = '';
    }
  };
}
