import Papa from 'papaparse';

import type {
  DailyColorGroup,
  DailyOrderRow,
  EditableOrderFields,
  FilterOptionSet,
  FilterState,
  DailyOrderItem,
  MakerColorGroup,
  MakerRow,
  MasterRow,
  MergeResult,
  OrderRow,
  ParsedImport,
  ProductionDetails,
  ProductionOverrideMap,
  RawEditMap,
  RawSourceRecord,
} from '../types';

const HEADER_ALIASES: Record<string, keyof EditableOrderFields> = {
  amazonorderid: 'amazonOrderId',
  purchasedate: 'purchaseDate',
  orderstatus: 'orderStatus',
  fulfillmentchannel: 'fulfillmentChannel',
  shipservicelevel: 'shipServiceLevel',
  productname: 'productName',
  sku: 'sku',
  itemstatus: 'itemStatus',
  quantity: 'quantity',
  qty: 'quantity',
  quantityordered: 'quantity',
  quantitypurchased: 'quantity',
};

export const REQUIRED_FIELDS: Array<keyof EditableOrderFields> = [
  'amazonOrderId',
  'purchaseDate',
  'orderStatus',
  'fulfillmentChannel',
  'shipServiceLevel',
  'productName',
  'sku',
  'itemStatus',
  'quantity',
];

const FIELD_LABELS: Record<keyof EditableOrderFields, string> = {
  amazonOrderId: '亚马逊订单号',
  purchaseDate: '购买时间',
  orderStatus: '订单状态',
  fulfillmentChannel: '配送方式',
  shipServiceLevel: '物流级别',
  productName: '产品名称',
  sku: 'sku',
  itemStatus: '商品状态',
  quantity: '数量',
};

const COLOR_RULES: Array<{ matcher: RegExp; value: string }> = [
  { matcher: /\b(grey|gray)\b/i, value: '灰色' },
  { matcher: /\bbeige\b/i, value: '米色' },
  { matcher: /\bbrown\b/i, value: '棕色' },
  { matcher: /\bblue\b/i, value: '蓝色' },
  { matcher: /\b(wheat|yellow)\b/i, value: '黄色' },
  { matcher: /\bblack\b/i, value: '黑色' },
  { matcher: /\bgreen\b/i, value: '绿色' },
];

const COMPANY_VARIANT_MARKERS = new Set([
  'beige',
  'black',
  'blue',
  'brown',
  'curved',
  'curve',
  'custom',
  'edge',
  'edged',
  'flat',
  'gray',
  'green',
  'grey',
  'heavy',
  'premium',
  'rectangle',
  'rectangular',
  'resistant',
  'square',
  'straight',
  'triangle',
  'triangular',
  'uv',
  'waterproof',
  'wheat',
  'yellow',
]);

const COMPANY_TRAILING_PRODUCT_WORDS = new Set([
  'awning',
  'canopy',
  'cloth',
  'cover',
  'fabric',
  'fence',
  'mesh',
  'panel',
  'privacy',
  'sail',
  'screen',
  'shade',
  'sun',
  'sunshade',
]);

