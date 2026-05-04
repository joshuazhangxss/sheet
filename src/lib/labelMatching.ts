import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import type {
  LabelMatch,
  LabelMatchStatus,
  LabelOrderReview,
  LabelPage,
  MasterRow,
  OrderRow,
} from '../types';

type ShippingSnapshot = {
  recipientName: string;
  postalCode: string;
  addressLine: string;
  cityState: string;
  trackingNumber: string;
};

type LabelOrderCandidate = ShippingSnapshot & {
  sourceRowId: string;
  amazonOrderId: string;
  amazonOrderCompact: string;
  trackingCompact: string;
  recipientTokens: string[];
  addressTokens: string[];
  cityStateTokens: string[];
  size: string;
  sizeBreakdown: string[];
  color: string;
  qty: number;
  note: string;
  productType: string;
};

type CandidateScore = {
  score: number;
  reasons: string[];
};

const ORDER_LIST_PAGE_PATTERN = /list of orders with successful label purchase/i;
const AMAZON_ORDER_ID_PATTERN = /\b\d{3}-\d{7}-\d{7}\b/g;

const SHIPPING_FIELD_ALIASES = {
  recipientName: ['recipientname', 'buyername', 'shiptoname', 'shipname'],
  postalCode: ['shippostalcode', 'postalcode', 'zipcode', 'zip', 'shipzip'],
  address1: ['shipaddress1', 'addressline1', 'address1', 'shipstreet1'],
  address2: ['shipaddress2', 'addressline2', 'address2', 'shipstreet2'],
  city: ['shipcity', 'city', 'town'],
  state: ['shipstate', 'state', 'province', 'region'],
  trackingNumber: ['trackingnumber', 'trackingid', 'carriertrackingnumber', 'trackingcode'],
} as const;

