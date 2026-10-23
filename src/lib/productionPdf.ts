import { batchProductType } from './batchProductType';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import { isPrivacyFenceType } from './orderProcessing';
import type { ReleasedBatch } from './batchWorkflow';

type Row = { size: string; note: string; qty: number; orderMarker: string; sectionTitle?: string };
export function productionColumns(batch: ReleasedBatch) {
  const lines = new Map(batch.lines.map(line => [line.id, line]));
  const orderVariants = new Map<string, Set<string>>();
  const orderNumbers = new Map<string, number>();
  for (const shipment of batch.shipments) for (const allocation of shipment.allocations) {
    const line = lines.get(allocation.lineId);
    if (!line) throw new Error('生产工作单缺少订单明细');
    const key = JSON.stringify([line.seller, line.orderId]);
    const variants = orderVariants.get(key) ?? new Set<string>();
    variants.add(JSON.stringify([line.color.trim(), line.size.trim()]));
    orderVariants.set(key, variants);

  }
  for (const [key, variants] of orderVariants) {
    if (variants.size > 1) orderNumbers.set(key, orderNumbers.size);
  }
  const columns = new Map<string, { title: string; privacy: boolean; rows: Map<string, Row> }>();
  for (const shipment of batch.shipments) for (const allocation of shipment.allocations) {
    const line = lines.get(allocation.lineId);
    if (!line) throw new Error('生产工作单缺少订单明细');
    const type = batchProductType(line);
    const privacy = isPrivacyFenceType(type);
    const title = `${line.color}${privacy ? '（阳）' : ''}`;
    const column = columns.get(title) ?? { title, privacy, rows: new Map<string, Row>() };
    const mark = type === '直边加环' ? '直+环' : type === '直边' ? '直' : '';
    const remainingNote = mark ? line.note.replace(/直边加环|直边|直\s*[+＋]\s*环|加环|打环|(?:^|\s)[直环](?=\s|$)/g, ' ').trim() : line.note;
    const note = [mark, remainingNote].filter(Boolean).join(' ');
    const orderKey = JSON.stringify([line.seller, line.orderId]);
    const orderMarker = orderNumbers.has(orderKey) ? Array.from({ length: Math.floor(orderNumbers.get(orderKey)! / 26) + 1 }, () => String.fromCodePoint(0x24d0 + orderNumbers.get(orderKey)! % 26)).join('') : '';
    const key = JSON.stringify([line.size, note, orderMarker]);
    const row = column.rows.get(key) ?? { size: line.size, note, qty: 0, orderMarker };
    row.qty += allocation.qty;
    column.rows.set(key, row);
    columns.set(title, column);
  }
  const colors = ['棕色', '米色', '灰色', '蓝色', '黄色', '绿色', '黑色', '白色'];
  return [...columns.values()].sort((a, b) => Number(a.privacy) - Number(b.privacy) || (colors.indexOf(a.title.replace('（阳）', '')) + 1 || 99) - (colors.indexOf(b.title.replace('（阳）', '')) + 1 || 99)).map(column => ({
    title: column.title,
    rows: [...column.rows.values()].sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }) || a.note.localeCompare(b.note)),
  }));
}

