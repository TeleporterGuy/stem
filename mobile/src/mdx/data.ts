// The data half of <DataTable> and <Chart>: JSON in, rows or points out.
//
// Both components read their payload from a fenced code child rather than an
// attribute, so the model can emit a hundred rows without escaping quotes. It is
// parsed with JSON.parse and nothing else — never eval, never a Function — which
// is why this file can be, and is, plain data code with no React in it. Shapes
// and coercions match src/renderer/mdx/components.tsx so a table sorts the same
// way on both screens.

export type Row = Record<string, unknown>;

/**
 * Accepts either an array of objects, or `{ columns: [...], rows: [[...], ...] }`.
 * Returns null for anything else, including invalid JSON — the caller shows the
 * raw block instead of a blank.
 */
export function parseTable(raw: string | undefined): { columns: string[]; rows: Row[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const columns: string[] = [];
      for (const r of parsed) {
        if (r && typeof r === 'object') {
          for (const k of Object.keys(r as Row)) if (!columns.includes(k)) columns.push(k);
        }
      }
      return { columns, rows: parsed as Row[] };
    }
    if (parsed && Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      const columns = parsed.columns.map(String);
      const rows = (parsed.rows as unknown[][]).map((arr) => {
        const o: Row = {};
        columns.forEach((c: string, i: number) => (o[c] = arr[i]));
        return o;
      });
      return { columns, rows };
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Numeric-aware comparison: sort as numbers when both sides parse, else as text. */
export function compareCells(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && cellText(a) !== '' && cellText(b) !== '') {
    return na - nb;
  }
  return cellText(a).localeCompare(cellText(b));
}

export function sortRows(rows: Row[], col: string, dir: 1 | -1): Row[] {
  return rows.slice().sort((a, b) => dir * compareCells(a[col], b[col]));
}

export interface Point {
  label: string;
  value: number;
}

/** `[{ label, value }, ...]`; entries whose value is not finite are dropped. */
export function parseSeries(raw: string | undefined): Point[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const pts = parsed
        .map((d) => ({ label: String((d as Point)?.label ?? ''), value: Number((d as Point)?.value) }))
        .filter((d) => Number.isFinite(d.value));
      return pts.length ? pts : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Where each bar starts and how long it runs, as fractions of the track, given a
 * domain that always includes zero. Signed series therefore share one baseline
 * instead of the minimum bar vanishing — the same fix the desktop chart carries.
 */
export function barGeometry(series: Point[]): Array<{ offset: number; length: number }> {
  const max = Math.max(0, ...series.map((d) => d.value));
  const min = Math.min(0, ...series.map((d) => d.value));
  const span = max - min || 1;
  const zero = (0 - min) / span;
  return series.map((d) => {
    const at = (d.value - min) / span;
    return { offset: Math.min(zero, at), length: Math.abs(at - zero) };
  });
}