function normalizeHeader(value: string): string {
  return value.replace(/\uFEFF/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeMatchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function compactMatchText(value: string): string {
  return normalizeMatchText(value).replace(/\s+/g, '');
}

function tokenizeMatchText(value: string): string[] {
  return normalizeMatchText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function getOriginalValue(row: OrderRow, aliases: readonly string[]): string {
  const normalizedAliases = new Set(aliases);

  for (const [header, value] of Object.entries(row.original)) {
    if (normalizedAliases.has(normalizeHeader(header)) && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function extractShippingSnapshot(row: OrderRow): ShippingSnapshot {
  const recipientName = getOriginalValue(row, SHIPPING_FIELD_ALIASES.recipientName);
  const postalCode = getOriginalValue(row, SHIPPING_FIELD_ALIASES.postalCode);
  const address1 = getOriginalValue(row, SHIPPING_FIELD_ALIASES.address1);
  const address2 = getOriginalValue(row, SHIPPING_FIELD_ALIASES.address2);
  const city = getOriginalValue(row, SHIPPING_FIELD_ALIASES.city);
  const state = getOriginalValue(row, SHIPPING_FIELD_ALIASES.state);

  return {
    recipientName,
    postalCode,
    addressLine: [address1, address2].filter(Boolean).join(' '),
    cityState: [city, state].filter(Boolean).join(' '),
    trackingNumber: getOriginalValue(row, SHIPPING_FIELD_ALIASES.trackingNumber),
  };
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

function extractAmazonOrderIds(text: string): string[] {
  return Array.from(new Set(text.match(AMAZON_ORDER_ID_PATTERN) ?? []));
}

function isOrderListHeaderPage(page: LabelPage): boolean {
  return ORDER_LIST_PAGE_PATTERN.test(page.text);
}

function isOrderListContinuationPage(page: LabelPage): boolean {
  const orderIds = extractAmazonOrderIds(page.text);

  if (orderIds.length === 0) {
    return false;
  }

  const leftoverText = page.text
    .replace(AMAZON_ORDER_ID_PATTERN, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();

  return leftoverText.length === 0 || leftoverText.length <= 24;
}

function collectOrderListPages(pages: LabelPage[]): LabelPage[] {
  const orderedPages = pages
    .slice()
    .sort((left, right) => left.pageNumber - right.pageNumber);
  const orderListPages: LabelPage[] = [];
  let previousWasOrderList = false;

  orderedPages.forEach((page) => {
    if (isOrderListHeaderPage(page)) {
      orderListPages.push(page);
      previousWasOrderList = true;
      return;
    }

    if (previousWasOrderList && isOrderListContinuationPage(page)) {
      orderListPages.push(page);
      previousWasOrderList = true;
      return;
    }

    previousWasOrderList = false;
  });

  return orderListPages;
}

export function getMatchableLabelPages(pages: LabelPage[]): LabelPage[] {
  const orderListPageIds = new Set(
    Array.from(groupPagesBySource(pages).values()).flatMap((sourcePages) =>
      collectOrderListPages(sourcePages).map((page) => page.id),
    ),
  );

  return pages.filter((page) => !orderListPageIds.has(page.id));
}

function groupPagesBySource(pages: LabelPage[]): Map<string, LabelPage[]> {
  const groups = new Map<string, LabelPage[]>();

  pages.forEach((page) => {
    const current = groups.get(page.sourceName) ?? [];
    current.push(page);
    groups.set(page.sourceName, current);
  });

  return groups;
}

function collectOrderListPageOrderIds(pages: LabelPage[]): string[] {
  const orderedIds: string[] = [];
  const seen = new Set<string>();

  pages
    .slice()
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .forEach((page) => {
      extractAmazonOrderIds(page.text).forEach((orderId) => {
        if (seen.has(orderId)) {
          return;
        }

        seen.add(orderId);
        orderedIds.push(orderId);
      });
    });

  return orderedIds;
}

function buildCandidates(filteredRows: OrderRow[], masterRows: MasterRow[]): LabelOrderCandidate[] {
  const masterBySourceId = new Map(masterRows.map((row) => [row.sourceRowId, row]));
  const grouped = new Map<
    string,
    {
      shipping: ShippingSnapshot;
      amazonOrderId: string;
      sourceRowIds: string[];
      sizeCounts: Map<string, number>;
      colors: string[];
      notes: string[];
      productTypes: string[];
      qty: number;
    }
  >();

  filteredRows.forEach((row) => {
    const masterRow = masterBySourceId.get(row.id);

    if (!masterRow) {
      return;
    }

    const candidateKey = row.amazonOrderId.trim() || row.id;
    const current = grouped.get(candidateKey);

    if (!current) {
      grouped.set(candidateKey, {
        shipping: extractShippingSnapshot(row),
        amazonOrderId: row.amazonOrderId,
        sourceRowIds: [row.id],
        sizeCounts: new Map([[masterRow.size || '待确认尺寸', masterRow.qty]]),
        colors: [masterRow.color],
        notes: [masterRow.note],
        productTypes: [masterRow.productType],
        qty: masterRow.qty,
      });
      return;
    }

    current.sourceRowIds.push(row.id);
    const sizeKey = masterRow.size || '待确认尺寸';
    current.sizeCounts.set(sizeKey, (current.sizeCounts.get(sizeKey) ?? 0) + masterRow.qty);
    current.colors.push(masterRow.color);
    current.notes.push(masterRow.note);
    current.productTypes.push(masterRow.productType);
    current.qty += masterRow.qty;
  });

  return Array.from(grouped.values()).map((group) => {
    const { size, sizeBreakdown } = formatSizeBreakdown(group.sizeCounts);

    return {
    ...group.shipping,
    sourceRowId: group.amazonOrderId.trim()
      ? `order::${group.amazonOrderId}`
      : group.sourceRowIds.join('::'),
    amazonOrderId: group.amazonOrderId,
    amazonOrderCompact: compactMatchText(group.amazonOrderId),
    trackingCompact: compactMatchText(group.shipping.trackingNumber),
    recipientTokens: tokenizeMatchText(group.shipping.recipientName).slice(0, 3),
    addressTokens: tokenizeMatchText(group.shipping.addressLine)
      .filter((token) => !/^\d{1,2}$/.test(token))
      .slice(0, 3),
    cityStateTokens: tokenizeMatchText(group.shipping.cityState).slice(0, 2),
    size,
    sizeBreakdown,
    color: joinUnique(group.colors),
    qty: group.qty,
    note: joinUnique(group.notes),
    productType: joinUnique(group.productTypes),
    };
  });
}

export function buildLabelOrderReviews(
  filteredRows: OrderRow[],
  masterRows: MasterRow[],
  matches: LabelMatch[],
): LabelOrderReview[] {
  const candidates = buildCandidates(filteredRows, masterRows);
  const matchesByOrderId = new Map<string, LabelMatch[]>();
  const hasMultipleLabelSources = new Set(matches.map((match) => match.sourceName)).size > 1;

  matches.forEach((match) => {
    const orderId = match.amazonOrderId.trim();

    if (!orderId) {
      return;
    }

    const current = matchesByOrderId.get(orderId) ?? [];
    current.push(match);
    matchesByOrderId.set(orderId, current);
  });

  return candidates
    .map((candidate) => {
      const matchedPages = (matchesByOrderId.get(candidate.amazonOrderId.trim()) ?? []).sort(
        (left, right) =>
          left.sourceName === right.sourceName
            ? left.pageNumber - right.pageNumber
            : left.sourceName.localeCompare(right.sourceName, undefined, {
                sensitivity: 'base',
                numeric: true,
              }),
      );
      const status: LabelMatchStatus = matchedPages.some((match) => match.status === 'matched')
        ? 'matched'
        : matchedPages.some((match) => match.status === 'possible')
          ? 'possible'
          : 'unmatched';
      const reasons = Array.from(
        new Set(matchedPages.flatMap((match) => match.reasons).filter(Boolean)),
      );

      return {
        id: candidate.amazonOrderId || candidate.sourceRowId,
        amazonOrderId: candidate.amazonOrderId,
        recipientName: candidate.recipientName,
        postalCode: candidate.postalCode,
        cityState: candidate.cityState,
        trackingNumber: candidate.trackingNumber,
        size: candidate.size,
        sizeBreakdown: candidate.sizeBreakdown,
        color: candidate.color,
        qty: candidate.qty,
        note: candidate.note,
        productType: candidate.productType,
        status,
        matchedPages:
          matchedPages.length > 0
            ? matchedPages
                .map((match) =>
                  hasMultipleLabelSources
                    ? `${match.sourceName} 第 ${match.pageNumber} 页`
                    : `第 ${match.pageNumber} 页`,
                )
                .join('、')
            : '—',
        reasons,
      };
    })
    .sort((left, right) => left.amazonOrderId.localeCompare(right.amazonOrderId));
}

function buildReasonsLabel(reasons: string[]): string[] {
  return Array.from(new Set(reasons));
}

function scoreCandidate(page: LabelPage, candidate: LabelOrderCandidate): CandidateScore {
  const pageCompact = compactMatchText(page.text);
  const pageTokens = new Set(tokenizeMatchText(page.text));
  const reasons: string[] = [];
  let score = 0;

  if (candidate.amazonOrderCompact && pageCompact.includes(candidate.amazonOrderCompact)) {
    score += 160;
    reasons.push('订单号');
  }

  if (
    candidate.trackingCompact &&
    candidate.trackingCompact.length >= 8 &&
    pageCompact.includes(candidate.trackingCompact)
  ) {
    score += 120;
    reasons.push('追踪号');
  }

  const postalCompact = compactMatchText(candidate.postalCode);
  if (postalCompact && postalCompact.length >= 5 && pageCompact.includes(postalCompact)) {
    score += 18;
    reasons.push('邮编');
  }

  const recipientHits = candidate.recipientTokens.filter((token) => pageTokens.has(token)).length;
  if (recipientHits >= 2) {
    score += 28;
    reasons.push('收件人');
  } else if (recipientHits === 1) {
    score += 12;
    reasons.push('收件人');
  }

  const addressHits = candidate.addressTokens.filter((token) => pageTokens.has(token)).length;
  if (addressHits >= 2) {
    score += 18;
    reasons.push('地址');
  } else if (addressHits === 1) {
    score += 8;
    reasons.push('地址');
  }

  const cityStateHits = candidate.cityStateTokens.filter((token) => pageTokens.has(token)).length;
  if (cityStateHits >= 2) {
    score += 12;
    reasons.push('城市州');
  } else if (cityStateHits === 1) {
    score += 5;
    reasons.push('城市州');
  }

  return {
    score,
    reasons: buildReasonsLabel(reasons),
  };
}

function buildLabelSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function buildUnmatched(page: LabelPage): LabelMatch {
  return {
    id: page.id,
    pageId: page.id,
    sourceName: page.sourceName,
    pageNumber: page.pageNumber,
    status: 'unmatched',
    score: 0,
    reasons: [],
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

function buildReasonedUnmatched(page: LabelPage, reasons: string[]): LabelMatch {
  return {
    ...buildUnmatched(page),
    reasons,
  };
}

function buildOrderAwareUnmatched(
  page: LabelPage,
  amazonOrderId: string,
  reasons: string[],
): LabelMatch {
  return {
    ...buildUnmatched(page),
    amazonOrderId,
    reasons,
  };
}

function buildMatchStatus(
  bestScore: number,
  nextScore: number,
  reasons: string[],
): LabelMatchStatus {
  if (bestScore === 0) {
    return 'unmatched';
  }

  if (reasons.includes('订单号') || reasons.includes('追踪号')) {
    return 'matched';
  }

  if (bestScore >= 42 && bestScore - nextScore >= 10) {
    return 'matched';
  }

  if (bestScore >= 22) {
    return 'possible';
  }

  return 'unmatched';
}

export function matchLabelPages(
  pages: LabelPage[],
  filteredRows: OrderRow[],
  masterRows: MasterRow[],
): LabelMatch[] {
  const candidates = buildCandidates(filteredRows, masterRows);
  const labelPages = getMatchableLabelPages(pages);
  const candidatesByOrderId = new Map(
    candidates
      .filter((candidate) => candidate.amazonOrderId.trim())
      .map((candidate) => [candidate.amazonOrderId.trim(), candidate]),
  );
  const fallbackAssignments = new Map<string, LabelOrderCandidate | undefined>();
  const fallbackOrderIdsByPageId = new Map<string, string>();

  groupPagesBySource(pages).forEach((sourcePages) => {
    const sourceOrderListPages = collectOrderListPages(sourcePages);
    const sourceOrderListPageIds = new Set(sourceOrderListPages.map((page) => page.id));
    const sourceLabelPages = sourcePages.filter((page) => !sourceOrderListPageIds.has(page.id));
    const fallbackOrderIds = collectOrderListPageOrderIds(sourceOrderListPages);
    const canUseSequenceFallback =
      fallbackOrderIds.length > 0 && fallbackOrderIds.length === sourceLabelPages.length;

    if (!canUseSequenceFallback) {
      return;
    }

    sourceLabelPages
      .slice()
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .forEach((page, index) => {
        const fallbackOrderId = fallbackOrderIds[index] ?? '';
        fallbackOrderIdsByPageId.set(page.id, fallbackOrderId);
        fallbackAssignments.set(page.id, candidatesByOrderId.get(fallbackOrderId));
      });
  });

  const initialMatches: LabelMatch[] = labelPages.map((page): LabelMatch => {
    if (candidates.length === 0) {
      return buildUnmatched(page);
    }

    const fallbackCandidate = fallbackAssignments.get(page.id);
    const fallbackOrderId = fallbackOrderIdsByPageId.get(page.id) ?? '';

    if (fallbackCandidate && !page.text.trim()) {
      return {
        id: page.id,
        pageId: page.id,
        sourceName: page.sourceName,
        pageNumber: page.pageNumber,
        status: 'matched',
        score: 200,
        reasons: ['汇总页顺序'],
        amazonOrderId: fallbackCandidate.amazonOrderId,
        sourceRowId: fallbackCandidate.sourceRowId,
        recipientName: fallbackCandidate.recipientName,
        postalCode: fallbackCandidate.postalCode,
        trackingNumber: fallbackCandidate.trackingNumber,
        size: fallbackCandidate.size,
        sizeBreakdown: fallbackCandidate.sizeBreakdown,
        color: fallbackCandidate.color,
        qty: fallbackCandidate.qty,
        note: fallbackCandidate.note,
        productType: fallbackCandidate.productType,
        labelSnippet: '',
      };
    }

    if (fallbackOrderId && !page.text.trim()) {
      return buildOrderAwareUnmatched(page, fallbackOrderId, ['汇总页顺序', '订单数据缺失']);
    }

    if (!page.text.trim()) {
      return buildReasonedUnmatched(page, ['无文字层']);
    }

    const ranked = candidates
      .map((candidate) => ({
        candidate,
        ...scoreCandidate(page, candidate),
      }))
      .sort((left, right) => right.score - left.score);

    const best = ranked[0];
    const next = ranked[1];

    if (!best || best.score === 0) {
      return buildReasonedUnmatched(page, ['无法提取匹配字段']);
    }

    const status = buildMatchStatus(best.score, next?.score ?? 0, best.reasons);

    return {
      id: page.id,
      pageId: page.id,
      sourceName: page.sourceName,
      pageNumber: page.pageNumber,
      status,
      score: best.score,
      reasons: best.reasons,
      amazonOrderId: best.candidate.amazonOrderId,
      sourceRowId: best.candidate.sourceRowId,
      recipientName: best.candidate.recipientName,
      postalCode: best.candidate.postalCode,
      trackingNumber: best.candidate.trackingNumber,
      size: best.candidate.size,
      sizeBreakdown: best.candidate.sizeBreakdown,
      color: best.candidate.color,
      qty: best.candidate.qty,
      note: best.candidate.note,
      productType: best.candidate.productType,
      labelSnippet: buildLabelSnippet(page.text),
    };
  });

  const matchGroups = new Map<string, LabelMatch[]>();

  initialMatches.forEach((match) => {
    if (!match.sourceRowId || match.status !== 'matched') {
      return;
    }

    const current = matchGroups.get(match.sourceRowId) ?? [];
    current.push(match);
    matchGroups.set(match.sourceRowId, current);
  });

  matchGroups.forEach((matches) => {
    if (matches.length <= 1) {
      return;
    }

    matches
      .sort((left, right) => right.score - left.score)
      .slice(1)
      .forEach((match) => {
        match.status = 'possible';
        match.reasons = buildReasonsLabel([...match.reasons, '重复订单']);
      });
  });

  return initialMatches;
}

function wrapText(text: string, maxChars: number): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();

  if (!cleaned) {
    return [];
  }

  const words = cleaned.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  words.forEach((word) => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (candidate.length <= maxChars) {
      currentLine = candidate;
      return;
    }

    if (currentLine) {
      lines.push(currentLine);
      currentLine = word;
      return;
    }

    lines.push(word);
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

async function loadLabelFontBytes(): Promise<Uint8Array> {
  const response = await fetch('/fonts/arial-unicode.ttf');

  if (!response.ok) {
    throw new Error(`字体文件加载失败：${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function drawWrappedText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size: number,
  maxChars: number,
  color = rgb(0.1, 0.14, 0.2),
): number {
  const lines = wrapText(text, maxChars);
  let cursor = y;

  lines.forEach((line) => {
    page.drawText(line, {
      x,
      y: cursor,
      size,
      font,
      color,
    });
    cursor -= size * 1.15;
  });

  return cursor;
}

function drawMatchedBackPage(page: PDFPage, match: LabelMatch, bold: PDFFont, regular: PDFFont) {
  const { width, height } = page.getSize();
  const margin = Math.max(18, Math.min(width, height) * 0.07);
  const titleSize = Math.min(18, width * 0.07);
  const heroSize = Math.min(24, width * 0.1);
  const bodySize = Math.min(11, width * 0.035);
  const smallSize = Math.min(9, width * 0.028);
  let cursor = height - margin - titleSize;

  page.drawText(match.color || '未识别颜色', {
    x: margin,
    y: cursor,
    size: titleSize,
    font: bold,
    color: rgb(0.08, 0.12, 0.18),
  });

  const qtyText = `x${match.qty || 0}`;
  page.drawText(qtyText, {
    x: width - margin - bold.widthOfTextAtSize(qtyText, titleSize),
    y: cursor,
    size: titleSize,
    font: bold,
    color: rgb(0.08, 0.12, 0.18),
  });

  cursor -= heroSize * 1.05;

  page.drawText(match.size || '待确认尺寸', {
    x: margin,
    y: cursor,
    size: heroSize,
    font: bold,
    color: rgb(0.08, 0.12, 0.18),
  });

  const rushText = match.note.includes('★') ? '★ 加急' : '';
  if (rushText) {
    page.drawText(rushText, {
      x: width - margin - bold.widthOfTextAtSize(rushText, bodySize),
      y: cursor + bodySize * 0.5,
      size: bodySize,
      font: bold,
      color: rgb(0.72, 0.36, 0.03),
    });
  }

  cursor -= bodySize * 1.8;

  const noteWithoutRush = match.note.replace(/★/g, '').trim();
  const metaParts = [match.productType, noteWithoutRush].filter(Boolean).join('   ');
  if (metaParts) {
    page.drawText(metaParts, {
      x: margin,
      y: cursor,
      size: bodySize,
      font: regular,
      color: rgb(0.2, 0.24, 0.3),
    });
    cursor -= bodySize * 1.8;
  }

  cursor = drawWrappedText(
    page,
    regular,
    `订单号 ${match.amazonOrderId || '未匹配'}`,
    margin,
    cursor,
    bodySize,
    Math.max(18, Math.floor((width - margin * 2) / (bodySize * 0.56))),
  );

  const recipientText = [match.recipientName, match.postalCode].filter(Boolean).join('   ');
  if (recipientText) {
    drawWrappedText(
      page,
      regular,
      recipientText,
      margin,
      cursor - bodySize * 0.4,
      bodySize,
      Math.max(18, Math.floor((width - margin * 2) / (bodySize * 0.56))),
    );
  }

  page.drawText('背面对照信息', {
    x: margin,
    y: margin,
    size: smallSize,
    font: regular,
    color: rgb(0.46, 0.49, 0.56),
  });
}

function drawUnmatchedBackPage(
  page: PDFPage,
  labelPage: LabelPage,
  match: LabelMatch | undefined,
  bold: PDFFont,
  regular: PDFFont,
) {
  const { width, height } = page.getSize();
  const margin = Math.max(18, Math.min(width, height) * 0.07);
  const titleSize = Math.min(18, width * 0.065);
  const bodySize = Math.min(11, width * 0.034);
  let cursor = height - margin - titleSize;

  page.drawText('未匹配到订单', {
    x: margin,
    y: cursor,
    size: titleSize,
    font: bold,
    color: rgb(0.58, 0.18, 0.16),
  });

  cursor -= bodySize * 2;
  page.drawText(`${labelPage.sourceName} · 第 ${labelPage.pageNumber} 页`, {
    x: margin,
    y: cursor,
    size: bodySize,
    font: regular,
    color: rgb(0.2, 0.24, 0.3),
  });

  cursor -= bodySize * 1.8;
  drawWrappedText(
    page,
    regular,
    match?.labelSnippet || labelPage.text || '没有提取到文本。',
    margin,
    cursor,
    bodySize,
    Math.max(18, Math.floor((width - margin * 2) / (bodySize * 0.56))),
  );
}

export async function buildLabelBackPdf(
  pages: LabelPage[],
  matches: LabelMatch[],
  embeddedFontBytes?: Uint8Array,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const fontBytes = embeddedFontBytes ?? (await loadLabelFontBytes());
  pdfDoc.registerFontkit(fontkit);
  const regular = await pdfDoc.embedFont(fontBytes, { subset: true });
  const bold = regular;
  const matchByPageId = new Map(matches.map((match) => [match.pageId, match]));

  pages.forEach((labelPage) => {
    const page = pdfDoc.addPage([labelPage.width || 288, labelPage.height || 432]);
    const match = matchByPageId.get(labelPage.id);

    if (match?.status !== 'unmatched' && match?.sourceRowId) {
      drawMatchedBackPage(page, match, bold, regular);
      return;
    }

    drawUnmatchedBackPage(page, labelPage, match, bold, regular);
  });

  return pdfDoc.save();
}
