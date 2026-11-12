import { test, expect } from '@playwright/test';
for (const reverse of [false, true]) test(`overlapping seller reports match distinct labels without inflated quantities (reverse=${reverse})`, async ({ page }) => {
  const directory = process.env.OVERLAP_FIXTURES;
  test.skip(!directory, 'Requires user-provided November 11 reports and labels');
  test.setTimeout(180_000);
  await page.goto('/');
  const names = ['ededn.txt', 'eden.pdf', 'eden2.txt', 'edenn2.pdf'];
  await page.locator('.bw input[type=file]').setInputFiles((reverse ? names.reverse() : names).map(name => `${directory}/${name}`));
  await expect(page.getByRole('status')).toContainText('已处理 4 个文件', { timeout: 150_000 });
  await expect(page.getByText(/已忽略 22 行跨文件重复商品/)).toBeVisible();
  await page.getByRole('button', { name: '查看结果并打印 →' }).click();
  await expect(page.getByRole('heading', { name: '打印中心' })).toBeVisible();
  await expect(page.locator('.bw-print-center tbody tr')).toHaveCount(26);
  await expect(page.locator('.bw-save')).toContainText('已保存到此浏览器');
  const result = await page.evaluate(async () => {
    const path = '/src/lib/batchWorkflow.ts';
    const { loadDraft } = await import(/* @vite-ignore */ path);
    const draft = await loadDraft();
    const batch = draft.history.find((b: {id:string}) => b.id === draft.releasedId);
    return { rows: draft.lines.length, units: batch.shipments.flatMap((s:{allocations:{qty:number}[]}) => s.allocations).reduce((n:number,a:{qty:number})=>n+a.qty,0) };
  });
  expect(result).toEqual({rows:61,units:30});
});
