import { expect, test } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test('daily worksheet history, repeat choices, differences and clear persistence', async ({ page }) => {
  await page.goto('/');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([288, 432]).drawText('SHIPPING LABEL\nOrder ORDER-001\nTracking TRACK000001', { x: 20, y: 380, font, size: 12, lineHeight: 18 });
  const label = Buffer.from(await pdf.save());
  async function upload(qty: number) {
    await page.locator('.bw input[type=file]').setInputFiles([
      { name: 'label.pdf', mimeType: 'application/pdf', buffer: label },
      { name: 'orders.csv', mimeType: 'text/csv', buffer: Buffer.from(`order-id,product-name,quantity,size,color,seller\nORDER-001,Fence,${qty},4 x 10,Green,Store A`) },
    ]);
    await expect(page.getByRole('status')).toContainText('已处理 2 个文件');
    await page.getByRole('button', { name: '2 打印', exact: true }).click();
  }
  async function download(name: string) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    await pending;
    await expect(page.getByRole('status')).toContainText('PDF 已生成');
  }
  await upload(1);
  await page.getByRole('button', { name: '预览生产工作单', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('相同版式');
  await page.getByRole('button', { name: '每日记录', exact: true }).click();
  await expect(page.getByText('还没有记录，打印生产工作单后会自动保存。')).toBeVisible();
  await download('3. 打印生产工作单');
  const history = page.getByRole('region', { name: '每日订单记录' });
  await expect(history.locator('details')).toHaveCount(1);
  await page.getByRole('button', { name: '3. 打印生产工作单', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('订单内容没有变化');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '3. 打印生产工作单', exact: true }).click();
  await download('只打印，不保存');
  await expect(history.locator('details')).toHaveCount(1);
  await page.getByRole('button', { name: '清空并重新上传', exact: true }).click();
  await upload(2);
  await page.getByRole('button', { name: '3. 打印生产工作单', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('修改');
  await expect(dialog).toContainText('×1');
  await expect(dialog).toContainText('×2');
  await download('保存新版本并打印');
  await expect(history.locator('details')).toHaveCount(2);
  await page.getByRole('button', { name: '清空并重新上传', exact: true }).click();
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  await page.reload();
  await page.getByRole('button', { name: '每日记录', exact: true }).click();
  await expect(history.locator('details')).toHaveCount(2);
  await history.locator('summary').last().click();
  await expect(history.locator('details').last().getByRole('table')).toBeVisible();
  await expect(history.locator('details').last().locator('tbody tr')).toHaveCount(1);
  await expect(history.locator('details').last().locator('.bw-record-qty')).toHaveText('1');
});

test('atomic daily versions and comparison ignores source ids', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // Vite serves the application modules in the isolated test browser.
    const path = '/src/lib/dailyRecords.ts';
    const { saveDailyRecord, dailyRecords, recordChanges, localDate } = await import(/* @vite-ignore */ path);
    const workflowPath = '/src/lib/batchWorkflow.ts';
    const { emptyLine } = await import(/* @vite-ignore */ workflowPath);
    const line = { ...emptyLine(), id: 'a', orderId: 'ORDER-1', product: 'Fence', color: 'Green', size: '4 x 10', qty: 1 };
    const batch = { id: 'batch', createdAt: new Date().toISOString(), lines: [line], shipments: [{ label: { id: 'label' }, allocations: [{ lineId: 'a', qty: 1 }] }], downloads: [] };
    const outcomes = await Promise.allSettled([saveDailyRecord(batch, '2026-10-22', null), saveDailyRecord(batch, '2026-10-22', null)]);
    const next = structuredClone(batch); next.lines[0].id = 'new'; next.shipments[0].allocations[0].lineId = 'new';
    const same = recordChanges(batch, next);
    next.shipments[0].allocations[0].qty = 2;
    const changed = recordChanges(batch, next);
    const removed = recordChanges(batch, { ...batch, shipments: [] });
    const added = recordChanges({ ...batch, shipments: [] }, batch);
    await saveDailyRecord(batch, '2026-10-23', null);
    return { successes: outcomes.filter(o => o.status === 'fulfilled').length, records: (await dailyRecords()).length, same, changed, removed, added, date: localDate(new Date(2026, 9, 22, 23, 59)) };
  });
  expect(result.successes).toBe(1);
  expect(result.records).toBe(2);
  expect(result.same).toEqual([]);
  expect(result.changed[0].kind).toBe('修改');
  expect(result.removed[0].kind).toBe('删除');
  expect(result.added[0].kind).toBe('新增');
  expect(result.date).toBe('2026-10-22');
});
