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
  partIndex: number;
  partCount: number;
  widthWeight: number;
};

type MakerPrintYangGroup = {
  key: string;
  color: string;
  qty: number;
  rows: MakerRow[];
  partIndex: number;
  partCount: number;
  units: number;
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

const MAX_PRINT_COLUMN_UNITS = 14.25;
const SECTION_HEADER_UNITS = 0.3;
const YANG_GROUP_HEADER_UNITS = 0.72;
const YANG_GROUP_GAP_UNITS = 0.32;

function estimateRowUnits(row: MakerRow): number {
  const contentLength = `${row.size} ${row.productType} ${stripRushNote(row.note)}`.trim().length;
  const rushUnits = hasRushNote(row.note) ? 0.05 : 0;
  const overflowUnits = Math.min(0.55, Math.max(0, (contentLength - 18) / 26) * 0.18);

  return 0.82 + rushUnits + overflowUnits;
}

function finalizeColumn(
  color: string,
  partIndex: number,
  sections: MakerPrintSection[],
): MakerPrintColumn {
  const totalQty = sections.reduce(
    (sum, section) => sum + section.rows.reduce((sectionSum, row) => sectionSum + row.qty, 0),
    0,
  );
  const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0);

  return {
    key: `${color}-${partIndex}`,
    color,
    qty: totalQty,
    sections,
    partIndex,
    partCount: 0,
    widthWeight: totalQty <= 2 || rowCount <= 2 ? 0.72 : totalQty <= 4 ? 0.82 : 0.96,
  };
}

function splitRegularColorIntoColumns(group: MakerColorGroup): MakerPrintColumn[] {
  const regularRows = group.rows.filter((row) => !isPrivacyFenceType(row.productType));

  if (regularRows.length === 0) {
    return [];
  }

  const columns: MakerPrintColumn[] = [];
  let currentSections: MakerPrintSection[] = [];
  let currentUnits = 0;
  let partIndex = 1;
  const rowBlocks = regularRows.reduce<MakerRow[][]>((blocks, row) => {
    const previousBlock = blocks.at(-1);

    if (
      row.orderMarker &&
      previousBlock &&
      previousBlock[0]?.orderMarker === row.orderMarker
    ) {
      previousBlock.push(row);
      return blocks;
    }

    blocks.push([row]);
    return blocks;
  }, []);

  const pushCurrentColumn = () => {
    if (currentSections.length === 0) {
      return;
    }

    columns.push(finalizeColumn(group.color, partIndex, currentSections));
    currentSections = [];
    currentUnits = 0;
    partIndex += 1;
  };

  rowBlocks.forEach((block) => {
    const activeSection = currentSections.at(-1);
    const isNewSection = activeSection?.title !== '常规';
    const sectionUnits = isNewSection ? SECTION_HEADER_UNITS : 0;
    const blockUnits = block.reduce((sum, row) => sum + estimateRowUnits(row), 0);

    if (
      currentSections.length > 0 &&
      currentUnits + sectionUnits + blockUnits > MAX_PRINT_COLUMN_UNITS
    ) {
      pushCurrentColumn();
    }

    const nextSection = currentSections.at(-1);

    if (nextSection?.title !== '常规') {
      currentSections.push({
        title: '常规',
        rows: [...block],
      });
      currentUnits += SECTION_HEADER_UNITS + blockUnits;
      return;
    }

    nextSection.rows.push(...block);
    currentUnits += blockUnits;
  });

  pushCurrentColumn();

  return columns.map((column) => ({
    ...column,
    partCount: columns.length,
  }));
}

function estimateYangGroupUnits(rows: MakerRow[]): number {
  return (
    rows.reduce((sum, row) => sum + estimateRowUnits(row) + 0.08, 0) + YANG_GROUP_HEADER_UNITS
  );
}

