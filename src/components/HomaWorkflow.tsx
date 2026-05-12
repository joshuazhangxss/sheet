import Papa from 'papaparse';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import { DataTable, type TableColumn } from './DataTable';
import { LabelMatchPanel } from './LabelMatchPanel';
import { MakerSheetBoard } from './MakerSheetBoard';
import { MakerSheetPrintView } from './MakerSheetPrintView';
import {
  buildLabelBackPdf,
  buildLabelOrderReviews,
  getMatchableLabelPages,
  matchLabelPages,
} from '../lib/labelMatching';
import {
  buildMakerColorGroups,
  buildMakerRows,
  mergeImportedData,
} from '../lib/orderProcessing';
import {
  buildHomaMasterRows,
  buildHomaOrderListRows,
  parseHomaExcel,
  type HomaOrderListRow,
} from '../lib/homaProcessing';
import type {
  LabelPage,
  OrderRow,
  ProductionOverrideMap,
} from '../types';

type HomaViewMode = 'orders' | 'maker';
type ExportColumn = {
  key: string;
  label: string;
};

function formatDateTimeLabel(value: string): string {
  return value.trim().replace('T', ' ');
}

function buildDateRangeLabel(rows: OrderRow[]): string {
  const dates = rows
    .map((row) => row.purchaseDateTime || row.purchaseDate)
    .filter(Boolean)
    .sort();

  if (dates.length === 0) {
    return '未识别到订单日期';
  }

  const first = formatDateTimeLabel(dates[0] ?? '');
  const last = formatDateTimeLabel(dates[dates.length - 1] ?? '');

  return first === last ? first : `${first} 至 ${last}`;
}

