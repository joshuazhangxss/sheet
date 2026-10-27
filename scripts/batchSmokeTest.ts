import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as XLSX from 'xlsx';
import { batchProblems, canConfirmSequence, confirmSequenceFile, scopeToLabelOrders, containsIdentifier, emptyBatch, emptyLine, fingerprint, releaseBatch, reviseBatch, suggestShipments } from '../src/lib/batchWorkflow';
import type { BatchLabel, OrderLine } from '../src/lib/batchWorkflow';
import { detectMapping, readTables, screenshotPrefill, tableToLines } from '../src/lib/batchImport';
import { batchDocumentPdf, orderedLabelsPdf } from '../src/lib/batchPdf';

const line = (id: string, extra: Partial<OrderLine> = {}): OrderLine => ({ ...emptyLine(), id, orderId: id, seller: 'Store A', product: 'Fence', color: '黑色', size: '6 x 20', qty: 2, ...extra });
const label = (id: string, text: string, page = 1): BatchLabel => ({ id, text, normalizedText: text, sourceName: 'anything.pdf', assetId: 'pdf', pageNumber: page, width: 288, height: 432, excluded: false });
assert(containsIdentifier('Order 123 - 1234567 - 1234567', '123-1234567-1234567'));
assert(containsIdentifier('Track 1Z 123 456 789 012 3456', '1Z1234567890123456'));
assert(!containsIdentifier('X123-1234567-12345678', '123-1234567-1234567'));
assert(!containsIdentifier('Order A1234', 'A123'));
const a = line('ORDER-A123'), b = line('ORDER-B456');
assert.equal(suggestShipments([a], [label('x', 'ORDER-A123')], {})[0].confirmed, true);
assert.equal(suggestShipments([line('123')], [label('short', 'Weight 123 lbs')], {})[0].confirmed, false);
assert.equal(suggestShipments([a], [{ ...label('x', 'ORDER-A123'), ocr: true }], {})[0].confirmed, true);
assert.equal(suggestShipments([a, { ...b, tracking: 'TRACK1234' }], [label('x', 'ORDER-A123 TRACK1234')], {})[0].confirmed, false);
assert.equal(suggestShipments([a, { ...a, id: 'other', seller: 'Store B' }], [label('x', 'ORDER-A123')], {})[0].allocations.length, 0);
assert.equal(suggestShipments([{ ...a, recipient: 'Jane Smith', postal: '90210' }], [label('x', 'Jane Smith 90210')], {})[0].confirmed, false);
assert.equal(suggestShipments([a], [{ ...label('x', ''), sequenceOrderId: 'ORDER-A123' }], {})[0].confirmed, true);
const draft = { ...emptyBatch(), lines: [a], labels: [label('x', 'ORDER-A123'), label('y', 'ORDER-A123', 2)] };
assert(suggestShipments(draft.lines, draft.labels, {}).every(s => !s.confirmed));
assert(batchProblems(draft, suggestShipments(draft.lines, draft.labels, {})).some(p => p.includes('分配 4')));
draft.assignments = { x: { confirmed: true, allocations: [{ lineId: a.id, qty: 1 }] }, y: { confirmed: true, allocations: [{ lineId: a.id, qty: 1 }] } };
assert.deepEqual(batchProblems(draft, suggestShipments(draft.lines, draft.labels, draft.assignments)), []);
assert.throws(() => releaseBatch({ ...draft, labels: draft.labels.map(l => ({ ...l, text: 'ORDER-A123 shipping label Jane Smith 100 Main Street CA 90210 Tracking SAME12345' })) }), /重复标签|重复追踪号/);
const released = releaseBatch(draft);
a.qty = 99;
assert.equal(released.lines[0].qty, 2, 'released data must be immutable');
a.qty = 2;
assert.throws(() => releaseBatch({ ...draft, history: [released] }), /历史批次/);
const revision = reviseBatch({ ...draft, history: [released] }, released);
assert.deepEqual(batchProblems(revision, suggestShipments(revision.lines, revision.labels, revision.assignments)), []);
assert.equal(releaseBatch(revision).revises, released.id);
assert.throws(() => releaseBatch({ ...draft, lines: [line('ORDER-A123', { qty: 0 })] }), /正整数/);
assert.throws(() => releaseBatch({ ...draft, assignments: {}, labels: [] }), /运输标签/);
assert.equal(releaseBatch({ ...draft, lines: [a, b] }).lines.length, 1, 'unlabeled orders must not enter production');
assert.throws(() => releaseBatch({ ...draft, lines: [a, b], assignments: { ...draft.assignments, x: { confirmed: true, allocations: [{ lineId: a.id, qty: 1 }, { lineId: b.id, qty: 2 }] } } }), /不可混合/);
const records = [{ 'order-id': 'ORD-55', 'description': 'Black fence 6 x 20', 'qty': 'bad', 'size': '6 x 20', 'color': 'Black' }];
const mapped = tableToLines({ id: 'table', name: 'random.csv', records, mapping: detectMapping(Object.keys(records[0])) });
assert.equal(mapped[0].qty, 0, 'malformed quantities must not become one');
assert.equal(mapped[0].orderId, 'ORD-55');
const fbaRecord = { ...records[0], qty: '2', 'fulfillment-channel': 'Amazon', 'item-status': 'Cancelled' };
const fba = tableToLines({ id: 'fba', name: 'fba', records: [fbaRecord], mapping: detectMapping(Object.keys(fbaRecord)) });
assert.equal(fba[0].reviewed, false, 'FBA and cancelled items require review');
assert.equal(screenshotPrefill('Order 123-1234567-1234567').qty, 0, 'missing screenshot quantity must require entry');
assert.equal(screenshotPrefill('Quantity: 3').qty, 3);
for (const value of ['', '1.5', '-3', '3x', '0']) {
  const invalid = tableToLines({ id: 't', name: 't', records: [{ ...records[0], qty: value }], mapping: detectMapping(Object.keys(records[0])) });
  assert.equal(invalid[0].qty, 0);
}
const csv = new File(['order-id,description,qty,size,color\nORD-55,Fence,2,6 x 20,Black'], 'random.csv');
assert.equal(tableToLines((await readTables(csv, 'test'))[0])[0].qty, 2);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(records), 'Orders');
const excel = new File([XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })], 'random.xlsx');
assert.equal((await readTables(excel, 'excel'))[0].mapping.orderId, 'order-id');
assert.equal(await fingerprint(csv), await fingerprint(new File([await csv.arrayBuffer()], 'renamed.csv')));
assert.equal(screenshotPrefill('Order 123-1234567-1234567').orderId, '123-1234567-1234567');
const original = await PDFDocument.create();
const font = await original.embedFont(StandardFonts.Helvetica);
original.addPage([288, 432]).drawText('A123 label one', { font });
original.addPage([400, 600]).drawText('B456 label two', { font });
const assets = [{ id: 'pdf', name: 'unchanged.pdf', file: new Blob([new Uint8Array(await original.save())], { type: 'application/pdf' }) }];
const sorted = releaseBatch({ ...emptyBatch(), lines: [b, a], labels: [label('b', 'ORDER-B456', 2), label('a', 'ORDER-A123', 1)], assets });
assert.equal(sorted.shipments[0].allocations[0].lineId, 'ORDER-A123');
const printed = await PDFDocument.load(await orderedLabelsPdf(sorted, assets));
assert.equal(printed.getPageCount(), 2);
assert.equal(printed.getPage(0).getWidth(), 288);
assert.equal(printed.getPage(1).getWidth(), 400);
const selected = await PDFDocument.load(await orderedLabelsPdf(sorted, assets, [1]));
assert.equal(selected.getPageCount(), 1);
assert.equal(selected.getPage(0).getWidth(), 400);
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => new Response(await readFile(`public${String(input)}`));
try {
  for (const kind of ['list', 'worksheet'] as const) {
    const pdf = await PDFDocument.load(await batchDocumentPdf(sorted, kind));
    assert(pdf.getPageCount() > 0);
  }
} finally { globalThis.fetch = originalFetch; }
console.log('Batch tests passed: identifiers, ambiguity, OCR review, package allocations, quantities, revisions, duplicate release, import formats, file fingerprints, original PDF order and size, and both print documents.');

