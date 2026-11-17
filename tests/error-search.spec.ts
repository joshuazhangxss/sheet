import { test, expect } from '@playwright/test';
test('error page searches all orders and edits without leaving the page', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/src/lib/batchWorkflow.ts';
    const { emptyBatch, emptyLine, saveDraft } = await import(/* @vite-ignore */ path);
    const d = emptyBatch();
    d.lines = [{ ...emptyLine(), id:'item', orderId:'SEARCH-12345', recipient:'Test Customer', product:'Fence', size:'6 x 9', color:'灰色', qty:0 }];
    d.labels = [{id:'label',assetId:'missing',text:'SEARCH-12345',normalizedText:'SEARCH-12345',sourceName:'test.pdf',pageNumber:1,width:288,height:432,excluded:false}];
    await saveDraft(d);
  });
  await page.reload();
  await page.getByRole('button',{name:'2 打印',exact:true}).click();
  await page.getByRole('button',{name:'查找此订单'}).first().click();
  await expect(page.getByLabel('搜索待处理订单')).toHaveValue('SEARCH-12345');
  const search = page.getByRole('region',{name:'查找并修改订单'});
  await expect(search).toContainText('Test Customer');
  await search.getByRole('button',{name:'修改商品'}).click();
  await page.locator('input[name=qty]').fill('2');
  await page.getByRole('button',{name:'确认并保存商品'}).click();
  await expect(page.getByRole('heading',{name:'需要补充的信息'})).toBeVisible();
  await expect(page.getByRole('button',{name:'继续打印',exact:true})).toBeEnabled();
  await search.getByRole('button',{name:/分配数量/}).click();
  await expect(page.getByRole('heading',{name:'核对标签原件'})).toBeVisible();
  await page.getByLabel('搜索待处理订单').fill('not-found');
  await expect(search).toContainText('没有找到订单');
});
