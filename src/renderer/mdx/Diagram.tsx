import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock } from './components';

// <Diagram> draws Mermaid source (flowcharts, sequence diagrams, timelines…)
// with pele, a small synchronous Mermaid renderer. It is imported on first use
// and never by the server bundle. Links and images are off, so a diagram can
// only be a picture. Colors are CSS variables (.mdx-diagram in styles.css), so
// a theme flip recolors without a redraw. A diagram pele can't parse falls
// back to its source in a code block.
//
// While a reply is still streaming, `live` draws every complete line as it
// arrives and keeps the last drawing that worked on screen, so the diagram
// grows as the model writes it. A render takes well under a millisecond.

type Pele = typeof import('pele');
type Purify = typeof import('dompurify').default;
let engine: { pele: Pele; purify: Purify } | null = null;
let loading: Promise<{ pele: Pele; purify: Purify }> | null = null;
/** Both load on the first diagram, in their own chunk, never with the app. */
function loadPele(): Promise<{ pele: Pele; purify: Purify }> {
  loading ??= Promise.all([import('pele'), import('dompurify')]).then(([p, d]) => (engine = { pele: p, purify: d.default }));
  return loading;
}

/** The source's complete lines: the last one may still be mid-token while streaming. */
export function completeLines(source: string): string {
  const cut = source.lastIndexOf('\n');
  return cut === -1 ? '' : source.slice(0, cut);
}

function draw(code: string, idPrefix: string, maxWidth: number | undefined): string {
  const { pele, purify } = engine!;
  const css = getComputedStyle(document.documentElement);
  const { svg } = pele.render(code, {
    idPrefix,
    maxWidth,
    fontFamily: css.getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif',
    fontSize: 13,
    links: false,
    images: false
  });
  // Pele escapes labels and filters links itself; the source is model text, so
  // the SVG goes through DOMPurify's SVG profile as well.
  return purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

/** The figure's width, so pele can lay a wide flowchart out vertically on a narrow pane. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || undefined);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || undefined));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function Diagram({ title, source, live = false }: { title?: string; source?: string; live?: boolean }) {
  const idPrefix = `mdx-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const figure = useRef<HTMLElement>(null);
  const width = useWidth(figure);
  const [loaded, setLoaded] = useState(engine !== null);
  // The last drawing that worked: a streaming line that doesn't parse yet keeps it.
  const lastGood = useRef<string | null>(null);
  const code = (live ? completeLines(source ?? '') : (source ?? '')).trim();

  useEffect(() => {
    if (engine) return;
    let mounted = true;
    loadPele().then(
      () => mounted && setLoaded(true),
      (err) => console.error('[Diagram] pele failed to load:', err)
    );
    return () => {
      mounted = false;
    };
  }, []);

  const { svg, failed } = useMemo(() => {
    if (!loaded || !code) return { svg: null, failed: false };
    try {
      const svg = draw(code, idPrefix, width);
      lastGood.current = svg;
      return { svg, failed: false };
    } catch (err) {
      if (live) return { svg: lastGood.current, failed: false };
      // Surface the real reason: a bare catch here turned every diagram
      // failure into the same opaque fallback.
      console.error('[Diagram] render failed:', err);
      return { svg: null, failed: true };
    }
  }, [loaded, code, idPrefix, width, live]);

  if (!code && !live) return <div className="chart-error">This diagram is empty.</div>;
  return (
    <figure className="mdx-diagram" ref={figure}>
      {title && <figcaption className="chart-title">{title}</figcaption>}
      {svg ? (
        // Pele's output, escaped by it and sanitized again by DOMPurify.
        <div className="mdx-diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : failed ? (
        <>
          <div className="mdx-diagram-note">Couldn’t draw this diagram; here is its source.</div>
          <CodeBlock lang="mermaid" value={code} />
        </>
      ) : (
        <div className="mdx-placeholder">
          <span className="mdx-placeholder-bar" aria-hidden="true" />
          <span className="mdx-placeholder-label">Drawing diagram…</span>
        </div>
      )}
    </figure>
  );
}
