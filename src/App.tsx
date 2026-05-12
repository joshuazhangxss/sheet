import Papa from 'papaparse';
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { flushSync } from 'react-dom';

import { DataTable, type TableColumn } from './components/DataTable';
import { DailyOrderColorBoard } from './components/DailyOrderColorBoard';
import { DailyOrderPrintView } from './components/DailyOrderPrintView';
import { LabelMatchPanel } from './components/LabelMatchPanel';
import { MakerSheetBoard } from './components/MakerSheetBoard';
import { MakerSheetPrintView } from './components/MakerSheetPrintView';
import './App.css';
import {
  buildLabelOrderReviews,
  buildLabelBackPdf,
  getMatchableLabelPages,
  matchLabelPages,
} from './lib/labelMatching';
import {
  buildDailyColorGroups,
  buildDailyOrderRows,
  buildMakerColorGroups,
  buildMasterOrderGroupSummaries,
  buildOrderGroupSummaries,
  applyRawEdits,
  buildMakerRows,
  buildMasterRows,
  composeNote,
  extractCompanyName,
  filterOrderRows,
  getDateRange,
  getFilterOptions,
  hasRushNote,
  inspectHeaders,
  isPrivacyFenceType,
  mergeImportedData,
  parseAmazonText,
  simplifyProductName,
  sortOrderRowsForReview,
  stripRushNote,
} from './lib/orderProcessing';
import { parseHomaExcel } from './lib/homaProcessing';
import type {
  DailyColorGroup,
  FilterPreset,
  FilterState,
  DailyOrderRow,
  LabelPage,
  LabelOrderReview,
  MakerColorGroup,
  MasterRow,
  OrderRow,
  ProductionOverrideMap,
  ProductionOverride,
  RawEditMap,
  ViewMode,
  ParsedImport,
} from './types';

const PRESET_STORAGE_KEY = 'warehouse-order-presets-v1';
const LAST_BATCH_TIME_STORAGE_KEY = 'warehouse-last-batch-time-v1';

const DEFAULT_FILTERS: FilterState = {
  dateFrom: '',
  dateTo: '',
  companyNames: [],
  colors: [],
  fulfillmentChannels: ['Merchant'],
  orderStatuses: [],
  shipServiceLevels: [],
  itemStatuses: [],
  keyword: '',
  excludePending: true,
  excludeCancelled: true,
  excludeShipped: false,
};

const VIEW_OPTIONS: Array<{
  mode: ViewMode;
  label: string;
  description: string;
}> = [
  {
    mode: 'raw',
    label: '原始数据',
    description: '按导入原样合并显示所有数据。',
  },
  {
    mode: 'filtered',
    label: '筛选结果',
    description: '只保留生产需要的亚马逊字段。',
  },
  {
    mode: 'master',
    label: '总表',
    description: '逐条显示提取后的尺寸、颜色、数量和标记。',
  },
  {
    mode: 'daily',
    label: '日订单',
    description: '按本地日期过滤并按亚马逊订单分组，保留同单多尺寸。',
  },
  {
    mode: 'maker',
    label: '生产单',
    description: '按颜色分组，每个颜色下显示尺寸、类型、数量和标记。',
  },
];

const PRIMARY_VIEW_OPTIONS = VIEW_OPTIONS.filter(
  (option) => option.mode === 'daily' || option.mode === 'maker',
);
const ADVANCED_VIEW_OPTIONS = VIEW_OPTIONS.filter(
  (option) => option.mode === 'raw' || option.mode === 'filtered' || option.mode === 'master',
);

type ExportColumn = {
  key: string;
  label: string;
};

type FilterArrayKey =
  | 'companyNames'
  | 'colors'
  | 'fulfillmentChannels'
  | 'orderStatuses'
  | 'shipServiceLevels'
  | 'itemStatuses';

type ImportSummary = {
  sourceCount: number;
  addedCount: number;
  duplicatesRemoved: number;
  warnings: string[];
};

type DailyPrintMeta = {
  generatedAt: string;
  dateRangeLabel: string;
  listMode: DailyListMode;
};

type DailyListMode = 'orders' | 'colors';
type OrderSourceMode = 'filters' | 'labels';

function cloneFilters(filters: Partial<FilterState> = DEFAULT_FILTERS): FilterState {
  return {
    dateFrom: filters.dateFrom ?? DEFAULT_FILTERS.dateFrom,
    dateTo: filters.dateTo ?? DEFAULT_FILTERS.dateTo,
    companyNames: [...(filters.companyNames ?? DEFAULT_FILTERS.companyNames)],
    colors: [...(filters.colors ?? DEFAULT_FILTERS.colors)],
    fulfillmentChannels: [
      ...(filters.fulfillmentChannels ?? DEFAULT_FILTERS.fulfillmentChannels),
    ],
    orderStatuses: [...(filters.orderStatuses ?? DEFAULT_FILTERS.orderStatuses)],
    shipServiceLevels: [
      ...(filters.shipServiceLevels ?? DEFAULT_FILTERS.shipServiceLevels),
    ],
    itemStatuses: [...(filters.itemStatuses ?? DEFAULT_FILTERS.itemStatuses)],
    keyword: filters.keyword ?? DEFAULT_FILTERS.keyword,
    excludePending: filters.excludePending ?? DEFAULT_FILTERS.excludePending,
    excludeCancelled: filters.excludeCancelled ?? DEFAULT_FILTERS.excludeCancelled,
    excludeShipped: filters.excludeShipped ?? DEFAULT_FILTERS.excludeShipped,
  };
}

function formatDateTimeLabel(value: string): string {
  return value.trim().replace('T', ' ');
}

function buildDateRangeLabel(
  dateFrom: string,
  dateTo: string,
  fallbackLabel: string,
): string {
  const from = formatDateTimeLabel(dateFrom);
  const to = formatDateTimeLabel(dateTo);

  if (from && to) {
    return from === to ? from : `${from} 至 ${to}`;
  }

  if (from) {
    return `${from} 起`;
  }

  if (to) {
    return `截至 ${to}`;
  }

  return fallbackLabel;
}

function padDateValue(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocalInput(date: Date): string {
  return `${date.getFullYear()}-${padDateValue(date.getMonth() + 1)}-${padDateValue(
    date.getDate(),
  )}T${padDateValue(date.getHours())}:${padDateValue(date.getMinutes())}`;
}

function isDateTimeInputValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.trim());
}

function getEffectiveRangeEnd(maxImportedTime: string): string {
  const now = formatLocalInput(new Date());

  if (!isDateTimeInputValue(maxImportedTime)) {
    return now;
  }

  return maxImportedTime < now ? maxImportedTime : now;
}

function shiftDateInputDay(dateValue: string, offsetDays: number): string {
  const next = new Date(`${dateValue}T00:00`);

  next.setDate(next.getDate() + offsetDays);

  return formatLocalInput(next).slice(0, 10);
}

function formatSameOrderPreview(
  labels: string[],
  limit = 2,
): string {
  const visibleLabels = labels.filter(Boolean).slice(0, limit);

  if (visibleLabels.length === 0) {
    return '';
  }

  const remainingCount = labels.filter(Boolean).length - visibleLabels.length;
  const suffix = remainingCount > 0 ? ` 等 ${remainingCount + visibleLabels.length} 项` : '';

  return `${visibleLabels.join('、')}${suffix}`;
}

function formatDailyItemSummary(items: DailyOrderRow['items']): string {
  return items
    .map((item) => (item.qty > 1 ? `${item.size} x${item.qty}` : item.size || '待确认'))
    .join('、');
}

function formatDailyTimeLabel(value: string): string {
  return value.replace('T', ' ');
}

