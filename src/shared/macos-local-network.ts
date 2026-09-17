import { connect as netConnect } from 'node:net';

// macOS 15+ Local Network Privacy. A missing usage string (or a denied grant)
// surfaces as EHOSTUNREACH / errno 65, which looks like a missing route. Name
// the permission instead of Home Assistant or the routing table.

export const LOCAL_NETWORK_DENIED_HINT =
  'macOS blocked access to the local network. Allow Stem in System Settings → Privacy & Security → Local Network, then retry.';

const LOCAL_NETWORK_DENIED_RE = /EHOSTUNREACH|ENETUNREACH|errno 65|\[Errno 65\]|No route to host/i;

export function isLocalNetworkDenied(text: string): boolean {
  return LOCAL_NETWORK_DENIED_RE.test(text);
}

export function describeError(e: unknown): string {
  if (typeof e === 'string') return e.trim() || 'an unknown error';
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    const detail = code && !cause.message.includes(code) ? `${code}: ${cause.message}` : cause.message;
    return `${e.message} (${detail})`;
  }
  const code = (e as NodeJS.ErrnoException).code;
  if (code && !e.message.includes(code)) return `${e.message} (${code})`;
  return e.message.trim() || 'an unknown error';
}

export function withLocalNetworkHint(message: string, platform = process.platform): string {
  if (platform !== 'darwin') return message;
  if (!isLocalNetworkDenied(message)) return message;
  if (message.includes('Privacy & Security → Local Network')) return message;
  return `${message} ${LOCAL_NETWORK_DENIED_HINT}`;
}

export function mcpErrorText(e: unknown, platform = process.platform): string {
  return withLocalNetworkHint(describeError(e), platform);
}

/** A host:port on the LAN that is not loopback (loopback is not Local Network TCC). */
export interface LanTarget {
  host: string;
  port: number;
}

/**
 * Private unicast targets from an MCP spec: the HTTP url, plus any env value
 * that parses as a URL (HOMEASSISTANT_URL and friends). Public hosts are
 * ignored so a Fastmail MCP does not probe the LAN.
 */
export function lanTargetsFromSpec(spec: { url?: string; env?: Record<string, string> }): LanTarget[] {
  const values = [spec.url, ...Object.values(spec.env ?? {})].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  );
  const seen = new Set<string>();
  const out: LanTarget[] = [];
  for (const raw of values) {
    const target = parseLanTarget(raw);
    if (!target) continue;
    const key = `${target.host}:${target.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

function parseLanTarget(raw: string): LanTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLanUnicastHostname(url.hostname)) return null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host: url.hostname, port };
}

/** RFC1918 / link-local / .local — not loopback (TCC does not apply there). */
export function isLanUnicastHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return false;
  if (host.endsWith('.local') || host.endsWith('.home.arpa')) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return false;
  const [first, second] = [Number(parts[1]), Number(parts[2])];
  if (first === 127) return false;
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

/**
 * Open a short TCP connection from this process (the GUI app / pi child of
 * Electron) so macOS can show the Local Network prompt before a Python
 * grandchild tries and fails silently. ECONNREFUSED and timeouts mean the
 * path exists; only EHOSTUNREACH-class errors fail the probe.
 */
export function probeLanTargets(
  spec: { url?: string; env?: Record<string, string> },
  options: { platform?: string; timeoutMs?: number } = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? 1500;
  const targets = lanTargetsFromSpec(spec);
  return (async () => {
    for (const target of targets) {
      await connectOnce(target, timeoutMs);
    }
  })();
}

function connectOnce(target: LanTarget, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: target.host, port: target.port });
    const finish = (err?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (!err) {
        resolve();
        return;
      }
      const text = mcpErrorText(err);
      if (isLocalNetworkDenied(text)) reject(new Error(text));
      else resolve();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish());
    socket.once('error', (err: Error) => finish(err));
  });
}
