import { expect, test } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function labelPdf(ids: string[], trackingOffset = 0): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [index, id] of ids.entries()) {
    const page = doc.addPage([288, 432]);
    page.drawText(`SHIPPING LABEL\nOrder ${id}\nJane Smith\n100 Main Street\nLos Angeles CA 90210\nTracking TRACK00000${index + 1 + trackingOffset}`, { x: 20, y: 390, size: 12, font, lineHeight: 18 });
  }
  return Buffer.from(await doc.save());
}
const csv = Buffer.from('order-id,product-name,quantity,size,color,seller,recipient-name\nORDER-002,Fence,2,6 x 20,Black,Store A,Jane Smith\nORDER-001,Fence,1,4 x 10,Green,Store A,Sam Smith');

test('mixed intake, duplicate detection, release, ordered printing, refresh, and revision', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '批次步骤' })).toBeVisible();
  const pdf = await labelPdf(['ORDER-002', 'ORDER-001']);
  await page.locator('.bw input[type=file]').setInputFiles([
    { name: 'no-special-name.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'unsorted.csv', mimeType: 'text/csv', buffer: csv },
  ]);
  await expect(page.getByRole('status')).toContainText('已处理 2 个文件');
  await page.locator('.bw input[type=file]').setInputFiles({ name: 'renamed.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.getByRole('status')).toContainText('已处理 0 个文件');
  await expect(page.getByText('renamed.pdf: 相同内容已导入，已跳过')).toBeVisible();
  await page.getByRole('button', { name: '2 打印' }).click();

  await expect(page.getByRole('heading', { name: '打印中心' })).toBeVisible();
  const rows = page.locator('.bw table tbody tr');
  await expect(rows.nth(0)).toContainText('001');
  await expect(rows.nth(0)).toContainText('Black');
  await expect(rows.nth(1)).toContainText('Green');
  for (const name of ['打印全部标签 PDF', '2. 打印顺序对照单', '3. 打印生产工作单']) {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    const download = await downloadPromise;
    await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
    const path = await download.path();
    const doc = await PDFDocument.load(await readFile(path!));
    expect(doc.getPageCount()).toBeGreaterThan(0);
    if (name === '打印全部标签 PDF') expect(doc.getPageCount()).toBe(2);
    await expect(page.getByRole('status')).toContainText('PDF 已生成');
    if (name !== '打印全部标签 PDF') {
      const preview = await page.context().newPage();
      await preview.goto('/');
      const bytes = [...await readFile(path!)];
      await preview.evaluate(async data => {
        const modulePath = '/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
        const pdfjs = await import(/* @vite-ignore */ modulePath);
        pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise;
        canvas.id = 'pdf-check'; document.body.replaceChildren(canvas);
      }, bytes);
      await preview.locator('#pdf-check').screenshot({ path: testInfo.outputPath(`${name.startsWith('2.') ? 'order-list' : 'worksheet'}.png`) });
      await preview.close();
    }
  }
  await page.getByLabel('选择补打 2', { exact: true }).check();
  const reprintPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '只补打选中的标签（1）' }).click();
  const reprint = await reprintPromise;
  expect((await PDFDocument.load(await readFile((await reprint.path())!))).getPageCount()).toBe(1);
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  await page.reload();
  await page.getByRole('button', { name: '2 打印' }).click();
  await expect(page.locator('.bw table tbody tr')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('print-center.png'), fullPage: true });
  await page.getByRole('button', { name: '1 上传文件' }).click();
  await expect(page.getByRole('button', { name: '选择文件，可多选' })).toBeEnabled();
  await page.locator('.bw input[type=file]').setInputFiles([
    { name: 'extra.pdf', mimeType: 'application/pdf', buffer: await labelPdf(['ORDER-003'], 2) },
    { name: 'extra.csv', mimeType: 'text/csv', buffer: Buffer.from('order-id,product-name,quantity,size,color,seller\nORDER-003,Fence,1,5 x 10,Blue,Store A') },
  ]);
  await expect(page.getByRole('status')).toContainText('已处理 2 个文件');
  await page.getByRole('button', { name: '2 打印' }).click();
  await expect(page.locator('.bw table tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: '1 上传文件' }).click();
  await page.getByRole('button', { name: '查看结果并打印 →' }).click();
  await expect(page.locator('.bw table tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: '清空并重新上传' }).click();
  await expect(page.getByRole('status')).toContainText('已清空');
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  await page.reload();
  await page.locator('.bw input[type=file]').setInputFiles([
    { name: 'labels.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'orders.csv', mimeType: 'text/csv', buffer: csv },
  ]);
  await expect(page.getByRole('status')).toContainText('已处理 2 个文件');
  await page.getByRole('button', { name: '2 打印' }).click();
  await expect(page.locator('.bw table tbody tr')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('labels first, manual entry, safe quantities, saved draft, and mobile layout', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('.bw input[type=file]').setInputFiles({ name: 'single.pdf', mimeType: 'application/pdf', buffer: await labelPdf(['MANUAL-99']) });
  await expect(page.getByRole('status')).toContainText('已处理 1 个文件');
  await page.getByRole('button', { name: '＋ 手动添加订单' }).click();
  await page.locator('input[name=orderId]').fill('MANUAL-99');
  await expect(page.locator('.bw-editor input')).toHaveCount(5);
  await expect(page.locator('input[name=seller]')).toHaveCount(0);
  await page.locator('input[name=product]').fill('Privacy fence');
  await page.locator('input[name=color]').fill('黑色');
  await page.locator('input[name=size]').fill('6 x 20');
  await page.locator('input[name=qty]').fill('1');
  await page.getByRole('button', { name: '确认并保存商品' }).click();
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  await page.reload();
  await page.getByRole('button', { name: '查看 / 修改订单' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('input[name=qty]').fill('0');
  await page.getByRole('button', { name: '确认并保存商品' }).click();
  await expect(page.locator('input[name=qty]')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '1 上传文件' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-intake.png'), fullPage: true });
});

test('uncertain matches are blocked until reviewed; split quantities must reconcile', async ({ page }) => {
  await page.goto('/');
  await page.locator('.bw input[type=file]').setInputFiles([
    { name: 'packages.pdf', mimeType: 'application/pdf', buffer: await labelPdf(['ORDER-002', 'ORDER-002']) },
    { name: 'orders.csv', mimeType: 'text/csv', buffer: Buffer.from('order-id,product-name,quantity,size,color\nORDER-002,Fence,2,6 x 20,Black') },
  ]);
  await expect(page.getByRole('status')).toContainText('已处理 2 个文件');
  await page.getByRole('button', { name: '2 打印' }).click();
  await expect(page.getByRole('button', { name: '继续打印' })).toBeDisabled();
  await page.getByText('逐个查看标签（2）', { exact: true }).click();
  for (const index of [0, 1]) {
    await page.getByRole('button', { name: '查看 / 分配' }).nth(index).click();
    await page.getByLabel(/包裹数量/).fill('1');
    await page.getByRole('button', { name: '确认这个标签和包裹内容' }).click();
  }
  await expect(page.getByRole('button', { name: '继续打印' })).toBeEnabled();
});

test('real screenshot OCR prefills an order and scanned PDF labels require review', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '批次步骤' })).toBeVisible();
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1300; canvas.height = 650;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1300, 650);
    ctx.fillStyle = 'black'; ctx.font = '40px Arial';
    ['Order 123-1234567-1234567', 'Black Fence', 'Size 6 x 20', 'Quantity 1', 'Jane Smith', '100 Main Street', 'Los Angeles CA 90210'].forEach((text, i) => ctx.fillText(text, 40, 65 + i * 70));
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(png);
  pdf.addPage([650, 325]).drawImage(image, { x: 0, y: 0, width: 650, height: 325 });
  await page.locator('.bw input[type=file]').setInputFiles([
    { name: 'order-screenshot.png', mimeType: 'image/png', buffer: png },
    { name: 'scanned-label.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) },
  ]);
  await expect(page.getByRole('status')).toContainText('已处理 2 个文件', { timeout: 150_000 });
  await page.getByRole('button', { name: '查看并录入', exact: true }).click();
  await expect(page.locator('input[name=orderId]')).toHaveValue('123-1234567-1234567');
  await page.locator('input[name=product]').fill('Fence');
  await page.locator('input[name=color]').fill('Black');
  await page.locator('input[name=size]').fill('6 x 20');
  await page.getByRole('button', { name: '确认并保存商品' }).click();
  await page.getByRole('button', { name: '完成截图录入' }).click();
  await page.getByRole('button', { name: '2 打印' }).click();
  await expect(page.getByRole('button', { name: '打印全部标签 PDF' })).toBeVisible();
  await expect(page.getByRole('button', { name: '继续打印' })).toHaveCount(0);
});

test('unknown seller columns are mapped and malformed quantities require correction', async ({ page }) => {
  await page.goto('/');
  await page.locator('.bw input[type=file]').setInputFiles({ name: 'new-seller.csv', mimeType: 'text/csv', buffer: Buffer.from('custom-reference,item-title,units,size,color\nNEW-ORDER-55,Fence,invalid,6 x 20,Black') });
  await expect(page.getByRole('status')).toContainText('已处理 1 个文件');
  await page.getByLabel('映射 订单号', { exact: true }).selectOption('custom-reference');
  await page.getByLabel('映射 产品', { exact: true }).selectOption('item-title');
  await page.getByLabel('映射 数量', { exact: true }).selectOption('units');
  await page.getByRole('button', { name: '应用映射并导入' }).click();
  await page.getByRole('button', { name: '查看 / 修改订单' }).click();
  await page.getByLabel('查看全部导入数据（含无标签订单）').check();
  await expect(page.getByText('无对应标签 · 已忽略', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('input[name=qty]').fill('2');
  await page.getByRole('button', { name: '确认并保存商品' }).click();
  await expect(page.getByText('无对应标签 · 已忽略', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1 上传文件' }).click();
  await page.getByRole('button', { name: '移除此文件', exact: true }).click();
  await page.getByRole('button', { name: '清空并重新上传' }).click();
  await expect(page.getByRole('status')).toContainText('已清空');
  await expect(page.getByRole('button', { name: '选择文件，可多选' })).toBeEnabled();
});

test('manual information first automatically matches a later label upload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ 手动添加订单' }).click();
  for (const [name, value] of Object.entries({ orderId: 'MANUAL-FIRST-01', product: 'Straight Flat-Edged Shade Sail', color: '棕色', size: '6 x 20', qty: '2' })) {
    await page.locator(`input[name=${name}]`).fill(value);
  }
  await page.getByRole('button', { name: '确认并保存商品' }).click();
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  await page.reload();
  await page.locator('.bw input[type=file]').setInputFiles({ name: 'later-label.pdf', mimeType: 'application/pdf', buffer: await labelPdf(['MANUAL-FIRST-01']) });
  await expect(page.getByRole('status')).toContainText('已处理 1 个文件');
  await page.getByRole('button', { name: '查看结果并打印 →' }).click();
  await expect(page.getByRole('heading', { name: '打印中心' })).toBeVisible();
  const rows = page.locator('.bw table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('MANUAL-FIRST-01');
  await expect(rows.first()).toContainText('棕色');
  await expect(rows.first()).toContainText('×2');
  await expect(rows.first()).toContainText('直边');
});
