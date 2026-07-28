import { useMemo } from 'react';
import { encodeQr, qrPathData } from './qr';

/**
 * A QR code as inline SVG, one `<path>` for every dark module.
 *
 * Black on white regardless of the app's theme: a dark-mode-inverted code is
 * unreadable to a good share of phone scanners, and the quiet zone has to be
 * light too, so the symbol carries its own paper. `shapeRendering="crispEdges"`
 * stops the renderer from antialiasing module boundaries into grey seams.
 */
export function QrImage({ text, size = 168, label }: { text: string; size?: number; label: string }) {
  const symbol = useMemo(() => {
    try {
      const code = encodeQr(text);
      // 4 modules of quiet zone on every side, as the spec requires.
      return { path: qrPathData(code, 4), extent: code.size + 8 };
    } catch {
      // Only reachable if the URL somehow exceeds the encoder's largest version;
      // the copy-link button is the fallback, so say nothing and render nothing.
      return null;
    }
  }, [text]);

  if (!symbol) return null;
  return (
    <svg
      className="qr-image"
      width={size}
      height={size}
      viewBox={`0 0 ${symbol.extent} ${symbol.extent}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={symbol.extent} height={symbol.extent} fill="#ffffff" />
      <path d={symbol.path} fill="#000000" />
    </svg>
  );
}