function splitYangColorIntoGroups(group: MakerColorGroup): MakerPrintYangGroup[] {
  const privacyRows = group.rows.filter((row) => isPrivacyFenceType(row.productType));

  if (privacyRows.length === 0) {
    return [];
  }

  const groupsByPart: MakerPrintYangGroup[] = [];
  let currentRows: MakerRow[] = [];
  let currentUnits = 0;
  let partIndex = 1;

  const pushCurrentGroup = () => {
    if (currentRows.length === 0) {
      return;
    }

    groupsByPart.push({
      key: `${group.color}-yang-${partIndex}`,
      color: group.color,
      qty: currentRows.reduce((sum, row) => sum + row.qty, 0),
      rows: currentRows,
      partIndex,
      partCount: 0,
      units: estimateYangGroupUnits(currentRows),
    });
    currentRows = [];
    currentUnits = 0;
    partIndex += 1;
  };

  privacyRows.forEach((row) => {
    const rowUnits = estimateRowUnits(row) + 0.08;
    const nextUnits = currentRows.length === 0 ? YANG_GROUP_HEADER_UNITS + rowUnits : currentUnits + rowUnits;

    if (currentRows.length > 0 && nextUnits > MAX_PRINT_COLUMN_UNITS) {
      pushCurrentGroup();
    }

    currentRows.push(row);
    currentUnits =
      currentRows.length === 1 ? YANG_GROUP_HEADER_UNITS + rowUnits : currentUnits + rowUnits;
  });

  pushCurrentGroup();

  return groupsByPart.map((yangGroup) => ({
    ...yangGroup,
    partCount: groupsByPart.length,
  }));
}

function packYangGroupsIntoColumns(groups: MakerColorGroup[]): MakerPrintYangColumn[] {
  const segments = groups.flatMap((group) => splitYangColorIntoGroups(group));
  const packedColumns: Array<MakerPrintYangColumn & { usedUnits: number }> = [];

  segments.forEach((segment) => {
    const targetColumn = packedColumns.find(
      (column) => column.usedUnits + YANG_GROUP_GAP_UNITS + segment.units <= MAX_PRINT_COLUMN_UNITS,
    );

    if (!targetColumn) {
      packedColumns.push({
        key: `yang-column-${packedColumns.length + 1}`,
        groups: [segment],
        widthWeight: 0.96,
        usedUnits: segment.units,
      });
      return;
    }

    targetColumn.groups.push(segment);
    targetColumn.usedUnits += YANG_GROUP_GAP_UNITS + segment.units;
  });

  return packedColumns.map((column) => ({
    key: column.key,
    groups: column.groups,
    widthWeight: 0.96,
  }));
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
  const regularColumns = groups.flatMap((group) => splitRegularColorIntoColumns(group));
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

  return row.productType || '待确认';
}

function renderPrintCell(row: MakerRow) {
  const isRush = hasRushNote(row.note);
  const markLabel = buildWorkerMark(row);
  const extraType =
    row.productType &&
    !isPrivacyFenceType(row.productType) &&
    row.productType !== '直边' &&
    row.productType !== markLabel
    ? row.productType
    : '';
  const tailLabel = [markLabel, extraType].filter(Boolean).join(' ');

  return (
    <div key={row.id} className={`maker-print-line ${isRush ? 'is-rush' : ''}`}>
      <strong className="maker-print-line-size">{row.size || '待确认'}</strong>
      {row.qty > 1 ? <span className="maker-print-line-qty">={row.qty}</span> : null}
      {tailLabel ? <span className="maker-print-line-type">{tailLabel}</span> : null}
      {row.orderMarker ? (
        <span className="maker-print-line-order-marker">{row.orderMarker}</span>
      ) : null}
      {isRush ? <span className="maker-print-line-star">★</span> : null}
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
        <div className="maker-print-group-meta">
          {group.partCount > 1 ? (
            <span className="maker-print-continuation">
              {group.partIndex}/{group.partCount}
            </span>
          ) : null}
          <strong>{group.qty}</strong>
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
      {dateRangeLabel ? <header className="maker-print-header">{dateRangeLabel}</header> : null}

      <div className="maker-print-pages">
        {pages.map((page) => (
          <section key={page.key} className="maker-print-paper">
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
                      <div className="maker-print-group-meta">
                        {column.partCount > 1 ? (
                          <span className="maker-print-continuation">
                            {column.partIndex}/{column.partCount}
                          </span>
                        ) : null}
                        <strong>{column.qty}</strong>
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
