import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
test('detachable strip preserves label dimensions and prints all allocated items', async ({ page }, testInfo) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const pdfPath = '/node_modules/.vite/deps/pdf-lib.js';
    const { PDFDocument } = await import(/* @vite-ignore */ pdfPath);
    const modulePath = '/src/lib/batchPdf.ts';
    const workflowPath = '/src/lib/batchWorkflow.ts';
    const { orderedLabelsPdf } = await import(/* @vite-ignore */ modulePath);
    const { emptyLine } = await import(/* @vite-ignore */ workflowPath);
    const source = await PDFDocument.create(); const original = source.addPage([288,432]);
    original.drawText('ORIGINAL SHIPPING LABEL', {x:20,y:380,size:14});
    const lines = [
      {...emptyLine(),id:'a',color:'黄色',size:'7’ X 7’',product:'Straight edge with grommets',note:'★'},
      {...emptyLine(),id:'b',color:'黄色',size:'7’ X 7’',product:'Shade sail'},
      {...emptyLine(),id:'c',color:'黄色',size:'7’ X 7’',product:'Privacy fence'},
    ];
    const batch = {lines,shipments:[{label:{assetId:'pdf',pageNumber:1},allocations:lines.map(l=>({lineId:l.id,qty:1}))}]};
    const bytes = await orderedLabelsPdf(batch,[{id:'pdf',file:new Blob([await source.save()])}],undefined,true);
    const pdf = await PDFDocument.load(bytes);
    const rendererPath='/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
    const renderer=await import(/* @vite-ignore */ rendererPath);
    renderer.GlobalWorkerOptions.workerSrc='/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
    const rendered=await renderer.getDocument({data:new Uint8Array(bytes)}).promise;
    const first=await rendered.getPage(1);const text=(await first.getTextContent()).items.map((i:{str?:string})=>i.str||'').join(' ');
    const canvas=document.createElement('canvas');const viewport=first.getViewport({scale:2});canvas.width=viewport.width;canvas.height=viewport.height;
    await first.render({canvas,viewport}).promise;document.body.replaceChildren(canvas);
    return {bytes:[...bytes],text,size:pdf.getPage(0).getSize(),count:pdf.getPageCount()};
  });
  expect(result.count).toBe(1);expect(result.size).toEqual({width:288,height:502});
  expect(result.text).toContain('黄 7x7直加环 急');expect(result.text).toContain('黄 7x7阳');expect(result.text).toContain('ORIGINAL SHIPPING LABEL');
  await writeFile(testInfo.outputPath('label-strip.pdf'),Buffer.from(result.bytes));
  await page.locator('canvas').screenshot({path:testInfo.outputPath('label-strip.png')});
});
