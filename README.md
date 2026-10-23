# Separate test version

This branch (`codex/batch-print-test`) contains the new batch upload, matching and printing workflow. The existing version remains on `main`. Do not merge this branch into `main` until testing is complete.

## Install on another PC

Install Git and Node.js 22.13 or newer (Node.js 24 LTS recommended). Open a terminal in the parent folder where you want a **new** test copy; leave your old app folder alone.

```sh
git clone --branch codex/batch-print-test --single-branch https://github.com/joshuazhangxss/sheet.git sheet-test
cd sheet-test
npm ci
npm run dev:test
```

Open http://127.0.0.1:5183/. Keep the terminal open while using the app. Stop with Ctrl+C. If GitHub asks you to sign in, use your GitHub account with access to this repository.

## Get updates later

Run these commands inside `sheet-test` (stop the running server first):

```sh
git pull --ff-only
npm ci
npm run dev:test
```

## Use the old version

Stop this test server, then start your existing copy from its original folder with its usual command (`npm run dev`). Nothing in the test install changes that folder or the GitHub `main` branch.

The test app uses port **5183**, separate from the old app on **5173**. Browser-saved orders are separate by computer, browser, and port. Git does not transfer uploaded orders or batches; upload your files again on the other PC. Do not change the test app to the old app's port. Generated output, temporary files and browser-test diagnostics are excluded from Git.

---

# Warehouse batch workspace

A browser-based React/TypeScript app for combining seller order exports, shipping-label PDFs, screenshots, and manually entered orders into one reviewed production batch.

## Run locally

```sh
npm install
npm run dev
```

The default screen is the new three-step batch workspace. **高级工作台** opens the existing Amazon/HOMA workspace separately. Existing legacy screens and their behavior are preserved; their in-memory orders are not automatically migrated into the new workspace.

## Daily workflow

1. Drop CSV, TXT, TSV, XLS/XLSX, shipping-label PDFs, and PNG/JPG/WebP/BMP screenshots together. File names and upload order do not control matching. Identical uploaded bytes are detected even when renamed.
2. Review orders. Add small orders manually, or use screenshot OCR as a starting point. A screenshot can contain several items; add each item and then mark the screenshot complete. Unknown table columns can be mapped in the import screen.
3. Review labels and package allocations. Unique, sufficiently long order/tracking identifiers can match automatically. OCR, recipient-name, short-identifier, and PDF-summary-sequence suggestions need confirmation. For multiple packages, allocate each item's quantity to its actual package. Missing/extra quantities, duplicate rows or labels, unreviewed inputs, and missing dimensions/colors block release. Exclude orders or labels that do not belong in the batch.
4. Release the batch, then download the original label pages, the corresponding numbered order list, and the production worksheet. Label PDF page 1 corresponds to order-list sequence 001. Shipping-label dimensions and content are copied without redrawing barcodes. Print labels at actual size (100%).

Published batches are immutable. Use **修改此批次（创建修订）** for corrections; this retains the old snapshot and requires releasing and printing the updated version. History supports selected-label reprints and records PDF generation, not physical print completion. Orders already in another released batch are blocked from accidental repeat production.

## Storage and privacy

Drafts, original files, and release history are saved in IndexedDB in this browser/origin. Reloads recover them. This is local storage, not a server backup or shared multi-user database; clearing site data removes it. Save failures are shown, and release waits for its snapshot to persist. Changing the localhost port creates a different browser storage origin.

OCR runs locally through Tesseract.js. Its worker/core and English recognition model download on first use; customer images are not uploaded for recognition. If OCR cannot run, the image/PDF remains available for manual review. Missing screenshot quantities are left invalid instead of silently assumed to be one.

## Supported inputs and practical limits

- Recognizes common Amazon and HOMA column names, plus generic seller aliases; other tabular schemas require mapping. This is not a guarantee of automatic support for every seller's export.
- HOMA tables without order IDs receive stable internal group IDs. Recipient matching or manual package confirmation is needed when labels do not contain a shared identifier.
- Labels should contain **one shipping label per PDF page**. Multi-label sheets must first be exported as individual-label pages. PDF order-summary pages are omitted using the existing Amazon parser.
- Screenshot OCR prefills identifiers and explicitly labeled fields, along with size/color suggestions. It does not infer every seller's screenshot layout or guarantee OCR correctness. Check every screenshot-derived item.
- The batch workspace and legacy workspace are independent. All new batch outputs use the same released snapshot.
- Real printer calibration, every carrier template, and every seller export still need checks with representative business files. Automated fixtures contain synthetic data only.

## Validation