function normalizeHeader(value: string): string {
  return value.replace(/\uFEFF/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function inspectHeaders(headers: string[]): {
  found: string[];
  missing: string[];
} {
  const foundFields = new Set<keyof EditableOrderFields>();

  headers.forEach((header) => {
    const alias = HEADER_ALIASES[normalizeHeader(header)];

    if (alias) {
      foundFields.add(alias);
    }
  });

  return {
    found: REQUIRED_FIELDS.filter((field) => foundFields.has(field)).map(
      (field) => FIELD_LABELS[field],
    ),
    missing: REQUIRED_FIELDS.filter((field) => !foundFields.has(field)).map(
      (field) => FIELD_LABELS[field],
    ),
  };
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(
    date.getDate(),
  )}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function cleanCell(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(cleanCell).filter(Boolean).join(' | ');
  }

  return String(value ?? '').replace(/\uFEFF/g, '').trim();
}

function normalizeCompanyWord(value: string): string {
  return value.toLowerCase().replace(/^[^a-z0-9&]+|[^a-z0-9&]+$/g, '');
}

function cleanCompanyWord(value: string): string {
  return value.replace(/^[^0-9A-Za-z&]+|[^0-9A-Za-z&]+$/g, '');
}

function isSizeLikeWord(value: string): boolean {
  return /\d/.test(value) || /^(x|×|ft|feet|foot|in|inch|inches)$/.test(value);
}

function simpleHash(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

function buildFullRowSignature(original: RawSourceRecord): string {
  return Object.entries(original)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join('|');
}

function buildDedupKey(row: OrderRow): string {
  if (row.amazonOrderId && row.productName) {
    return `${row.amazonOrderId}::${row.productName.toLowerCase()}`;
  }

  return buildFullRowSignature(row.original).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractCompanyName(productName: string): string {
  const words = productName.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const collected: string[] = [];

  for (const word of words) {
    const normalized = normalizeCompanyWord(word);

    if (!normalized) {
      if (collected.length > 0) {
        break;
      }

      continue;
    }

    if (isSizeLikeWord(normalized) || COMPANY_VARIANT_MARKERS.has(normalized)) {
      break;
    }

    const cleaned = cleanCompanyWord(word);

    if (!cleaned) {
      if (collected.length > 0) {
        break;
      }

      continue;
    }

    collected.push(cleaned);

    if (collected.length >= 6) {
      break;
    }
  }

  while (collected.length > 0) {
    const trailingWord = normalizeCompanyWord(collected[collected.length - 1] ?? '');

    if (COMPANY_TRAILING_PRODUCT_WORDS.has(trailingWord)) {
      collected.pop();
      continue;
    }

    break;
  }

  const candidate = collected
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-|:;/]+|[-|:;/]+$/g, '')
    .trim();

  if (!candidate || !/[a-z]/i.test(candidate)) {
    return '';
  }

  const candidateWords = candidate
    .split(/\s+/)
    .map(normalizeCompanyWord)
    .filter(Boolean);

  if (candidateWords.length === 0 || candidateWords.length > 5) {
    return '';
  }

  if (candidateWords.every((word) => COMPANY_TRAILING_PRODUCT_WORDS.has(word))) {
    return '';
  }

  return candidate;
}

export function simplifyProductName(productName: string): string {
  const source = productName.replace(/\s+/g, ' ').trim();

  if (!source) {
    return '';
  }

  const companyName = extractCompanyName(source);

  if (!companyName) {
    return source;
  }

  const nextValue = source
    .replace(
      new RegExp(`^${escapeRegExp(companyName)}\\b\\s*(?:[|:/-]+\\s*)?`, 'i'),
      '',
    )
    .replace(/^[|:/-]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return nextValue || source;
}

export function toDateTimeInputValue(value: string): string {
  const source = value.trim();

  if (!source) {
    return '';
  }

  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      source,
    )
  ) {
    const parsed = new Date(source);

    if (!Number.isNaN(parsed.getTime())) {
      return formatLocalDateTime(parsed);
    }
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(source)) {
    return source.slice(0, 16);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    return `${source}T00:00`;
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(source)) {
    const parsed = new Date(source);

    if (!Number.isNaN(parsed.getTime())) {
      return formatLocalDateTime(parsed);
    }
  }

  const parsed = new Date(source);

  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return formatLocalDateTime(parsed);
}

function normalizeFilterDateTime(
  value: string,
  boundary: 'start' | 'end',
): string {
  const source = value.trim();

  if (!source) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    return `${source}${boundary === 'start' ? 'T00:00' : 'T23:59'}`;
  }

  return toDateTimeInputValue(source);
}

function parseQuantity(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return 1;
  }

  return parsed;
}

function createOrderRow(
  original: RawSourceRecord,
  sourceName: string,
  index: number,
): OrderRow {
  const mapped: EditableOrderFields = {
    amazonOrderId: '',
    purchaseDate: '',
    orderStatus: '',
    fulfillmentChannel: '',
    shipServiceLevel: '',
    productName: '',
    sku: '',
    itemStatus: '',
    quantity: 1,
  };

  for (const [header, value] of Object.entries(original)) {
    const alias = HEADER_ALIASES[normalizeHeader(header)];

    if (!alias) {
      continue;
    }

    if (alias === 'quantity') {
      mapped.quantity = parseQuantity(value);
      continue;
    }

    mapped[alias] = value;
  }

  const signature = `${sourceName}|${index}|${mapped.amazonOrderId}|${mapped.productName}|${buildFullRowSignature(original)}`;

  return {
    id: `${sourceName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${index}-${simpleHash(signature)}`,
    sourceName,
    original,
    originalProductName: mapped.productName,
    amazonOrderId: mapped.amazonOrderId,
    purchaseDate: mapped.purchaseDate,
    purchaseDateTime: toDateTimeInputValue(mapped.purchaseDate),
    orderStatus: mapped.orderStatus,
    fulfillmentChannel: mapped.fulfillmentChannel,
    shipServiceLevel: mapped.shipServiceLevel,
    productName: mapped.productName,
    sku: mapped.sku,
    itemStatus: mapped.itemStatus,
    quantity: mapped.quantity,
  };
}