/** Compact landscape columns; wrap text and use another page only when needed. */
export function drawProductionSheet(doc: PDFDocument, font: PDFFont, batch: ReleasedBatch, numberFont: PDFFont = font) {
  const groups = productionColumns(batch);
  const regular = groups.filter(g => !g.title.endsWith('（阳）'));
  const privacy = groups.filter(g => g.title.endsWith('（阳）'));
  const stacks: typeof groups[] = [[], []];
  for (const group of privacy) {
    const weight = (stack: typeof groups) => stack.reduce((n, g) => n + g.rows.length + 2, 0);
    stacks[weight(stacks[0]) <= weight(stacks[1]) ? 0 : 1].push(group);
  }
  const columns = [...regular, ...stacks.filter(stack => stack.length).map(stack => ({
    title: stack[0].title,
    rows: stack.flatMap((group, i) => [
      ...(i ? [{ size: '', note: '', qty: 0, orderMarker: '', sectionTitle: group.title }] : []),
      ...group.rows,
    ]),
  }))];
  const fontFor = (char: string) => /[0-9.×='’”"]/.test(char) ? numberFont : font;
  const measure = (value: string, size: number) => [...value].reduce((sum, char) => sum + fontFor(char).widthOfTextAtSize(char, size), 0);
  const size = 16;
  const leading = 19;
  const width = 792, height = 612, margin = 16, available = width - margin * 2;
  const text = (row: Row) => row.sectionTitle ?? `${row.orderMarker}${row.size.replace(/\s*X\s*/g, '×')}${row.qty > 1 ? `=${row.qty}` : ''}${row.note ? ` ${row.note.replace(/★\s*加急/g, '★')}` : ''}`;
  const prepared = columns.map(column => ({ ...column, width: Math.min(180, Math.max(78, ...column.rows.map(row => measure(text(row), size) + 10), measure(column.title, size) + 10)) }));
  const bands: typeof prepared[] = [];
  let band: typeof prepared = [];
  for (const column of prepared) {
    if (band.length && band.length >= Math.floor(available / 78)) { bands.push(band); band = []; }
    band.push(column);
  }
  if (band.length) bands.push(band);
  for (const band of bands) {
    const naturalWidth = band.reduce((sum, c) => sum + c.width, 0);
    const widths = band.map(c => c.width * available / naturalWidth);
    const wrapped = band.map((c, i) => c.rows.map(row => {
      const rowSize = Math.max(11, Math.min(size, size * (widths[i] - 10) / measure(text(row), size)));
      const result: string[] = []; let current = '';
      for (const char of text(row)) {
        if (current && measure(current + char, rowSize) > widths[i] - 10) { result.push(current); current = ''; }
        current += char;
      }
      if (current) result.push(current);
      return { lines: result, size: rowSize, sectionTitle: row.sectionTitle };
    }).flatMap(({ lines, size: rowSize, sectionTitle }) => {
      // Keep even unusually long manual notes printable across pages.
      const chunks: { lines: string[]; size: number; sectionTitle?: string }[] = [];
      const maxLines = Math.floor((height - 70 - margin) / leading);
      for (let offset = 0; offset < lines.length; offset += maxLines) chunks.push({ lines: lines.slice(offset, offset + maxLines), size: rowSize, sectionTitle });
      return chunks;
    }));
    const cursors = band.map(() => 0);
    do {
      const page = doc.addPage([width, height]);
      const bold = (value: string, x: number, y: number, fontSize: number) => {
        for (const char of value) {
          const selectedFont = fontFor(char);
          page.drawText(char, { x, y, size: fontSize, font: selectedFont });
          x += selectedFont.widthOfTextAtSize(char, fontSize);
        }
      };
      page.drawText(new Date(batch.createdAt).toLocaleDateString(), { x: margin, y: height - 23, size: 10, font });
      let x = margin;
      band.forEach((column, i) => {
        if (cursors[i] >= wrapped[i].length) { x += widths[i]; return; }
        const activeTitle = [...wrapped[i].slice(0, cursors[i])].reverse().find(row => row.sectionTitle)?.sectionTitle ?? column.title;
        const headerSize = Math.min(size, size * (widths[i] - 10) / measure(activeTitle, size));
        bold(activeTitle, x + 5, height - 45, headerSize);
        if (cursors[i]) page.drawText('续页', { x: x + 5, y: height - 30, size: 8, font });
        page.drawLine({ start: { x, y: height - 51 }, end: { x: x + widths[i], y: height - 51 }, thickness: 0.6, color: rgb(0.55, 0.55, 0.55) });
        let y = height - 70;
        while (cursors[i] < wrapped[i].length) {
          const row = wrapped[i][cursors[i]];
          if (y - (row.lines.length - 1) * leading - (row.sectionTitle ? leading + 12 : 0) < margin) break;
          if (row.sectionTitle) {
            y -= 10;
            page.drawLine({ start: { x, y: y + leading - 4 }, end: { x: x + widths[i], y: y + leading - 4 }, thickness: 0.5, color: rgb(0.65, 0.65, 0.65) });
          }
          for (const line of row.lines) { bold(line, x + 5, y, row.size); y -= leading; }
          y -= 3;
          cursors[i]++;
        }
        if (i) page.drawLine({ start: { x, y: height - 31 }, end: { x, y: Math.max(margin, y + 8) }, thickness: 0.5, color: rgb(0.65, 0.65, 0.65) });
        x += widths[i];
      });
    } while (cursors.some((cursor, i) => cursor < wrapped[i].length));
  }
}
