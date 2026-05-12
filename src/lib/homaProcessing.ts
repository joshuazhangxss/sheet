import * as XLSX from 'xlsx';

import {
  extractSize,
  toDateTimeInputValue,
} from './orderProcessing';
import type {
  MasterRow,
  OrderRow,
  ParsedImport,
  ProductionOverrideMap,
  RawSourceRecord,
} from '../types';

export type HomaOrderListRow = {
  id: string;
  amazonOrderId: string;
  purchaseDate: string;
  customerName: string;
  sku: string;
  description: string;
  size: string;
  color: string;
  productType: string;
  qty: number;
};

const HOMA_COLUMN_ALIASES = {
  customerName: ['customername', 'name'],
  sku: ['sku'],
  description: ['description'],
  productSize: ['productsize', 'size'],
  quantity: ['quantity', 'qty'],
  amazonOrderId: ['订单号', 'amazonorderid', 'orderno'],
  orderDate: ['订单日期', 'orderdate', 'date'],
} as const;

const HOMA_COLOR_MAP: Array<{ matcher: RegExp; zh: string; en: string }> = [
  { matcher: /双色|brown\s*\/\s*khaki/i, zh: '双色', en: 'Brown/Khaki' },
  { matcher: /米色|beige/i, zh: '米色', en: 'Beige' },
  { matcher: /棕色|brown/i, zh: '棕色', en: 'Brown' },
  { matcher: /灰色|grey|gray/i, zh: '灰色', en: 'Grey' },
  { matcher: /蓝色|blue/i, zh: '蓝色', en: 'Blue' },
  { matcher: /黄色|yellow|wheat/i, zh: '黄色', en: 'Yellow' },
  { matcher: /绿色|green/i, zh: '绿色', en: 'Green' },
  { matcher: /黑色|black/i, zh: '黑色', en: 'Black' },
];

function normalizeHeader(value: string): string {
  return value.replace(/\uFEFF/g, '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function cleanCell(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return String(value ?? '').replace(/\uFEFF/g, '').trim();
}

function simpleHash(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

function excelSerialToDateString(value: number): string {
  const parsed = XLSX.SSF.parse_date_code(value);

  if (!parsed) {
    return '';
  }

  const year = String(parsed.y).padStart(4, '0');
  const month = String(parsed.m).padStart(2, '0');
  const day = String(parsed.d).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function normalizeExcelDate(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return excelSerialToDateString(value);
  }

  if (value instanceof Date) {
    return cleanCell(value);
  }

  return cleanCell(value);
}

function findValue(
  row: Record<string, unknown>,
  aliases: readonly string[],
): string {
  const aliasSet = new Set(aliases.map(normalizeHeader));

  for (const [header, value] of Object.entries(row)) {
    if (aliasSet.has(normalizeHeader(header))) {
      return cleanCell(value);
    }
  }

  return '';
}

function parseColor(description: string, sku: string): { zh: string; en: string } {
  const source = `${description} ${sku}`;

  for (const rule of HOMA_COLOR_MAP) {
    if (rule.matcher.test(source)) {
      return { zh: rule.zh, en: rule.en };
    }
  }

  return { zh: '未识别颜色', en: 'Unknown' };
}

function buildSyntheticProductName(description: string, size: string, sku: string): string {
  const color = parseColor(description, sku);

  return [color.en, size].filter(Boolean).join(' ').trim() || description;
}

function buildOrderRow(
  original: RawSourceRecord,
  sourceName: string,
  index: number,
): OrderRow {
  const customerName = findValue(original, HOMA_COLUMN_ALIASES.customerName);
  const sku = findValue(original, HOMA_COLUMN_ALIASES.sku);
  const description = findValue(original, HOMA_COLUMN_ALIASES.description);
  const productSize = findValue(original, HOMA_COLUMN_ALIASES.productSize);
  const amazonOrderId = findValue(original, HOMA_COLUMN_ALIASES.amazonOrderId);
  const orderDate = findValue(original, HOMA_COLUMN_ALIASES.orderDate);
  const quantity = Number.parseInt(findValue(original, HOMA_COLUMN_ALIASES.quantity), 10) || 1;
  const syntheticProductName = buildSyntheticProductName(description, productSize, sku);
  const signature = `${sourceName}|${index}|${amazonOrderId}|${sku}|${description}|${productSize}|${customerName}`;

  return {
    id: `${sourceName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${index}-${simpleHash(signature)}`,
    sourceName,
    original,
    originalProductName: description || syntheticProductName,
    amazonOrderId,
    purchaseDate: orderDate,
    purchaseDateTime: toDateTimeInputValue(orderDate),
    orderStatus: 'Unshipped',
    fulfillmentChannel: 'Merchant',
    shipServiceLevel: 'Standard',
    productName: syntheticProductName,
    sku,
    itemStatus: 'Unshipped',
    quantity,
  };
}

function sheetRowsToObjects(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: true,
  });
}

