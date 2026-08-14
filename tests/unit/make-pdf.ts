/**
 * A minimal but structurally valid PDF (correct xref offsets) with one
 * Helvetica text object per page — enough for pdf.js to extract real text.
 */
export function makePdf(pages: string[][], title?: string): Buffer {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objs[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`;
  objs[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;
  objs[4] = `4 0 obj\n<< ${title ? `/Title (${title})` : ''} >>\nendobj\n`;
  pages.forEach((lines, i) => {
    const id = pageIds[i];
    const content = `BT /F1 12 Tf 50 700 Td 14 TL ${lines
      .map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`)
      .join(' ')} ET`;
    objs[id] =
      `${id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>\nendobj\n`;
    objs[id + 1] = `${id + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += objs[i];
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