const sequenceDraft = { ...emptyBatch(), lines: [line('SUMMARY-A'), line('OUTSIDE')], labels: [{ ...label('seq', ''), sequenceOrderId: 'SUMMARY-A' }] };
const scoped = scopeToLabelOrders(sequenceDraft);
assert.equal(scoped.lines.filter(l => !l.excluded).length, 1);
assert.equal(scoped.lines.find(l => l.orderId === 'OUTSIDE')?.excluded, true);
assert(canConfirmSequence(suggestShipments(scoped.lines, scoped.labels, {}), scoped.lines));
const confirmedSequence = confirmSequenceFile(scoped, 'pdf');
assert.equal(suggestShipments(confirmedSequence.lines, confirmedSequence.labels, confirmedSequence.assignments)[0].confirmed, true);
assert.throws(() => scopeToLabelOrders({ ...emptyBatch(), labels: [label('unknown', '')] }), /找到订单/);
assert.throws(() => confirmSequenceFile({ ...sequenceDraft, labels: [{ ...label('conflict', 'OUTSIDE'), sequenceOrderId: 'SUMMARY-A' }] }, 'pdf'), /冲突/);

assert.equal(releaseBatch({ ...draft, lines: [a, line('UNRELATED', { qty: 0, size: '', color: '', reviewed: false })], pending: [{ id: 'unused', name: 'unused', records: [], mapping: {} }] }).lines.length, 1);
assert.throws(() => releaseBatch({ ...draft, lines: [a, { ...a, id: 'other-item', sku: 'second', qty: 1 }] }), /标签分配 0/);

