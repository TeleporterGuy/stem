import { readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { log, logFlushed } from '../../src/main/log';
import { logFilePath } from '../../src/main/workspace/paths';

describe('main-process file logger', () => {
  it('appends one structured line per call and never throws on odd payloads', async () => {
    log('test', 'first message', { a: 1 });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    log('test', 'multi\nline', circular);
    await logFlushed();

    const text = await readFile(logFilePath(), 'utf8');
    expect(text).toContain('[test] first message {"a":1}');
    expect(text).toContain('multi\\nline [unserializable payload]');
    // One line each — the embedded newline was escaped, not written.
    expect(text.split('\n').filter((l) => l.includes('[test]'))).toHaveLength(2);
  });

  it('rotates the file once past the size cap', async () => {
    await logFlushed();
    await writeFile(logFilePath(), 'x'.repeat(5 * 1024 * 1024 + 1), 'utf8');
    log('test', 'after rotation');
    await logFlushed();

    const rotated = await stat(`${logFilePath()}.1`);
    expect(rotated.size).toBeGreaterThan(5 * 1024 * 1024);
    const fresh = await readFile(logFilePath(), 'utf8');
    expect(fresh).toContain('after rotation');
    expect(fresh.length).toBeLessThan(4200);
  });
});
