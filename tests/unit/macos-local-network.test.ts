import { describe, expect, it } from 'vitest';
import {
  LOCAL_NETWORK_DENIED_HINT,
  describeError,
  isLanUnicastHostname,
  lanTargetsFromSpec,
  mcpErrorText,
  probeLanTargets,
  withLocalNetworkHint
} from '../../src/shared/macos-local-network';

describe('mcpErrorText', () => {
  it('unwraps fetch failed causes the way provider-auth does', () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.178.67:8123'), { code: 'EHOSTUNREACH' });
    const err = new Error('fetch failed', { cause });
    expect(describeError(err)).toContain('EHOSTUNREACH');
  });

  it('names Local Network permission on darwin, and only there', () => {
    const raw = 'OSError: [Errno 65] No route to host';
    expect(withLocalNetworkHint(raw, 'linux')).toBe(raw);
    expect(withLocalNetworkHint(raw, 'darwin')).toContain(LOCAL_NETWORK_DENIED_HINT);
    expect(mcpErrorText(raw, 'darwin')).not.toMatch(/Home Assistant|routing/i);
    // Idempotent: already-hinted text is not doubled.
    const hinted = withLocalNetworkHint(raw, 'darwin');
    expect(withLocalNetworkHint(hinted, 'darwin')).toBe(hinted);
  });

  it('does not treat a public-host failure as Local Network', () => {
    expect(withLocalNetworkHint('ENOTFOUND api.example.com', 'darwin')).toBe('ENOTFOUND api.example.com');
  });
});

describe('lanTargetsFromSpec', () => {
  it('takes the HTTP url and env values that parse as private URLs', () => {
    expect(
      lanTargetsFromSpec({
        url: 'http://192.168.178.67:8123/mcp',
        env: {
          HOMEASSISTANT_URL: 'http://192.168.178.67:8123',
          HA_TOKEN: 'secret',
          PUBLIC: 'https://api.fastmail.com/mcp'
        }
      })
    ).toEqual([{ host: '192.168.178.67', port: 8123 }]);
  });

  it('keeps .local and RFC1918 and drops loopback', () => {
    expect(lanTargetsFromSpec({ url: 'http://homeassistant.local:8123' })).toEqual([
      { host: 'homeassistant.local', port: 8123 }
    ]);
    expect(lanTargetsFromSpec({ url: 'http://10.0.0.5' })).toEqual([{ host: '10.0.0.5', port: 80 }]);
    expect(lanTargetsFromSpec({ url: 'http://127.0.0.1:8123' })).toEqual([]);
    expect(lanTargetsFromSpec({ url: 'http://localhost:8123' })).toEqual([]);
  });

  it('does not treat a public URL as a LAN target', () => {
    expect(isLanUnicastHostname('api.openai.com')).toBe(false);
    expect(lanTargetsFromSpec({ url: 'https://mcp.gmail.com' })).toEqual([]);
  });
});

describe('probeLanTargets', () => {
  it('is a no-op off darwin even when the spec is a LAN URL', async () => {
    await expect(
      probeLanTargets({ url: 'http://192.168.178.67:8123' }, { platform: 'linux', timeoutMs: 50 })
    ).resolves.toBeUndefined();
  });
});
