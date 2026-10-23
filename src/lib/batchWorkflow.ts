import { extractCompanyName } from './orderProcessing';
import type { LabelPage } from '../types';

export type OrderLine = {
  id: string; seller: string; orderId: string; tracking: string; recipient: string;
  address: string; postal: string; product: string; sku: string; size: string;
  color: string; qty: number; note: string; source: string; excluded: boolean;
  reviewed: boolean; status: string; fulfillment: string; itemStatus: string; shippingService: string;
};
export type BatchLabel = LabelPage & { assetId: string; excluded: boolean; sequenceOrderId?: string; ocr?: boolean };
export type Allocation = { lineId: string; qty: number };
export type Assignment = { allocations: Allocation[]; confirmed: boolean };
export type Shipment = { label: BatchLabel; allocations: Allocation[]; confirmed: boolean; reason: string };
export type Asset = { id: string; name: string; file: Blob };
export type PendingTable = { id: string; name: string; records: Record<string, string>[]; mapping: Record<string, string> };
export type Screenshot = { id: string; assetId: string; text: string; reviewed: boolean; lineIds?: string[] };
export type ReleasedBatch = { id: string; revises?: string; createdAt: string; lines: OrderLine[]; shipments: Shipment[]; downloads: { at: string; kind: string }[] };
export type BatchDraft = {
  version: 1; id: string; revises?: string; lines: OrderLine[]; labels: BatchLabel[]; assignments: Record<string, Assignment>;
  assets: Asset[]; pending: PendingTable[]; screenshots: Screenshot[]; history: ReleasedBatch[];
  releasedId: string | null; warnings: string[];
};
export const newId = () => crypto.randomUUID();
export function emptyBatch(): BatchDraft {
  return { version: 1, id: newId(), lines: [], labels: [], assignments: {}, assets: [], pending: [], screenshots: [], history: [], releasedId: null, warnings: [] };
}
export function emptyLine(): OrderLine {
  return { id: newId(), seller: '', orderId: '', tracking: '', recipient: '', address: '', postal: '', product: '', sku: '', size: '', color: '', qty: 1, note: '', source: '手动录入', excluded: false, reviewed: true, status: '', fulfillment: '', itemStatus: '', shippingService: '' };
}
export function normalize(value: string): string { return value.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, ''); }
export function orderKey(line: OrderLine): string {
  const canonical = (value: string) => value.normalize('NFKC').trim().toUpperCase();
  return JSON.stringify([canonical(line.seller), canonical(line.orderId) || line.id]);
}
export function lineIdentity(line: OrderLine): string {
  return [orderKey(line), normalize(line.sku), normalize(line.product), normalize(line.size), normalize(line.color)].join('|');
}
// Match identifiers as complete tokens, allowing spaces/hyphens within long identifiers.
export function containsIdentifier(text: string, identifier: string): boolean {
  const tokens = identifier.trim().match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return false;
  const compact = tokens.join('');
  const pattern = compact.length >= 8 ? [...compact].join('[\\s-]*') : tokens.join('[\\s-]*');
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}
export function suggestShipments(lines: OrderLine[], labels: BatchLabel[], assignments: Record<string, Assignment>): Shipment[] {
  const groups = new Map<string, OrderLine[]>();
  lines.filter(l => !l.excluded).forEach(l => groups.set(orderKey(l), [...(groups.get(orderKey(l)) ?? []), l]));
  const result = labels.filter(l => !l.excluded).map(label => {
    const saved = assignments[label.id];
    if (saved) return { label, ...saved, reason: saved.confirmed ? '已人工确认' : '待确认分配' };
    const exact = [...groups.values()].filter(group => group.some(l =>
      (l.orderId && containsIdentifier(label.text, l.orderId)) || (l.tracking && containsIdentifier(label.text, l.tracking))));
    if (exact.length === 1) {
      const strong = exact[0].some(l =>
        (normalize(l.orderId).length >= 6 && containsIdentifier(label.text, l.orderId)) ||
        (normalize(l.tracking).length >= 8 && containsIdentifier(label.text, l.tracking)));
      if (label.sequenceOrderId && !exact[0].some(l => l.orderId === label.sequenceOrderId)) return { label, allocations: [], confirmed: false, reason: '标签订单号与 PDF 汇总订单号冲突' };
      return { label, allocations: exact[0].map(l => ({ lineId: l.id, qty: l.qty })), confirmed: strong,
        reason: strong ? '订单号 / 追踪号匹配' : '订单标识较短，请核对原件确认' };
    }
    if (exact.length > 1) return { label, allocations: [], confirmed: false, reason: '多个订单标识冲突，请人工选择' };
    if (label.sequenceOrderId) {
      const sequence = [...groups.values()].filter(group => group.some(l => l.orderId === label.sequenceOrderId));
      if (sequence.length === 1) return { label, allocations: sequence[0].map(l => ({ lineId: l.id, qty: l.qty })), confirmed: true, reason: 'PDF 汇总订单号匹配' };
    }
    const soft = [...groups.values()].filter(group => group.some(l => l.recipient.trim().length >= 4 && normalize(label.text).includes(normalize(l.recipient)) && (!l.postal || containsIdentifier(label.text, l.postal))));
    return { label, allocations: soft.length === 1 ? soft[0].map(l => ({ lineId: l.id, qty: l.qty })) : [], confirmed: false, reason: soft.length === 1 ? '姓名 / 邮编建议，需确认' : '未匹配，请选择订单' };
  });
  const counts = new Map<string, number>();
  result.forEach(s => s.allocations.forEach(a => counts.set(a.lineId, (counts.get(a.lineId) ?? 0) + 1)));
  return result.map(s => !assignments[s.label.id] && s.allocations.some(a => (counts.get(a.lineId) ?? 0) > 1)
    ? { ...s, confirmed: false, reason: '同一订单有多个标签，请分配每包数量并确认' } : s);
}
export function lineProblems(line: OrderLine): string[] {
  if (line.excluded) return [];
  const problems: string[] = [];
  if (!line.orderId.trim()) problems.push('缺少订单号');
  if (!line.product.trim()) problems.push('缺少产品');
  if (!line.size.trim() || /待确认|未识别/.test(line.size)) problems.push('缺少尺寸');
  if (!line.color.trim() || /待确认|未识别|未知/.test(line.color)) problems.push('缺少颜色');
  if (!Number.isSafeInteger(line.qty) || line.qty < 1) problems.push('数量必须为正整数');
  return problems;
}
// Scope by the whole matched order, so a missing item allocation cannot disappear.
export function labelOrderLines(lines: OrderLine[], shipments: Shipment[]): OrderLine[] {
  const byId = new Map(lines.map(line => [line.id, line]));
  const keys = new Set(shipments.flatMap(s => s.allocations.flatMap(a => {
    const line = byId.get(a.lineId);
    return line && !line.excluded ? [orderKey(line)] : [];
  })));
  return lines.filter(line => !line.excluded && keys.has(orderKey(line)));
}

