import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { LabelPage, LabelParseResult } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url,
).toString();

function normalizeLabelText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const AMAZON_ORDER_ID_PATTERN = /\b\d{3}-\d{7}-\d{7}\b/g;

function isOrderListPageText(value: string): boolean {
  return /list of orders with successful label purchase/i.test(value);
}

function isOrderListContinuationPageText(value: string): boolean {
  const orderIds = value.match(AMAZON_ORDER_ID_PATTERN) ?? [];

  if (orderIds.length === 0) {
    return false;
  }

  const leftoverText = value
    .replace(AMAZON_ORDER_ID_PATTERN, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();

  return leftoverText.length === 0 || leftoverText.length <= 24;
}

function collectOrderListPageNumbers(
  pages: Array<{
    pageNumber: number;
    text: string;
  }>,
): number[] {
  const orderedPages = pages.slice().sort((left, right) => left.pageNumber - right.pageNumber);
  const orderListPages: number[] = [];
  let previousWasOrderList = false;

  orderedPages.forEach((page) => {
    if (isOrderListPageText(page.text)) {
      orderListPages.push(page.pageNumber);
      previousWasOrderList = true;
      return;
    }

    if (previousWasOrderList && isOrderListContinuationPageText(page.text)) {
      orderListPages.push(page.pageNumber);
      previousWasOrderList = true;
      return;
    }

    previousWasOrderList = false;
  });

  return orderListPages;
}

export async function parseLabelPdf(file: File): Promise<LabelParseResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;
  const pages: LabelPage[] = [];
  const warnings: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    try {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const viewport = page.getViewport({ scale: 1 });

      pages.push({
        id: `${file.name}-${pageNumber}`,
        sourceName: file.name,
        pageNumber,
        text,
        normalizedText: normalizeLabelText(text),
        width: viewport.width,
        height: viewport.height,
      });

      page.cleanup();
    } catch (error) {
      warnings.push(
        `${file.name} 第 ${pageNumber} 页解析失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      );
    }
  }

  const orderListPages = collectOrderListPageNumbers(pages);
  const imageOnlyPages = pages
    .filter((page) => !page.text.trim())
    .map((page) => page.pageNumber);

  if (orderListPages.length > 0) {
    warnings.push(
      `${file.name} 第 ${orderListPages.join('、')} 页是标签购买成功汇总页，不是实际标签页。`,
    );
  }

  if (imageOnlyPages.length > 0) {
    warnings.push(
      `${file.name} 有 ${imageOnlyPages.length} 页没有可搜索文字层；当前会优先尝试按汇总页顺序回退匹配，否则需要 OCR 才能自动匹配。`,
    );
  }

  await pdf.destroy();

  return {
    sourceName: file.name,
    pages,
    warnings,
  };
}