function getAmazonRawPurchaseTime(row: OrderRow): string {
  const directMatch = row.original['purchase-date'];

  if (directMatch) {
    return directMatch;
  }

  const fallbackEntry = Object.entries(row.original).find(
    ([key]) => key.replace(/\uFEFF/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') === 'purchasedate',
  );

  return fallbackEntry?.[1] || row.purchaseDate;
}

function translateFulfillmentChannel(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return '未填写';
  }

  if (normalized.includes('merchant') || normalized === 'mfn') {
    return '自配送';
  }

  if (normalized.includes('amazon') || normalized === 'afn') {
    return '亚马逊配送';
  }

  return value;
}

function translateStatus(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return '未填写';
  }

  if (normalized.includes('pending')) {
    return '待处理';
  }

  if (normalized.includes('cancel')) {
    return '已取消';
  }

  if (normalized.includes('partially')) {
    return '部分发货';
  }

  if (normalized.includes('unshipped')) {
    return '未发货';
  }

  if (normalized.includes('shipped')) {
    return '已发货';
  }

  return value;
}

function translateShipServiceLevelUi(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return '未填写';
  }

  if (normalized.includes('expedited')) {
    return '加急';
  }

  if (normalized.includes('freeeconomy') || normalized.includes('economy')) {
    return '经济';
  }

  if (normalized.includes('standard')) {
    return '标准';
  }

  if (normalized.includes('priority')) {
    return '优先';
  }

  if (normalized.includes('second') || normalized.includes('next')) {
    return '次日';
  }

  return value;
}

function translateFilterOption(key: FilterArrayKey, value: string): string {
  if (key === 'companyNames' || key === 'colors') {
    return value;
  }

  if (key === 'fulfillmentChannels') {
    return translateFulfillmentChannel(value);
  }

  if (key === 'shipServiceLevels') {
    return translateShipServiceLevelUi(value);
  }

  return translateStatus(value);
}

function readSavedPresets(): FilterPreset[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as FilterPreset[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (preset): preset is FilterPreset =>
          Boolean(
            preset &&
              typeof preset === 'object' &&
              typeof preset.name === 'string' &&
              typeof preset.savedAt === 'string',
          ),
      )
      .map((preset) => ({
        ...preset,
        filters: cloneFilters(preset.filters),
      }));
  } catch {
    return [];
  }
}

function readStoredLastBatchTime(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    const raw = window.localStorage.getItem(LAST_BATCH_TIME_STORAGE_KEY) ?? '';
    return isDateTimeInputValue(raw) ? raw : '';
  } catch {
    return '';
  }
}

