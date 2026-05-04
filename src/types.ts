export type RawSourceRecord = Record<string, string>;

export type ViewMode = 'raw' | 'filtered' | 'master' | 'maker' | 'daily';

export type OrderRow = {
  id: string;
  sourceName: string;
  original: RawSourceRecord;
  originalProductName: string;
  amazonOrderId: string;
  purchaseDate: string;
  purchaseDateTime: string;
  orderStatus: string;
  fulfillmentChannel: string;
  shipServiceLevel: string;
  productName: string;
  sku: string;
  itemStatus: string;
  quantity: number;
};

export type EditableOrderFields = Pick<
  OrderRow,
  | 'amazonOrderId'
  | 'purchaseDate'
  | 'orderStatus'
  | 'fulfillmentChannel'
  | 'shipServiceLevel'
  | 'productName'
  | 'sku'
  | 'itemStatus'
  | 'quantity'
>;

export type RawEditMap = Record<string, Partial<EditableOrderFields>>;

export type FilterState = {
  dateFrom: string;
  dateTo: string;
  companyNames: string[];
  colors: string[];
  fulfillmentChannels: string[];
  orderStatuses: string[];
  shipServiceLevels: string[];
  itemStatuses: string[];
  keyword: string;
  excludePending: boolean;
  excludeCancelled: boolean;
  excludeShipped: boolean;
};

export type FilterPreset = {
  name: string;
  savedAt: string;
  filters: FilterState;
};

export type ProductionDetails = {
  size: string;
  color: string;
  productType: string;
  note: string;
  rush: boolean;
  requiresStraightMark: boolean;
};

export type ProductionOverride = {
  size?: string;
  color?: string;
  note?: string;
  productType?: string;
  rush?: boolean;
};

export type ProductionOverrideMap = Record<string, ProductionOverride>;

export type MasterRow = {
  id: string;
  sourceRowId: string;
  size: string;
  color: string;
  qty: number;
  note: string;
  productType: string;
  amazonOrderId: string;
  orderStatus: string;
  shipServiceLevel: string;
  purchaseDate: string;
};

export type MakerRow = {
  id: string;
  size: string;
  color: string;
  productType: string;
  qty: number;
  note: string;
  orderMarker: string;
  sameOrderCount: number;
  amazonOrderIds: string;
  orderStatuses: string;
  shipServiceLevels: string;
  sourceRowIds: string[];
};

export type MakerColorGroup = {
  color: string;
  rows: MakerRow[];
  totalQty: number;
};

export type DailyOrderItem = {
  size: string;
  qty: number;
};

export type DailyOrderRow = {
  id: string;
  amazonOrderId: string;
  purchaseDate: string;
  rawPurchaseDate: string;
  color: string;
  marks: string;
  rush: boolean;
  items: DailyOrderItem[];
  totalQty: number;
  sourceRowIds: string[];
};

export type DailyColorGroup = {
  color: string;
  normalRows: DailyOrderRow[];
  yangRows: DailyOrderRow[];
  totalQty: number;
};

export type LabelPage = {
  id: string;
  sourceName: string;
  pageNumber: number;
  text: string;
  normalizedText: string;
  width: number;
  height: number;
};

export type LabelParseResult = {
  sourceName: string;
  pages: LabelPage[];
  warnings: string[];
};

export type LabelMatchStatus = 'matched' | 'possible' | 'unmatched';

export type LabelMatch = {
  id: string;
  pageId: string;
  sourceName: string;
  pageNumber: number;
  status: LabelMatchStatus;
  score: number;
  reasons: string[];
  amazonOrderId: string;
  sourceRowId: string;
  recipientName: string;
  postalCode: string;
  trackingNumber: string;
  size: string;
  sizeBreakdown: string[];
  color: string;
  qty: number;
  note: string;
  productType: string;
  labelSnippet: string;
};

export type LabelOrderReview = {
  id: string;
  amazonOrderId: string;
  recipientName: string;
  postalCode: string;
  cityState: string;
  trackingNumber: string;
  size: string;
  sizeBreakdown: string[];
  color: string;
  qty: number;
  note: string;
  productType: string;
  status: LabelMatchStatus;
  matchedPages: string;
  reasons: string[];
};

export type ParsedImport = {
  sourceName: string;
  rows: OrderRow[];
  headers: string[];
  warnings: string[];
};

export type MergeResult = {
  rows: OrderRow[];
  headers: string[];
  duplicatesRemoved: number;
};

export type FilterOptionSet = {
  companyNames: string[];
  colors: string[];
  fulfillmentChannels: string[];
  orderStatuses: string[];
  shipServiceLevels: string[];
  itemStatuses: string[];
};
