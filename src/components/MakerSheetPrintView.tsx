import type { CSSProperties } from 'react';

import {
  hasRushNote,
  isPrivacyFenceType,
  stripRushNote,
} from '../lib/orderProcessing';
import type { MakerColorGroup, MakerRow } from '../types';

type MakerSheetPrintViewProps = {
  groups: MakerColorGroup[];
  dateRangeLabel: string;
};

type MakerPrintSection = {
  title: string;
  rows: MakerRow[];
};

type MakerPrintColumn = {
  key: string;
  color: string;
  qty: number;
  sections: MakerPrintSection[];
  widthWeight: number;
};

type MakerPrintYangGroup = {
  key: string;
  color: string;
  qty: number;
  rows: MakerRow[];
};

type MakerPrintYangColumn = {
  key: string;
  groups: MakerPrintYangGroup[];
  widthWeight: number;
};

type MakerPrintPage = {
  key: string;
  regularColumns: MakerPrintColumn[];
  yangColumns: MakerPrintYangColumn[];
  gridTemplateColumns: string;
};

const YANG_COLUMN_WIDTH_WEIGHT = 0.66;
const TRAILING_YANG_COLORS = new Set(['绿色', '黑色']);
function buildRegularColorColumn(group: MakerColorGroup): MakerPrintColumn | null {
  const regularRows = group.rows.filter((row) => !isPrivacyFenceType(row.productType));

  if (regularRows.length === 0) {
    return null;
  }

  const sections: MakerPrintSection[] = [
    {
      title: '常规',
      rows: regularRows,
    },
  ];
  const totalQty = sections.reduce(
    (sum, section) => sum + section.rows.reduce((sectionSum, row) => sectionSum + row.qty, 0),
    0,
  );
  const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0);

  return {
    key: `${group.color}-1`,
    color: group.color,
    qty: totalQty,
    sections,
    widthWeight: totalQty <= 2 || rowCount <= 2 ? 0.72 : totalQty <= 4 ? 0.82 : 0.96,
  };
}

function buildYangColorGroup(group: MakerColorGroup): MakerPrintYangGroup | null {
  const privacyRows = group.rows.filter((row) => isPrivacyFenceType(row.productType));

  if (privacyRows.length === 0) {
    return null;
  }

  return {
    key: `${group.color}-yang`,
    color: group.color,
    qty: privacyRows.reduce((sum, row) => sum + row.qty, 0),
    rows: privacyRows,
  };
}

function packYangGroupsIntoColumns(groups: MakerColorGroup[]): MakerPrintYangColumn[] {
  const segments = groups
    .map((group) => buildYangColorGroup(group))
    .filter((group): group is MakerPrintYangGroup => Boolean(group));
  const trailingSegments = segments.filter((segment) => TRAILING_YANG_COLORS.has(segment.color));
  const standardSegments = segments.filter((segment) => !TRAILING_YANG_COLORS.has(segment.color));
  const columns: MakerPrintYangColumn[] = [];

  if (standardSegments.length > 0) {
    columns.push({
      key: 'yang-column-1',
      groups: standardSegments,
      widthWeight: YANG_COLUMN_WIDTH_WEIGHT,
    });
  }

  if (trailingSegments.length > 0) {
    columns.push({
      key: 'yang-column-trailing',
      groups: trailingSegments,
      widthWeight: YANG_COLUMN_WIDTH_WEIGHT,
    });
  }

  return columns;
}

function buildGridTemplate(
  regularColumns: MakerPrintColumn[],
  yangColumns: MakerPrintYangColumn[],
): string {
  if (regularColumns.length === 0 && yangColumns.length === 0) {
    return 'minmax(0, 1fr)';
  }

  const parts = [
    ...regularColumns.map((column) => `minmax(0, ${column.widthWeight}fr)`),
    ...yangColumns.map((column) => `minmax(0, ${column.widthWeight}fr)`),
  ];

  return parts.join(' ');
}

function buildPrintPages(groups: MakerColorGroup[]): MakerPrintPage[] {
  const regularColumns = groups
    .map((group) => buildRegularColorColumn(group))
    .filter((column): column is MakerPrintColumn => Boolean(column));
  const yangColumns = packYangGroupsIntoColumns(groups);

  return [
    {
      key: 'page-1',
      regularColumns,
      yangColumns,
      gridTemplateColumns: buildGridTemplate(regularColumns, yangColumns),
    },
  ];
}