export function parseAmazonText(text: string, sourceName: string): ParsedImport {
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transform: (value) => cleanCell(value),
  });

  const headers: string[] = [];
  const rows: OrderRow[] = [];

  parsed.data.forEach((record, index) => {
    const original: RawSourceRecord = {};

    Object.entries(record).forEach(([header, value]) => {
      if (!header || header === '__parsed_extra') {
        return;
      }

      const cleanedHeader = header.trim();

      if (!headers.includes(cleanedHeader)) {
        headers.push(cleanedHeader);
      }

      original[cleanedHeader] = cleanCell(value);
    });

    const hasContent = Object.values(original).some(Boolean);

    if (!hasContent) {
      return;
    }

    rows.push(createOrderRow(original, sourceName, index));
  });

  const warnings = parsed.errors.map((error) => `${sourceName}: ${error.message}`);

  return {
    sourceName,
    rows,
    headers,
    warnings,
  };
}

export function mergeImportedData(
  existingRows: OrderRow[],
  existingHeaders: string[],
  imports: ParsedImport[],
): MergeResult {
  const rows = [...existingRows];
  const headers = [...existingHeaders];
  const seenRows = new Set(existingRows.map(buildDedupKey));
  let duplicatesRemoved = 0;

  imports.forEach((item) => {
    item.headers.forEach((header) => {
      if (!headers.includes(header)) {
        headers.push(header);
      }
    });

    item.rows.forEach((row) => {
      const dedupKey = buildDedupKey(row);

      if (seenRows.has(dedupKey)) {
        duplicatesRemoved += 1;
        return;
      }

      seenRows.add(dedupKey);
      rows.push(row);
    });
  });

  return {
    rows,
    headers,
    duplicatesRemoved,
  };
}

export function applyRawEdits(rows: OrderRow[], edits: RawEditMap): OrderRow[] {
  return rows.map((row) => {
    const rowEdits = edits[row.id];

    if (!rowEdits) {
      return row;
    }

    const nextPurchaseDate = rowEdits.purchaseDate ?? row.purchaseDate;

    return {
      ...row,
      ...rowEdits,
      quantity:
        typeof rowEdits.quantity === 'number' ? rowEdits.quantity : row.quantity,
      purchaseDate: nextPurchaseDate,
      purchaseDateTime: toDateTimeInputValue(nextPurchaseDate),
    };
  });
}

function normalizeComparisonValue(value: string): string {
  return value.trim().toLowerCase();
}

function matchesLifecycle(row: OrderRow, matcher: string): boolean {
  const target = matcher.toLowerCase();

  return [row.orderStatus, row.itemStatus].some((value) =>
    normalizeComparisonValue(value).includes(target),
  );
}

export function filterOrderRows(rows: OrderRow[], filters: FilterState): OrderRow[] {
  const keyword = filters.keyword.trim().toLowerCase();
  const dateFrom = normalizeFilterDateTime(filters.dateFrom, 'start');
  const dateTo = normalizeFilterDateTime(filters.dateTo, 'end');

  return rows.filter((row) => {
    if (dateFrom && (!row.purchaseDateTime || row.purchaseDateTime < dateFrom)) {
      return false;
    }

    if (dateTo && (!row.purchaseDateTime || row.purchaseDateTime > dateTo)) {
      return false;
    }

    if (
      filters.companyNames.length > 0 &&
      !filters.companyNames
        .map(normalizeComparisonValue)
        .includes(normalizeComparisonValue(extractCompanyName(row.productName)))
    ) {
      return false;
    }

    if (
      filters.colors.length > 0 &&
      !filters.colors
        .map(normalizeComparisonValue)
        .includes(normalizeComparisonValue(extractColor(row.productName, row.sku)))
    ) {
      return false;
    }

    if (
      filters.fulfillmentChannels.length > 0 &&
      !filters.fulfillmentChannels
        .map(normalizeComparisonValue)
        .includes(normalizeComparisonValue(row.fulfillmentChannel))
    ) {
      return false;
    }

    if (
      filters.orderStatuses.length > 0 &&
      !filters.orderStatuses
        .map(normalizeComparisonValue)
        .includes(normalizeComparisonValue(row.orderStatus))
    ) {
      return false;
    }

    if (
      filters.shipServiceLevels.length > 0 &&
      !filters.shipServiceLevels
        .map(normalizeComparisonValue)
        .includes(normalizeComparisonValue(row.shipServiceLevel))
    ) {
      return false;
    }

    if (
      filters.itemStatuses.length > 0 &&
      !filters.itemStatuses
        .map(normalizeComparisonValue)
        .includes(normalizeComparisonValue(row.itemStatus))
    ) {
      return false;
    }

    if (filters.excludePending && matchesLifecycle(row, 'pending')) {
      return false;
    }

    if (filters.excludeCancelled && matchesLifecycle(row, 'cancel')) {
      return false;
    }

    if (filters.excludeShipped && matchesLifecycle(row, 'shipped')) {
      return false;
    }

    if (keyword) {
      const haystack = `${row.productName} ${row.sku}`.toLowerCase();
      if (!haystack.includes(keyword)) {
        return false;
      }
    }

    return true;
  });
}