export async function parseHomaExcel(file: File): Promise<ParsedImport> {
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    cellDates: true,
  });
  const rows: OrderRow[] = [];
  const headers: string[] = [];
  const warnings: string[] = [];

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return;
    }

    const records = sheetRowsToObjects(sheet);

    records.forEach((record, index) => {
      const normalized: RawSourceRecord = {};

      Object.entries(record).forEach(([header, value]) => {
        if (!headers.includes(header)) {
          headers.push(header);
        }

        if (normalizeHeader(header) === normalizeHeader('订单日期')) {
          normalized[header] = normalizeExcelDate(value);
          return;
        }

        normalized[header] = cleanCell(value);
      });

      const hasContent = Object.values(normalized).some(Boolean);

      if (!hasContent) {
        return;
      }

      const orderId = findValue(normalized, HOMA_COLUMN_ALIASES.amazonOrderId);
      const description = findValue(normalized, HOMA_COLUMN_ALIASES.description);

      if (!orderId || !description) {
        warnings.push(`${file.name} / ${sheetName} 第 ${index + 2} 行缺少订单号或描述，已跳过。`);
        return;
      }

      rows.push(buildOrderRow(normalized, file.name, rows.length));
    });
  });

  return {
    sourceName: file.name,
    rows,
    headers,
    warnings,
  };
}

function getOriginalValue(row: OrderRow, header: string): string {
  const target = normalizeHeader(header);

  for (const [key, value] of Object.entries(row.original)) {
    if (normalizeHeader(key) === target) {
      return value.trim();
    }
  }

  return '';
}

function resolveHomaColor(row: OrderRow): string {
  return parseColor(
    getOriginalValue(row, 'Description') || row.originalProductName || row.productName,
    row.sku,
  ).zh;
}

function resolveHomaSize(row: OrderRow): string {
  const size = getOriginalValue(row, 'Product Size');

  return extractSize(size || row.productName, row.sku) || size || '待确认尺寸';
}

export function buildHomaMasterRows(
  rows: OrderRow[],
  overrides: ProductionOverrideMap,
): MasterRow[] {
  return rows
    .slice()
    .sort((left, right) => {
      const leftDate = left.purchaseDateTime || left.purchaseDate;
      const rightDate = right.purchaseDateTime || right.purchaseDate;

      return leftDate.localeCompare(rightDate) || left.amazonOrderId.localeCompare(right.amazonOrderId);
    })
    .map((row) => {
      const override = overrides[row.id] ?? {};

      return {
        id: row.id,
        sourceRowId: row.id,
        size: override.size ?? resolveHomaSize(row),
        color: override.color ?? resolveHomaColor(row),
        qty: row.quantity,
        note: override.note ?? '',
        productType: override.productType ?? '',
        amazonOrderId: row.amazonOrderId,
        orderStatus: row.orderStatus,
        shipServiceLevel: row.shipServiceLevel,
        purchaseDate: row.purchaseDateTime || row.purchaseDate,
      };
    });
}

export function buildHomaOrderListRows(
  rows: OrderRow[],
  overrides: ProductionOverrideMap,
): HomaOrderListRow[] {
  return rows
    .slice()
    .sort((left, right) => {
      const leftDate = left.purchaseDateTime || left.purchaseDate;
      const rightDate = right.purchaseDateTime || right.purchaseDate;

      return leftDate.localeCompare(rightDate) || left.amazonOrderId.localeCompare(right.amazonOrderId);
    })
    .map((row) => {
      const override = overrides[row.id] ?? {};

      return {
        id: row.id,
        amazonOrderId: row.amazonOrderId,
        purchaseDate: row.purchaseDateTime || row.purchaseDate,
        customerName: getOriginalValue(row, 'Customer Name') || '—',
        sku: row.sku,
        description: getOriginalValue(row, 'Description') || row.originalProductName || row.productName,
        size: override.size ?? resolveHomaSize(row),
        color: override.color ?? resolveHomaColor(row),
        productType: override.productType ?? '—',
        qty: row.quantity,
      };
    });
}