// Multi-item orders keep their own production rows, even at identical sizes.
const { productionColumns } = await import('../src/lib/productionPdf');
const workerLines = [line('one', { orderId: 'MULTI', qty: 1 }), line('two', { orderId: 'MULTI', color: '棕色', qty: 2 }), line('three', { orderId: 'SINGLE', qty: 1 })];
const workerBatch = { ...released, lines: workerLines, shipments: workerLines.map((l, i) => ({ ...released.shipments[0], label: label(`worker-${i}`, l.orderId), allocations: [{ lineId: l.id, qty: l.qty }] })) };
const workerRows = productionColumns(workerBatch).flatMap(c => c.rows);
assert.equal(workerRows.length, 3);
assert.equal(workerRows.filter(r => r.orderMarker === 'ⓐ').reduce((n, r) => n + r.qty, 0), 3);
assert.equal(workerRows.filter(r => !r.orderMarker).reduce((n, r) => n + r.qty, 0), 1);

const secondGroup = line('four', { orderId: 'OTHER-MULTI', qty: 2 });
const letterRows = productionColumns({ ...workerBatch, lines: [...workerBatch.lines, secondGroup], shipments: [...workerBatch.shipments, { ...released.shipments[0], allocations: [{ lineId: secondGroup.id, qty: 2 }] }] }).flatMap(c => c.rows);
assert.equal(letterRows.some(r => r.orderMarker === 'ⓑ'), false, 'multiple identical units do not receive a marker');

// Identical dimensions/colors from different orders must never combine.
const separateLines = [line('separate-a', { orderId: 'ORDER-A', size: '6 X 9', color: '灰色', qty: 1 }), line('separate-b', { orderId: 'ORDER-B', size: '6 X 9', color: '灰色', qty: 2 })];
const separateBatch = { ...released, lines: separateLines, shipments: separateLines.map(l => ({ ...released.shipments[0], allocations: [{ lineId: l.id, qty: l.qty }] })) };
const separateRows = productionColumns(separateBatch).flatMap(c => c.rows);
assert.deepEqual(separateRows.map(r => r.qty), [1, 2], 'separate orders retain their own quantity');
assert(separateRows.every(r => r.size === '6 X 9' && !r.orderMarker));
const sameOrderBatch = { ...separateBatch, lines: separateLines.map(l => ({ ...l, orderId: 'ORDER-A' })) };
assert.deepEqual(productionColumns(sameOrderBatch).flatMap(c => c.rows).map(r => r.qty), [3], 'identical items within one order still combine');

const uploadOrder = releaseBatch({ ...emptyBatch(), lines: [a, b], labels: [{ ...label('second-order', b.orderId), assetId: 'first-upload' }, { ...label('first-order', a.orderId), assetId: 'second-upload' }] });
assert.deepEqual(uploadOrder.shipments.map(s => s.allocations[0].lineId), [b.id, a.id]);
assert.equal(uploadOrder.labelOrder, 'upload');

const { batchProductType } = await import('../src/lib/batchProductType');
assert.equal(batchProductType(line('edge', { product:'Straight edge shade sail with grommets', note:'' })), '直边加环');
assert.equal(batchProductType(line('edge', { product:'直边加环遮阳网', note:'' })), '直边加环');
assert.equal(batchProductType(line('edge', { product:'Shade Sail', note:'直+环' })), '直边加环');
assert.equal(batchProductType(line('edge', { product:'Straight edge shade sail', note:'' })), '直边');
assert.equal(batchProductType(line('edge', { product:'Privacy fence with grommets', note:'' })), '隐私围栏');
const ringLine = line('ring', {product:'Straight edge shade sail with grommets', note:''});
const ringBatch = { ...released, lines:[ringLine], shipments:[{...released.shipments[0],allocations:[{lineId:ringLine.id,qty:1}]}] };
assert.equal(productionColumns(ringBatch)[0].rows[0].note, '直+环');
