import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import Papa from 'papaparse';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { productionColumns } from '../src/lib/productionPdf';

const directory = process.env.REAL_BATCH_FIXTURES;
test('real seller files import together without filename or upload-order pairing', async ({ page }, testInfo) => {
  test.skip(!directory, 'Set REAL_BATCH_FIXTURES to the local directory containing the eight user-provided files.');
  test.setTimeout(300_000);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '批次步骤' })).toBeVisible();
  const names = ['huram.pdf', 'eden2.txt', 'enos.pdf', 'eden.txt', 'eden2.pdf', 'huam.txt', 'eden.pdf', 'enos.txt'];
  const uploads = await Promise.all(names.map(async (name, index) => ({ name: `upload-${index}.${name.split('.').pop()}`, mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain', buffer: await readFile(join(directory!, name)) })));
  const expected = new Map<string, string[]>();
  for (const upload of uploads.filter(f => f.mimeType === 'application/pdf')) {
    const pdf = await getDocument({ data: new Uint8Array(upload.buffer), useSystemFonts: true }).promise;
    const ids: string[] = [];
    let success = false;
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const text = (await (await pdf.getPage(pageNo)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
      if (/list of orders with successful label purchase/i.test(text)) success = true;
      if (success) ids.push(...(text.split(/list of orders with (?:an )?errors? in label purchase/i)[0].match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []));
      if (/errors? in label purchase/i.test(text)) success = false;
    }
    expected.set(createHash('sha256').update(upload.buffer).digest('hex'), ids);
    await pdf.destroy();
  }
  const successfulIds = new Set([...expected.values()].flat());
  const rawIncluded = uploads.filter(f => f.mimeType === 'text/plain').flatMap(f => Papa.parse<Record<string, string>>(f.buffer.toString('utf8'), { header: true, delimiter: '\t', skipEmptyLines: true }).data).filter(row => successfulIds.has(row['amazon-order-id']));
  expect(rawIncluded).toHaveLength(71);
  expect(rawIncluded.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(82);
  await page.locator('.bw input[type=file]').setInputFiles(uploads);
  await expect(page.getByRole('status')).toContainText('已处理 8 个文件', { timeout: 260_000 });
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  const report = await page.evaluate(async () => {
    const path = '/src/lib/batchWorkflow.ts';
    const { loadDraft, suggestShipments, batchProblems } = await import(/* @vite-ignore */ path);
    const draft = await loadDraft();
    const shipments = suggestShipments(draft.lines, draft.labels, draft.assignments);
    return { rows: draft.lines.length, labels: draft.labels.length, suggested: shipments.filter((s: { allocations: unknown[] }) => s.allocations.length).length,
      confirmed: shipments.filter((s: { confirmed: boolean }) => s.confirmed).length, pending: draft.pending.length,
      problems: batchProblems(draft, shipments), warnings: draft.warnings, draft, shipments };
  });
  await writeFile(testInfo.outputPath('local-diagnostic.json'), JSON.stringify(report, null, 2));
  await testInfo.attach('local-diagnostic.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify({ rows: report.rows, labels: report.labels, suggested: report.suggested, confirmed: report.confirmed, pending: report.pending, problemCount: report.problems.length, warningCount: report.warnings.length }));
  const workerColumns = productionColumns({ ...report.draft, shipments: report.shipments });
  expect(workerColumns.flatMap(column => column.rows).reduce((sum, row) => sum + row.qty, 0)).toBe(82);
  expect(workerColumns.some(column => column.title.includes('（阳）'))).toBe(true);
  expect(report.rows).toBe(281);
  expect(report.labels).toBe(68);
  expect(report.pending).toBe(0);
  expect([...expected.values()].map(ids => ids.length).sort((a, b) => a - b)).toEqual([6, 9, 18, 35]);
  for (const [assetId, ids] of expected) {
    const shipments = report.shipments.filter((s: { label: { assetId: string } }) => s.label.assetId === assetId);
    expect(shipments.map((s: { label: { sequenceOrderId: string } }) => s.label.sequenceOrderId)).toEqual(ids);
    for (const shipment of shipments) {
      for (const allocation of shipment.allocations) {
        expect(report.draft.lines.find((line: { id: string }) => line.id === allocation.lineId).orderId).toBe(shipment.label.sequenceOrderId);
      }
    }
  }
  await page.getByRole('button', { name: '2 打印', exact: true }).click();
  await expect(page.locator('.bw table tbody tr')).toHaveCount(68);
  await page.getByRole('button', { name: '预览生产工作单', exact: true }).click();
  const preview = page.getByRole('region', { name: '生产工作单预览', exact: true });
  await expect(preview.locator('iframe')).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
  await preview.getByRole('button', { name: '关闭预览' }).click();
  await expect(preview).toHaveCount(0);
  let labelBytes: Buffer | undefined;
  for (const name of ['打印全部标签 PDF', '2. 打印顺序对照单', '3. 打印生产工作单']) {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    const download = await downloadPromise;
    const bytes = await readFile((await download.path())!);
    await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
    const document = await PDFDocument.load(bytes);
    if (name === '打印全部标签 PDF') { expect(document.getPageCount()).toBe(68); labelBytes = bytes; }
    else expect(document.getPageCount()).toBeGreaterThan(0);
    if (name === '3. 打印生产工作单') {
      expect(document.getPageCount()).toBe(1);
      expect(document.getPages().every(p => p.getWidth() > p.getHeight())).toBe(true);
      const parsed = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
      let text = '';
      for (let i = 1; i <= parsed.numPages; i++) text += (await (await parsed.getPage(i)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
      expect(text).not.toContain('生产工作单');
      expect(text).not.toContain('共 82 件');
      expect(text).toContain('ⓐ');
      expect(text).not.toContain('同');
      for (const column of workerColumns) expect(text).toContain(column.title);
      expect(text).not.toContain('标签序号:');
      expect(text).not.toContain('未标数量');
      await parsed.destroy();
    }
  }
  const verified = await page.evaluate(async data => {
    const modulePath = '/src/lib/batchWorkflow.ts';
    const { loadDraft } = await import(/* @vite-ignore */ modulePath);
    const draft = await loadDraft();
    const batch = draft.history.find((b: { id: string }) => b.id === draft.releasedId);
    const pdfPath = '/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
    const pdfjs = await import(/* @vite-ignore */ pdfPath);
    pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
    const output = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    async function pixels(pdf: { getPage: (index: number) => Promise<{ getViewport: (options: { scale: number }) => { width: number; height: number }; render: (options: unknown) => { promise: Promise<void> } }> }, index: number) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvas, viewport }).promise;
      return canvas.toDataURL();
    }
    const identical = [];
    for (const index of [0, 33, 67]) {
      const label = batch.shipments[index].label;
      const asset = draft.assets.find((a: { id: string }) => a.id === label.assetId);
      const original = await pdfjs.getDocument({ data: new Uint8Array(await asset.file.arrayBuffer()) }).promise;
      identical.push(await pixels(original, label.pageNumber) === await pixels(output, index + 1));
      await original.destroy();
    }
    await output.destroy();
    return { orders: new Set(batch.lines.map((l: { orderId: string }) => l.orderId)).size,
      lines: batch.lines.length, quantity: batch.lines.reduce((n: number, l: { qty: number }) => n + l.qty, 0),
      allocated: batch.shipments.reduce((n: number, s: { allocations: { qty: number }[] }) => n + s.allocations.reduce((sum, a) => sum + a.qty, 0), 0), identical };
  }, [...labelBytes!]);
  expect(verified).toEqual({ orders: 68, lines: 71, quantity: 82, allocated: 82, identical: [true, true, true] });
  console.log('Real-file final verification: 8 mixed uploads, 68 orders/labels, 71 item rows, 82 units; 210 unrelated rows excluded; 3 sampled printed labels pixel-identical to originals.');
});