function buildTsv(
  rows: Array<Record<string, string | number>>,
  columns: ExportColumn[],
): string {
  const lines = [
    columns.map((column) => column.label).join('\t'),
    ...rows.map((row) =>
      columns
        .map((column) =>
          String(row[column.key] ?? '')
            .replace(/\t/g, ' ')
            .replace(/\r?\n/g, ' '),
        )
        .join('\t'),
    ),
  ];

  return lines.join('\n');
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

function isHomaExcelFile(file: File): boolean {
  return /\.xlsx?$/i.test(file.name);
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const printCleanupRef = useRef<null | (() => void)>(null);
  const isUnmountingRef = useRef(false);
  const [baseRows, setBaseRows] = useState<OrderRow[]>([]);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawEdits, setRawEdits] = useState<RawEditMap>({});
  const [productionOverrides, setProductionOverrides] =
    useState<ProductionOverrideMap>({});
  const [filters, setFilters] = useState<FilterState>(() => cloneFilters(DEFAULT_FILTERS));
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [primaryViewMode, setPrimaryViewMode] = useState<'daily' | 'maker'>('daily');
  const [pasteText, setPasteText] = useState('');
  const [presetName, setPresetName] = useState('');
  const [savedPresets, setSavedPresets] = useState<FilterPreset[]>(readSavedPresets);
  const [lastBatchTime, setLastBatchTime] = useState<string>(readStoredLastBatchTime);
  const [isDragging, setIsDragging] = useState(false);
  const [includeMasterMetadata, setIncludeMasterMetadata] = useState(false);
  const [dailyListMode, setDailyListMode] = useState<DailyListMode>('orders');
  const [orderSourceMode, setOrderSourceMode] = useState<OrderSourceMode>('filters');
  const [lastImportSummary, setLastImportSummary] = useState<ImportSummary | null>(null);
  const [dailyPrintMeta, setDailyPrintMeta] = useState<DailyPrintMeta | null>(null);
  const [labelPages, setLabelPages] = useState<LabelPage[]>([]);
  const [labelWarnings, setLabelWarnings] = useState<string[]>([]);
  const [isParsingLabels, setIsParsingLabels] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    '请先上传 Amazon CSV/TXT 或 HOMA Excel 文件；也可以直接粘贴 Amazon 表格文本。',
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(savedPresets));
    } catch {
      // Ignore storage failures; the active session still works without presets.
    }
  }, [savedPresets]);

  useEffect(() => {
    try {
      if (lastBatchTime) {
        window.localStorage.setItem(LAST_BATCH_TIME_STORAGE_KEY, lastBatchTime);
      } else {
        window.localStorage.removeItem(LAST_BATCH_TIME_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures; the active session still works without remembered batch time.
    }
  }, [lastBatchTime]);

  useEffect(
    () => () => {
      isUnmountingRef.current = true;
      printCleanupRef.current?.();
      if (typeof document !== 'undefined') {
        document.body.classList.remove('print-maker-sheet');
        document.body.classList.remove('print-daily-orders');
      }
    },
    [],
  );

  const deferredKeyword = useDeferredValue(filters.keyword);
  const workingRows = applyRawEdits(baseRows, rawEdits);
  const allMasterRows = buildMasterRows(workingRows, productionOverrides);
  const filteredRows = filterOrderRows(workingRows, {
    ...filters,
    keyword: deferredKeyword,
  });
  const labelMatches = matchLabelPages(labelPages, workingRows, allMasterRows);
  const matchableLabelPages = getMatchableLabelPages(labelPages);
  const labelOrderReviews: LabelOrderReview[] = buildLabelOrderReviews(
    workingRows,
    allMasterRows,
    labelMatches,
  );
  const labelMatchedOrderIds = new Set(
    labelMatches
      .filter((match) => match.status !== 'unmatched' && match.amazonOrderId.trim())
      .map((match) => match.amazonOrderId.trim()),
  );
  const labelMatchedRows =
    labelMatchedOrderIds.size > 0
      ? workingRows.filter((row) => labelMatchedOrderIds.has(row.amazonOrderId.trim()))
      : [];
  const orderSourceRows =
    orderSourceMode === 'labels' && labelMatchedRows.length > 0 ? labelMatchedRows : filteredRows;
  const filteredReviewRows = sortOrderRowsForReview(orderSourceRows);
  const filteredOrderGroups = buildOrderGroupSummaries(filteredReviewRows);
  const masterRows = buildMasterRows(orderSourceRows, productionOverrides);
  const dailyRows = buildDailyOrderRows(orderSourceRows, productionOverrides);
  const dailyColorGroups: DailyColorGroup[] = buildDailyColorGroups(dailyRows);
  const masterOrderGroups = buildMasterOrderGroupSummaries(masterRows);
  const makerRows = buildMakerRows(masterRows);
  const makerColorGroups: MakerColorGroup[] = buildMakerColorGroups(makerRows);
  const matchableOrderCount = new Set(
    workingRows.map((row) => row.amazonOrderId.trim() || row.id),
  ).size;
  const filterOptions = getFilterOptions(workingRows);
  const dateRange = getDateRange(workingRows);
  const activeView = VIEW_OPTIONS.find((option) => option.mode === viewMode) ?? VIEW_OPTIONS[0];
  const hasImportedData = baseRows.length > 0;
  const headerInspection = inspectHeaders(rawHeaders);
  const importedSourceCount = new Set(baseRows.map((row) => row.sourceName)).size;
  const purchaseDateRangeLabel =
    dateRange.min && dateRange.max
      ? dateRange.min === dateRange.max
        ? formatDateTimeLabel(dateRange.min)
        : `${formatDateTimeLabel(dateRange.min)} 至 ${formatDateTimeLabel(dateRange.max)}`
      : '未识别到购买时间';
  const latestImportedDay = dateRange.max?.slice(0, 10) ?? '';
  const previousImportedDay = latestImportedDay ? shiftDateInputDay(latestImportedDay, -1) : '';
  const hasYesterdayShortcut =
    Boolean(previousImportedDay) &&
    Boolean(dateRange.min) &&
    previousImportedDay >= dateRange.min.slice(0, 10);
  const labelOrderDateRange = getDateRange(labelMatchedRows);
  const activeDateRangeLabel =
    orderSourceMode === 'labels' && labelMatchedRows.length > 0
      ? buildDateRangeLabel(
          labelOrderDateRange.min,
          labelOrderDateRange.max,
          '标签匹配订单',
        )
      : buildDateRangeLabel(filters.dateFrom, filters.dateTo, purchaseDateRangeLabel);

  const rushCount = masterRows.filter((row) => row.note.includes('★')).length;
  const labelSourceCount = new Set(labelPages.map((page) => page.sourceName)).size;
  const isLabelOrderMode = orderSourceMode === 'labels' && labelMatchedRows.length > 0;
  const hasLabelPages = labelPages.length > 0;
  const viewCounts: Record<ViewMode, number> = {
    raw: baseRows.length,
    filtered: orderSourceRows.length,
    master: masterRows.length,
    daily: dailyRows.length,
    maker: makerRows.length,
  };
  const isAdvancedViewMode = ADVANCED_VIEW_OPTIONS.some((option) => option.mode === viewMode);

  const rawColumns: TableColumn<OrderRow>[] = [
    {
      key: 'sourceName',
      label: '来源文件',
      getValue: (row) => row.sourceName,
    },
    ...rawHeaders.map((header) => ({
      key: header,
      label: header,
      getValue: (row: OrderRow) => row.original[header] ?? '',
    })),
  ];

  const filteredColumns: TableColumn<OrderRow>[] = [
    {
      key: 'amazonOrderId',
      label: '亚马逊订单号',
      render: (row) => {
        const group = filteredOrderGroups.get(row.amazonOrderId);

        return (
          <div className="stack-cell">
            <strong>{row.amazonOrderId || '—'}</strong>
            {group && group.lineCount > 1 ? (
              <span>
                同单 {group.lineCount} 项 · 共 {group.totalQty} 件
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'purchaseDate',
      label: '本地时间',
      editable: true,
      inputType: 'datetime-local',
      getValue: (row) => row.purchaseDateTime || row.purchaseDate,
      helperText: () => '仓库筛选使用本地时间',
    },
    {
      key: 'rawPurchaseDate',
      label: 'Amazon 原始时间 UTC',
      getValue: (row) => getAmazonRawPurchaseTime(row),
    },
    {
      key: 'orderStatus',
      label: '订单状态',
      editable: true,
      getValue: (row) => row.orderStatus,
      helperText: (row) => translateStatus(row.orderStatus),
    },
    {
      key: 'fulfillmentChannel',
      label: '配送方式',
      editable: true,
      getValue: (row) => row.fulfillmentChannel,
      helperText: (row) => translateFulfillmentChannel(row.fulfillmentChannel),
    },
    {
      key: 'shipServiceLevel',
      label: '物流级别',
      editable: true,
      getValue: (row) => row.shipServiceLevel,
      helperText: (row) => translateShipServiceLevelUi(row.shipServiceLevel),
    },
    {
      key: 'productName',
      label: '产品名称',
      editable: true,
      getValue: (row) =>
        rawEdits[row.id]?.productName ?? simplifyProductName(row.originalProductName),
      helperText: (row) => {
        const companyName = extractCompanyName(row.originalProductName);
        const orderGroup = filteredOrderGroups.get(row.amazonOrderId);
        const sameOrderLabel =
          orderGroup && orderGroup.lineCount > 1
            ? `同单含：${formatSameOrderPreview(orderGroup.labels)}`
            : '';
        const originalLabel =
          simplifyProductName(row.originalProductName) !== row.originalProductName
            ? `原始：${row.originalProductName}`
            : '';

        return [companyName ? `公司：${companyName}` : '', sameOrderLabel, originalLabel]
          .filter(Boolean)
          .join(' · ');
      },
    },
    {
      key: 'sku',
      label: 'sku',
      editable: true,
      getValue: (row) => row.sku,
    },
    {
      key: 'quantity',
      label: '数量',
      editable: true,
      inputType: 'number',
      align: 'right',
      getValue: (row) => row.quantity,
    },
  ];

  const masterColumns: TableColumn<MasterRow>[] = [
    {
      key: 'size',
      label: '尺寸',
      editable: true,
      getValue: (row) => row.size,
      placeholder: '待确认',
      helperText: (row) => {
        const orderGroup = masterOrderGroups.get(row.amazonOrderId);
        const sameOrderLabel =
          orderGroup && orderGroup.lineCount > 1
            ? `同单 ${orderGroup.lineCount} 项 · ${formatSameOrderPreview(orderGroup.labels)}`
            : '';

        return [row.amazonOrderId ? `订单：${row.amazonOrderId}` : '', sameOrderLabel]
          .filter(Boolean)
          .join(' · ');
      },
    },
    {
      key: 'color',
      label: '颜色',
      editable: true,
      getValue: (row) => row.color,
      placeholder: '待确认',
    },
    {
      key: 'qty',
      label: '数量',
      editable: true,
      inputType: 'number',
      align: 'right',
      getValue: (row) => row.qty,
    },
    {
      key: 'note',
      label: '标记',
      editable: true,
      getValue: (row) => row.note,
    },
  ];

  const dailyColumns: TableColumn<DailyOrderRow>[] = [
    {
      key: 'purchaseDate',
      label: '本地时间',
      render: (row) => <span className="daily-meta-text">{formatDailyTimeLabel(row.purchaseDate)}</span>,
    },
    {
      key: 'rawPurchaseDate',
      label: 'Amazon 原始时间 UTC',
      render: (row) => <span className="daily-meta-text">{row.rawPurchaseDate || '—'}</span>,
    },
    {
      key: 'amazonOrderId',
      label: '亚马逊订单号',
      render: (row) => (
        <div className="daily-meta-stack">
          <strong className="daily-order-id">{row.amazonOrderId || '—'}</strong>
          <span>同单 {row.items.length} 项 · 共 {row.totalQty} 件</span>
        </div>
      ),
    },
    {
      key: 'color',
      label: '颜色',
      render: (row) => (
        <strong className="daily-main-text">{row.color || '待确认'}</strong>
      ),
    },
    {
      key: 'items',
      label: '尺寸',
      render: (row) => (
        <div className="daily-item-stack">
          {row.items.map((item, index) => (
            <strong key={`${row.id}-size-${index}`} className="daily-main-text">
              {item.size || '待确认'}
            </strong>
          ))}
        </div>
      ),
    },
    {
      key: 'qty',
      label: '数量',
      render: (row) => (
        <div className="daily-item-stack daily-item-stack--qty">
          {row.items.map((item, index) => (
            <strong key={`${row.id}-qty-${index}`} className="daily-main-text">
              {item.qty}
            </strong>
          ))}
        </div>
      ),
      align: 'center',
    },
    {
      key: 'marks',
      label: '标记',
      render: (row) => <strong className="daily-mark-text">{row.marks || '—'}</strong>,
    },
    {
      key: 'rush',
      label: '加急',
      render: (row) => <strong className="daily-rush-text">{row.rush ? '★' : '—'}</strong>,
      align: 'center',
    },
  ];

  const filterGroups: Array<{
    key: FilterArrayKey;
    label: string;
    options: string[];
  }> = [
    {
      key: 'companyNames',
      label: '公司 / 品牌',
      options: filterOptions.companyNames,
    },
    {
      key: 'colors',
      label: '颜色',
      options: filterOptions.colors,
    },
    {
      key: 'fulfillmentChannels',
      label: '配送方式',
      options: filterOptions.fulfillmentChannels,
    },
    {
      key: 'orderStatuses',
      label: '订单状态',
      options: filterOptions.orderStatuses,
    },
    {
      key: 'shipServiceLevels',
      label: '物流级别',
      options: filterOptions.shipServiceLevels,
    },
    {
      key: 'itemStatuses',
      label: '商品状态',
      options: filterOptions.itemStatuses,
    },
  ];

  function setFilterValue<Key extends keyof FilterState>(
    key: Key,
    value: FilterState[Key],
  ) {
    setFilters((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function toggleArrayFilter(key: FilterArrayKey, option: string) {
    setFilters((current) => {
      const nextValues = current[key].includes(option)
        ? current[key].filter((value) => value !== option)
        : [...current[key], option];

      return {
        ...current,
        [key]: nextValues,
      };
    });
  }

  function clearArrayFilter(key: FilterArrayKey) {
    setFilters((current) => ({
      ...current,
      [key]: [],
    }));
  }

  function applyDailyOrderPreset(dayOffset: 0 | -1) {
    const baseDate = latestImportedDay || formatLocalInput(new Date()).slice(0, 10);
    const targetDate = dayOffset === 0 ? baseDate : shiftDateInputDay(baseDate, dayOffset);
    const start = `${targetDate}T00:00`;
    const end = `${targetDate}T23:59`;

    setOrderSourceMode('filters');
    setFilters({
      ...cloneFilters(DEFAULT_FILTERS),
      dateFrom: start,
      dateTo: end,
      fulfillmentChannels: ['Merchant'],
      orderStatuses: ['Shipped'],
      excludePending: true,
      excludeCancelled: true,
      excludeShipped: false,
    });
    setViewMode('daily');
    setPrimaryViewMode('daily');
    setStatusMessage(
      `已套用${dayOffset === 0 ? '今日' : '昨日'}订单预设：本地日 ${targetDate} + 自配送 + 已发货。`,
    );
  }

  function rememberLastBatchTime(timestamp = formatLocalInput(new Date())): string {
    setLastBatchTime(timestamp);
    return timestamp;
  }

  function markCurrentAsLastBatchTime() {
    const timestamp = rememberLastBatchTime();
    setStatusMessage(`已记录上次打单时间：${formatDateTimeLabel(timestamp)}。`);
  }

  function applySinceLastBatchPreset() {
    if (!lastBatchTime) {
      setStatusMessage('还没有记录上次打单时间。先点“记当前打单时间”，或先打印一次日订单。');
      return;
    }

    const end = getEffectiveRangeEnd(dateRange.max);

    if (end < lastBatchTime) {
      setStatusMessage(
        `上次打单时间 ${formatDateTimeLabel(lastBatchTime)} 晚于当前导入数据的最新本地时间 ${formatDateTimeLabel(
          end,
        )}。请导入更新文件或手动调整时间。`,
      );
      return;
    }

    setOrderSourceMode('filters');
    setFilters({
      ...cloneFilters(DEFAULT_FILTERS),
      dateFrom: lastBatchTime,
      dateTo: end,
      fulfillmentChannels: ['Merchant'],
      orderStatuses: ['Shipped'],
      excludePending: true,
      excludeCancelled: true,
      excludeShipped: false,
    });
    setViewMode('daily');
    setPrimaryViewMode('daily');
    setStatusMessage(
      `已套用上次打单后范围：${formatDateTimeLabel(lastBatchTime)} 至 ${formatDateTimeLabel(
        end,
      )} + 自配送 + 已发货。`,
    );
  }

  function applyWarehouseDefault() {
    setOrderSourceMode('filters');
    setFilters({
      ...cloneFilters(DEFAULT_FILTERS),
      dateFrom: dateRange.min,
      dateTo: dateRange.max,
    });
    setStatusMessage(
      '已套用仓库默认筛选：自配送、排除待处理，并使用完整时间范围。',
    );
  }

  function resetFilters() {
    setOrderSourceMode('filters');
    setFilters({
      ...cloneFilters(DEFAULT_FILTERS),
      dateFrom: dateRange.min,
      dateTo: dateRange.max,
    });
    setStatusMessage('筛选条件已重置为当前数据范围和仓库默认设置。');
  }

  function updateRawCell(rowId: string, field: string, nextValue: string) {
    setRawEdits((current) => {
      const nextRow = { ...(current[rowId] ?? {}) };

      if (field === 'quantity') {
        const parsed = Number.parseInt(nextValue, 10);
        nextRow.quantity = Number.isNaN(parsed) ? 0 : parsed;
      } else if (
        field === 'purchaseDate' ||
        field === 'orderStatus' ||
        field === 'fulfillmentChannel' ||
        field === 'shipServiceLevel' ||
        field === 'productName' ||
        field === 'sku' ||
        field === 'amazonOrderId' ||
        field === 'itemStatus'
      ) {
        nextRow[field] = nextValue;
      }

      return {
        ...current,
        [rowId]: nextRow,
      };
    });
  }

  function updateProductionCell(rowId: string, field: string, nextValue: string) {
    setProductionOverrides((current) => ({
      ...current,
      [rowId]: {
        ...(current[rowId] ?? {}),
        [field]: nextValue,
      },
    }));
  }

  function applyProductionOverrideToRows(
    rowIds: string[],
    patch: Partial<ProductionOverride>,
  ) {
    setProductionOverrides((current) => {
      const next = { ...current };

      rowIds.forEach((rowId) => {
        next[rowId] = {
          ...(next[rowId] ?? {}),
          ...patch,
        };
      });

      return next;
    });
  }

  function appendParsedImports(
    parsedImports: ParsedImport[],
    sourceCount: number,
  ) {
    const warnings = parsedImports.flatMap((item) => item.warnings);

    const merged = mergeImportedData(baseRows, rawHeaders, parsedImports);
    const addedCount = merged.rows.length - baseRows.length;
    const warningSuffix =
      warnings.length > 0
        ? ` ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}`
        : '';

    startTransition(() => {
      setBaseRows(merged.rows);
      setRawHeaders(merged.headers);
      setViewMode('daily');
      setPrimaryViewMode('daily');
      setFilters((current) => {
        if (current.dateFrom || current.dateTo) {
          return current;
        }

        const nextRange = getDateRange(merged.rows);

        return {
          ...current,
          dateFrom: nextRange.min,
          dateTo: nextRange.max,
        };
      });
    });

    setLastImportSummary({
      sourceCount,
      addedCount,
      duplicatesRemoved: merged.duplicatesRemoved,
      warnings,
    });

    setStatusMessage(
      `已导入 ${addedCount} 行数据，来源 ${sourceCount} 个文件/文本，去重 ${merged.duplicatesRemoved} 行。${warningSuffix}`,
    );
  }

  async function importFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const parsedImports = await Promise.all(
      files.map(async (file) =>
        isHomaExcelFile(file)
          ? parseHomaExcel(file)
          : parseAmazonText(await file.text(), file.name),
      ),
    );

    const nextRows = parsedImports.flatMap((item) => item.rows);
    const warnings = parsedImports.flatMap((item) => item.warnings);

    if (nextRows.length === 0) {
      setStatusMessage(warnings[0] || '上传的文件中没有识别到可用数据。');
      return;
    }

    appendParsedImports(parsedImports, files.length);
  }

  async function importPastedText() {
    if (!pasteText.trim()) {
      setStatusMessage('请先粘贴 CSV 或制表符分隔的表格内容。');
      return;
    }

    const parsed = parseAmazonText(pasteText, '粘贴文本');

    if (parsed.rows.length === 0) {
      setStatusMessage(parsed.warnings[0] || '粘贴内容中没有识别到可用数据。');
      return;
    }

    appendParsedImports([parsed], 1);
    setPasteText('');
  }

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
    const mergedMatches = matchLabelPages(mergedPages, workingRows, allMasterRows);
    const matchedOrderIds = new Set(
      mergedMatches
        .filter((match) => match.status !== 'unmatched' && match.amazonOrderId.trim())
        .map((match) => match.amazonOrderId.trim()),
    );
    const matchedRowCount =
      matchedOrderIds.size > 0
        ? workingRows.filter((row) => matchedOrderIds.has(row.amazonOrderId.trim())).length
        : 0;

    setLabelPages((current) => [...current, ...dedupedPages]);
    setLabelWarnings((current) => [...current, ...warnings]);

    if (matchedOrderIds.size > 0) {
      setOrderSourceMode('labels');
      setViewMode('maker');
      setPrimaryViewMode('maker');
      setStatusMessage(
        `已导入 ${dedupedPages.length} 页标签 PDF，并自动生成生产单：${matchedOrderIds.size} 个订单，${matchedRowCount} 条原始行。`,
      );
      return;
    }

    setStatusMessage(
      `已导入 ${dedupedPages.length} 页标签 PDF，暂时还没有匹配到订单。`,
    );
  }

  async function importLabelFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }

    setIsParsingLabels(true);

    try {
      const { parseLabelPdf } = await import('./lib/labelPdf');
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

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);

    if (selectedFiles.length === 0) {
      return;
    }

    void importFiles(selectedFiles);
    event.currentTarget.value = '';
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void importFiles(Array.from(event.dataTransfer.files));
  }

  function clearAllData() {
    setBaseRows([]);
    setRawHeaders([]);
    setRawEdits({});
    setProductionOverrides({});
    setLabelPages([]);
    setLabelWarnings([]);
    setIsParsingLabels(false);
    setFilters(cloneFilters(DEFAULT_FILTERS));
    setDailyListMode('orders');
    setPasteText('');
    setViewMode('daily');
    setPrimaryViewMode('daily');
    setOrderSourceMode('filters');
    setLastImportSummary(null);
    setStatusMessage('已清空已导入文件、粘贴内容和手动修改。');
  }

  function clearLabelData() {
    setLabelPages([]);
    setLabelWarnings([]);
    setOrderSourceMode('filters');
    setStatusMessage('已清空标签 PDF 和匹配结果。');
  }

  function savePreset() {
    const name = presetName.trim();

    if (!name) {
      setStatusMessage('请输入预设名称后再保存。');
      return;
    }

    const nextPreset: FilterPreset = {
      name,
      savedAt: new Date().toISOString(),
      filters: cloneFilters(filters),
    };

    setSavedPresets((current) => {
      const withoutMatch = current.filter((preset) => preset.name !== name);
      return [nextPreset, ...withoutMatch].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
      );
    });
    setStatusMessage(`已保存筛选预设“${name}”。`);
  }

  function loadPreset(preset: FilterPreset) {
    setFilters(cloneFilters(preset.filters));
    setPresetName(preset.name);
    setStatusMessage(`已加载筛选预设“${preset.name}”。`);
  }

  function deletePreset(name: string) {
    setSavedPresets((current) => current.filter((preset) => preset.name !== name));
    setStatusMessage(`已删除筛选预设“${name}”。`);
  }

  function buildExportPayload(): {
    filename: string;
    columns: ExportColumn[];
    rows: Array<Record<string, string | number>>;
  } {
    if (viewMode === 'raw') {
      const columns = [
        { key: 'source_file', label: '来源文件' },
        ...rawHeaders.map((header) => ({ key: header, label: header })),
      ];

      return {
        filename: '原始数据.csv',
        columns,
        rows: baseRows.map((row) => ({
          source_file: row.sourceName,
          ...Object.fromEntries(rawHeaders.map((header) => [header, row.original[header] ?? ''])),
        })),
      };
    }

    if (viewMode === 'filtered') {
      return {
        filename: '筛选结果.csv',
        columns: [
          { key: 'amazon_order_id', label: '亚马逊订单号' },
          { key: 'local_purchase_date', label: '本地时间' },
          { key: 'amazon_purchase_date_utc', label: 'Amazon 原始时间 UTC' },
          { key: 'order_status', label: '订单状态' },
          { key: 'fulfillment_channel', label: '配送方式' },
          { key: 'ship_service_level', label: '物流级别' },
          { key: 'product_name', label: '产品名称' },
          { key: 'sku', label: 'sku' },
          { key: 'quantity', label: '数量' },
        ],
        rows: filteredReviewRows.map((row) => ({
          amazon_order_id: row.amazonOrderId,
          local_purchase_date: row.purchaseDateTime || row.purchaseDate,
          amazon_purchase_date_utc: getAmazonRawPurchaseTime(row),
          order_status: translateStatus(row.orderStatus),
          fulfillment_channel: translateFulfillmentChannel(row.fulfillmentChannel),
          ship_service_level: translateShipServiceLevelUi(row.shipServiceLevel),
          product_name:
            rawEdits[row.id]?.productName ?? simplifyProductName(row.originalProductName),
          sku: row.sku,
          quantity: row.quantity,
        })),
      };
    }

    if (viewMode === 'master') {
      const baseColumns = [
        { key: 'size', label: '尺寸' },
        { key: 'color', label: '颜色' },
        { key: 'qty', label: '数量' },
        { key: 'note', label: '标记' },
      ];

      return {
        filename: '总表.csv',
        columns: includeMasterMetadata
          ? [
              ...baseColumns,
              { key: 'amazon_order_id', label: '亚马逊订单号' },
              { key: 'order_status', label: '订单状态' },
              { key: 'ship_service_level', label: '物流级别' },
            ]
          : baseColumns,
        rows: masterRows.map((row) => ({
          size: row.size,
          color: row.color,
          qty: row.qty,
          note: row.note,
          amazon_order_id: row.amazonOrderId,
          order_status: translateStatus(row.orderStatus),
          ship_service_level: translateShipServiceLevelUi(row.shipServiceLevel),
        })),
      };
    }

    if (viewMode === 'daily') {
      if (dailyListMode === 'colors') {
        return {
          filename: '日订单-按颜色.csv',
          columns: [
            { key: 'color', label: '颜色' },
            { key: 'category', label: '分类' },
            { key: 'items', label: '尺寸' },
            { key: 'marks', label: '标记' },
            { key: 'rush', label: '加急' },
            { key: 'total_qty', label: '总数量' },
            { key: 'amazon_order_id', label: '亚马逊订单号' },
            { key: 'purchase_date', label: '本地时间' },
            { key: 'amazon_purchase_date_utc', label: 'Amazon 原始时间 UTC' },
          ],
          rows: dailyColorGroups.flatMap((group) => [
            ...group.normalRows.map((row) => ({
              color: group.color,
              category: '常规',
              items: formatDailyItemSummary(row.items),
              marks: row.marks,
              rush: row.rush ? '★' : '',
              total_qty: row.totalQty,
              amazon_order_id: row.amazonOrderId,
              purchase_date: row.purchaseDate,
              amazon_purchase_date_utc: row.rawPurchaseDate,
            })),
            ...group.yangRows.map((row) => ({
              color: group.color,
              category: '阳',
              items: formatDailyItemSummary(row.items),
              marks: row.marks,
              rush: row.rush ? '★' : '',
              total_qty: row.totalQty,
              amazon_order_id: row.amazonOrderId,
              purchase_date: row.purchaseDate,
              amazon_purchase_date_utc: row.rawPurchaseDate,
            })),
          ]),
        };
      }

      return {
        filename: '日订单.csv',
        columns: [
          { key: 'purchase_date', label: '本地时间' },
          { key: 'amazon_purchase_date_utc', label: 'Amazon 原始时间 UTC' },
          { key: 'amazon_order_id', label: '亚马逊订单号' },
          { key: 'items', label: '订单内容' },
          { key: 'color', label: '颜色' },
          { key: 'marks', label: '标记' },
          { key: 'rush', label: '加急' },
          { key: 'total_qty', label: '总数量' },
        ],
        rows: dailyRows.map((row) => ({
          purchase_date: row.purchaseDate,
          amazon_purchase_date_utc: row.rawPurchaseDate,
          amazon_order_id: row.amazonOrderId,
          items: formatDailyItemSummary(row.items),
          color: row.color,
          marks: row.marks,
          rush: row.rush ? '★' : '',
          total_qty: row.totalQty,
        })),
      };
    }

    return {
      filename: '生产单.csv',
      columns: [
        { key: 'color', label: '颜色' },
        { key: 'category', label: '分类' },
        { key: 'size', label: '尺寸' },
        { key: 'type', label: '类型' },
        { key: 'qty', label: '数量' },
        { key: 'rush', label: '加急' },
        { key: 'remark', label: '备注' },
      ],
      rows: makerColorGroups.flatMap((group) =>
        group.rows.map((row) => ({
          color: group.color,
          category: isPrivacyFenceType(row.productType) ? '隐私围栏' : '常规',
          size: row.size,
          type: row.productType,
          qty: row.qty,
          rush: hasRushNote(row.note) ? '★' : '',
          remark: stripRushNote(row.note),
        })),
      ),
    };
  }

  async function copyCurrentView() {
    const payload = buildExportPayload();

    if (payload.rows.length === 0) {
      setStatusMessage('当前视图没有可复制的数据。');
      return;
    }

    try {
      await navigator.clipboard.writeText(buildTsv(payload.rows, payload.columns));
      setStatusMessage(`已复制 ${payload.rows.length} 行“${activeView.label}”数据到剪贴板。`);
    } catch {
      setStatusMessage('当前浏览器会话无法复制到剪贴板。');
    }
  }

  function exportCurrentView() {
    const payload = buildExportPayload();

    if (payload.rows.length === 0) {
      setStatusMessage('当前视图没有可导出的数据。');
      return;
    }

    downloadCsv(payload.filename, payload.rows, payload.columns);
    setStatusMessage(`已导出 ${payload.filename}。`);
  }

  function exportLabelMatchesCsv() {
    if (labelMatches.length === 0) {
      setStatusMessage('当前没有可导出的标签匹配结果。');
      return;
    }

    downloadCsv(
      '标签匹配结果.csv',
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
        postal_code: match.postalCode,
        tracking_number: match.trackingNumber,
        size: match.size,
        color: match.color,
        qty: match.qty,
        type: match.productType,
        note: match.note,
        reasons: match.reasons.join(' / '),
        label_text: match.labelSnippet,
      })),
      [
        { key: 'source_file', label: '来源 PDF' },
        { key: 'page_number', label: '页码' },
        { key: 'status', label: '状态' },
        { key: 'amazon_order_id', label: '亚马逊订单号' },
        { key: 'recipient_name', label: '收件人' },
        { key: 'postal_code', label: '邮编' },
        { key: 'tracking_number', label: '追踪号' },
        { key: 'size', label: '尺寸' },
        { key: 'color', label: '颜色' },
        { key: 'qty', label: '数量' },
        { key: 'type', label: '类型' },
        { key: 'note', label: '标记' },
        { key: 'reasons', label: '匹配依据' },
        { key: 'label_text', label: '标签文本摘要' },
      ],
    );
    setStatusMessage('已导出标签匹配结果 CSV。');
  }

  async function exportLabelBacksidePdf() {
    if (matchableLabelPages.length === 0 || labelMatches.length === 0) {
      setStatusMessage('当前没有可导出的背面 PDF。');
      return;
    }

    try {
      const pdfBytes = await buildLabelBackPdf(matchableLabelPages, labelMatches);

      downloadPdf('标签背面信息.pdf', pdfBytes);
      setStatusMessage('已导出标签背面信息 PDF。');
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
    let frameOne = 0;
    let frameTwo = 0;
    let fallbackTimer = 0;
    let cleaned = false;

    const applyMakerPrintScale = () => {
      if (!printRoot) {
        return;
      }

      const papers = Array.from(
        printRoot.querySelectorAll<HTMLElement>('.maker-print-paper'),
      );

      if (papers.length > 1) {
        papers.forEach((paper) => {
          paper.style.setProperty('--maker-print-scale', '1');
        });
        return;
      }

      papers.forEach((paper) => {
        const fit = paper.querySelector<HTMLElement>('.maker-print-fit');

        if (!fit) {
          return;
        }

        paper.style.setProperty('--maker-print-scale', '1');

        const paperWidth = paper.clientWidth;
        const paperHeight = paper.clientHeight;
        const contentWidth = fit.scrollWidth;
        const contentHeight = fit.scrollHeight;

        if (paperWidth <= 0 || paperHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
          return;
        }

        const nextScale = Math.min(1, paperWidth / contentWidth, paperHeight / contentHeight);
        paper.style.setProperty('--maker-print-scale', `${Math.max(nextScale, 0.45)}`);
      });
    };

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
      printRoot
        ?.querySelectorAll<HTMLElement>('.maker-print-paper')
        .forEach((paper) => paper.style.removeProperty('--maker-print-scale'));
      printCleanupRef.current = null;

    };

    printCleanupRef.current = cleanup;
    document.body.classList.add(printClassName);
    window.addEventListener('afterprint', cleanup);

    frameOne = window.requestAnimationFrame(() => {
      frameTwo = window.requestAnimationFrame(() => {
        applyMakerPrintScale();
        window.print();
        fallbackTimer = window.setTimeout(cleanup, 800);
      });
    });

    setStatusMessage('已打开生产单打印预览，将尽量压缩到单页横向输出。');
  }

  function printDailyOrders() {
    const isColorMode = dailyListMode === 'colors';
    const hasPrintableRows = isColorMode ? dailyColorGroups.length > 0 : dailyRows.length > 0;

    if (!hasPrintableRows || typeof window === 'undefined' || typeof document === 'undefined') {
      setStatusMessage('当前日订单没有可打印的数据。');
      return;
    }

    printCleanupRef.current?.();
    const recordedBatchTime = rememberLastBatchTime();

    flushSync(() => {
      setDailyPrintMeta({
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        dateRangeLabel: activeDateRangeLabel,
        listMode: dailyListMode,
      });
    });

    const printClassName = 'print-daily-orders';
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

      if (!isUnmountingRef.current) {
        setDailyPrintMeta(null);
      }
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

    setStatusMessage(
      `${isColorMode ? '已打开按颜色日订单打印预览' : '已打开日订单打印预览'}，并记录本次打单时间：${formatDateTimeLabel(
        recordedBatchTime,
      )}。`,
    );
  }

  return (
    <>
      <div className="app-shell">
            <header className="app-header">
              <div className="header-copy">
                <p className="kicker">Amazon / HOMA 订单文件 + 标签 PDF</p>
                <h1>仓库排单</h1>
                <p className="header-text">
                  Amazon CSV/TXT 和 HOMA Excel 都可以导入到同一个订单库。上传标签后会直接生成生产单；没有标签时再用时间筛选。
                </p>
              </div>

              {hasImportedData ? (
                <div className="metric-row">
                  <div className="metric-card">
                    <span>订单库</span>
                    <strong>{matchableOrderCount}</strong>
                  </div>
                  <div className="metric-card">
                    <span>标签页</span>
                    <strong>{matchableLabelPages.length}</strong>
                  </div>
                  <div className="metric-card">
                    <span>当前批次</span>
                    <strong>{dailyRows.length}</strong>
                  </div>
                  <div className="metric-card">
                    <span>生产单 / 加急</span>
                    <strong>
                      {makerRows.length} / {rushCount}
                    </strong>
                  </div>
                </div>
              ) : (
                <div className="start-note">
                  先导入 Amazon 或 HOMA 订单文件。导入后可以直接上传标签 PDF 生成今日批次。
                </div>
              )}
            </header>

            <section className="section-card">
              <div className="section-head">
                <div>
                  <h2>导入订单</h2>
                  <p className="section-text">支持多个 Amazon CSV/TXT、HOMA Excel，也支持直接粘贴 Amazon 表格文本。</p>
                </div>
                <div className="section-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    选择文件
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={clearAllData}
                    disabled={baseRows.length === 0 && !pasteText}
                  >
                    全部清空
                  </button>
                </div>
              </div>

              <div className="import-grid">
                <div
              className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <strong>拖入订单文件</strong>
              <span>支持 Amazon CSV/TXT，也支持 HOMA Excel 文件一起导入。</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                multiple
                onChange={handleFileInput}
                hidden
              />
            </div>

            <div className="paste-panel">
              <label className="field-label" htmlFor="paste-import">
                粘贴表格文本
              </label>
              <textarea
                id="paste-import"
                value={pasteText}
                onChange={(event) => setPasteText(event.currentTarget.value)}
                placeholder="粘贴带 Amazon 表头的 CSV 或制表符内容。"
                rows={7}
              />
              <button
                type="button"
                className="button button-secondary"
                onClick={importPastedText}
              >
                导入粘贴内容
              </button>
            </div>
          </div>

          <div className="status-bar">{statusMessage}</div>
        </section>

        {hasImportedData ? (
          <details className="section-card collapsible-card">
            <summary className="details-summary">
              <span>导入检查</span>
              <strong>{purchaseDateRangeLabel}</strong>
            </summary>

            <div className="check-grid">
              <div className="check-card">
                <span className="check-label">来源</span>
                <strong>{importedSourceCount}</strong>
                <p>最近一次新增 {lastImportSummary?.addedCount ?? 0} 行。</p>
              </div>

              <div className="check-card">
                <span className="check-label">去重</span>
                <strong>{lastImportSummary?.duplicatesRemoved ?? 0}</strong>
                <p>优先按订单号 + 产品名称去重。</p>
              </div>

              <div className="check-card">
                <span className="check-label">时间范围</span>
                <strong>{purchaseDateRangeLabel}</strong>
                <p>筛选会按本地时间处理。</p>
              </div>

              <div className="check-card">
                <span className="check-label">关键列</span>
                <strong>{headerInspection.found.length}</strong>
                <p>缺少 {headerInspection.missing.length} 列。</p>
              </div>
            </div>

            <div className="check-detail-grid">
              <div className="check-panel">
                <div className="check-panel-head">
                  <h3>已识别</h3>
                  <span>{headerInspection.found.length}</span>
                </div>
                <div className="token-list">
                  {headerInspection.found.map((field) => (
                    <span key={field} className="token token-good">
                      {field}
                    </span>
                  ))}
                </div>
              </div>

              <div className="check-panel">
                <div className="check-panel-head">
                  <h3>缺少列</h3>
                  <span>{headerInspection.missing.length}</span>
                </div>
                {headerInspection.missing.length === 0 ? (
                  <p className="empty-chip-list">关键列已识别完整。</p>
                ) : (
                  <div className="token-list">
                    {headerInspection.missing.map((field) => (
                      <span key={field} className="token token-warn">
                        {field}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="check-panel">
                <div className="check-panel-head">
                  <h3>导入警告</h3>
                  <span>{lastImportSummary?.warnings.length ?? 0}</span>
                </div>
                {lastImportSummary?.warnings.length ? (
                  <ul className="warning-list">
                    {lastImportSummary.warnings.slice(0, 4).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty-chip-list">最近一次导入没有警告。</p>
                )}
              </div>
            </div>
          </details>
        ) : null}

        {hasImportedData ? (
          <LabelMatchPanel
            orderCount={matchableOrderCount}
            labelPageCount={matchableLabelPages.length}
            sourceCount={labelSourceCount}
            warnings={labelWarnings}
            matches={labelMatches}
            orderReviews={labelOrderReviews}
            isUsingLabelOrders={isLabelOrderMode}
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

        {hasImportedData && !hasLabelPages ? (
          <section className="section-card">
            <div className="section-head">
              <div>
                <h2>时间筛选</h2>
                <p className="section-text">没有标签时，再用这里筛订单。</p>
              </div>
              <div className="section-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => applyDailyOrderPreset(0)}
                >
                  今日
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => applyDailyOrderPreset(-1)}
                  disabled={!hasYesterdayShortcut}
                >
                  昨日
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={applySinceLastBatchPreset}
                  disabled={!lastBatchTime}
                >
                  上次打单后到现在
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={markCurrentAsLastBatchTime}
                >
                  记当前打单时间
                </button>
              </div>
            </div>

            {latestImportedDay ? (
              <div className="status-bar">
                今日 = {latestImportedDay}
                {hasYesterdayShortcut ? `，昨日 = ${previousImportedDay}` : ''}。
                上次打单时间：{lastBatchTime ? formatDateTimeLabel(lastBatchTime) : '尚未记录'}。
              </div>
            ) : null}

            <div className="filter-top-grid">
              <label className="field">
                <span>开始时间</span>
                <input
                  type="datetime-local"
                  step={60}
                  value={filters.dateFrom}
                  min={dateRange.min || undefined}
                  max={dateRange.max || undefined}
                  onChange={(event) => setFilterValue('dateFrom', event.currentTarget.value)}
                />
              </label>

              <label className="field">
                <span>结束时间</span>
                <input
                  type="datetime-local"
                  step={60}
                  value={filters.dateTo}
                  min={dateRange.min || undefined}
                  max={dateRange.max || undefined}
                  onChange={(event) => setFilterValue('dateTo', event.currentTarget.value)}
                />
              </label>

              <label className="field field-wide">
                <span>关键词</span>
                <input
                  type="search"
                  value={filters.keyword}
                  onChange={(event) => setFilterValue('keyword', event.currentTarget.value)}
                  placeholder="搜索产品名称或 SKU"
                />
              </label>
            </div>

            <div className="section-actions quick-action-row">
              <button
                type="button"
                className="button button-secondary"
                onClick={applyWarehouseDefault}
              >
                仓库默认
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={resetFilters}
              >
                重置筛选
              </button>
            </div>

            <details className="advanced-panel">
              <summary className="details-summary">
                <span>更多筛选</span>
                <strong>{filterGroups.length} 组</strong>
              </summary>

              <div className="toggle-row">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={filters.excludePending}
                    onChange={(event) =>
                      setFilterValue('excludePending', event.currentTarget.checked)
                    }
                  />
                  <span>排除待处理</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={filters.excludeCancelled}
                    onChange={(event) =>
                      setFilterValue('excludeCancelled', event.currentTarget.checked)
                    }
                  />
                  <span>排除已取消</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={filters.excludeShipped}
                    onChange={(event) =>
                      setFilterValue('excludeShipped', event.currentTarget.checked)
                    }
                  />
                  <span>排除已发货</span>
                </label>
              </div>

              <div className="filter-grid">
                {filterGroups.map((group) => (
                  <div key={group.key} className="filter-block">
                    <div className="filter-block-head">
                      <span>{group.label}</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => clearArrayFilter(group.key)}
                      >
                        全部
                      </button>
                    </div>

                    <div className="chip-list">
                      {group.options.length === 0 ? (
                        <span className="empty-chip-list">没有可选值。</span>
                      ) : (
                        group.options.map((option) => (
                          <button
                            key={option}
                            type="button"
                            className={`chip ${
                              filters[group.key].includes(option) ? 'is-selected' : ''
                            }`}
                            onClick={() => toggleArrayFilter(group.key, option)}
                          >
                            {translateFilterOption(group.key, option)}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="filter-footer">
                <div className="preset-box">
                  <label className="field field-inline">
                    <span>预设名称</span>
                    <input
                      type="text"
                      value={presetName}
                      onChange={(event) => setPresetName(event.currentTarget.value)}
                      placeholder="例如：自配送日常"
                    />
                  </label>
                  <button type="button" className="button button-secondary" onClick={savePreset}>
                    保存
                  </button>
                </div>

                <div className="legend-box">
                  <strong>标记</strong>
                  <span>直 = 直边</span>
                  <span>直+环 = 直边打环</span>
                  <span>★ = 加急</span>
                </div>
              </div>

              <div className="preset-list">
                {savedPresets.length === 0 ? (
                  <span className="empty-chip-list">还没有保存的预设。</span>
                ) : (
                  savedPresets.map((preset) => (
                    <div key={preset.name} className="preset-item">
                      <div className="preset-copy">
                        <strong>{preset.name}</strong>
                        <span>{new Date(preset.savedAt).toLocaleString()}</span>
                      </div>
                      <div className="preset-actions">
                        <button
                          type="button"
                          className="button button-ghost button-small"
                          onClick={() => loadPreset(preset)}
                        >
                          加载
                        </button>
                        <button
                          type="button"
                          className="button button-ghost button-small danger"
                          onClick={() => deletePreset(preset.name)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </details>
          </section>
        ) : null}

        {hasImportedData ? (
          <section className="section-card">
            <div className="section-head">
              <div>
                <h2>{isLabelOrderMode || primaryViewMode === 'maker' ? '生产单' : '日订单'}</h2>
                <p className="section-text">
                  {isLabelOrderMode
                    ? `当前来源：标签批次，已自动生成生产单。时间范围：${activeDateRangeLabel}`
                    : `当前来源：时间筛选。时间范围：${activeDateRangeLabel}`}
                </p>
              </div>
              <div className="section-actions">
                {!isLabelOrderMode && primaryViewMode === 'daily' ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={printDailyOrders}
                  >
                    打印日订单
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

            {!isLabelOrderMode ? (
              <div className="output-toolbar">
                <div className="view-tabs">
                  {PRIMARY_VIEW_OPTIONS.map((option) => (
                    <button
                      key={option.mode}
                      type="button"
                      className={`view-tab ${primaryViewMode === option.mode ? 'is-active' : ''}`}
                      onClick={() => {
                        setPrimaryViewMode(option.mode as 'daily' | 'maker');
                        setViewMode(option.mode);
                      }}
                    >
                      <span>{option.label}</span>
                      <strong>{viewCounts[option.mode]}</strong>
                    </button>
                  ))}
                </div>

                {primaryViewMode === 'daily' ? (
                  <div className="view-tabs">
                    <button
                      type="button"
                      className={`view-tab ${dailyListMode === 'orders' ? 'is-active' : ''}`}
                      onClick={() => setDailyListMode('orders')}
                    >
                      <span>按订单</span>
                      <strong>{dailyRows.length}</strong>
                    </button>
                    <button
                      type="button"
                      className={`view-tab ${dailyListMode === 'colors' ? 'is-active' : ''}`}
                      onClick={() => setDailyListMode('colors')}
                    >
                      <span>按颜色</span>
                      <strong>{dailyColorGroups.length}</strong>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!isLabelOrderMode && primaryViewMode === 'daily' ? (
              dailyListMode === 'orders' ? (
                <DataTable
                  rows={dailyRows}
                  columns={dailyColumns}
                  rowKey={(row) => row.id}
                  emptyState="当前没有可生成日订单的数据。"
                />
              ) : (
                <DailyOrderColorBoard
                  groups={dailyColorGroups}
                  emptyState="当前没有可生成按颜色分组的日订单。"
                  onUpdateSize={(row, nextValue) => {
                    if (row.items.length !== 1) {
                      setStatusMessage('同单多尺寸请到总表里分别修改尺寸。');
                      return;
                    }

                    applyProductionOverrideToRows(row.sourceRowIds, {
                      size: nextValue,
                    });
                  }}
                  onToggleRush={(row) => {
                    applyProductionOverrideToRows(row.sourceRowIds, {
                      rush: !row.rush,
                    });
                    setStatusMessage(
                      !row.rush
                        ? '已标记为加急，并同步到日订单和生产单。'
                        : '已取消加急标记，并同步到日订单和生产单。',
                    );
                  }}
                />
              )
            ) : (
              <MakerSheetBoard
                groups={makerColorGroups}
                emptyState="当前没有可生成生产单的数据。"
                onEdit={(row, field, nextValue) => {
                  setProductionOverrides((current) => {
                    const next = { ...current };
                    const nextValueForField =
                      field === 'note'
                        ? composeNote(nextValue, hasRushNote(row.note))
                        : nextValue;

                    row.sourceRowIds.forEach((sourceRowId) => {
                      next[sourceRowId] = {
                        ...(next[sourceRowId] ?? {}),
                        [field]: nextValueForField,
                      };
                    });

                    return next;
                  });
                }}
              />
            )}
          </section>
        ) : null}

        {hasImportedData ? (
          <details className="section-card collapsible-card">
            <summary className="details-summary">
              <span>更多数据</span>
              <strong>原始数据 / 筛选结果 / 总表</strong>
            </summary>

            <div className="output-toolbar">
              <div className="view-tabs">
                {ADVANCED_VIEW_OPTIONS.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    className={`view-tab ${viewMode === option.mode ? 'is-active' : ''}`}
                    onClick={() => setViewMode(option.mode)}
                  >
                    <span>{option.label}</span>
                    <strong>{viewCounts[option.mode]}</strong>
                  </button>
                ))}
              </div>

              {viewMode === 'master' ? (
                <label className="toggle meta-toggle">
                  <input
                    type="checkbox"
                    checked={includeMasterMetadata}
                    onChange={(event) => setIncludeMasterMetadata(event.currentTarget.checked)}
                  />
                  <span>导出总表时带订单信息</span>
                </label>
              ) : null}
            </div>

            <div className="section-actions compact-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={copyCurrentView}
                disabled={!isAdvancedViewMode}
              >
                复制表格
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={exportCurrentView}
                disabled={!isAdvancedViewMode}
              >
                导出 CSV
              </button>
            </div>

            {viewMode === 'raw' ? (
              <DataTable
                rows={baseRows}
                columns={rawColumns}
                rowKey={(row) => row.id}
                emptyState="请先上传文件或粘贴文本。"
              />
            ) : null}

            {viewMode === 'filtered' ? (
              <DataTable
                rows={filteredReviewRows}
                columns={filteredColumns}
                rowKey={(row) => row.id}
                emptyState="当前筛选条件下没有匹配数据。"
                onEdit={(row, columnKey, nextValue) =>
                  updateRawCell(row.id, columnKey, nextValue)
                }
              />
            ) : null}

            {viewMode === 'master' ? (
              <DataTable
                rows={masterRows}
                columns={masterColumns}
                rowKey={(row) => row.id}
                emptyState="当前没有可生成总表的数据。"
                onEdit={(row, columnKey, nextValue) => {
                  if (columnKey === 'qty') {
                    updateRawCell(row.sourceRowId, 'quantity', nextValue);
                    return;
                  }

                  updateProductionCell(row.sourceRowId, columnKey, nextValue);
                }}
              />
            ) : null}

            {!isAdvancedViewMode ? (
              <p className="empty-chip-list">先选择上方一个数据视图。</p>
            ) : null}
          </details>
        ) : null}
      </div>

      {hasImportedData ? (
            <MakerSheetPrintView
              groups={makerColorGroups}
              dateRangeLabel={activeDateRangeLabel}
            />
          ) : null}

      {hasImportedData ? (
            <DailyOrderPrintView
              rows={dailyRows}
              colorGroups={dailyColorGroups}
              listMode={dailyPrintMeta?.listMode ?? dailyListMode}
            />
          ) : null}
    </>
  );
}

export default App;
