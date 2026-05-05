import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PDFDocument } from 'pdf-lib';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MakerSheetPrintView } from '../src/components/MakerSheetPrintView';
import {
  buildLabelBackPdf,
  buildLabelOrderReviews,
  getMatchableLabelPages,
  matchLabelPages,
} from '../src/lib/labelMatching';
import {
  buildDailyColorGroups,
  buildDailyOrderRows,
  buildMasterOrderGroupSummaries,
  buildMakerColorGroups,
  buildMakerRows,
  buildMasterRows,
  buildOrderGroupSummaries,
  extractColor,
  extractSize,
  extractCompanyName,
  filterOrderRows,
  getFilterOptions,
  isRushOrder,
  mergeImportedData,
  parseAmazonText,
  simplifyProductName,
  sortOrderRowsForReview,
  toDateTimeInputValue,
} from '../src/lib/orderProcessing';
import type { FilterState, LabelPage } from '../src/types';

type CsvRow = Record<string, string | number>;

const CSV_HEADERS = [
  'amazon-order-id',
  'purchase-date',
  'order-status',
  'fulfillment-channel',
  'ship-service-level',
  'product-name',
  'sku',
  'item-status',
  'quantity',
];

function buildCsv(rows: CsvRow[]): string {
  const lines = [
    CSV_HEADERS.join(','),
    ...rows.map((row) =>
      CSV_HEADERS.map((header) => JSON.stringify(String(row[header] ?? ''))).join(','),
    ),
  ];

  return lines.join('\n');
}

function countMatches(haystack: string, pattern: RegExp): number {
  return haystack.match(pattern)?.length ?? 0;
}

function expectIncludes(haystack: string, needle: string) {
  assert.ok(haystack.includes(needle), `Expected output to include "${needle}".`);
}