function downloadCsv(
  filename: string,
  rows: Array<Record<string, string | number>>,
  columns: ExportColumn[],
) {
  const csv = Papa.unparse({
    fields: columns.map((column) => column.label),
    data: rows.map((row) => columns.map((column) => row[column.key] ?? '')),
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadPdf(filename: string, bytes: Uint8Array) {
  const normalizedBytes = new Uint8Array(bytes.byteLength);
  normalizedBytes.set(bytes);
  const blob = new Blob([normalizedBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function HomaWorkflow() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const printCleanupRef = useRef<(() => void) | null>(null);
  const isUnmountingRef = useRef(false);
  const [baseRows, setBaseRows] = useState<OrderRow[]>([]);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [labelPages, setLabelPages] = useState<LabelPage[]>([]);
  const [labelWarnings, setLabelWarnings] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState(
    '先导入 HOMA Excel，再上传标签 PDF。标签匹配成功后会直接生成订单表和生产单。',
  );
  const [isImportingExcel, setIsImportingExcel] = useState(false);
  const [isParsingLabels, setIsParsingLabels] = useState(false);
  const [viewMode, setViewMode] = useState<HomaViewMode>('orders');
  const [productionOverrides, setProductionOverrides] = useState<ProductionOverrideMap>({});

  useEffect(
    () => () => {
      isUnmountingRef.current = true;
      printCleanupRef.current?.();
      if (typeof document !== 'undefined') {
        document.body.classList.remove('print-maker-sheet');
      }
    },
    [],
  );

  const allMasterRows = buildHomaMasterRows(baseRows, productionOverrides);
  const labelMatches = matchLabelPages(labelPages, baseRows, allMasterRows);
  const matchableLabelPages = getMatchableLabelPages(labelPages);
  const labelOrderReviews = buildLabelOrderReviews(baseRows, allMasterRows, labelMatches);
  const matchedOrderIds = new Set(
    labelMatches
      .filter((match) => match.status !== 'unmatched' && match.amazonOrderId.trim())
      .map((match) => match.amazonOrderId.trim()),
  );
  const hasMatchedLabelOrders = matchedOrderIds.size > 0;
  const activeRows =
    labelPages.length > 0
      ? baseRows.filter((row) => matchedOrderIds.has(row.amazonOrderId.trim()))
      : baseRows;
  const orderListRows = buildHomaOrderListRows(activeRows, productionOverrides);
  const makerColorGroups = buildMakerColorGroups(
    buildMakerRows(buildHomaMasterRows(activeRows, productionOverrides)),
  );
  const activeDateRangeLabel = buildDateRangeLabel(activeRows);
  const rushCount = makerColorGroups.reduce(
    (sum, group) => sum + group.rows.filter((row) => row.note.includes('★')).length,
    0,
  );
  const labelSourceCount = new Set(labelPages.map((page) => page.sourceName)).size;

  const orderColumns: TableColumn<HomaOrderListRow>[] = [
    {
      key: 'purchaseDate',
      label: '订单日期',
      render: (row) => <strong>{formatDateTimeLabel(row.purchaseDate || '—')}</strong>,
    },
    {
      key: 'amazonOrderId',
      label: '订单号',
      render: (row) => <strong>{row.amazonOrderId || '—'}</strong>,
    },
    {
      key: 'customerName',
      label: '客户',
      render: (row) => <span>{row.customerName || '—'}</span>,
    },
    {
      key: 'description',
      label: '产品',
      render: (row) => (
        <div className="stack-cell">
          <strong>{row.description || '—'}</strong>
          <span>{row.sku || '—'}</span>
        </div>
      ),
    },
    {
      key: 'color',
      label: '颜色',
      render: (row) => <strong>{row.color || '—'}</strong>,
    },
    {
      key: 'size',
      label: '尺寸',
      render: (row) => <strong>{row.size || '—'}</strong>,
    },
    {
      key: 'productType',
      label: '类型',
      render: (row) => <strong>{row.productType || '—'}</strong>,
    },
    {
      key: 'qty',
      label: '数量',
      align: 'right',
      render: (row) => <strong>{row.qty}</strong>,
    },
  ];

  function appendLabelPages(nextPages: LabelPage[], warnings: string[]) {
    const seen = new Set(
      labelPages.map((page) => `${page.sourceName}::${page.pageNumber}::${page.normalizedText}`),
    );
    const dedupedPages = nextPages.filter((page) => {
      const key = `${page.sourceName}::${page.pageNumber}::${page.normalizedText}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
    const mergedPages = [...labelPages, ...dedupedPages];
    const mergedMatches = matchLabelPages(mergedPages, baseRows, allMasterRows);
    const matchedIds = new Set(
      mergedMatches
        .filter((match) => match.status !== 'unmatched' && match.amazonOrderId.trim())
        .map((match) => match.amazonOrderId.trim()),
    );

    setLabelPages((current) => [...current, ...dedupedPages]);
    setLabelWarnings((current) => [...current, ...warnings]);

    if (matchedIds.size > 0) {
      setViewMode('maker');
      setStatusMessage(
        `已导入 ${dedupedPages.length} 页标签，并匹配到 ${matchedIds.size} 个订单，已自动生成生产单。`,
      );
      return;
    }

    setStatusMessage(`已导入 ${dedupedPages.length} 页标签，但还没有匹配到订单。`);
  }

  async function importExcelFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    setIsImportingExcel(true);

    try {
      const parsed = await Promise.all(files.map((file) => parseHomaExcel(file)));
      const merged = mergeImportedData(baseRows, rawHeaders, parsed);
      const warnings = parsed.flatMap((item) => item.warnings);

      setBaseRows(merged.rows);
      setRawHeaders(merged.headers);
      setStatusMessage(
        `已导入 ${files.length} 个 Excel 文件，订单库共 ${merged.rows.length} 行，去重 ${merged.duplicatesRemoved} 行。${
          warnings.length ? ` 另有 ${warnings.length} 条导入提醒。` : ''
        }`,
      );
    } catch (error) {
      setStatusMessage(
        `Excel 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    } finally {
      setIsImportingExcel(false);
    }
  }

  async function importLabelFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    setIsParsingLabels(true);

    try {
      const { parseLabelPdf } = await import('../lib/labelPdf');
      const parsed = await Promise.all(files.map((file) => parseLabelPdf(file)));
      const nextPages = parsed.flatMap((item) => item.pages);
      const warnings = parsed.flatMap((item) => item.warnings);

      if (nextPages.length === 0) {
        setStatusMessage(warnings[0] || '标签 PDF 没有识别到可用页面。');
        return;
      }

      appendLabelPages(nextPages, warnings);
    } catch (error) {
      setStatusMessage(
        `标签 PDF 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    } finally {
      setIsParsingLabels(false);
    }
  }

  function handleExcelInput(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);

    if (selectedFiles.length === 0) {
      return;
    }

    void importExcelFiles(selectedFiles);
    event.currentTarget.value = '';
  }

  function clearAllData() {
    setBaseRows([]);
    setRawHeaders([]);
    setLabelPages([]);
    setLabelWarnings([]);
    setProductionOverrides({});
    setViewMode('orders');
    setStatusMessage('已清空 HOMA Excel 和标签数据。');
  }

  function clearLabelData() {
    setLabelPages([]);
    setLabelWarnings([]);
    setViewMode('orders');
    setStatusMessage('已清空标签 PDF，订单库保留。');
  }

  function exportOrderCsv() {
    if (orderListRows.length === 0) {
      setStatusMessage('当前没有可导出的订单数据。');
      return;
    }

    downloadCsv(
      'HOMA订单.csv',
      orderListRows.map((row) => ({
        order_date: formatDateTimeLabel(row.purchaseDate),
        amazon_order_id: row.amazonOrderId,
        customer_name: row.customerName,
        sku: row.sku,
        description: row.description,
        color: row.color,
        size: row.size,
        type: row.productType,
        qty: row.qty,
      })),
      [
        { key: 'order_date', label: '订单日期' },
        { key: 'amazon_order_id', label: '订单号' },
        { key: 'customer_name', label: '客户' },
        { key: 'sku', label: 'SKU' },
        { key: 'description', label: '产品' },
        { key: 'color', label: '颜色' },
        { key: 'size', label: '尺寸' },
        { key: 'type', label: '类型' },
        { key: 'qty', label: '数量' },
      ],
    );
    setStatusMessage('已导出 HOMA 订单 CSV。');
  }

  function exportLabelMatchesCsv() {
    if (labelMatches.length === 0) {
      setStatusMessage('当前没有可导出的标签匹配结果。');
      return;
    }

    downloadCsv(
      'HOMA标签匹配结果.csv',
      labelMatches.map((match) => ({
        source_file: match.sourceName,
        page_number: match.pageNumber,
        status:
          match.status === 'matched'
            ? '已匹配'
            : match.status === 'possible'
              ? '待确认'
              : '未匹配',
        amazon_order_id: match.amazonOrderId,
        recipient_name: match.recipientName,
        size: match.size,
        color: match.color,
        qty: match.qty,
        type: match.productType,
        note: match.note,
        reasons: match.reasons.join(' / '),
      })),
      [
        { key: 'source_file', label: '来源 PDF' },
        { key: 'page_number', label: '页码' },
        { key: 'status', label: '状态' },
        { key: 'amazon_order_id', label: '订单号' },
        { key: 'recipient_name', label: '客户' },
        { key: 'size', label: '尺寸' },
        { key: 'color', label: '颜色' },
        { key: 'qty', label: '数量' },
        { key: 'type', label: '类型' },
        { key: 'note', label: '标记' },
        { key: 'reasons', label: '匹配依据' },
      ],
    );
    setStatusMessage('已导出 HOMA 标签匹配结果 CSV。');
  }

  async function exportLabelBacksidePdf() {
    if (matchableLabelPages.length === 0 || labelMatches.length === 0) {
      setStatusMessage('当前没有可导出的背面 PDF。');
      return;
    }

    try {
      const pdfBytes = await buildLabelBackPdf(matchableLabelPages, labelMatches);

      downloadPdf('HOMA标签背面信息.pdf', pdfBytes);
      setStatusMessage('已导出 HOMA 标签背面信息 PDF。');
    } catch (error) {
      setStatusMessage(
        `背面 PDF 生成失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  }

  function printMakerSheet() {
    if (makerColorGroups.length === 0) {
      setStatusMessage('当前生产单没有可打印的数据。');
      return;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    printCleanupRef.current?.();

    const printClassName = 'print-maker-sheet';
    const printRoot = document.querySelector<HTMLElement>('.maker-print-root');

    if (!printRoot) {
      return;
    }

    let frameOne = 0;
    let frameTwo = 0;
    let fallbackTimer = 0;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      window.cancelAnimationFrame(frameOne);
      window.cancelAnimationFrame(frameTwo);
      window.clearTimeout(fallbackTimer);
      window.removeEventListener('afterprint', cleanup);
      document.body.classList.remove(printClassName);
      printCleanupRef.current = null;
    };

    printCleanupRef.current = cleanup;
    document.body.classList.add(printClassName);
    window.addEventListener('afterprint', cleanup);

    frameOne = window.requestAnimationFrame(() => {
      frameTwo = window.requestAnimationFrame(() => {
        window.print();
        fallbackTimer = window.setTimeout(cleanup, 800);
      });
    });

    setStatusMessage('已打开 HOMA 生产单打印预览。');
  }

  return (
    <>
      <div className="app-shell">
        <header className="app-header">
          <div className="header-copy">
            <p className="kicker">Excel 订单 + 标签 PDF</p>
            <h1>HOMA 排单</h1>
            <p className="header-text">
              导入 HOMA Excel，再上传标签 PDF。系统会自动按标签匹配订单，并生成订单表和生产单。
            </p>
          </div>

          {baseRows.length > 0 ? (
            <div className="metric-row">
              <div className="metric-card">
                <span>订单库</span>
                <strong>{baseRows.length}</strong>
              </div>
              <div className="metric-card">
                <span>标签页</span>
                <strong>{matchableLabelPages.length}</strong>
              </div>
              <div className="metric-card">
                <span>当前订单</span>
                <strong>{orderListRows.length}</strong>
              </div>
              <div className="metric-card">
                <span>生产单 / 加急</span>
                <strong>
                  {makerColorGroups.reduce((sum, group) => sum + group.rows.length, 0)} / {rushCount}
                </strong>
              </div>
            </div>
          ) : (
            <div className="start-note">先导入 HOMA Excel。导入后再上传标签 PDF。</div>
          )}
        </header>

        <section className="section-card">
          <div className="section-head">
            <div>
              <h2>导入 HOMA Excel</h2>
              <p className="section-text">支持 `.xlsx / .xls`。会读取订单号、客户、描述、尺寸和数量。</p>
            </div>
            <div className="section-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={isImportingExcel}
              >
                {isImportingExcel ? '正在解析 Excel…' : '选择 Excel'}
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={clearAllData}
                disabled={baseRows.length === 0 && labelPages.length === 0}
              >
                全部清空
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              multiple
              hidden
              onChange={handleExcelInput}
            />
          </div>

          <div className="status-bar">{statusMessage}</div>

          {baseRows.length > 0 ? (
            <div className="check-grid">
              <div className="check-card">
                <span className="check-label">文件列</span>
                <strong>{rawHeaders.length}</strong>
                <p>已识别 Excel 表头。</p>
              </div>
              <div className="check-card">
                <span className="check-label">时间范围</span>
                <strong>{buildDateRangeLabel(baseRows)}</strong>
                <p>按 Excel 里的订单日期显示。</p>
              </div>
              <div className="check-card">
                <span className="check-label">标签匹配</span>
                <strong>{hasMatchedLabelOrders ? matchedOrderIds.size : 0}</strong>
                <p>{hasMatchedLabelOrders ? '已按标签筛出订单。' : '上传标签后会自动筛批次。'}</p>
              </div>
            </div>
          ) : null}
        </section>

        {baseRows.length > 0 ? (
          <LabelMatchPanel
            orderCount={baseRows.length}
            labelPageCount={matchableLabelPages.length}
            sourceCount={labelSourceCount}
            warnings={labelWarnings}
            matches={labelMatches}
            orderReviews={labelOrderReviews}
            isUsingLabelOrders={hasMatchedLabelOrders}
            onImport={(files) => {
              void importLabelFiles(files);
            }}
            onClear={clearLabelData}
            onExportCsv={exportLabelMatchesCsv}
            onExportBackPdf={() => {
              void exportLabelBacksidePdf();
            }}
            isParsing={isParsingLabels}
          />
        ) : null}

        {baseRows.length > 0 ? (
          <section className="section-card">
            <div className="section-head">
              <div>
                <h2>{viewMode === 'orders' ? '订单表' : '生产单'}</h2>
                <p className="section-text">
                  {hasMatchedLabelOrders
                    ? `当前来源：标签批次。时间范围：${activeDateRangeLabel}`
                    : `当前来源：Excel 全部订单。时间范围：${activeDateRangeLabel}`}
                </p>
              </div>
              <div className="section-actions">
                {viewMode === 'orders' ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={exportOrderCsv}
                  >
                    导出订单 CSV
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={printMakerSheet}
                  >
                    打印生产单
                  </button>
                )}
              </div>
            </div>

            <div className="output-toolbar">
              <div className="view-tabs">
                <button
                  type="button"
                  className={`view-tab ${viewMode === 'orders' ? 'is-active' : ''}`}
                  onClick={() => setViewMode('orders')}
                >
                  <span>订单</span>
                  <strong>{orderListRows.length}</strong>
                </button>
                <button
                  type="button"
                  className={`view-tab ${viewMode === 'maker' ? 'is-active' : ''}`}
                  onClick={() => setViewMode('maker')}
                >
                  <span>生产单</span>
                  <strong>{makerColorGroups.reduce((sum, group) => sum + group.rows.length, 0)}</strong>
                </button>
              </div>
            </div>

            {viewMode === 'orders' ? (
              <DataTable
                rows={orderListRows}
                columns={orderColumns}
                rowKey={(row) => row.id}
                emptyState={
                  labelPages.length > 0
                    ? '当前标签批次还没有匹配到 HOMA 订单。'
                    : '请先导入 HOMA Excel。'
                }
              />
            ) : (
              <MakerSheetBoard
                groups={makerColorGroups}
                emptyState="当前没有可生成生产单的 HOMA 数据。"
                onEdit={(row, field, nextValue) => {
                  setProductionOverrides((current) => {
                    const next = { ...current };

                    row.sourceRowIds.forEach((sourceRowId) => {
                      next[sourceRowId] = {
                        ...(next[sourceRowId] ?? {}),
                        [field]: nextValue,
                      };
                    });

                    return next;
                  });
                }}
              />
            )}
          </section>
        ) : null}
      </div>

      {baseRows.length > 0 ? (
        <MakerSheetPrintView
          groups={makerColorGroups}
          dateRangeLabel={activeDateRangeLabel}
        />
      ) : null}
    </>
  );
}