```sh
npm run build
npm run lint
npm run smoke       # existing Amazon/HOMA behavior
npm run test:batch  # matching, quantities, duplicates, snapshots, imports, PDFs
npx playwright install chromium
npm run test:e2e    # browser workflow, persistence, mobile, real OCR, PDF rendering
```

Browser tests use isolated temporary contexts and synthetic documents. The OCR test needs network access for initial runtime/model downloads. PDF and UI screenshots are written to the ignored `test-results/` directory for visual review.

## Optional real-file acceptance test

Set `REAL_BATCH_FIXTURES` to the local directory containing `eden.pdf`, `eden.txt`, `eden2.pdf`, `eden2.txt`, `enos.pdf`, `enos.txt`, `huam.txt`, and `huram.pdf`, then run `npm run test:real`. Without this variable, the real-file test is skipped. Customer files are not committed.

This test renames and shuffles all eight uploads, independently reads the PDFs' successful-purchase lists, verifies 68 shipments / 71 item rows / 82 units, verifies automatic ignoring of 210 unrelated report rows and explicit batch review, generates all three PDFs, and compares three exported label images pixel-for-pixel with their original pages. Test confirmations occur only in an isolated browser context; they do not approve production in the user's browser. Generated diagnostics and PDFs stay in ignored `test-results/`.

The matching screen supports explicit per-PDF sequence confirmation where every proposed order agrees with that PDF's complete successful-purchase sequence. Cancelled, pending, and Amazon-fulfilled orders remain outside the bulk ordinary-status confirmation.

Batches are now label-driven by default: only whole orders associated with uploaded labels contribute to metrics, validation, release snapshots, or print documents. Unrelated report rows remain available under “查看全部导入数据” and automatically become eligible if their labels arrive later; no bulk-exclusion step is needed. Unmatched uploaded labels still require matching or explicit exclusion.

The main navigation is Upload → Check matches → Print. Item editing is a secondary action; batch management, legacy tools, detailed issue lists, and individual labels are collapsed until needed.

Current simplified flow: Upload → Print. Unique order/tracking identifiers and complete per-PDF success-summary order mappings pass automatically, including OCR-derived identifiers; conflicting identifiers and ambiguous/multiple-package allocations still require resolution. Shipment statuses no longer require operator approval. The first print action saves the immutable batch automatically. Label-order lists show merchant (or explicitly labeled product brand fallback), color, dimensions, quantity, and a short rush marker; long product titles and recipient/tracking details are omitted.

### Production worksheet printing

The batch print center's production worksheet uses landscape US Letter pages, with compact 16-point dimensions grouped into color columns, following the supplied `sheet.pdf` reference. Privacy fence products have separate `（阳）` columns. Identical size/production-note rows are summed across matched label allocations; quantities greater than one appear as `=2`, while single units omit the quantity. Straight-edge, grommet, custom notes and rush markers remain visible. Rows fit on one line by adjusting their font from 16 down to 11 points when needed. Unusually long notes may wrap; overflowing columns continue onto additional pages. There is no footer; the available space is reserved for production details. The supplied 82-unit batch is checked to fit on one page. Order details remain in the label comparison view.

Worksheet updates: the heading contains only the batch date. Orders containing different sizes or colors retain separate production rows prefixed with circled letters `ⓐ`, `ⓑ`, …; matching markers identify items to keep together. Grouping uses seller and order ID, never recipient name alone. Simplified Chinese uses Noto Sans CJK SC (OFL license included), and dimensions/quantities use Arial Bold. The Chinese font uses a static regular-weight TrueType instance embedded whole for reliable printing.

Privacy/balcony net color groups are stacked into at most two columns to free width for the other products. The print tab includes a production worksheet preview generated by the same PDF function as the download, without recording preview as a download.

### HOMA and quick manual entry

HOMA sheets with `No.`, `Customer Name`, `SKU`, `Description`, `Product Size`, `Quantity`, and `订单号` import directly. A continuation row with blank number/name/order ID inherits the preceding order within that sheet; a new numbered row never inherits a missing ID. Chinese descriptions supply colors. Scanned labels use OCR and the PDF's successful-order summary when available; no filename pairing is required.

Choose **手动添加订单**, then paste text or an image into **粘贴订单文字或截图**. Text uses **识别并填入**; clipboard images run English/Simplified Chinese OCR automatically (first use requires downloading models). Check/edit the populated fields and save to match uploaded labels. Enter one product at a time; use the same order ID for another item from that order. Missing quantities are not guessed. Multiple detected orders or explicitly listed products ask you to split the input rather than silently dropping items.

Local HOMA fixture tests: set `HOMA_FIXTURES` to the directory containing the supplied HOMA spreadsheet and PDF. These customer files are not stored in Git.