export function batchProblems(draft: BatchDraft, shipments: Shipment[]): string[] {
  const problems: string[] = [];
  const active = labelOrderLines(draft.lines, shipments);
  if (!active.length) problems.push('请添加订单');
  if (!shipments.length) problems.push('请添加实际运输标签');
  active.forEach(l => lineProblems({ ...l, reviewed: true }).forEach(p => problems.push(`${l.orderId || l.source}: ${p}`)));
  const labelTexts = new Set<string>();
  const trackingNumbers = new Set<string>();
  shipments.forEach(({ label }) => {
    const text = normalize(label.text);
    const tracking = label.text.match(/\b1Z[0-9A-Z]{16}\b/i)?.[0]
      ?? label.text.match(/tracking\s*(?:number|id|no\.?)?\s*[:#]?\s*([A-Z0-9-]{8,})/i)?.[1];
    if (text.length >= 40 && labelTexts.has(text)) problems.push(`${label.sourceName} p${label.pageNumber}: 重复标签文字，请排除重复页`);
    if (tracking && trackingNumbers.has(normalize(tracking))) problems.push(`${label.sourceName} p${label.pageNumber}: 重复追踪号，请排除重复标签`);
    labelTexts.add(text);
    if (tracking) trackingNumbers.add(normalize(tracking));
  });
  const used = new Map<string, number>();
  const activeIds = new Set(active.map(l => l.id));
  shipments.forEach(s => {
    if (!s.confirmed || !s.allocations.length) problems.push(`${s.label.sourceName} p${s.label.pageNumber}: 标签待确认`);
    s.allocations.forEach(a => {
      if (!activeIds.has(a.lineId) || !Number.isSafeInteger(a.qty) || a.qty <= 0) problems.push(`标签 p${s.label.pageNumber}: 分配无效`);
      used.set(a.lineId, (used.get(a.lineId) ?? 0) + a.qty);
    });
    const keys = new Set(s.allocations.map(a => orderKey(active.find(l => l.id === a.lineId) ?? emptyPlaceholder)));
    if (keys.size > 1) problems.push(`标签 p${s.label.pageNumber}: 不可混合不同订单`);
  });
  active.forEach(l => { if (used.get(l.id) !== l.qty) problems.push(`${l.orderId}: 标签分配 ${used.get(l.id) ?? 0} / 订单数量 ${l.qty}`); });
  const ancestors = new Set<string>();
  let ancestor = draft.revises;
  while (ancestor && !ancestors.has(ancestor)) { ancestors.add(ancestor); ancestor = draft.history.find(b => b.id === ancestor)?.revises; }
  const released = new Set(draft.history.filter(b => !ancestors.has(b.id)).flatMap(b => b.lines.map(orderKey)));
  active.forEach(l => { if (released.has(orderKey(l))) problems.push(`${l.orderId}: 已在历史批次发布，请从历史批次补打`); });
  const seen = new Set<string>();
  active.forEach(l => { const key = lineIdentity(l); if (seen.has(key)) problems.push(`${l.orderId}: 重复商品行，请合并数量或排除重复行`); seen.add(key); });
  return [...new Set(problems)];
}
const emptyPlaceholder = { seller: '', orderId: '', id: 'missing' } as OrderLine;
export function releaseBatch(draft: BatchDraft): ReleasedBatch {
  const shipments = suggestShipments(draft.lines, draft.labels, draft.assignments);
  const problems = batchProblems(draft, shipments);
  if (problems.length) throw new Error(problems.join('\n'));
  shipments.sort((a, b) => {
    const left = draft.lines.find(l => l.id === a.allocations[0].lineId)!;
    const right = draft.lines.find(l => l.id === b.allocations[0].lineId)!;
    return `${left.seller} ${left.orderId}`.localeCompare(`${right.seller} ${right.orderId}`, undefined, { numeric: true }) || a.label.id.localeCompare(b.label.id);
  });
  return structuredClone({ id: draft.id, revises: draft.revises, createdAt: new Date().toISOString(), lines: labelOrderLines(draft.lines, shipments), shipments, downloads: [] });
}
export async function fingerprint(blob: Blob): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('warehouse-batches', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function loadDraft(): Promise<BatchDraft | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', 'readonly');
    const request = tx.objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export async function saveDraft(draft: BatchDraft): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', 'readwrite');
    tx.objectStore('workspace').put(draft, 'current');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('保存取消')); };
  });
}

