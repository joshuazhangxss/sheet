import Papa from 'papaparse';
import { extractColor, extractSize } from './orderProcessing';
import { emptyLine, normalize } from './batchWorkflow';
import type { OrderLine, PendingTable } from './batchWorkflow';

export const importFields = {
  seller: '卖家 / 账号', orderId: '订单号', tracking: '追踪号', recipient: '收件人',
  address: '街道地址', postal: '邮编', product: '产品', sku: 'SKU', size: '尺寸',
  color: '颜色', qty: '数量', note: '备注', status: '订单状态',
  fulfillment: '配送方式', itemStatus: '商品状态', shippingService: '物流服务',
} as const;
export type ImportField = keyof typeof importFields;
const aliases: Record<ImportField, string[]> = {
  seller: ['seller', 'account', 'store', 'shop', 'seller-name', 'sales-channel', '卖家', '账号', '店铺'],
  orderId: ['amazon-order-id', 'order-id', 'order-number', 'order-no', 'orderno', '订单号'],
  tracking: ['tracking-number', 'tracking-id', 'tracking', '追踪号', '运单号'],
  recipient: ['recipient-name', 'buyer-name', 'ship-to-name', 'customer-name', 'name', '姓名', '收件人', '客户'],
  address: ['ship-address-1', 'shipping-address', 'address', 'address1', 'street', '地址'],
  postal: ['ship-postal-code', 'postal-code', 'zip', 'zipcode', '邮编'],
  product: ['product-name', 'item-name', 'description', 'title', '产品', '描述'],
  sku: ['sku', 'seller-sku'], size: ['size', 'product-size', '尺寸'], color: ['color', 'colour', '颜色'],
  qty: ['quantity', 'qty', 'quantity-ordered', 'quantity-purchased', '数量'],
  note: ['note', 'notes', '备注'], status: ['order-status', 'status', '状态'],
  fulfillment: ['fulfillment-channel', 'fulfillment', '配送方式'], itemStatus: ['item-status', '商品状态'],
  shippingService: ['ship-service-level', 'shipping-service', '物流服务'],
};
export function detectMapping(headers: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.find(h => names.some(n => normalize(n) === normalize(h))) ?? '']));
}
export async function readTables(file: File, assetId: string): Promise<PendingTable[]> {
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return workbook.SheetNames.flatMap((name, index) => {
      const records = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[name], { defval: '', raw: false });
      return records.length ? [{ id: `${assetId}:${index}`, name: `${file.name} / ${name}`, records, mapping: detectMapping(Object.keys(records[0])) }] : [];
    });
  }
  const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.replace(/^\uFEFF/, '').trim() });
  if (parsed.errors.length) throw new Error(parsed.errors.map(e => `第 ${e.row ?? '?'} 行: ${e.message}`).join('; '));
  return parsed.data.length ? [{ id: assetId, name: file.name, records: parsed.data, mapping: detectMapping(parsed.meta.fields ?? []) }] : [];
}
export function tableCanImport(table: PendingTable): boolean {
  return Boolean(table.mapping.product && table.mapping.qty && (table.mapping.orderId || (table.mapping.recipient && table.mapping.size)));
}
export function tableToLines(table: PendingTable): OrderLine[] {
  const homa = (!table.mapping.orderId && Boolean(table.mapping.recipient && table.mapping.size)) || Boolean(table.mapping.recipient && table.mapping.size && table.mapping.sku && table.records.some(record => Object.keys(record).some(h => normalize(h) === 'NO')));
  let previousOrder = '';
  let previousRecipient = '';
  let group = '';
  let recipient = '';
  return table.records.map((record, index) => {
    const line = emptyLine();
    const get = (key: ImportField) => String(record[table.mapping[key]] ?? '').trim();
    for (const key of Object.keys(importFields) as ImportField[]) {
      if (key !== 'qty') line[key] = get(key);
    }
    if (homa && table.mapping.orderId) {
      const numberHeader = Object.keys(record).find(h => normalize(h) === 'NO');
      const continuation = numberHeader && !String(record[numberHeader]).trim() && !line.recipient && !line.orderId;
      if (continuation) { line.orderId = previousOrder; line.recipient = previousRecipient; }
      else { previousOrder = line.orderId; previousRecipient = line.recipient; }
      line.seller ||= 'HOMA';
    }
    if (homa && !table.mapping.orderId) {
      const numberHeader = Object.keys(record).find(h => ['NO', '序号'].includes(normalize(h)));
      const number = numberHeader ? record[numberHeader].trim() : String(index + 1);
      if (number || !group) { group = number || String(index + 1); recipient = line.recipient; }
      line.orderId = `HOMA-${table.id.slice(0, 8)}-${group}`;
      line.recipient ||= recipient;
      line.seller ||= 'HOMA';
    }
    line.id = `${table.id}:row:${index}`;
    line.source = `${table.name} · 行 ${index + 2}`;
    // Never silently turn an absent, fractional, or malformed quantity into one.
    line.qty = /^\d+$/.test(get('qty')) ? Number(get('qty')) : 0;
    line.size ||= extractSize(line.product, line.sku);
    line.color ||= line.product.match(/棕色|米色|灰色|蓝色|黄色|绿色|黑色|白色|红色|橙色|紫色/)?.[0] || extractColor(line.product, line.sku);
    if (homa && line.size) line.size = extractSize(line.size, '') || line.size;
    const statusNeedsReview = /pending|cancel|shipped|取消|待处理|已发货/i.test(line.status) && !/unshipped/i.test(line.status);
    line.reviewed = !statusNeedsReview && !/amazon|afn/i.test(line.fulfillment) && !/cancel|取消/i.test(line.itemStatus);
    if (/expedited|priority|rush|加急/i.test(line.shippingService)) line.note = `★ 加急 ${line.note}`.trim();
    return line;
  });
}
export function screenshotPrefill(text: string): Partial<OrderLine> {
  const orderId = text.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0]
    ?? text.match(/(?:order\s*(?:number|no\.?|id|#)|订单号)\s*[:#：]?\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1] ?? '';
  const tracking = text.match(/\b1Z[A-Z0-9]{16}\b/i)?.[0]
    ?? text.match(/(?:tracking\s*(?:number|no\.?|id|#)?|追踪号|运单号)\s*[:#：]?\s*([A-Z0-9][A-Z0-9 -]{7,})/i)?.[1]?.trim() ?? '';
  const quantity = text.match(/(?:quantity|qty|数量)\s*[:：]?\s*(\d+)\b/i)?.[1];
  const recipient = text.match(/(?:recipient|customer name|ship to|收件人)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim() ?? '';
  const product = text.match(/(?:product|item name|产品)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim() ?? '';
  return { orderId, tracking, recipient, product, qty: quantity ? Number(quantity) : 0,
    size: extractSize(text, ''), color: extractColor(text, ''), source: '截图录入', reviewed: false };
}


/** Pasted text and screenshot OCR share the same extraction rules. */
export function quickOrderPrefill(text: string): Partial<OrderLine> {
  text = text.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[‐‑‒–—−]/g, '-')
    .replace(/(\d{3})\s*-\s*(\d{7})\s*-\s*(\d{7})/g, '$1-$2-$3');
  const ids = [...new Set(text.match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? [])];
  if (ids.length > 1) throw new Error('检测到多个订单号，请每次粘贴一个订单商品。');
  const value = (names: string) => text.match(new RegExp(`(?:^|\\n)\\s*(?:${names})[ \\t]*(?:[:：][ \\t]*(?:\\n[ \\t]*)?|\\n[ \\t]*)([^\\n]+)`, 'i'))?.[1]?.trim() ?? '';
  if ((text.match(/^(?:product|item name|product name|description|产品|商品名称|产品名称)\s*[:：]/gim) ?? []).length > 1) throw new Error('检测到多个商品，请每次粘贴一个商品，避免漏掉数量或尺寸。');
  const base = screenshotPrefill(text);
  const labeledIds = [...text.matchAll(/(?:^|\n)\s*(?:order\s*(?:number|no\.?|id|#)|订单号|订单编号)[ \t]*[:：#]?[ \t]*(?:\n[ \t]*)?([A-Z0-9][A-Z0-9-]{3,})/gi)].map(match => match[1].toUpperCase());
  if (new Set([...ids, ...labeledIds]).size > 1) throw new Error('检测到多个订单号，请每次粘贴一个订单商品。');
  const quantity = value('quantity|qty|数量|购买数量|订购数量');
  const qty = quantity ? (/^\d+(?:\s*(?:件|个|pcs?))?$/i.test(quantity) ? parseInt(quantity, 10) : 0) : base.qty;
  const explicitType = value('type|style|类型|款式');
  const sku = value('sku|seller sku');
  const seller = value('seller|store|shop|account|卖家|商家|店铺|账号');
  const explicitSize = value('size|尺寸');
  const explicitColor = value('color|colour|颜色');
  const product = value('product|item name|产品|title|product name|description|商品|商品名称|产品名称|标题') || base.product;
  const inferredTitle = text.split(/\n/).map(s => s.replace(/^.*?\b\d{3}-\d{7}-\d{7}\b\s*/, '').replace(/\s+(?:Standard|Expedited)\b.*$/i, '').trim()).find(s => s.length > 12 && !/^(?:order|tracking|quantity|qty|size|color|seller|store|sku|recipient|ship to|订单|数量|尺寸|颜色|追踪|运单|收件人)\b/i.test(s) && !/\d{3}-\d{7}-\d{7}/.test(s) && /shade|sail|fence|screen|canopy|遮阳|围栏|阳台|四角|三角/i.test(s));
  const dimensionText = text.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, '').replace(/(\d)°(?=\s*[xX×])/g, "$1'");
  return { ...base, seller, sku, product: [product || inferredTitle || '', explicitType].filter(Boolean).join(' · '), orderId: ids[0] || labeledIds[0] || base.orderId, qty,
    size: explicitSize || extractSize(dimensionText, sku), color: (explicitColor && (extractColor(explicitColor, '') || explicitColor)) || text.match(/棕色|米色|灰色|蓝色|黄色|绿色|黑色|白色|红色|橙色|紫色/)?.[0] || extractColor(text, sku),
    note: value('note|notes|备注'), source: '粘贴录入', reviewed: false };
}

/** Split Amazon order cards before extracting fields so values never bleed between orders. */
export function pastedOrderLines(input: string): Partial<OrderLine>[] {
  const text = input.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[‐‑‒–—−]/g, '-')
    .replace(/(\d{3})\s*-\s*(\d{7})\s*-\s*(\d{7})/g, '$1-$2-$3');
  const matches = [...text.matchAll(/\b\d{3}-\d{7}-\d{7}\b/g)];
  if (matches.length <= 1) return [quickOrderPrefill(text)];
  if (new Set(matches.map(m => m[0])).size !== matches.length) throw new Error('同一订单号出现多次，请每个订单只粘贴一次；多个商品请分别添加。');
  return matches.map((match, index) => {
    const block = text.slice(match.index, matches[index + 1]?.index ?? text.length);
    // Multiple quantities indicate multiple products in one card, not one combined item.
    if ([...block.matchAll(/(?:quantity|qty|数量)\s*[:：]/gi)].length > 1) throw new Error(`订单 ${match[0]} 有多个商品，请分别添加，避免漏单。`);
    const line = quickOrderPrefill(block);
    return { ...line, size: extractSize(line.size || '', '') || line.size };
  });
}
