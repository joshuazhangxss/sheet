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
const ERROR_ORDER_LIST_PAGE_PATTERN = /list of orders with (?:an )?errors? in label purchase/i;

function isOrderListPageText(value: string): boolean {
  return /list of orders with successful label purchase/i.test(value);
}

function hasErrorOrderListSection(value: string): boolean {
  return ERROR_ORDER_LIST_PAGE_PATTERN.test(value);
}

function getTextBeforeErrorOrderList(value: string): string {
  const errorHeaderMatch = value.match(ERROR_ORDER_LIST_PAGE_PATTERN);

  if (!errorHeaderMatch) {
    return value;
  }

  return value.slice(0, errorHeaderMatch.index ?? 0);
}

function extractErrorOrderIds(value: string): string[] {
  const errorHeaderMatch = value.match(ERROR_ORDER_LIST_PAGE_PATTERN);

  if (!errorHeaderMatch) {
    return [];
  }

  const errorSectionText = value.slice(
    (errorHeaderMatch.index ?? 0) + errorHeaderMatch[0].length,
  );

  return Array.from(new Set(errorSectionText.match(AMAZON_ORDER_ID_PATTERN) ?? []));
}

function extractOrderIds(value: string): string[] {
  return Array.from(new Set(value.match(AMAZON_ORDER_ID_PATTERN) ?? []));
}

function isOrderListContinuationPageText(value: string): boolean {
  const successText = getTextBeforeErrorOrderList(value);
  const orderIds = successText.match(AMAZON_ORDER_ID_PATTERN) ?? [];

  if (orderIds.length === 0) {
    return false;
  }

  const leftoverText = successText
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

function collectErrorOrderEntries(
  pages: Array<{
    pageNumber: number;
    text: string;
  }>,
): Array<{ pageNumber: number; orderIds: string[] }> {
  const orderedPages = pages.slice().sort((left, right) => left.pageNumber - right.pageNumber);
  const entries: Array<{ pageNumber: number; orderIds: string[] }> = [];
  let previousWasErrorOrderList = false;

  orderedPages.forEach((page) => {
    if (hasErrorOrderListSection(page.text)) {
      const orderIds = extractErrorOrderIds(page.text);

      if (orderIds.length > 0) {
        entries.push({
          pageNumber: page.pageNumber,
          orderIds,
        });
      }

      previousWasErrorOrderList = true;
      return;
    }

    if (previousWasErrorOrderList && isOrderListContinuationPageText(page.text)) {
      const orderIds = extractOrderIds(page.text);

      if (orderIds.length > 0) {
        entries.push({
          pageNumber: page.pageNumber,
          orderIds,
        });
      }

      previousWasErrorOrderList = true;
      return;
    }

    previousWasErrorOrderList = false;
  });

  return entries;
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
  const errorOrderEntries = collectErrorOrderEntries(pages);
  const imageOnlyPages = pages
    .filter((page) => !page.text.trim())
    .map((page) => page.pageNumber);

  if (orderListPages.length > 0) {
    warnings.push(
      `${file.name} 第 ${orderListPages.join('、')} 页是标签购买成功汇总页，不是实际标签页。`,
    );
  }

  errorOrderEntries.forEach((entry) => {
    warnings.push(
      `${file.name} 第 ${entry.pageNumber} 页有标签购买失败订单：${entry.orderIds.join(
        '、',
      )}。这些订单不会作为成功标签匹配，请单独处理。`,
    );
  });

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
