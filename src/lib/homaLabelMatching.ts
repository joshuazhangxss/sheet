import { getMatchableLabelPages } from './labelMatching';
import type {
  LabelMatch,
  LabelOrderReview,
  LabelPage,
  MasterRow,
  OrderRow,
} from '../types';

function normalizeHeader(value: string): string {
  return value.replace(/\uFEFF/g, '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function getOriginalValue(row: OrderRow, aliases: readonly string[]): string {
  const aliasSet = new Set(aliases.map(normalizeHeader));

  for (const [header, value] of Object.entries(row.original)) {
    if (aliasSet.has(normalizeHeader(header)) && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function hasOriginalHeader(row: OrderRow, aliases: readonly string[]): boolean {
  const aliasSet = new Set(aliases.map(normalizeHeader));

  return Object.keys(row.original).some((header) => aliasSet.has(normalizeHeader(header)));
}

function joinUnique(values: string[]): string {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).join('、');
}

function formatSizeBreakdown(
  sizeCounts: Map<string, number>,
): { size: string; sizeBreakdown: string[] } {
  const entries = Array.from(sizeCounts.entries()).filter(([size]) => size.trim());
  const sizeBreakdown = entries.map(([size, qty]) => (qty > 1 ? `${size} = ${qty}` : size));

  return {
    size: sizeBreakdown.join('、'),
    sizeBreakdown,
  };
}

function buildLabelSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function buildUnmatched(page: LabelPage, reasons: string[]): LabelMatch {
  return {
    id: page.id,
    pageId: page.id,
    sourceName: page.sourceName,
    pageNumber: page.pageNumber,
    status: 'unmatched',
    score: 0,
    reasons,
    amazonOrderId: '',
    sourceRowId: '',
    recipientName: '',
    postalCode: '',
    trackingNumber: '',
    size: '',
    sizeBreakdown: [],
    color: '',
    qty: 0,
    note: '',
    productType: '',
    labelSnippet: buildLabelSnippet(page.text),
  };
}

type HomaLabelGroup = {
  id: string;
  sourceRowIds: string[];
  amazonOrderId: string;
  recipientName: string;
  size: string;
  sizeBreakdown: string[];
  color: string;
  qty: number;
  note: string;
  productType: string;
};

function buildHomaLabelGroups(rows: OrderRow[], masterRows: MasterRow[]): HomaLabelGroup[] {
  const masterBySourceId = new Map(masterRows.map((row) => [row.sourceRowId, row]));
  const hasOrderNumberColumn = rows.some((row) => hasOriginalHeader(row, ['No.', 'No', '序号']));
  const groups: Array<{
    id: string;
    sourceRowIds: string[];
    amazonOrderIds: string[];
    recipientName: string;
    sizeCounts: Map<string, number>;
    colors: string[];
    qty: number;
    notes: string[];
    productTypes: string[];
  }> = [];
  let currentGroup: (typeof groups)[number] | undefined;

  rows.forEach((row, index) => {
    const orderNumber = getOriginalValue(row, ['No.', 'No', '序号']);
    const recipientName = getOriginalValue(row, ['Customer Name', 'Name', '客户', '姓名']);
    const masterRow = masterBySourceId.get(row.id);
    const size = masterRow?.size || '待确认尺寸';
    const qty = masterRow?.qty ?? row.quantity;
    const shouldStartGroup = !hasOrderNumberColumn || Boolean(orderNumber) || !currentGroup;

    if (shouldStartGroup) {
      currentGroup = {
        id: orderNumber || `${index + 1}`,
        sourceRowIds: [],
        amazonOrderIds: [],
        recipientName,
        sizeCounts: new Map(),
        colors: [],
        qty: 0,
        notes: [],
        productTypes: [],
      };
      groups.push(currentGroup);
    }

    const group = currentGroup;

    if (!group) {
      return;
    }

    group.sourceRowIds.push(row.id);
    group.amazonOrderIds.push(row.amazonOrderId);
    group.sizeCounts.set(size, (group.sizeCounts.get(size) ?? 0) + qty);
    group.colors.push(masterRow?.color ?? '');
    group.qty += qty;
    group.notes.push(masterRow?.note ?? '');
    group.productTypes.push(masterRow?.productType ?? '');

    if (!group.recipientName && recipientName) {
      group.recipientName = recipientName;
    }
  });

  return groups.map((group) => {
    const { size, sizeBreakdown } = formatSizeBreakdown(group.sizeCounts);

    return {
      id: group.id,
      sourceRowIds: group.sourceRowIds,
      amazonOrderId: joinUnique(group.amazonOrderIds),
      recipientName: group.recipientName,
      size,
      sizeBreakdown,
      color: joinUnique(group.colors),
      qty: group.qty,
      note: joinUnique(group.notes),
      productType: joinUnique(group.productTypes),
    };
  });
}

export function getHomaLabelGroupCount(rows: OrderRow[]): number {
  const hasOrderNumberColumn = rows.some((row) => hasOriginalHeader(row, ['No.', 'No', '序号']));
  let count = 0;
  let hasCurrentGroup = false;

  rows.forEach((row) => {
    const orderNumber = getOriginalValue(row, ['No.', 'No', '序号']);

    if (!hasOrderNumberColumn || orderNumber || !hasCurrentGroup) {
      count += 1;
      hasCurrentGroup = true;
    }
  });

  return count;
}

export function buildHomaSequenceLabelMatches(
  pages: LabelPage[],
  rows: OrderRow[],
  masterRows: MasterRow[],
): LabelMatch[] {
  const labelGroups = buildHomaLabelGroups(rows, masterRows);

  return getMatchableLabelPages(pages)
    .map((page, index) => {
      const group = labelGroups[index];

      if (!group) {
        return buildUnmatched(page, ['Excel数据缺失']);
      }

      return {
        id: `${page.id}::${group.sourceRowIds.join('::')}`,
        pageId: page.id,
        sourceName: page.sourceName,
        pageNumber: page.pageNumber,
        status: 'matched',
        score: 200,
        reasons: ['Excel顺序'],
        amazonOrderId: group.amazonOrderId,
        sourceRowId: group.sourceRowIds.join('::'),
        recipientName: group.recipientName,
        postalCode: '',
        trackingNumber: '',
        size: group.size,
        sizeBreakdown: group.sizeBreakdown,
        color: group.color,
        qty: group.qty,
        note: group.note,
        productType: group.productType,
        labelSnippet: buildLabelSnippet(page.text),
      };
    });
}

export function buildHomaSequenceOrderReviews(matches: LabelMatch[]): LabelOrderReview[] {
  const hasMultipleLabelSources = new Set(matches.map((match) => match.sourceName)).size > 1;

  return matches
    .filter((match) => match.status !== 'unmatched' && match.sourceRowId)
    .map((match) => ({
      id: match.sourceRowId,
      amazonOrderId: match.amazonOrderId,
      recipientName: match.recipientName,
      postalCode: match.postalCode,
      cityState: '',
      trackingNumber: match.trackingNumber,
      size: match.size,
      sizeBreakdown: match.sizeBreakdown,
      color: match.color,
      qty: match.qty,
      note: match.note,
      productType: match.productType,
      status: match.status,
      matchedPages: hasMultipleLabelSources
        ? `${match.sourceName} 第 ${match.pageNumber} 页`
        : `第 ${match.pageNumber} 页`,
      reasons: match.reasons,
    }));
}
