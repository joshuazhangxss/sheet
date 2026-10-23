import type { ReleasedBatch } from './batchWorkflow';
import { displayMerchant, orderKey } from './batchWorkflow';
import { batchProductType } from './batchProductType';
export interface DailyRecord { id: string; date: string; version: number; savedAt: string; batch: ReleasedBatch }
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function recordOrders(batch: ReleasedBatch) {
  const orders = new Map<string, { orderId: string; merchant: string; items: Map<string, number> }>();
  for (const shipment of batch.shipments) for (const allocation of shipment.allocations) {
    const line = batch.lines.find(l => l.id === allocation.lineId);
    if (!line) throw new Error('订单记录缺少商品信息');
    const key = orderKey(line);
    const order = orders.get(key) ?? { orderId: line.orderId, merchant: displayMerchant(line), items: new Map<string, number>() };
    const item = [line.product, line.sku, batchProductType(line), line.color, line.size, line.note].filter(Boolean).join(' · ');
    order.items.set(item, (order.items.get(item) ?? 0) + allocation.qty);
    orders.set(key, order);
  }
  return [...orders].map(([key, order]) => ({ key, orderId: order.orderId, merchant: order.merchant,
    text: [...order.items].sort(([a], [b]) => a.localeCompare(b)).map(([item, qty]) => `${item} ×${qty}`).join('；') }));
}
export function recordChanges(before: ReleasedBatch, after: ReleasedBatch) {
  const old = new Map(recordOrders(before).map(o => [o.key, o]));
  const next = new Map(recordOrders(after).map(o => [o.key, o]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap(key => {
    const a = old.get(key), b = next.get(key);
    return a?.text === b?.text && a?.merchant === b?.merchant ? [] : [{ key, orderId: (b ?? a)!.orderId,
      kind: !a ? '新增' : !b ? '删除' : '修改', before: a ? `${a.merchant} · ${a.text}` : '—', after: b ? `${b.merchant} · ${b.text}` : '—' }];
  });
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('warehouse-daily-records', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function dailyRecords(): Promise<DailyRecord[]> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').getAll();
    request.onsuccess = () => resolve((request.result as DailyRecord[]).sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version));
    request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
// Compare and append atomically, including when two tabs print concurrently.
export async function saveDailyRecord(batch: ReleasedBatch, date: string, expectedId: string | null) {
  const db = await database();
  try { return await new Promise<DailyRecord>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    const request = store.getAll();
    let record: DailyRecord;
    let conflict = false;
    request.onsuccess = () => {
      const latest = (request.result as DailyRecord[]).filter(r => r.date === date).sort((a, b) => b.version - a.version)[0];
      if ((latest?.id ?? null) !== expectedId) { conflict = true; tx.abort(); return; }
      record = { id: crypto.randomUUID(), date, version: (latest?.version ?? 0) + 1, savedAt: new Date().toISOString(), batch: structuredClone(batch) };
      store.add(record);
    };
    tx.oncomplete = () => resolve(record);
    tx.onabort = tx.onerror = () => reject(new Error(conflict ? '当天记录已在其他页面更新，请重新点击打印查看最新变化。' : '每日记录保存失败，请检查浏览器空间后重试。'));
  }); } finally { db.close(); }
}

export function yesterdayDuplicates(batch: ReleasedBatch, records: DailyRecord[], now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const date = localDate(yesterday);
  const normalize = (id: string) => id.trim().toUpperCase();
  // Include every saved version: an order removed later may already have been printed.
  const previous = new Set(records.filter(record => record.date === date)
    .flatMap(record => recordOrders(record.batch).map(order => normalize(order.orderId))));
  return [...new Set(recordOrders(batch).map(order => normalize(order.orderId)))]
    .filter(id => id && previous.has(id));
}
