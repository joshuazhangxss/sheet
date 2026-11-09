import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { labelStripText } from './labelStrip';
import { batchProductType } from './batchProductType';
import { drawProductionSheet } from './productionPdf';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { displayMerchant } from './batchWorkflow';
import type { Asset, ReleasedBatch } from './batchWorkflow';

export async function orderedLabelsPdf(batch: ReleasedBatch, assets: Asset[], selected?: number[], withStrip = false, paper: '4x6' | '100x150' = '4x6'): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const documents = new Map<string, PDFDocument>();
  let stripFont: PDFFont | undefined;
  if (withStrip) {
    output.registerFontkit(fontkit);
    const response = await fetch('/fonts/arial-unicode.ttf');
    if (!response.ok) throw new Error('打印字体加载失败，请重试');
    stripFont = await output.embedFont(await response.arrayBuffer(), { subset: true });
  }
  for (const [index, shipment] of batch.shipments.entries()) {
    if (selected && !selected.includes(index)) continue;
    const asset = assets.find(a => a.id === shipment.label.assetId);
    if (!asset) throw new Error(`原始标签文件缺失: ${shipment.label.sourceName}`);
    let document = documents.get(asset.id);
    if (!document) { document = await PDFDocument.load(await asset.file.arrayBuffer()); documents.set(asset.id, document); }
    const [page] = await output.copyPages(document, [shipment.label.pageNumber - 1]);
    if (!stripFont) output.addPage(page);
    else {
      const { width, height } = page.getSize();
      if (page.getRotation().angle !== 0) throw new Error('此标签带旋转设置，请先使用原始标签打印。');
      const pageWidth = paper === '100x150' ? 100 * 72 / 25.4 : 288;
      const pageHeight = paper === '100x150' ? 150 * 72 / 25.4 : 432;
      const margin = 7;
      const items = shipment.allocations.map(a => {
        const line = batch.lines.find(l => l.id === a.lineId);
        if (!line) throw new Error('标签缺少订单商品信息');
        return labelStripText(line, a.qty);
      });
      // Prefer one line; wrap between complete items before reducing type size.
      let fontSize = 11;
      const pack = (size: number) => {
        const rows: string[] = [];
        let current = '';
        for (const item of items) {
          const combined = current ? `${current} | ${item}` : item;
          if (stripFont!.widthOfTextAtSize(combined, size) <= pageWidth - margin * 2) current = combined;
          else {
            if (current) rows.push(current);
            const parts = wrap(item, stripFont!, size, pageWidth - margin * 2);
            rows.push(...parts.slice(0, -1)); current = parts.at(-1) || '';
          }
        }
        if (current) rows.push(current);
        return rows;
      };
      let texts = pack(fontSize);
      while (texts.length > 2 && fontSize > 9) { fontSize -= 0.5; texts = pack(fontSize); }
      const stripHeight = texts.length * (fontSize + 3) + 13;
      if (stripHeight > 70) throw new Error('此订单商品太多，无法在信息条内清晰排版。请使用原始标签和顺序对照单。');
      const target = output.addPage([pageWidth, pageHeight]);
      const availableHeight = pageHeight - stripHeight - margin * 2;
      const scale = Math.min((pageWidth - margin * 2) / width, availableHeight / height);
      const embedded = await output.embedPage(page);
      target.drawPage(embedded, { x: (pageWidth - width * scale) / 2, y: margin, width: width * scale, height: height * scale });
      const cutY = pageHeight - margin - stripHeight;
      target.drawLine({ start: { x: margin, y: cutY }, end: { x: pageWidth - margin, y: cutY }, thickness: 0.5, dashArray: [3, 3], color: rgb(0.5, 0.5, 0.5) });
      texts.forEach((text, i) => target.drawText(text, { x: margin, y: pageHeight - margin - fontSize - i * (fontSize + 3), size: fontSize, font: stripFont! }));
    }
  }
  if (!output.getPageCount()) throw new Error('请选择至少一个标签');
  return output.save();
}
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const result: string[] = [];
  let current = '';
  for (const char of text.replace(/[\r\n\t]/g, ' ')) {
    if (current && font.widthOfTextAtSize(current + char, size) > width) { result.push(current); current = ''; }
    current += char;
  }
  if (current) result.push(current);
  return result;
}
export async function batchDocumentPdf(batch: ReleasedBatch, kind: 'list' | 'worksheet'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const response = await fetch(kind === 'worksheet' ? '/fonts/noto-sans-sc.ttf' : '/fonts/arial-unicode.ttf');
  if (!response.ok) throw new Error('打印字体加载失败，请重试');
  const font = await doc.embedFont(await response.arrayBuffer(), { subset: kind !== 'worksheet' });
  if (kind === 'worksheet') {
    const boldResponse = await fetch('/fonts/arial-bold.ttf');
    if (!boldResponse.ok) throw new Error('打印字体加载失败，请重试');
    const numberFont = await doc.embedFont(await boldResponse.arrayBuffer(), { subset: true });
    drawProductionSheet(doc, font, batch, numberFont);
    return doc.save();
  }
  let page: PDFPage;
  let y = 0;
  let pageNumber = 0;
  function addPage() {
    page = doc.addPage([595.28, 841.89]);
    pageNumber++;
    page.drawText(kind === 'list' ? '标签顺序对照单 / Label order list' : '生产工作单 / Production worksheet', { x: 35, y: 802, size: 17, font });
    page.drawText(`批次 ${batch.id.slice(0, 8)} · ${new Date(batch.createdAt).toLocaleString()} · ${pageNumber}`, { x: 35, y: 780, size: 9, font });
    page.drawText('标签请以实际尺寸 100% 打印；对照单序号对应标签 PDF 的页码。', { x: 35, y: 30, size: 9, font });
    y = 750;
  }
  function write(text: string, size = 11) {
    for (const line of wrap(text, font, size, 520)) {
      if (y < 65) addPage();
      page.drawText(line, { x: 35, y, size, font, color: rgb(0.12, 0.18, 0.21) });
      y -= size + 5;
    }
  }
  addPage();
  const byId = new Map(batch.lines.map(l => [l.id, l]));
  if (kind === 'list') {
    batch.shipments.forEach((shipment, index) => {
      if (y < 150) addPage();
      const first = byId.get(shipment.allocations[0].lineId)!;
      write(`${String(index + 1).padStart(3, '0')}  ${displayMerchant(first)}`, 14);
      shipment.allocations.forEach(a => { const line = byId.get(a.lineId)!; write(`${batchProductType(line)} · ${line.color} · ${line.size} · ×${a.qty}${line.note.includes('★') ? ' · 加急' : ''}`); });
      y -= 14;
    });
  }

  return doc.save();
}
