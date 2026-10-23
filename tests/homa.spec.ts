import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('HOMA merged order rows match the scanned labels and summary', async ({ page }) => {
  test.skip(!process.env.HOMA_FIXTURES, 'Requires local HOMA files');
  test.setTimeout(180_000);
  await page.goto('/');
  await page.locator('.bw input[type=file]').setInputFiles([
    { name: 'orders.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await readFile(`${process.env.HOMA_FIXTURES}/2026102101_HOMA .xlsx`) },
    { name: 'labels.pdf', mimeType: 'application/pdf', buffer: await readFile(`${process.env.HOMA_FIXTURES}/2026102101_HOMA_Label.pdf`) },
  ]);
  await expect(page.getByRole('status')).toContainText('已处理 2 个文件', { timeout: 150_000 });
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  const result = await page.evaluate(async () => {
    const path = '/src/lib/batchWorkflow.ts';
    const { loadDraft, suggestShipments, batchProblems } = await import(/* @vite-ignore */path);
    const d = await loadDraft(); const s = suggestShipments(d.lines, d.labels, d.assignments);
    return { count: d.lines.length, sellers: d.lines.map((l: {seller:string}) => l.seller), qty: d.lines.reduce((n:number,l:{qty:number})=>n+l.qty,0), labels: d.labels.length, matched:s.filter((x:{confirmed:boolean})=>x.confirmed).length, issues:batchProblems(d,s), allocations: s.map((x:{allocations:unknown[]}) => x.allocations.length).sort() };
  });
  expect(result).toEqual({ count:6, sellers:Array(6).fill('HOMA'), qty:6, labels:5, matched:5, issues:[], allocations:[1,1,1,1,2] });
  await page.getByRole('button', { name:'2 打印', exact:true }).click();
  await expect(page.locator('.bw table tbody tr')).toHaveCount(5);
});

test('manual pasted text fills editable matching fields', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name:'＋ 手动添加订单'}).click();
  await page.getByRole('textbox', {name:'粘贴订单文字或截图'}).fill('Order ID: 123-1234567-1234567\nProduct: Brown Shade Sail\nSize: 8 x 10\nColor: 棕色\nQuantity: 2\nSeller: Test shop');
  await page.getByRole('button', {name:'识别并填入',exact:true}).click();
  await expect(page.locator('input[name=orderId]')).toHaveValue('123-1234567-1234567');
  await expect(page.locator('input[name=qty]')).toHaveValue('2');
  await expect(page.locator('input[name=size]')).toHaveValue('8 x 10');
  await expect(page.locator('input[name=seller]')).toHaveValue('Test shop');
  await expect(page.locator('input[name=color]')).toHaveValue('棕色');
  await page.getByRole('button', {name:'确认并保存商品'}).click();
  await expect(page.locator('input[name=orderId]')).toHaveCount(0);
});

test('clipboard screenshot OCR fills the manual order fields', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', {name:'＋ 手动添加订单'}).click();
  await page.getByRole('textbox', {name:'粘贴订单文字或截图'}).evaluate(async element => {
    const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 400;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0,0,1100,400); ctx.fillStyle = 'black'; ctx.font = '32px Arial';
    ['Order ID: 123-1234567-1234567','Product: Brown Shade Sail','Size: 8 x 10','Color: Brown','Quantity: 2'].forEach((line,i)=>ctx.fillText(line,30,55+i*65));
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b=>resolve(b!), 'image/png'));
    const data = new DataTransfer(); data.items.add(new File([blob], 'clipboard.png', {type:'image/png'}));
    element.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:data}));
  });
  await expect(page.locator('input[name=orderId]')).toHaveValue('123-1234567-1234567', {timeout:100_000});
  await expect(page.locator('input[name=qty]')).toHaveValue('2');
  await expect(page.locator('input[name=product]')).toHaveValue('Brown Shade Sail');
});