async function main() {
  const fileOne = buildCsv([
    {
      'amazon-order-id': 'A-1001',
      'purchase-date': '2026-04-23T08:12',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'FreeEconomy',
      'product-name': "Sun Shade Depot Beige Straight Sun Shade 9' x 16'",
      sku: 'BG-ST-9X16',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1002',
      'purchase-date': '2026-04-23T08:15',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Expedited',
      'product-name': "LOVE STORY Brown Curved Sun Shade 4' x 12'",
      sku: 'BR-CV-4X12',
      'item-status': 'Unshipped',
      quantity: 2,
    },
    {
      'amazon-order-id': 'A-1003',
      'purchase-date': '2026-04-23T08:18',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Standard',
      'product-name': "Green Privacy Fence Screen 6' x 12'",
      sku: 'GN-PF-6X12',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1004',
      'purchase-date': '2026-04-23T08:22',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Standard',
      'product-name': "Black Curved Shade 5' x 8'",
      sku: 'BK-CV-5X8',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1005',
      'purchase-date': '2026-04-23T08:24',
      'order-status': 'Pending',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Standard',
      'product-name': "Black Flat Shade 6' x 10'",
      sku: 'BK-ST-6X10',
      'item-status': 'Pending',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1006',
      'purchase-date': '2026-04-23T08:26',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Amazon',
      'ship-service-level': 'Standard',
      'product-name': "Grey Curved Shade 9' x 14'",
      sku: 'GY-CV-9X14',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1007',
      'purchase-date': '2026-04-23T08:29',
      'order-status': 'Cancelled',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Standard',
      'product-name': "Blue Straight Shade 4' x 9'",
      sku: 'BL-ST-4X9',
      'item-status': 'Cancelled',
      quantity: 1,
    },
  ]);

  const fileTwo = buildCsv([
    {
      'amazon-order-id': 'A-1001',
      'purchase-date': '2026-04-23T08:12',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'FreeEconomy',
      'product-name': "Sun Shade Depot Beige Straight Sun Shade 9' x 16'",
      sku: 'BG-ST-9X16',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1008',
      'purchase-date': '2026-04-23T08:35',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Standard',
      'product-name': "Yellow Curved Shade 8' x 12'",
      sku: 'YL-CV-8X12',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1009',
      'purchase-date': '2026-04-23T08:37',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Expedited',
      'product-name': "Beige Straight Sun Shade with Grommets 10' x 12'",
      sku: 'BG-ST-10X12',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1010',
      'purchase-date': '2026-04-23T08:40',
      'order-status': 'Unshipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Standard',
      'product-name': "Beige Curved Shade 8' x 10'",
      sku: 'BG-CV-8X10',
      'item-status': 'Unshipped',
      quantity: 1,
    },
    {
      'amazon-order-id': 'A-1011',
      'purchase-date': '2026-04-23T08:44',
      'order-status': 'Shipped',
      'fulfillment-channel': 'Merchant',
      'ship-service-level': 'Expedited',
      'product-name': "Brown Straight Shade 7' x 10'",
      sku: 'BR-ST-7X10',
      'item-status': 'Shipped',
      quantity: 1,
    },
  ]);

  const merged = mergeImportedData([], [], [
    parseAmazonText(fileOne, 'sample-one.csv'),
    parseAmazonText(fileTwo, 'sample-two.csv'),
  ]);

  assert.equal(merged.rows.length, 11, 'Expected one duplicate row to be removed.');
  assert.equal(merged.duplicatesRemoved, 1, 'Duplicate removal should catch the repeated order.');
  assert.equal(
    toDateTimeInputValue('2026-04-30T00:41:22+00:00'),
    '2026-04-29T17:41',
    'Amazon UTC timestamps should be converted into local warehouse time for filtering.',
  );

  const defaultFilters: FilterState = {
    dateFrom: '2026-04-23T08:12',
    dateTo: '2026-04-23T08:40',
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

  const filteredRows = filterOrderRows(merged.rows, defaultFilters);
  assert.equal(filteredRows.length, 7, 'Warehouse default filters should leave 7 active rows.');

  const filterOptions = getFilterOptions(merged.rows);
  assert.deepEqual(
    new Set(filterOptions.companyNames),
    new Set(['LOVE STORY', 'Sun Shade Depot']),
    'Company filter options should be detected from leading brand/company prefixes.',
  );
  assert.deepEqual(
    new Set(filterOptions.colors),
    new Set(['棕色', '米色', '绿色', '黑色', '灰色', '蓝色', '黄色']),
    'Color filter options should be detected from product titles and SKU values.',
  );
  assert.equal(
    extractCompanyName(merged.rows[0]?.productName ?? ''),
    'Sun Shade Depot',
    'Company extraction should keep leading company words even if they contain generic shade words.',
  );
  assert.equal(
    simplifyProductName(merged.rows[0]?.productName ?? ''),
    "Beige Straight Sun Shade 9' x 16'",
    'Simplified product name should remove the company prefix while preserving the product wording.',
  );
  assert.equal(
    isRushOrder("Eden's Decor Straight Flat-Edged Sun Shade Sail Rectangular 4' x 10' Brown", 'Standard'),
    true,
    "Eden's Decor orders with Standard shipping should be treated as rush orders.",
  );
  assert.equal(
    isRushOrder("Sun Shade Depot Beige Straight Sun Shade 9' x 16'", 'Standard'),
    false,
    'Standard shipping should stay non-rush for other companies.',
  );
  assert.equal(
    extractSize(
      "5' x 5' x 5' Triangle Sun Shade Sail Canopy UV Block Fabric Shelter Cloth Screen Awning",
      '',
    ),
    '5’ X 5’ X 5’',
    'Triangle shades should keep all three dimensions instead of truncating to two.',
  );
  assert.equal(
    extractSize(`Eden's Decor Balcony Privacy Screen Brown 2'6"x 21' Cover Mesh`, ''),
    '2’6” X 21’',
    'Mixed feet-inch sizes should still be extracted after the dimension parser update.',
  );
  assert.equal(
    extractColor(
      `Eden's Decor Balcony Privacy Screen Brown/Khaki 2'6"x 12' Cover Mesh Windscreen`,
      'BalconyFence_BROWN/KHAKI2612',
    ),
    '双色',
    'Brown/Khaki privacy screens should map to the warehouse dual-color bucket instead of 棕色.',
  );

  const beigeOnlyRows = filterOrderRows(merged.rows, {
    ...defaultFilters,
    colors: ['米色'],
  });
  assert.equal(
    beigeOnlyRows.length,
    3,
    'Color filtering should keep only rows whose parsed color matches the selected color.',
  );

  const masterRows = buildMasterRows(filteredRows, {});
  const beigeStraight = masterRows.find((row) => row.amazonOrderId === 'A-1001');
  const brownRush = masterRows.find((row) => row.amazonOrderId === 'A-1002');
  const privacyFence = masterRows.find((row) => row.amazonOrderId === 'A-1003');
  const blackCurved = masterRows.find((row) => row.amazonOrderId === 'A-1004');
  const grommetRush = masterRows.find((row) => row.amazonOrderId === 'A-1009');

  assert.ok(beigeStraight, 'Expected beige straight sample row to exist.');
  assert.equal(beigeStraight.color, '米色');
  assert.equal(beigeStraight.productType, '直边');
  assert.equal(beigeStraight.note, '直');

  assert.ok(brownRush, 'Expected brown rush sample row to exist.');
  assert.equal(brownRush.color, '棕色');
  assert.equal(brownRush.productType, '弯边');
  assert.equal(brownRush.note, '★');

  assert.ok(privacyFence, 'Expected privacy fence sample row to exist.');
  assert.equal(privacyFence.color, '绿色');
  assert.equal(privacyFence.productType, '隐私围栏');

  assert.ok(blackCurved, 'Expected black curved sample row to exist.');
  assert.equal(blackCurved.color, '黑色');
  assert.equal(blackCurved.productType, '弯边');

  assert.ok(grommetRush, 'Expected grommet sample row to exist.');
  assert.equal(grommetRush.note, '直+环 ★');

  const syntheticBundledRows = sortOrderRowsForReview([
    {
      ...filteredRows[0]!,
      id: 'bundle-1',
      amazonOrderId: 'BUNDLE-1',
      quantity: 1,
      productName: "Sun Shade Depot Beige Straight Sun Shade 9' x 16'",
      originalProductName: "Sun Shade Depot Beige Straight Sun Shade 9' x 16'",
      purchaseDate: '2026-04-23T09:00',
      purchaseDateTime: '2026-04-23T09:00',
    },
    {
      ...filteredRows[1]!,
      id: 'bundle-2',
      amazonOrderId: 'BUNDLE-1',
      quantity: 2,
      productName: "LOVE STORY Brown Curved Sun Shade 4' x 12'",
      originalProductName: "LOVE STORY Brown Curved Sun Shade 4' x 12'",
      purchaseDate: '2026-04-23T09:00',
      purchaseDateTime: '2026-04-23T09:00',
    },
  ]);
  const bundledOrderGroups = buildOrderGroupSummaries(syntheticBundledRows);
  const bundledMasterGroups = buildMasterOrderGroupSummaries(
    buildMasterRows(syntheticBundledRows, {}),
  );
  const bundledDailyRows = buildDailyOrderRows(syntheticBundledRows, {});
  const bundledMakerRows = buildMakerRows(buildMasterRows(syntheticBundledRows, {}));

  assert.equal(
    bundledOrderGroups.get('BUNDLE-1')?.lineCount,
    2,
    'Same amazon-order-id rows should be grouped as one multi-line order.',
  );
  assert.equal(
    bundledOrderGroups.get('BUNDLE-1')?.totalQty,
    3,
    'Grouped order summary should accumulate quantities across same-order rows.',
  );
  assert.equal(
    bundledMasterGroups.get('BUNDLE-1')?.lineCount,
    2,
    'Master-row grouping should keep the same amazon-order-id bundle information.',
  );
  assert.equal(
    bundledDailyRows.length,
    2,
    'Daily-order rows should keep different marks or colors as separate printable lines.',
  );
  assert.equal(
    bundledMakerRows.length,
    2,
    'Maker rows should keep same-order bundled items separated instead of merging them with unrelated rows.',
  );
  assert.equal(
    new Set(bundledMakerRows.map((row) => row.orderMarker)).size,
    1,
    'Maker rows from the same bundled amazon-order-id should share one repeated marker.',
  );
  assert.equal(
    bundledMakerRows.every((row) => row.orderMarker.length > 0),
    true,
    'Bundled maker rows should carry a visible same-order marker.',
  );
  assert.equal(
    bundledMakerRows.every((row) => row.orderMarker.startsWith('同')),
    true,
    'Bundled maker rows should use the worker-facing 同A / 同B style markers.',
  );
  const bundledPrintMarkup = renderToStaticMarkup(
    React.createElement(MakerSheetPrintView, {
      groups: buildMakerColorGroups(bundledMakerRows),
      dateRangeLabel: '2026-04-23 09:00',
    }),
  );
  expectIncludes(bundledPrintMarkup, bundledMakerRows[0]!.orderMarker);

  const sameColorBundledMasterRows = [
    {
      id: 'same-color-single',
      sourceRowId: 'same-color-single',
      size: `3’ X 7’`,
      color: '米色',
      qty: 1,
      note: '直',
      productType: '直边',
      amazonOrderId: 'SINGLE-1',
      orderStatus: 'Shipped',
      shipServiceLevel: 'Standard',
      purchaseDate: '2026-04-23T09:00',
    },
    {
      id: 'same-color-bundle-1',
      sourceRowId: 'same-color-bundle-1',
      size: `4’ X 11’`,
      color: '米色',
      qty: 1,
      note: '直',
      productType: '直边',
      amazonOrderId: 'BUNDLE-SAME-COLOR',
      orderStatus: 'Shipped',
      shipServiceLevel: 'Standard',
      purchaseDate: '2026-04-23T09:01',
    },
    {
      id: 'same-color-bundle-2',
      sourceRowId: 'same-color-bundle-2',
      size: `8’ X 14’`,
      color: '米色',
      qty: 1,
      note: '直',
      productType: '直边',
      amazonOrderId: 'BUNDLE-SAME-COLOR',
      orderStatus: 'Shipped',
      shipServiceLevel: 'Standard',
      purchaseDate: '2026-04-23T09:01',
    },
  ];
  const sameColorBundledRows = buildMakerRows(sameColorBundledMasterRows);
  const sameColorBundledGroup = buildMakerColorGroups(sameColorBundledRows).find(
    (group) => group.color === '米色',
  );
  assert.deepEqual(
    sameColorBundledGroup?.rows.map((row) => row.size),
    [`3’ X 7’`, `4’ X 11’`, `8’ X 14’`],
    'Same-color bundled maker rows should be kept together at the end of the color column.',
  );
  assert.equal(
    sameColorBundledGroup?.rows[1]?.orderMarker,
    sameColorBundledGroup?.rows[2]?.orderMarker,
    'Same-color bundled rows should share one visible order marker.',
  );

  const sameShapeDifferentOrdersMakerRows = buildMakerRows([
    {
      id: 'split-order-1',
      sourceRowId: 'split-order-1',
      size: `4’ X 11’`,
      color: '棕色',
      qty: 1,
      note: '直',
      productType: '直边',
      amazonOrderId: 'ORDER-A',
      orderStatus: 'Shipped',
      shipServiceLevel: 'Standard',
      purchaseDate: '2026-04-23T09:10',
    },
    {
      id: 'split-order-2',
      sourceRowId: 'split-order-2',
      size: `4’ X 11’`,
      color: '棕色',
      qty: 1,
      note: '直',
      productType: '直边',
      amazonOrderId: 'ORDER-B',
      orderStatus: 'Shipped',
      shipServiceLevel: 'Standard',
      purchaseDate: '2026-04-23T09:11',
    },
    {
      id: 'merge-order-1',
      sourceRowId: 'merge-order-1',
      size: `5’ X 10’`,
      color: '米色',
      qty: 1,
      note: '直',
      productType: '直边',
      amazonOrderId: 'ORDER-C',
      orderStatus: 'Shipped',
      shipServiceLevel: 'Standard',
      purchaseDate: '2026-04-23T09:12',
    },
    {
      id: 'merge-order-2',
      sourceRowId: 'merge-order-2',
      size: `5’ X 10’`,
      color: '米色',
      qty: 1,
      note: '直',
      productType: '直边',
      amazonOrderId: 'ORDER-C',
      orderStatus: 'Shipped',
      shipServiceLevel: 'Standard',
      purchaseDate: '2026-04-23T09:12',
    },
  ]);
  assert.equal(
    sameShapeDifferentOrdersMakerRows.filter((row) => row.color === '棕色').length,
    2,
    'Different orders with the same size/color should stay as separate maker rows.',
  );
  assert.equal(
    sameShapeDifferentOrdersMakerRows.find((row) => row.color === '米色')?.qty,
    2,
    'The same order with two identical items should still merge into a single =2 maker row.',
  );

  const privacyDailyRows = buildDailyOrderRows(
    [
      {
        ...filteredRows[0]!,
        id: 'privacy-1',
        amazonOrderId: 'PRIVACY-1',
        quantity: 1,
        productName: `Eden's Decor Balcony Privacy Screen Brown 2'6"x 21' Cover Mesh Windscreen`,
        originalProductName: `Eden's Decor Balcony Privacy Screen Brown 2'6"x 21' Cover Mesh Windscreen`,
        sku: 'BalconyFence_Brown2621',
        purchaseDate: '2026-04-23T09:15',
        purchaseDateTime: '2026-04-23T09:15',
        shipServiceLevel: 'FreeEconomy',
      },
    ],
    {},
  );

  assert.equal(
    privacyDailyRows[0]?.items[0]?.size,
    '2’6” X 21’',
    'Mixed feet-inch privacy sizes should be extracted correctly for daily orders.',
  );
  assert.equal(
    privacyDailyRows[0]?.marks,
    '阳',
    'Privacy-screen daily rows should carry the 阳 mark.',
  );

  const dualColorPrivacyDailyRows = buildDailyOrderRows(
    [
      {
        ...filteredRows[0]!,
        id: 'privacy-dual-1',
        amazonOrderId: 'PRIVACY-DUAL-1',
        quantity: 1,
        productName:
          `Eden's Decor Balcony Privacy Screen Brown/Khaki 2'6"x 12' Cover Mesh Windscreen`,
        originalProductName:
          `Eden's Decor Balcony Privacy Screen Brown/Khaki 2'6"x 12' Cover Mesh Windscreen`,
        sku: 'BalconyFence_BROWN/KHAKI2612',
        purchaseDate: '2026-04-23T09:16',
        purchaseDateTime: '2026-04-23T09:16',
        shipServiceLevel: 'FreeEconomy',
      },
    ],
    {},
  );
  const dualColorPrivacyGroups = buildDailyColorGroups(dualColorPrivacyDailyRows);

  assert.equal(
    dualColorPrivacyDailyRows[0]?.color,
    '双色',
    'Daily-order rows should keep Brown/Khaki privacy items in the warehouse dual-color bucket.',
  );
  assert.equal(
    dualColorPrivacyGroups[0]?.color,
    '双色',
    'Daily color grouping should expose Brown/Khaki privacy items under the 双色 color section.',
  );

  const rowToCorrect = filteredRows.find((row) => row.amazonOrderId === 'A-1004');
  assert.ok(rowToCorrect, 'Expected a non-rush sample row for manual correction testing.');

  const correctedMasterRows = buildMasterRows(filteredRows, {
    [rowToCorrect.id]: {
      size: "4’ X 10’",
      rush: true,
    },
  });
  const correctedDailyRows = buildDailyOrderRows(filteredRows, {
    [rowToCorrect.id]: {
      size: "4’ X 10’",
      rush: true,
    },
  });
  const correctedMasterRow = correctedMasterRows.find(
    (row) => row.sourceRowId === rowToCorrect.id,
  );
  const correctedDailyRow = correctedDailyRows.find((row) =>
    row.sourceRowIds.includes(rowToCorrect.id),
  );

  assert.equal(
    correctedMasterRow?.size,
    "4’ X 10’",
    'Manual production size corrections should flow into the master sheet.',
  );
  assert.equal(
    correctedMasterRow?.note,
    '★',
    'Manual rush corrections should update the master-sheet note.',
  );
  assert.equal(
    correctedDailyRow?.items[0]?.size,
    "4’ X 10’",
    'Manual production size corrections should flow into the daily order view.',
  );
  assert.equal(
    correctedDailyRow?.rush,
    true,
    'Manual rush corrections should flow into the daily order view.',
  );

  const dailyColorGroups = buildDailyColorGroups(
    buildDailyOrderRows(
      [
        {
          ...filteredRows[1]!,
          id: 'color-normal-1',
          amazonOrderId: 'COLOR-BROWN-1',
          quantity: 1,
          productName: "Brown Straight Shade 4' x 12'",
          originalProductName: "Brown Straight Shade 4' x 12'",
          shipServiceLevel: 'Standard',
          purchaseDate: '2026-04-23T09:20',
          purchaseDateTime: '2026-04-23T09:20',
        },
        {
          ...filteredRows[1]!,
          id: 'color-yang-1',
          amazonOrderId: 'COLOR-BROWN-2',
          quantity: 1,
          productName: `Brown Privacy Fence Screen 2'6"x 21'`,
          originalProductName: `Brown Privacy Fence Screen 2'6"x 21'`,
          sku: 'BalconyFence_Brown2621',
          shipServiceLevel: 'Standard',
          purchaseDate: '2026-04-23T09:30',
          purchaseDateTime: '2026-04-23T09:30',
        },
      ],
      {},
    ),
  );

  assert.equal(
    dailyColorGroups[0]?.color,
    '棕色',
    'Daily color grouping should keep rows under the parsed color bucket.',
  );
  assert.equal(
    dailyColorGroups[0]?.normalRows.length,
    1,
    'Daily color grouping should keep normal rows in the top section.',
  );
  assert.equal(
    dailyColorGroups[0]?.yangRows.length,
    1,
    'Daily color grouping should move 阳 rows into the bottom section.',
  );
  assert.equal(
    dailyColorGroups[0]?.normalRows[0]?.marks,
    '直',
    'Normal daily color rows should stay separate from 阳 rows even under the same color.',
  );
  assert.equal(
    dailyColorGroups[0]?.yangRows[0]?.marks,
    '阳',
    'Yang daily color rows should stay in the dedicated bottom section.',
  );

  const makerGroups = buildMakerColorGroups(buildMakerRows(masterRows));
  assert.deepEqual(
    new Set(makerGroups.map((group) => group.color)),
    new Set(['棕色', '米色', '绿色', '黑色', '黄色']),
    'Maker groups should keep the expected filtered colors.',
  );
  assert.deepEqual(
    makerGroups.map((group) => group.color).slice(0, 3),
    ['棕色', '米色', '黄色'],
    'Maker print columns should follow the warehouse color order before fallback colors.',
  );

  const compactMarkup = renderToStaticMarkup(
    React.createElement(MakerSheetPrintView, {
      groups: makerGroups,
      dateRangeLabel: '2026-04-23 08:12 至 2026-04-23 08:40',
    }),
  );

  assert.equal(
    countMatches(compactMarkup, /class="maker-print-page"/g),
    1,
    'Five-color compact sample should fit into a single print page.',
  );
  expectIncludes(compactMarkup, '米色');
  expectIncludes(compactMarkup, '棕色');
  expectIncludes(compactMarkup, '绿色');
  expectIncludes(compactMarkup, '绿色（阳）');
  expectIncludes(compactMarkup, '黑色');
  expectIncludes(compactMarkup, '黄色');
  assert.equal(
    compactMarkup.includes('=1'),
    false,
    'Print worksheet should omit quantity labels when the quantity is exactly one.',
  );

  const overflowMasterRows = Array.from({ length: 28 }, (_, index) => ({
    id: `overflow-${index}`,
    sourceRowId: `overflow-${index}`,
    size: `${index + 4}’ X ${index + 9}’`,
    color: '米色',
    qty: 1,
    note: index % 4 === 0 ? '直 ★' : index % 2 === 0 ? '直' : '',
    productType: index % 3 === 0 ? '直边' : '弯边',
    amazonOrderId: `B-${index}`,
    orderStatus: 'Unshipped',
    shipServiceLevel: index % 4 === 0 ? 'Expedited' : 'Standard',
    purchaseDate: `2026-04-23T10:${String(index).padStart(2, '0')}`,
  }));

  const overflowGroups = buildMakerColorGroups(buildMakerRows(overflowMasterRows));
  const overflowMarkup = renderToStaticMarkup(
    React.createElement(MakerSheetPrintView, {
      groups: overflowGroups,
      dateRangeLabel: '2026-04-23 10:00 至 2026-04-23 10:27',
    }),
  );

  expectIncludes(overflowMarkup, '1/2');
  expectIncludes(overflowMarkup, '2/2');
  assert.equal(
    countMatches(overflowMarkup, /class="maker-print-page"/g),
    1,
    'A single overflowing color should spill into spare columns on the same page.',
  );

  const summaryFallbackRows = [
    {
      ...filteredRows[0]!,
      id: 'summary-order-1a',
      amazonOrderId: '111-1111111-1111111',
      quantity: 1,
      productName: "Grey Straight Shade 4' x 6'",
      originalProductName: "Grey Straight Shade 4' x 6'",
      sku: 'GY-ST-4X6',
      purchaseDate: '2026-04-23T09:40',
      purchaseDateTime: '2026-04-23T09:40',
    },
    {
      ...filteredRows[0]!,
      id: 'summary-order-1b',
      amazonOrderId: '111-1111111-1111111',
      quantity: 2,
      productName: "Grey Straight Shade 4' x 9'",
      originalProductName: "Grey Straight Shade 4' x 9'",
      sku: 'GY-ST-4X9',
      purchaseDate: '2026-04-23T09:40',
      purchaseDateTime: '2026-04-23T09:40',
    },
    {
      ...filteredRows[1]!,
      id: 'summary-order-2',
      amazonOrderId: '222-2222222-2222222',
      quantity: 1,
      productName: "Brown Curved Shade 8' x 10'",
      originalProductName: "Brown Curved Shade 8' x 10'",
      sku: 'BR-CV-8X10',
      purchaseDate: '2026-04-23T09:45',
      purchaseDateTime: '2026-04-23T09:45',
    },
  ];
  const summaryFallbackMasterRows = buildMasterRows(summaryFallbackRows, {});
  const summaryFallbackPages: LabelPage[] = [
    {
      id: 'summary-label-1',
      sourceName: 'summary-labels.pdf',
      pageNumber: 1,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'summary-label-2',
      sourceName: 'summary-labels.pdf',
      pageNumber: 2,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'summary-label-3',
      sourceName: 'summary-labels.pdf',
      pageNumber: 3,
      text: 'List of orders with successful label purchase 111-1111111-1111111 222-2222222-2222222',
      normalizedText: '',
      width: 288,
      height: 432,
    },
  ];
  const summaryFallbackMatches = matchLabelPages(
    summaryFallbackPages,
    summaryFallbackRows,
    summaryFallbackMasterRows,
  );

  assert.equal(
    getMatchableLabelPages(summaryFallbackPages).length,
    2,
    'Summary pages should be excluded from the effective label-page count.',
  );
  assert.equal(
    summaryFallbackMatches.length,
    2,
    'Summary pages should not appear as match rows.',
  );
  assert.deepEqual(
    summaryFallbackMatches.map((match) => match.status),
    ['matched', 'matched'],
    'Image-only labels should match via summary-page sequence fallback when the counts line up.',
  );
  assert.deepEqual(
    summaryFallbackMatches[0]?.reasons,
    ['汇总页顺序'],
    'Summary fallback matches should surface the sequence-based reason.',
  );
  assert.equal(
    summaryFallbackMatches[0]?.amazonOrderId,
    '111-1111111-1111111',
    'The first summary order should map to the first label page.',
  );
  assert.equal(
    summaryFallbackMatches[0]?.size,
    '4’ X 6’、4’ X 9’ = 2',
    'Label matching should preserve repeated-size quantities under the same amazon-order-id.',
  );
  assert.deepEqual(
    summaryFallbackMatches[0]?.sizeBreakdown,
    ['4’ X 6’', '4’ X 9’ = 2'],
    'Label matching should expose a line-by-line size breakdown for clearer review.',
  );
  assert.equal(
    summaryFallbackMatches[0]?.qty,
    3,
    'Aggregated label matches should sum quantities across same-order rows.',
  );

  const continuationSummaryPages: LabelPage[] = [
    {
      id: 'continuation-label-1',
      sourceName: 'continuation-summary.pdf',
      pageNumber: 1,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'continuation-label-2',
      sourceName: 'continuation-summary.pdf',
      pageNumber: 2,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'continuation-summary-1',
      sourceName: 'continuation-summary.pdf',
      pageNumber: 3,
      text: 'List of orders with successful label purchase 111-1111111-1111111',
      normalizedText:
        'LIST OF ORDERS WITH SUCCESSFUL LABEL PURCHASE 111 1111111 1111111',
      width: 288,
      height: 432,
    },
    {
      id: 'continuation-summary-2',
      sourceName: 'continuation-summary.pdf',
      pageNumber: 4,
      text: '222-2222222-2222222',
      normalizedText: '222 2222222 2222222',
      width: 288,
      height: 432,
    },
  ];
  const continuationSummaryMatches = matchLabelPages(
    continuationSummaryPages,
    summaryFallbackRows,
    summaryFallbackMasterRows,
  );

  assert.equal(
    getMatchableLabelPages(continuationSummaryPages).length,
    2,
    'Continuation summary pages without the header should still be excluded from matchable label pages.',
  );
  assert.deepEqual(
    continuationSummaryMatches.map((match) => match.amazonOrderId),
    ['111-1111111-1111111', '222-2222222-2222222'],
    'Sequence fallback should read order ids across a summary continuation page.',
  );

  const multiSummaryRows = [
    {
      ...filteredRows[0]!,
      id: 'multi-summary-1',
      amazonOrderId: '333-3333333-3333333',
      quantity: 1,
      productName: "Grey Straight Shade 6' x 8'",
      originalProductName: "Grey Straight Shade 6' x 8'",
      sku: 'GY-ST-6X8',
      purchaseDate: '2026-04-23T09:50',
      purchaseDateTime: '2026-04-23T09:50',
    },
    {
      ...filteredRows[1]!,
      id: 'multi-summary-2',
      amazonOrderId: '444-4444444-4444444',
      quantity: 1,
      productName: "Brown Curved Shade 7' x 10'",
      originalProductName: "Brown Curved Shade 7' x 10'",
      sku: 'BR-CV-7X10',
      purchaseDate: '2026-04-23T09:51',
      purchaseDateTime: '2026-04-23T09:51',
    },
    {
      ...filteredRows[2]!,
      id: 'multi-summary-3',
      amazonOrderId: '555-5555555-5555555',
      quantity: 1,
      productName: "Green Privacy Fence Screen 6' x 12'",
      originalProductName: "Green Privacy Fence Screen 6' x 12'",
      sku: 'GN-PF-6X12',
      purchaseDate: '2026-04-23T09:52',
      purchaseDateTime: '2026-04-23T09:52',
    },
  ];
  const multiSummaryMasterRows = buildMasterRows(multiSummaryRows, {});
  const multiSummaryPages: LabelPage[] = [
    {
      id: 'multi-label-1',
      sourceName: 'multi-summary.pdf',
      pageNumber: 1,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'multi-label-2',
      sourceName: 'multi-summary.pdf',
      pageNumber: 2,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'multi-label-3',
      sourceName: 'multi-summary.pdf',
      pageNumber: 3,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'multi-summary-4',
      sourceName: 'multi-summary.pdf',
      pageNumber: 4,
      text: 'List of orders with successful label purchase 333-3333333-3333333 444-4444444-4444444',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'multi-summary-5',
      sourceName: 'multi-summary.pdf',
      pageNumber: 5,
      text: 'List of orders with successful label purchase 555-5555555-5555555',
      normalizedText: '',
      width: 288,
      height: 432,
    },
  ];
  const multiSummaryMatches = matchLabelPages(
    multiSummaryPages,
    multiSummaryRows,
    multiSummaryMasterRows,
  );

  assert.equal(
    getMatchableLabelPages(multiSummaryPages).length,
    3,
    'Multiple summary pages should still be excluded from the effective label-page count.',
  );
  assert.deepEqual(
    multiSummaryMatches.map((match) => match.amazonOrderId),
    ['333-3333333-3333333', '444-4444444-4444444', '555-5555555-5555555'],
    'Sequence fallback should honor order ids collected across multiple summary pages.',
  );

  const labelPages: LabelPage[] = [
    {
      id: 'label-1',
      sourceName: 'labels.pdf',
      pageNumber: 1,
      text: 'SHIP TO JANE DOE 90210 AMAZON ORDER A-1001',
      normalizedText: 'SHIP TO JANE DOE 90210 AMAZON ORDER A 1001',
      width: 288,
      height: 432,
    },
    {
      id: 'label-2',
      sourceName: 'labels.pdf',
      pageNumber: 2,
      text: 'JOHN BROWN 10011 TRACKING 1Z9999999999999999',
      normalizedText: 'JOHN BROWN 10011 TRACKING 1Z9999999999999999',
      width: 288,
      height: 432,
    },
    {
      id: 'label-3',
      sourceName: 'labels.pdf',
      pageNumber: 3,
      text: 'UNKNOWN LABEL WITHOUT ORDER INFORMATION',
      normalizedText: 'UNKNOWN LABEL WITHOUT ORDER INFORMATION',
      width: 288,
      height: 432,
    },
  ];

  const rowsWithShipping = filteredRows.map((row) => {
    if (row.amazonOrderId === 'A-1001') {
      return {
        ...row,
        original: {
          ...row.original,
          'recipient-name': 'Jane Doe',
          'ship-postal-code': '90210',
        },
      };
    }

    if (row.amazonOrderId === 'A-1002') {
      return {
        ...row,
        original: {
          ...row.original,
          'recipient-name': 'John Brown',
          'ship-postal-code': '10011',
          'tracking-number': '1Z9999999999999999',
        },
      };
    }

    return row;
  });
  const shippingMasterRows = buildMasterRows(rowsWithShipping, {});
  const labelMatches = matchLabelPages(labelPages, rowsWithShipping, shippingMasterRows);

  assert.deepEqual(
    labelMatches.map((match) => match.status),
    ['matched', 'matched', 'unmatched'],
    'Label matching should identify exact order/tracking matches and leave unknown pages unmatched.',
  );
  assert.equal(labelMatches[0]?.amazonOrderId, 'A-1001');
  assert.equal(labelMatches[1]?.amazonOrderId, 'A-1002');

  const labelOrderReviews = buildLabelOrderReviews(
    rowsWithShipping,
    shippingMasterRows,
    labelMatches,
  );
  const reviewA1001 = labelOrderReviews.find((review) => review.amazonOrderId === 'A-1001');

  assert.equal(
    reviewA1001?.recipientName,
    'Jane Doe',
    'Order-level label review should keep recipient names for verification.',
  );
  assert.equal(
    reviewA1001?.status,
    'matched',
    'Order-level label review should reflect the matched label status.',
  );

  const amazonOrderIdMap = new Map<string, string>([
    ['A-1001', '111-0000001-0000001'],
    ['A-1002', '111-0000002-0000002'],
    ['A-1008', '111-0000008-0000008'],
    ['A-1009', '111-0000009-0000009'],
  ]);
  const rowsWithNumericOrders = rowsWithShipping.map((row) => ({
    ...row,
    amazonOrderId: amazonOrderIdMap.get(row.amazonOrderId) ?? row.amazonOrderId,
  }));
  const numericMasterRows = buildMasterRows(rowsWithNumericOrders, {});

  const multiSourceLabelPages: LabelPage[] = [
    {
      id: 'alpha-1',
      sourceName: 'alpha.pdf',
      pageNumber: 1,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'alpha-2',
      sourceName: 'alpha.pdf',
      pageNumber: 2,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'alpha-3',
      sourceName: 'alpha.pdf',
      pageNumber: 3,
      text: 'List of orders with successful label purchase 111-0000001-0000001 111-0000002-0000002',
      normalizedText:
        'LIST OF ORDERS WITH SUCCESSFUL LABEL PURCHASE 111 0000001 0000001 111 0000002 0000002',
      width: 288,
      height: 432,
    },
    {
      id: 'beta-1',
      sourceName: 'beta.pdf',
      pageNumber: 1,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'beta-2',
      sourceName: 'beta.pdf',
      pageNumber: 2,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'beta-3',
      sourceName: 'beta.pdf',
      pageNumber: 3,
      text: 'List of orders with successful label purchase 111-0000008-0000008 111-0000009-0000009',
      normalizedText:
        'LIST OF ORDERS WITH SUCCESSFUL LABEL PURCHASE 111 0000008 0000008 111 0000009 0000009',
      width: 288,
      height: 432,
    },
  ];
  const multiSourceMatches = matchLabelPages(
    multiSourceLabelPages,
    rowsWithNumericOrders,
    numericMasterRows,
  );

  assert.deepEqual(
    multiSourceMatches.map((match) => match.amazonOrderId),
    ['111-0000001-0000001', '111-0000002-0000002', '111-0000008-0000008', '111-0000009-0000009'],
    'Sequence fallback should stay inside each label PDF instead of interleaving pages from different sources.',
  );

  const multiSourceReviews = buildLabelOrderReviews(
    rowsWithNumericOrders,
    numericMasterRows,
    multiSourceMatches,
  );
  const reviewA1008 = multiSourceReviews.find(
    (review) => review.amazonOrderId === '111-0000008-0000008',
  );

  assert.equal(
    reviewA1008?.matchedPages,
    'beta.pdf 第 1 页',
    'Order reviews should include the label source name when multiple PDFs are uploaded together.',
  );

  const partialFallbackLabelPages: LabelPage[] = [
    {
      id: 'partial-1',
      sourceName: 'partial.pdf',
      pageNumber: 1,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'partial-2',
      sourceName: 'partial.pdf',
      pageNumber: 2,
      text: '',
      normalizedText: '',
      width: 288,
      height: 432,
    },
    {
      id: 'partial-3',
      sourceName: 'partial.pdf',
      pageNumber: 3,
      text: 'List of orders with successful label purchase 111-0000001-0000001 111-9999999-9999999',
      normalizedText:
        'LIST OF ORDERS WITH SUCCESSFUL LABEL PURCHASE 111 0000001 0000001 111 9999999 9999999',
      width: 288,
      height: 432,
    },
  ];
  const partialFallbackMatches = matchLabelPages(
    partialFallbackLabelPages,
    rowsWithNumericOrders,
    numericMasterRows,
  );

  assert.deepEqual(
    partialFallbackMatches.map((match) => ({
      status: match.status,
      orderId: match.amazonOrderId,
      reasons: match.reasons,
    })),
    [
      {
        status: 'matched',
        orderId: '111-0000001-0000001',
        reasons: ['汇总页顺序'],
      },
      {
        status: 'unmatched',
        orderId: '111-9999999-9999999',
        reasons: ['汇总页顺序', '订单数据缺失'],
      },
    ],
    'Sequence fallback should still match known pages even if one summary-page order is missing from the uploaded data.',
  );

  const embeddedFontBytes = await readFile('public/fonts/arial-unicode.ttf');
  const backPdfBytes = await buildLabelBackPdf(labelPages, labelMatches, embeddedFontBytes);
  const backPdf = await PDFDocument.load(backPdfBytes);

  assert.equal(backPdf.getPageCount(), 3, 'Back-side PDF should preserve label page order and count.');

  console.log('Smoke test passed.');
  console.log(`Merged rows: ${merged.rows.length}, filtered rows: ${filteredRows.length}.`);
  console.log(`Print pages: compact=${countMatches(compactMarkup, /class="maker-print-page"/g)}, overflow=${countMatches(overflowMarkup, /class="maker-print-page"/g)}.`);
  console.log(`Label matches: ${labelMatches.map((match) => match.status).join(', ')}.`);
}

void main().catch((error: unknown) => {
  console.error('Smoke test failed.');
  console.error(error);
  process.exitCode = 1;
});