function buildWorkerMark(row: MakerRow): string {
  const mark = stripRushNote(row.note);

  if (mark) {
    return mark;
  }

  if (isPrivacyFenceType(row.productType)) {
    return '';
  }

  if (row.productType === '弯边') {
    return '';
  }

  return row.productType || '待确认';
}

function isSingleDigitLeadingDimension(segment: string): boolean {
  return /^\d(?!\d)/.test(segment.trim());
}

function renderPrintCell(row: MakerRow) {
  const isRush = hasRushNote(row.note);
  const markLabel = buildWorkerMark(row);
  const shouldHideCurvedType = row.productType === '弯边' && !isPrivacyFenceType(row.productType);
  const extraType =
    row.productType &&
    !shouldHideCurvedType &&
    !isPrivacyFenceType(row.productType) &&
    row.productType !== '直边' &&
    row.productType !== markLabel
    ? row.productType
    : '';
  const tailLabel = [markLabel, extraType].filter(Boolean).join(' ');
  const sizeText = row.size || '待确认';
  const sizeSegments = sizeText.split(' X ');
  const sizeSegmentCount = sizeSegments.length;
  const isCompactLine = sizeSegmentCount >= 3;
  const hasTail = Boolean(row.qty > 1 || tailLabel || row.orderMarker);
  const isCrowdedLine =
    hasTail && (sizeText.length >= 13 || sizeSegmentCount >= 3 || Boolean(row.orderMarker));
  const isRoomyTriangle =
    isCompactLine &&
    !isCrowdedLine &&
    isSingleDigitLeadingDimension(sizeSegments[0] ?? '') &&
    isSingleDigitLeadingDimension(sizeSegments[1] ?? '');

  return (
    <div
      key={row.id}
      className={`maker-print-line ${isRush ? 'is-rush' : ''} ${
        isCompactLine ? 'is-compact' : ''
      } ${isRoomyTriangle ? 'is-roomy-triangle' : ''} ${
        isCrowdedLine ? 'is-crowded' : ''
      }`}
    >
      <strong className="maker-print-line-size">{sizeText}</strong>
      {hasTail ? (
        <span className="maker-print-line-tail">
          {row.qty > 1 ? <span className="maker-print-line-qty">={row.qty}</span> : null}
          {tailLabel ? <span className="maker-print-line-type">{tailLabel}</span> : null}
          {row.orderMarker ? (
            <span className="maker-print-line-order-marker">{row.orderMarker}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function renderPrintSection(title: string, rows: MakerRow[]) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="maker-print-subsection">
      {title !== '常规' ? <div className="maker-print-subtitle">{title}</div> : null}
      <div className="maker-print-item-list">{rows.map((row) => renderPrintCell(row))}</div>
    </section>
  );
}

function renderYangGroup(group: MakerPrintYangGroup) {
  return (
    <section key={group.key} className="maker-print-yang-group">
      <header className="maker-print-yang-header">
        <div>
          <h3>{group.color}（阳）</h3>
        </div>
      </header>
      <div className="maker-print-item-list">
        {group.rows.map((row) => renderPrintCell(row))}
      </div>
    </section>
  );
}

export function MakerSheetPrintView({
  groups,
  dateRangeLabel,
}: MakerSheetPrintViewProps) {
  const pages = buildPrintPages(groups);

  return (
    <div className="maker-print-root">
      <div className="maker-print-pages">
        {pages.map((page, index) => (
          <section key={page.key} className="maker-print-paper">
            {index === 0 && dateRangeLabel ? (
              <header className="maker-print-header">{dateRangeLabel}</header>
            ) : null}
            <div className="maker-print-fit">
              <section
                className="maker-print-page"
                style={
                  {
                    gridTemplateColumns: page.gridTemplateColumns,
                  } as CSSProperties
                }
              >
                {page.regularColumns.map((column) => (
                  <section key={column.key} className="maker-print-group">
                    <header className="maker-print-group-header">
                      <div>
                        <span className="maker-print-color-label">颜色</span>
                        <h2>{column.color}</h2>
                      </div>
                    </header>

                    {column.sections.map((section) => (
                      <div key={`${column.key}-${section.title}`}>
                        {renderPrintSection(section.title, section.rows)}
                      </div>
                    ))}
                  </section>
                ))}

                {page.yangColumns.map((column) => (
                  <section key={column.key} className="maker-print-yang-column">
                    {column.groups.map((group) => renderYangGroup(group))}
                  </section>
                ))}
              </section>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