function normalizeUnit(unit: string | undefined): string {
  if (!unit) {
    return '';
  }

  if (/^(ft|feet|foot|['’′`])$/i.test(unit)) {
    return '’';
  }

  if (/^(in|inch|inches|["”“])$/i.test(unit)) {
    return '”';
  }

  return unit;
}

function formatDimensionToken(value: string): string {
  const token = value.trim();

  if (!token) {
    return '';
  }

  const mixedMatch = token.match(
    /^(\d{1,2})\s*(?:ft|feet|foot|['’′`])\s*(\d{1,2})\s*(?:in|inch|inches|["”“])$/i,
  );

  if (mixedMatch) {
    const [, feetValue, inchValue] = mixedMatch;
    return `${feetValue}’${inchValue}”`;
  }

  const simpleMatch = token.match(
    /^(\d{1,3}(?:\.\d+)?)\s*(ft|feet|foot|in|inch|inches|['’′`"])?$/i,
  );

  if (!simpleMatch) {
    return token;
  }

  const [, numericValue, unit] = simpleMatch;
  return `${numericValue}${normalizeUnit(unit)}`;
}

export function extractSize(productName: string, sku: string): string {
  const dimensionToken =
    /(?:\d{1,2}\s*(?:ft|feet|foot|['’′`])\s*\d{1,2}\s*(?:in|inch|inches|["”“])|\d{1,3}(?:\.\d+)?\s*(?:ft|feet|foot|in|inch|inches|['’′`"])?)/
      .source;
  const chainPattern = new RegExp(
    `(${dimensionToken})\\s*[xX×]\\s*(${dimensionToken})(?:\\s*[xX×]\\s*(${dimensionToken}))?`,
    'i',
  );

  for (const source of [productName, sku]) {
    const match = source.match(chainPattern);

    if (!match) {
      continue;
    }

    const formattedParts = match
      .slice(1)
      .filter((part): part is string => Boolean(part))
      .map(formatDimensionToken)
      .filter(Boolean);

    if (formattedParts.length >= 2) {
      return formattedParts.join(' X ').trim();
    }
  }

  return '';
}

export function extractColor(productName: string, sku: string): string {
  const combined = `${productName} ${sku}`;
  const normalized = combined.replace(/[_-]+/g, ' ');

  if (/\bbrown\b/i.test(normalized) && /\bkhaki\b/i.test(normalized)) {
    return '双色';
  }

  for (const rule of COLOR_RULES) {
    if (rule.matcher.test(combined)) {
      return rule.value;
    }
  }

  return '';
}

export function extractProductType(productName: string, sku: string): string {
  const combined = `${productName} ${sku}`.toLowerCase();

  if (combined.includes('privacy screen') || combined.includes('privacy fence')) {
    return '隐私围栏';
  }

  if (/\b(flat|straight)\b/i.test(combined)) {
    return '直边';
  }

  // Worker-facing sheets only need a simple edge label for regular shades.
  return '弯边';
}

export function isPrivacyFenceType(productType: string): boolean {
  return productType.includes('隐私围栏') || productType.toLowerCase().includes('privacy');
}

export function isRushOrder(productName: string, shipServiceLevel: string): boolean {
  if (/expedited/i.test(shipServiceLevel)) {
    return true;
  }

  const companyName = extractCompanyName(productName);

  if (/^eden'?s decor$/i.test(companyName) && /standard/i.test(shipServiceLevel)) {
    return true;
  }

  return false;
}

export function buildNote(productName: string, shipServiceLevel: string): string {
  const markers: string[] = [];

  if (/\b(straight|flat)\b/i.test(productName)) {
    markers.push('直');
  }

  if (/grommet/i.test(productName)) {
    markers.push('环');
  }

  const notes: string[] = [];
  const markLabel = Array.from(new Set(markers)).join('+');

  if (markLabel) {
    notes.push(markLabel);
  }

  if (isRushOrder(productName, shipServiceLevel)) {
    notes.push('★');
  }

  return notes.join(' ');
}

export function hasRushNote(note: string): boolean {
  return note.includes('★');
}

export function stripRushNote(note: string): string {
  return note
    .replace(/★/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function composeNote(remark: string, isRush: boolean): string {
  const cleanedRemark = remark.replace(/★/g, '').replace(/\s+/g, ' ').trim();

  if (cleanedRemark && isRush) {
    return `${cleanedRemark} ★`;
  }

  if (cleanedRemark) {
    return cleanedRemark;
  }

  return isRush ? '★' : '';
}

function compareDailyOrderItems(left: DailyOrderItem, right: DailyOrderItem): number {
  const sizeDifference = compareLabels(left.size, right.size);

  if (sizeDifference !== 0) {
    return sizeDifference;
  }

  return left.qty - right.qty;
}

function buildDailyRowSizeLabel(row: DailyOrderRow): string {
  return row.items
    .map((item) => (item.qty > 1 ? `${item.size} x${item.qty}` : item.size))
    .join('、');
}

function isDailyYangRow(row: DailyOrderRow): boolean {
  return row.marks.includes('阳');
}

function sortDailyRows(rows: DailyOrderRow[]): DailyOrderRow[] {
  return [...rows].sort((left, right) => {
    const rushDifference = Number(right.rush) - Number(left.rush);

    if (rushDifference !== 0) {
      return rushDifference;
    }

    const marksDifference = compareLabels(left.marks, right.marks);

    if (marksDifference !== 0) {
      return marksDifference;
    }

    const sizeDifference = compareLabels(buildDailyRowSizeLabel(left), buildDailyRowSizeLabel(right));

    if (sizeDifference !== 0) {
      return sizeDifference;
    }

    const qtyDifference = left.totalQty - right.totalQty;

    if (qtyDifference !== 0) {
      return qtyDifference;
    }

    const orderDifference = compareLabels(left.amazonOrderId, right.amazonOrderId);

    if (orderDifference !== 0) {
      return orderDifference;
    }

    return compareLabels(left.purchaseDate, right.purchaseDate);
  });
}

export function buildDailyOrderMarks(row: OrderRow, productType?: string): string {
  const markers: string[] = [];
  const resolvedType = productType || extractProductType(row.productName, row.sku);

  if (/\b(straight|flat)\b/i.test(row.productName) || resolvedType === '直边') {
    markers.push('直');
  }

  if (/grommet/i.test(row.productName)) {
    markers.push('环');
  }

  if (isPrivacyFenceType(resolvedType) || /privacy screen|privacy fence/i.test(row.productName)) {
    markers.push('阳');
  }

  return Array.from(new Set(markers)).join('+');
}

export function extractProductionDetails(row: OrderRow): ProductionDetails {
  return {
    size: extractSize(row.productName, row.sku),
    color: extractColor(row.productName, row.sku),
    productType: extractProductType(row.productName, row.sku),
    note: buildNote(row.productName, row.shipServiceLevel),
    rush: isRushOrder(row.productName, row.shipServiceLevel),
    requiresStraightMark: /\b(straight|flat)\b/i.test(row.productName),
  };
}

function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

function uniqueLabels(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildOrderRowGroupLabel(row: OrderRow): string {
  const color = extractColor(row.productName, row.sku);
  const size = extractSize(row.productName, row.sku);
  const baseLabel =
    [color, size].filter(Boolean).join(' ') ||
    simplifyProductName(row.originalProductName || row.productName);
  const qtyLabel = row.quantity > 1 ? ` x${row.quantity}` : '';

  return `${baseLabel}${qtyLabel}`.trim();
}

function buildMasterRowGroupLabel(row: MasterRow): string {
  const baseLabel = [row.color, row.size].filter(Boolean).join(' ') || row.size || row.color;
  const qtyLabel = row.qty > 1 ? ` x${row.qty}` : '';

  return `${baseLabel}${qtyLabel}`.trim();
}

type OrderGroupSummary = {
  lineCount: number;
  totalQty: number;
  labels: string[];
};

export function sortOrderRowsForReview(rows: OrderRow[]): OrderRow[] {
  return [...rows].sort((left, right) => {
    const byDate = compareLabels(
      left.purchaseDateTime || left.purchaseDate,
      right.purchaseDateTime || right.purchaseDate,
    );

    if (byDate !== 0) {
      return byDate;
    }

    const byOrderId = compareLabels(left.amazonOrderId, right.amazonOrderId);

    if (byOrderId !== 0) {
      return byOrderId;
    }

    const bySource = compareLabels(left.sourceName, right.sourceName);

    if (bySource !== 0) {
      return bySource;
    }

    return compareLabels(left.productName, right.productName);
  });
}

export function buildOrderGroupSummaries(rows: OrderRow[]): Map<string, OrderGroupSummary> {
  const groups = new Map<
    string,
    {
      lineCount: number;
      totalQty: number;
      labels: string[];
    }
  >();

  rows.forEach((row) => {
    const orderId = row.amazonOrderId.trim();

    if (!orderId) {
      return;
    }

    const current = groups.get(orderId);

    if (!current) {
      groups.set(orderId, {
        lineCount: 1,
        totalQty: row.quantity,
        labels: [buildOrderRowGroupLabel(row)],
      });
      return;
    }

    current.lineCount += 1;
    current.totalQty += row.quantity;
    current.labels.push(buildOrderRowGroupLabel(row));
  });

  return new Map(
    Array.from(groups.entries()).map(([orderId, summary]) => [
      orderId,
      {
        lineCount: summary.lineCount,
        totalQty: summary.totalQty,
        labels: uniqueLabels(summary.labels),
      },
    ]),
  );
}

export function buildMasterOrderGroupSummaries(
  rows: MasterRow[],
): Map<string, OrderGroupSummary> {
  const groups = new Map<
    string,
    {
      lineCount: number;
      totalQty: number;
      labels: string[];
    }
  >();

  rows.forEach((row) => {
    const orderId = row.amazonOrderId.trim();

    if (!orderId) {
      return;
    }

    const current = groups.get(orderId);

    if (!current) {
      groups.set(orderId, {
        lineCount: 1,
        totalQty: row.qty,
        labels: [buildMasterRowGroupLabel(row)],
      });
      return;
    }

    current.lineCount += 1;
    current.totalQty += row.qty;
    current.labels.push(buildMasterRowGroupLabel(row));
  });

  return new Map(
    Array.from(groups.entries()).map(([orderId, summary]) => [
      orderId,
      {
        lineCount: summary.lineCount,
        totalQty: summary.totalQty,
        labels: uniqueLabels(summary.labels),
      },
    ]),
  );
}

export function buildMasterRows(
  rows: OrderRow[],
  overrides: ProductionOverrideMap,
): MasterRow[] {
  return [...rows]
    .sort((left, right) => {
      const byDate = compareLabels(
        left.purchaseDateTime || left.purchaseDate,
        right.purchaseDateTime || right.purchaseDate,
      );
      if (byDate !== 0) {
        return byDate;
      }

      return compareLabels(left.amazonOrderId, right.amazonOrderId);
    })
    .map((row) => {
      const extracted = extractProductionDetails(row);
      const override = overrides[row.id] ?? {};
      const rush = override.rush ?? extracted.rush;
      const note = composeNote(stripRushNote(override.note ?? extracted.note), rush);

      return {
        id: row.id,
        sourceRowId: row.id,
        size: override.size ?? extracted.size,
        color: override.color ?? extracted.color,
        qty: row.quantity,
        note,
        productType: override.productType ?? extracted.productType,
        amazonOrderId: row.amazonOrderId,
        orderStatus: row.orderStatus,
        shipServiceLevel: row.shipServiceLevel,
        purchaseDate: row.purchaseDateTime || row.purchaseDate,
      };
    });
}

function sortMakerRows(rows: MakerRow[]): MakerRow[] {
  return [...rows].sort((left, right) => {
    const bundledDifference =
      Number(Boolean(left.orderMarker)) - Number(Boolean(right.orderMarker));
    if (bundledDifference !== 0) {
      return bundledDifference;
    }

    if (left.orderMarker && right.orderMarker) {
      const markerDifference = compareLabels(left.orderMarker, right.orderMarker);
      if (markerDifference !== 0) {
        return markerDifference;
      }
    }

    const rushDifference = Number(right.note.includes('★')) - Number(left.note.includes('★'));
    if (rushDifference !== 0) {
      return rushDifference;
    }

    const straightDifference =
      Number(right.note.includes('直')) - Number(left.note.includes('直'));
    if (straightDifference !== 0) {
      return straightDifference;
    }

    const sizeDifference = compareLabels(left.size, right.size);
    if (sizeDifference !== 0) {
      return sizeDifference;
    }

    const typeDifference = compareLabels(left.productType, right.productType);
    if (typeDifference !== 0) {
      return typeDifference;
    }

    return compareLabels(left.color, right.color);
  });
}

const MAKER_COLOR_PRIORITY = ['棕色', '双色', '米色', '灰色', '蓝色', '黄色'];

function compareMakerColors(left: string, right: string): number {
  const leftIndex = MAKER_COLOR_PRIORITY.indexOf(left);
  const rightIndex = MAKER_COLOR_PRIORITY.indexOf(right);

  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) {
      return 1;
    }

    if (rightIndex === -1) {
      return -1;
    }

    return leftIndex - rightIndex;
  }

  return compareLabels(left, right);
}

function buildSameOrderMarker(index: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  if (index < alphabet.length) {
    return `同${alphabet[index]}`;
  }

  const firstIndex = Math.floor(index / alphabet.length) - 1;
  const secondIndex = index % alphabet.length;
  const first = alphabet[firstIndex] ?? '';
  const second = alphabet[secondIndex] ?? '';

  if (first && second) {
    return `同${first}${second}`;
  }

  return `同${index + 1}`;
}

export function buildMakerRows(rows: MasterRow[]): MakerRow[] {
  const orderCounts = new Map<string, number>();

  rows.forEach((row) => {
    const orderId = row.amazonOrderId.trim();

    if (!orderId) {
      return;
    }

    orderCounts.set(orderId, (orderCounts.get(orderId) ?? 0) + 1);
  });

  const bundledOrderIds = Array.from(orderCounts.entries())
    .filter(([, count]) => count > 1)
    .sort(([leftOrderId], [rightOrderId]) => compareLabels(leftOrderId, rightOrderId));
  const orderMarkers = new Map(
    bundledOrderIds.map(([orderId], index) => [orderId, buildSameOrderMarker(index)]),
  );
  const groups = new Map<string, MakerRow>();

  rows.forEach((row) => {
    const orderId = row.amazonOrderId.trim();
    const sameOrderCount = orderCounts.get(orderId) ?? 0;
    const orderMarker = orderMarkers.get(orderId) ?? '';
    const groupKey =
      row.size && row.color
        ? `${row.color}::${row.size}::${row.productType}::${row.note}::${
            orderId || row.sourceRowId
          }`
        : `review::${row.sourceRowId}`;
    const current = groups.get(groupKey);

    if (!current) {
      groups.set(groupKey, {
        id: groupKey || row.id,
        size: row.size,
        color: row.color,
        productType: row.productType,
        qty: row.qty,
        note: row.note,
        orderMarker,
        sameOrderCount,
        amazonOrderIds: row.amazonOrderId,
        orderStatuses: row.orderStatus,
        shipServiceLevels: row.shipServiceLevel,
        sourceRowIds: [row.sourceRowId],
      });
      return;
    }

    current.qty += row.qty;
    current.sourceRowIds.push(row.sourceRowId);
    current.amazonOrderIds = Array.from(
      new Set([...current.amazonOrderIds.split(', ').filter(Boolean), row.amazonOrderId]),
    ).join(', ');
    current.sameOrderCount = Math.max(current.sameOrderCount, sameOrderCount);
    current.orderStatuses = Array.from(
      new Set([...current.orderStatuses.split(', ').filter(Boolean), row.orderStatus]),
    ).join(', ');
    current.shipServiceLevels = Array.from(
      new Set([
        ...current.shipServiceLevels.split(', ').filter(Boolean),
        row.shipServiceLevel,
      ]),
    ).join(', ');
  });

  return sortMakerRows(Array.from(groups.values()));
}

export function buildDailyOrderRows(
  rows: OrderRow[],
  overrides: ProductionOverrideMap,
): DailyOrderRow[] {
  const groups = new Map<string, DailyOrderRow>();

  rows.forEach((row) => {
    const extracted = extractProductionDetails(row);
    const override = overrides[row.id] ?? {};
    const size = override.size ?? extracted.size;
    const color = override.color ?? extracted.color;
    const productType = override.productType ?? extracted.productType;
    const marks = buildDailyOrderMarks(row, productType);
    const rush = override.rush ?? isRushOrder(row.productName, row.shipServiceLevel);
    const item: DailyOrderItem = {
      size,
      qty: row.quantity,
    };
    const groupKey = [
      row.amazonOrderId.trim() || row.id,
      color.trim(),
      marks.trim(),
      rush ? 'rush' : 'normal',
    ].join('::');
    const current = groups.get(groupKey);

    if (!current) {
      groups.set(groupKey, {
        id: groupKey,
        amazonOrderId: row.amazonOrderId,
        purchaseDate: row.purchaseDateTime || row.purchaseDate,
        rawPurchaseDate: row.original['purchase-date'] || row.purchaseDate,
        color,
        marks,
        rush,
        items: [item],
        totalQty: row.quantity,
        sourceRowIds: [row.id],
      });
      return;
    }

    current.items.push(item);
    current.totalQty += row.quantity;
    current.sourceRowIds.push(row.id);
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      items: [...group.items].sort(compareDailyOrderItems),
    }))
    .sort((left, right) => {
      const byDate = compareLabels(left.purchaseDate, right.purchaseDate);

      if (byDate !== 0) {
        return byDate;
      }

      const byOrderId = compareLabels(left.amazonOrderId, right.amazonOrderId);

      if (byOrderId !== 0) {
        return byOrderId;
      }

      const byColor = compareLabels(left.color, right.color);

      if (byColor !== 0) {
        return byColor;
      }

      return compareLabels(left.marks, right.marks);
    });
}

export function buildDailyColorGroups(rows: DailyOrderRow[]): DailyColorGroup[] {
  const groups = new Map<string, DailyColorGroup>();

  rows.forEach((row) => {
    const color = row.color || '待确认颜色';
    const current = groups.get(color);

    if (!current) {
      groups.set(color, {
        color,
        normalRows: isDailyYangRow(row) ? [] : [row],
        yangRows: isDailyYangRow(row) ? [row] : [],
        totalQty: row.totalQty,
      });
      return;
    }

    if (isDailyYangRow(row)) {
      current.yangRows.push(row);
    } else {
      current.normalRows.push(row);
    }

    current.totalQty += row.totalQty;
  });

  return Array.from(groups.values())
    .sort((left, right) => compareLabels(left.color, right.color))
    .map((group) => ({
      ...group,
      normalRows: sortDailyRows(group.normalRows),
      yangRows: sortDailyRows(group.yangRows),
    }));
}

export function buildMakerColorGroups(rows: MakerRow[]): MakerColorGroup[] {
  const groups = new Map<string, MakerColorGroup>();

  rows.forEach((row) => {
    const color = row.color || '未识别颜色';
    const current = groups.get(color);

    if (!current) {
      groups.set(color, {
        color,
        rows: [row],
        totalQty: row.qty,
      });
      return;
    }

    current.rows.push(row);
    current.totalQty += row.qty;
  });

  return Array.from(groups.values())
    .sort((left, right) => compareMakerColors(left.color, right.color))
    .map((group) => ({
      ...group,
      rows: sortMakerRows(group.rows),
    }));
}

export function getFilterOptions(rows: OrderRow[]): FilterOptionSet {
  const unique = (values: string[]) =>
    Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(compareLabels);

  return {
    companyNames: unique(rows.map((row) => extractCompanyName(row.productName))),
    colors: unique(rows.map((row) => extractColor(row.productName, row.sku))),
    fulfillmentChannels: unique(rows.map((row) => row.fulfillmentChannel)),
    orderStatuses: unique(rows.map((row) => row.orderStatus)),
    shipServiceLevels: unique(rows.map((row) => row.shipServiceLevel)),
    itemStatuses: unique(rows.map((row) => row.itemStatus)),
  };
}

export function getDateRange(rows: OrderRow[]): { min: string; max: string } {
  const dates = rows.map((row) => row.purchaseDateTime).filter(Boolean).sort(compareLabels);

  return {
    min: dates[0] ?? '',
    max: dates[dates.length - 1] ?? '',
  };
}
