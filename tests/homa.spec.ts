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
  await expect(page.locator('input[name=seller]')).toHaveCount(0);
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

test('pasted OCR text handles split fields, Unicode order IDs and rejects ambiguity', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ 手动添加订单' }).click();
  const text = page.getByRole('textbox', { name: '粘贴订单文字或截图' });
  await text.fill('订单编号：１２３ – １２３４５６７ – １２３４５６７\n商品名称\nShade Sail\n尺寸\n6 x 20\n颜色\nBrown\n数量\n2 件\n类型：直边加环');
  await page.getByRole('button', { name: '识别并填入', exact: true }).click();
  await expect(page.locator('input[name=orderId]')).toHaveValue('123-1234567-1234567');
  await expect(page.locator('input[name=qty]')).toHaveValue('2');
  await expect(page.locator('input[name=color]')).toHaveValue('棕色');
  await expect(page.locator('input[name=product]')).toHaveValue('Shade Sail · 直边加环');
  await expect(page.locator('input[name=size]')).toHaveValue('6 x 20');
  await text.fill('Order ID: SHOP-1234\nOrder ID: SHOP-5678\nProduct: Shade Sail');
  await page.getByRole('button', { name: '识别并填入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('多个订单号');
  await text.fill('Order ID: SHOP-1234\nProduct: Shade Sail\nQuantity: 1.5');
  await page.getByRole('button', { name: '识别并填入', exact: true }).click();
  await expect(page.locator('input[name=qty]')).toHaveValue('0');
});

test('actual Amazon order text and screenshot extract production fields', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('button', { name: '＋ 手动添加订单' }).click();
  const pasted = `33 minutes ago
10/23/2026
7:47 AM PDT
113-9916925-0962656
Buyer name:
Noel
Fulfillment method: Seller
Sales channel: Amazon.com
Sun Shade Sail Flat-Edged Square Outdoor with Durable Thick Air-Permeable UV Block Canopy Fabric Material for Garden, Patio, Swimming Pool, Backyard, Fence, Deck (Grey, 14' X 14')
ASIN: B07S47J6YR
SKU: SET_Grey1414
Quantity: 1
Item subtotal: $125.99
Standard
Ship by date: Mon, Oct 26, 2026 PDT
Deliver by date: Mon, Nov 2, 2026 PST`;
  await page.getByRole('textbox', { name: '粘贴订单文字或截图' }).fill(pasted);
  await page.getByRole('button', { name: '识别并填入', exact: true }).click();
  await expect(page.locator('input[name=orderId]')).toHaveValue('113-9916925-0962656');
  await expect(page.locator('input[name=color]')).toHaveValue('灰色');
  await expect(page.locator('input[name=qty]')).toHaveValue('1');
  await expect(page.locator('input[name=size]')).toHaveValue(/14.*14/);
  const screenshotPath = process.env.AMAZON_SCREENSHOT;
  if (!screenshotPath) return;
  const bytes = [...await readFile(screenshotPath)];
  await page.locator('input[name=orderId]').fill('');
  await page.getByRole('textbox', { name: '粘贴订单文字或截图' }).evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'amazon.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, bytes);
  await expect(page.locator('input[name=orderId]')).toHaveValue('113-9916925-0962656', { timeout: 100_000 });
  await expect(page.locator('input[name=color]')).toHaveValue('灰色');
  await expect(page.locator('input[name=qty]')).toHaveValue('1');
  await expect(page.locator('input[name=size]')).toHaveValue(/14.*14/);
  await expect(page.locator('input[name=product]')).toHaveValue(/Flat.Edged/i);
});

test('four Amazon cards paste as separate normalized orders and reject repeat intake', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ 手动添加订单' }).click();
  const cards = [
    ['114-5876606-2097029', "Eden's Decor Privacy Fence Screen Heavy Duty Fencing Chain Link Fence Privacy 150 GSM for Garden Backyard Outdoor Privacy(Dark Green, 5ft X 9ft)", 'FS_DarkGreen0509', '1'],
    ['114-1149143-9362660', "Eden's Decor Straight Flat-Edged Sun Shade Sail Rectangular 4' x 7' Beige UV-Blocking Outdoor Canopy Fabric Cloth Awning for Pergola Patio Garden Backyard Custom Size", 'EDD-FBEC-0407', '1'],
    ['111-8958521-9336214', "Eden's Decor Straight Flat Edge Sun Shade Sail with Grommets, Pergola Shade Cover Outdoor Sun Shade, Patio Shade, Deck Shade(Grey, 8' X 13')", 'FLAT0813Grey', '2'],
    ['113-1476029-8724228', "Eden's Decor Balcony Privacy Screen Brown 3'x 13' Cover Mesh Windscreen Weather-Resistant UV Protection for Backyard Deck, Patio, Balcony, Pool, Porch, Fence, Railing, Gardening", 'BalconyFence_Brown0313', '1'],
  ];
  const text = cards.map(([id, title, sku, qty]) => `10/27/2026\n11:55 AM PDT\n${id}\nBuyer name:\nTest Buyer\nFulfillment method: Seller\nSales channel: Amazon.com\n\n${title}\nASIN: TEST\nSKU: ${sku}\nQuantity: ${qty}\nItem subtotal: $125.99\nShip by date: Wed, Oct 28, 2026 PDT\nUnshipped (${qty})\nBuy shipping`).join('\n\n');
  async function paste() { await page.getByRole('textbox', { name: '粘贴订单文字或截图' }).fill(text); await page.getByRole('button', { name: '识别并填入', exact: true }).click(); }
  await paste();
  const table = page.getByRole('table', { name: '批量粘贴订单' });
  await expect(table.locator('tbody tr')).toHaveCount(4);
  for (const [index, color] of ['绿色', '米色', '灰色', '棕色'].entries()) await expect(page.getByLabel(`第${index + 1}行color`, { exact: true })).toHaveValue(color);
  for (const [index, size] of ['5’ X 9’', '4’ X 7’', '8’ X 13’', '3’ X 13’'].entries()) await expect(page.getByLabel(`第${index + 1}行size`, { exact: true })).toHaveValue(size);
  await expect(page.getByLabel('第3行qty', { exact: true })).toHaveValue('2');
  await expect(table.locator('tbody tr').nth(2)).toContainText('直边加环');
  await page.getByRole('button', { name: '添加全部 4 个订单', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已添加 4 个订单');
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  const result = await page.evaluate(async () => {
    const path = '/src/lib/batchWorkflow.ts';
    const { loadDraft, suggestShipments } = await import(/* @vite-ignore */ path);
    const draft = await loadDraft();
    const labels = draft.lines.map((l: {orderId:string}, index:number) => ({ id: String(index), assetId: 'test', fileName:'labels.pdf', pageNumber:index + 1, orderIds:[l.orderId], trackingNumbers:[], text:l.orderId, normalizedText:l.orderId, excluded:false }));
    return suggestShipments(draft.lines, labels, {}).map((s:{confirmed:boolean;allocations:{qty:number}[]}) => ({ confirmed:s.confirmed, qty:s.allocations.reduce((n,a)=>n+a.qty,0) }));
  });
  expect(result).toEqual([{confirmed:true,qty:1},{confirmed:true,qty:1},{confirmed:true,qty:2},{confirmed:true,qty:1}]);
  await page.getByRole('button', { name: '＋ 添加商品' }).click();
  await paste();
  await page.getByRole('button', { name: '添加全部 4 个订单', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已经添加');
});