export function reviseBatch(draft: BatchDraft, batch: ReleasedBatch): BatchDraft {
  if (draft.history.some(b => b.revises === batch.id)) throw new Error('此版本已有修订，请选择最新版本');
  return { ...emptyBatch(), revises: batch.id, assets: draft.assets, history: draft.history,
    lines: structuredClone(batch.lines), labels: structuredClone(batch.shipments.map(s => s.label)),
    assignments: Object.fromEntries(batch.shipments.map(s => [s.label.id, { allocations: structuredClone(s.allocations), confirmed: true }])),
  };
}

export function scopeToLabelOrders(draft: BatchDraft): BatchDraft {
  const shipments = suggestShipments(draft.lines, draft.labels, draft.assignments);
  if (!shipments.length || shipments.some(s => !s.allocations.length)) throw new Error('请先为所有标签找到订单，再缩小本批范围');
  const included = new Set(shipments.flatMap(s => s.allocations.map(a => a.lineId)));
  return { ...draft, lines: draft.lines.map(l => included.has(l.id) ? l : { ...l, excluded: true }) };
}

export function canConfirmSequence(shipments: Shipment[], lines: OrderLine[]): boolean {
  if (!shipments.length) return false;
  const seen = new Set<string>();
  return shipments.every(s => {
    const id = s.label.sequenceOrderId;
    if (!id || seen.has(id) || !s.allocations.length) return false;
    seen.add(id);
    return s.allocations.every(a => lines.find(l => l.id === a.lineId)?.orderId === id);
  });
}

export function confirmSequenceFile(draft: BatchDraft, assetId: string): BatchDraft {
  const shipments = suggestShipments(draft.lines, draft.labels, draft.assignments).filter(s => s.label.assetId === assetId);
  if (!canConfirmSequence(shipments, draft.lines)) throw new Error('汇总顺序存在缺失或冲突，请逐个核对标签');
  return { ...draft, assignments: { ...draft.assignments, ...Object.fromEntries(shipments.map(s => [s.label.id, { allocations: s.allocations, confirmed: true }])) } };
}

export function displayMerchant(line: OrderLine): string {
  if (line.seller.trim() && !/^amazon[.\s]/i.test(line.seller)) return line.seller;
  const brand = extractCompanyName(line.product);
  return brand ? `${brand}（品牌）` : '未提供商家';
}
