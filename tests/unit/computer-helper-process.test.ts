import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HelperProcess } from '../../src/desktop/computer-host/helper';

// The wire between the host and the Swift helper. A reply finds its caller by
// the envelope `id`; element-id actions (press/focus/menu/set_value) once sent
// their element as `id` too, the reply came back under the element's number,
// and every such action "timed out" after 30 s although the helper had done it.

const mac = process.platform === 'darwin';

describe.skipIf(!mac)('HelperProcess', () => {
  let dir = '';
  let helper: HelperProcess | null = null;

  afterEach(() => {
    helper?.kill();
    helper = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in helper that answers every line with what it read. */
  function echoHelper(): HelperProcess {
    dir = mkdtempSync(join(tmpdir(), 'stem-helper-'));
    const bin = join(dir, 'echo-helper');
    writeFileSync(
      bin,
      `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const obj = JSON.parse(line);
  if (obj.cmd === 'stop') process.exit(0);
  process.stdout.write(JSON.stringify({ id: obj.id, ok: true, text: JSON.stringify(obj) }) + '\\n');
});
`
    );
    chmodSync(bin, 0o755);
    return new HelperProcess(bin);
  }

  it('answers an element-id action under its own request id', async () => {
    helper = echoHelper();
    const reply = await helper.call('press', { element: 61 }, 2_000);
    expect(reply.ok).toBe(true);
    expect(JSON.parse(reply.text!)).toMatchObject({ cmd: 'press', element: 61 });
  });

  it('never lets a command field overwrite the envelope', async () => {
    helper = echoHelper();
    const reply = await helper.call('focus', { id: 999, cmd: 'bogus' }, 2_000);
    expect(reply.ok).toBe(true);
    expect(JSON.parse(reply.text!)).toMatchObject({ cmd: 'focus' });
  });
});
