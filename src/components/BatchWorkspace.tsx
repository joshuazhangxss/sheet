import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { batchProblems, displayMerchant, labelOrderLines, emptyBatch, emptyLine, fingerprint, lineProblems, loadDraft, orderKey, releaseBatch, reviseBatch, saveDraft, suggestShipments } from '../lib/batchWorkflow';
import type { Asset, BatchDraft, OrderLine, Shipment } from '../lib/batchWorkflow';
import { detectMapping, importFields, readTables, screenshotPrefill, tableCanImport, tableToLines } from '../lib/batchImport';
import type { ImportField } from '../lib/batchImport';
import './BatchWorkspace.css';

function AssetPreview({ asset, page = 1 }: { asset?: Asset; page?: number }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!asset) return;
    const next = URL.createObjectURL(asset.file);
    if (imageRef.current) imageRef.current.src = next;
    if (frameRef.current) frameRef.current.src = `${next}#page=${page}&toolbar=1`;
    return () => URL.revokeObjectURL(next);
  }, [asset, page]);
  if (!asset) return <p>原文件不可用</p>;
  return asset.file.type.startsWith('image/') ? <img className="bw-image" ref={imageRef} alt={asset.name} />
    : <iframe className="bw-pdf" title={`标签预览 ${asset.name}`} ref={frameRef} />;
}

function OrderEditor({ initial, onSave, onCancel }: { initial: OrderLine; onSave: (line: OrderLine) => void; onCancel: () => void }) {
  const [line, setLine] = useState(initial);
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = { ...line, reviewed: true };
    const issues = lineProblems(next);
    if (issues.length) { setError(issues.join('；')); return; }
    onSave(next);
  }
  const [error, setError] = useState('');
  return <form className="bw-editor" onSubmit={submit}>
    <h3>{initial.source === '手动录入' ? '添加 / 修改订单商品' : '核对订单商品'}</h3>
    <p>一个表单是一件商品。同一订单的其他尺寸可继续添加，并使用相同账号与订单号。</p>
    <div className="bw-form-grid">{(Object.keys(importFields) as ImportField[]).map(key => <label key={key}>
      {importFields[key]} {['orderId', 'product', 'size', 'color', 'qty'].includes(key) ? '*' : ''}
      <input name={key} value={line[key]} type={key === 'qty' ? 'number' : 'text'} min={key === 'qty' ? 1 : undefined} step={key === 'qty' ? 1 : undefined}
        required={['orderId', 'product', 'size', 'color', 'qty'].includes(key)}
        onChange={e => setLine({ ...line, [key]: key === 'qty' ? Number(e.target.value) : e.target.value })} />
    </label>)}</div>
    {(line.status || line.fulfillment || line.itemStatus) && <p>订单状态：{line.status || '未提供'} · 商品状态：{line.itemStatus || '未提供'} · 配送：{line.fulfillment || '未提供'}。保存表示已核对该订单可以生产。</p>}
    {error && <p role="alert" className="bw-error">{error}</p>}
    <div className="bw-actions"><button className="bw-primary" type="submit">确认并保存商品</button><button type="button" onClick={onCancel}>取消</button></div>
  </form>;
}

function ShipmentEditor({ shipment, lines, onSave }: { shipment: Shipment; lines: OrderLine[]; onSave: (allocations: Shipment['allocations']) => void }) {
  const groups = new Map<string, OrderLine[]>();
  lines.filter(l => !l.excluded).forEach(l => groups.set(orderKey(l), [...(groups.get(orderKey(l)) ?? []), l]));
  const initialLine = lines.find(l => l.id === shipment.allocations[0]?.lineId);
  const [selected, setSelected] = useState(initialLine ? orderKey(initialLine) : '');
  const [amounts, setAmounts] = useState<Record<string, number>>(Object.fromEntries(shipment.allocations.map(a => [a.lineId, a.qty])));
  const selectedLines = groups.get(selected) ?? [];
  const allocations = selectedLines.map(l => ({ lineId: l.id, qty: amounts[l.id] ?? l.qty })).filter(a => a.qty > 0);
  return <div className="bw-editor">
    <label>选择这个包裹对应的订单<select aria-label="选择包裹订单" value={selected} onChange={e => { setSelected(e.target.value); setAmounts({}); }}>
      <option value="">请选择订单</option>{[...groups].map(([key, group]) => <option key={key} value={key}>{group[0].seller} · {group[0].orderId} · {group[0].recipient}</option>)}
    </select></label>
    <p>多包裹订单：填写本标签包裹内的商品数量。不在此包裹的商品填 0。</p>
    {selectedLines.map(line => <label key={line.id}>{line.product} · {line.color} · {line.size}（订单共 {line.qty}）
      <input aria-label={`包裹数量 ${line.id}`} type="number" min="0" max={line.qty} step="1" value={amounts[line.id] ?? line.qty} onChange={e => setAmounts({ ...amounts, [line.id]: Number(e.target.value) })} />
    </label>)}
    <button className="bw-primary" disabled={!allocations.length || allocations.some(a => !Number.isSafeInteger(a.qty) || a.qty > (lines.find(l => l.id === a.lineId)?.qty ?? 0))}
      onClick={() => onSave(allocations)}>确认这个标签和包裹内容</button>
  </div>;
}

export function BatchWorkspace({ onAdvanced }: { onAdvanced: () => void }) {
  const [draft, setDraft] = useState<BatchDraft>(emptyBatch);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [saveStatus, setSaveStatus] = useState('正在恢复草稿…');
  const [savedDraft, setSavedDraft] = useState<BatchDraft | null>(null);
  const [failedDraft, setFailedDraft] = useState<BatchDraft | null>(null);
  const [step, setStep] = useState(0);
  const [editor, setEditor] = useState<OrderLine | null>(null);
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [worksheetPreview, setWorksheetPreview] = useState<{ batchId: string; asset: Asset } | null>(null);
  const [selectedPrint, setSelectedPrint] = useState<number[]>([]);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [showAllOrders, setShowAllOrders] = useState(false);
  const [undo, setUndo] = useState<BatchDraft | null>(null);
  const [loadError, setLoadError] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const displayedSaveStatus = ready && savedDraft !== draft && failedDraft !== draft ? '保存中…' : saveStatus;
  useEffect(() => {
    let active = true;
    loadDraft().then(value => { if (active) { if (value?.version === 1) setDraft(value); setReady(true); } })
      .catch(() => { if (active) { setSaveStatus('草稿读取失败，请刷新重试，以免覆盖已有批次。'); setLoadError(true); } });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setSaveStatus('保存中…');
      saveDraft(draft).then(() => { if (active) { setSavedDraft(draft); setSaveStatus('已保存到此浏览器'); } })
        .catch(() => { if (active) { setFailedDraft(draft); setSaveStatus('保存失败：请检查浏览器空间，离开前重试保存。'); } });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [draft, ready]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (busy || displayedSaveStatus !== '已保存到此浏览器') event.preventDefault();
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [busy, displayedSaveStatus]);
  const shipments = suggestShipments(draft.lines, draft.labels, draft.assignments);
  const issues = batchProblems(draft, shipments);
  const activeLines = labelOrderLines(draft.lines, shipments);
  const released = draft.history.find(b => b.id === (historyId ?? draft.releasedId));
  const frozen = Boolean(draft.releasedId);
  const activeIds = new Set(activeLines.map(l => l.id));
  const outsideCount = draft.lines.filter(l => !l.excluded && !activeIds.has(l.id)).length;
  const chosenShipment = shipments.find(s => s.label.id === selectedLabel);
  const screenshot = draft.screenshots.find(s => s.id === selectedScreenshot);
  function change(next: BatchDraft) { setUndo(draft); setDraft(next); }
  function saveLine(line: OrderLine) {
    const exists = draft.lines.some(l => l.id === line.id);
    change({ ...draft, assignments: {}, lines: exists ? draft.lines.map(l => l.id === line.id ? line : l) : [...draft.lines, line],
      screenshots: draft.screenshots.map(s => s.id === selectedScreenshot ? { ...s, lineIds: [...new Set([...(s.lineIds ?? []), line.id])] } : s),
    });
    setEditor(null); setMessage('订单已保存，标签已重新匹配。');
  }
  function removeFile(assetId: string) {
    const screenshotLines = new Set(draft.screenshots.filter(s => s.assetId === assetId).flatMap(s => s.lineIds ?? []));
    change({ ...draft, lines: draft.lines.filter(l => !l.id.startsWith(assetId) && !screenshotLines.has(l.id)),
      labels: draft.labels.filter(l => l.assetId !== assetId), pending: draft.pending.filter(t => !t.id.startsWith(assetId)),
      screenshots: draft.screenshots.filter(s => s.assetId !== assetId), assignments: {},
    });
    setSelectedLabel(null); setSelectedScreenshot(null); setEditor(null);
  }
  async function intake(files: File[]) {
    if (!files.length || importing.current || frozen) return;
    importing.current = true;
    setBusy('正在识别文件…');
    const next = structuredClone(draft);
    const errors: string[] = [];
    let imported = 0;
    try {
      for (const file of files) {
        setBusy(`正在处理 ${file.name}…`);
        try {
          const id = await fingerprint(file);
          // Same bytes are duplicates even when renamed. Historical assets may be reused in a new draft.
          if (next.labels.some(l => l.assetId === id) || next.lines.some(l => l.id.startsWith(id)) || next.pending.some(t => t.id.startsWith(id)) || next.screenshots.some(s => s.assetId === id)) {
            errors.push(`${file.name}: 相同内容已导入，已跳过`); continue;
          }
          if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
            const { parseLabelPdf } = await import('../lib/labelPdf');
            const { getMatchableLabelPages } = await import('../lib/labelMatching');
            const parsed = await parseLabelPdf(file);
            let recognizedPages = parsed.pages;
            if (getMatchableLabelPages(parsed.pages).some(p => p.text.trim().length < 30)) {
              try {
                const { recognizeLabelPages } = await import('../lib/batchOcr');
                recognizedPages = await recognizeLabelPages(file, parsed.pages, setBusy);
              } catch { errors.push(`${file.name}: 扫描标签识别未完成，请在匹配页核对原件并手动分配。`); }
            }
            const allPages = recognizedPages.map(p => ({ ...p, id: `${id}:${p.pageNumber}`, sourceName: `${file.name} [${id.slice(0, 6)}]` }));
            const pages = getMatchableLabelPages(allPages);
            if (!pages.length) throw new Error('没有可用运输标签页');
            const nonLabels = allPages.filter(p => !pages.some(label => label.id === p.id));
            const sequenceIds = [...new Set(nonLabels.flatMap(p => p.text.split(/list of orders with (?:an )?errors? in label purchase/i)[0].match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []))];
            next.labels.push(...pages.map((p, index) => ({ ...p, assetId: id, excluded: false, ocr: parsed.pages.find(original => original.pageNumber === p.pageNumber)?.text !== p.text, sequenceOrderId: sequenceIds.length === pages.length ? sequenceIds[index] : undefined })));
            next.warnings.push(...parsed.warnings);
            if (!next.assets.some(a => a.id === id)) next.assets.push({ id, name: file.name, file });
          } else if (/\.(png|jpe?g|webp|bmp)$/i.test(file.name) || file.type.startsWith('image/')) {
            if (!next.assets.some(a => a.id === id)) next.assets.push({ id, name: file.name, file });
            let text = '';
            try {
              setBusy(`截图文字识别 ${file.name}（首次需下载识别模型）…`);
              const { createWorker } = await import('tesseract.js');
              const worker = await createWorker('eng');
              try { text = (await worker.recognize(file)).data.text; } finally { await worker.terminate(); }
            } catch { errors.push(`${file.name}: OCR 未完成。截图已保留，可对照图片手动录入。`); }
            next.screenshots.push({ id, assetId: id, text, reviewed: false });
          } else if (/\.(csv|txt|tsv|xlsx|xls)$/i.test(file.name)) {
            const tables = await readTables(file, id);
            if (!tables.length) throw new Error('没有找到数据行');
            for (const table of tables) {
              if (tableCanImport(table)) next.lines.push(...tableToLines(table));
              else next.pending.push(table);
            }
            if (!next.assets.some(a => a.id === id)) next.assets.push({ id, name: file.name, file });
          } else throw new Error('暂不支持此格式，请使用 CSV / TXT / Excel / PDF / 图片');
          imported++;
        } catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      next.warnings.push(...errors);
      change(next);
      setMessage(`已处理 ${imported} 个文件。${errors.length ? `${errors.length} 条提示，请查看导入记录。` : '订单和标签已自动匹配。'}`);
    } finally { importing.current = false; setBusy(''); }
  }
  async function release() {
    setBusy('正在保存发布批次…');
    try {
      const batch = releaseBatch(draft);
      const next = { ...draft, releasedId: batch.id, history: [...draft.history, batch] };
      await saveDraft(next);
      setDraft(next); setUndo(null); setHistoryId(null); setSelectedPrint([]); setStep(3);
      setMessage('批次已锁定。所有打印文件使用同一批数据与顺序。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  }
  async function exportPdf(kind: 'labels' | 'list' | 'worksheet' | 'selected', preview = false) {
    if (!released) return;
    setBusy('正在生成打印 PDF…');
    try {
      const { batchDocumentPdf, orderedLabelsPdf } = await import('../lib/batchPdf');
      const bytes = kind === 'labels' || kind === 'selected'
        ? await orderedLabelsPdf(released, draft.assets, kind === 'selected' ? selectedPrint : undefined)
        : await batchDocumentPdf(released, kind);
      if (preview) {
        setWorksheetPreview({ batchId: released.id, asset: { id: released.id, name: '生产工作单', file: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }) } });
        setMessage('工作单预览与打印 PDF 使用相同版式。');
        return;
      }
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${released.id.slice(0, 8)}-${kind}${kind === 'selected' ? `-${selectedPrint.map(i => i + 1).join('_')}` : ''}.pdf`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDraft(current => ({ ...current, history: current.history.map(b => b.id === released.id ? { ...b, downloads: [...b.downloads, { at: new Date().toISOString(), kind: kind === 'selected' ? `补打 ${selectedPrint.map(i => i + 1).join(', ')}` : kind }] } : b) }));
      setMessage('PDF 已生成。打开文件后打印；运输标签请选择实际尺寸 100%。下载记录不代表已完成实体打印。');
    } catch (error) { setMessage(`生成失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(''); }
  }
  if (!ready) return <main className="bw"><h1>仓库批次工作台</h1><p role="status">{displayedSaveStatus}</p>{loadError && <button onClick={() => window.location.reload()}>重新读取草稿</button>}</main>;
  return <main className="bw">
    <div className="bw-save"><span>{displayedSaveStatus} · 批次 {draft.id.slice(0, 8)} {frozen ? '· 已锁定' : '· 草稿'}</span>
      <details className="bw-more"><summary>管理</summary><div className="bw-actions"><button onClick={onAdvanced} disabled={Boolean(busy)}>高级工作台</button><button disabled={Boolean(busy)} onClick={() => { void saveDraft(draft).then(() => { setSavedDraft(draft); setSaveStatus('已保存到此浏览器'); }).catch(() => { setFailedDraft(draft); setSaveStatus('保存失败，请检查浏览器存储空间'); }); }}>立即保存</button>
      <button disabled={Boolean(busy) || frozen} onClick={() => { change({ ...emptyBatch(), assets: draft.assets, history: draft.history }); setEditor(null); setSelectedScreenshot(null); setSelectedLabel(null); setStep(0); setMessage('已清空草稿，可以撤销。历史批次仍保留。'); }}>清空草稿</button>
      <button disabled={!undo || Boolean(busy) || frozen} onClick={() => { if (undo) { setDraft(undo); setUndo(null); setEditor(null); } }}>撤销上一步</button>
      <button disabled={Boolean(busy) || (!frozen && (draft.lines.length > 0 || draft.labels.length > 0 || draft.pending.length > 0 || draft.screenshots.length > 0))} onClick={() => { setDraft({ ...emptyBatch(), assets: draft.assets, history: draft.history }); setUndo(null); setHistoryId(null); setSelectedPrint([]); setStep(0); }}>新建批次</button></div></details>
    </div>
    <nav className="bw-steps" aria-label="批次步骤">{[{ label: '上传文件', value: 0 }, { label: '打印', value: 3 }].map(({ label, value }, index) => <button aria-current={(step === 1 ? 2 : step) === value ? 'step' : undefined} className={(step === 1 ? 2 : step) === value ? 'active' : ''} key={label} onClick={() => { if (value === 3 && !frozen && !historyId) { if (issues.length) setStep(2); else void release(); } else setStep(value); }}><span>{index + 1}</span>{label}</button>)}</nav>
    <div className="bw-shortcuts"><button onClick={() => setStep(1)}>查看 / 修改订单</button></div>
    <div className="bw-metrics"><div><strong>{new Set(activeLines.map(orderKey)).size}</strong><span>订单</span></div><div><strong>{activeLines.reduce((n, l) => n + l.qty, 0)}</strong><span>商品数量</span></div><div><strong>{shipments.length}</strong><span>运输标签</span></div></div>
    {(busy || message) && <p className="bw-message" role="status">{busy || message}</p>}
    <fieldset className="bw-content" disabled={Boolean(busy)}>
    {step === 0 && <>
      <section className="bw-card"><h2>上传文件</h2>
        <div className="bw-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) void intake(Array.from(e.dataTransfer.files)); }}>
          <strong>拖入订单、标签或截图</strong><p>支持表格、PDF 和图片，无需改名或排序</p>
          <button className="bw-primary" disabled={frozen} onClick={() => fileInput.current?.click()}>选择文件，可多选</button>
          <input ref={fileInput} type="file" multiple accept=".csv,.txt,.tsv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp,.bmp" hidden onChange={e => { void intake(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </div>
        <div className="bw-actions"><button disabled={frozen} onClick={() => { setEditor(emptyLine()); setStep(1); }}>＋ 手动添加订单</button><button className="bw-primary" disabled={!shipments.length} onClick={() => { if (issues.length) setStep(2); else void release(); }}>查看结果并打印 →</button></div>
      </section>
      {draft.assets.some(asset => draft.lines.some(l => l.id.startsWith(asset.id)) || draft.labels.some(l => l.assetId === asset.id) || draft.pending.some(t => t.id.startsWith(asset.id)) || draft.screenshots.some(s => s.assetId === asset.id)) && <section className="bw-card"><h3>本批文件</h3>{draft.assets.filter(asset => draft.lines.some(l => l.id.startsWith(asset.id)) || draft.labels.some(l => l.assetId === asset.id) || draft.pending.some(t => t.id.startsWith(asset.id)) || draft.screenshots.some(s => s.assetId === asset.id)).map(asset => <div className="bw-file" key={asset.id}><div><strong>{asset.name}</strong><small>{draft.lines.filter(l => l.id.startsWith(asset.id)).length} 个商品行 · {draft.labels.filter(l => l.assetId === asset.id).length} 个标签页 · {(asset.file.size / 1024).toFixed(0)} KB</small></div><button disabled={frozen} onClick={() => removeFile(asset.id)}>移除此文件</button></div>)}</section>}
      {draft.pending.map(table => <section className="bw-card" key={table.id}><h3>识别表格字段：{table.name}</h3><p>{table.records.length} 行。选择每个字段对应的列；不会猜测未知格式。</p>
        <div className="bw-form-grid">{(Object.keys(importFields) as ImportField[]).map(key => <label key={key}>{importFields[key]}<select aria-label={`映射 ${importFields[key]}`} disabled={frozen} value={table.mapping[key] ?? ''} onChange={e => change({ ...draft, pending: draft.pending.map(t => t.id === table.id ? { ...t, mapping: { ...t.mapping, [key]: e.target.value } } : t) })}><option value="">不使用</option>{Object.keys(table.records[0] ?? {}).map(h => <option key={h}>{h}</option>)}</select></label>)}</div>
        <details><summary>预览前 3 行</summary><pre>{JSON.stringify(table.records.slice(0, 3), null, 2)}</pre></details>
        <div className="bw-actions"><button disabled={frozen || !table.mapping.product || !table.mapping.qty || !table.mapping.orderId} onClick={() => change({ ...draft, lines: [...draft.lines, ...tableToLines(table)], pending: draft.pending.filter(t => t.id !== table.id) })}>应用映射并导入</button><button disabled={frozen} onClick={() => change({ ...draft, pending: draft.pending.filter(t => t.id !== table.id) })}>排除此表格</button><button disabled={frozen} onClick={() => change({ ...draft, pending: draft.pending.map(t => t.id === table.id ? { ...t, mapping: detectMapping(Object.keys(t.records[0])) } : t) })}>重置映射</button></div>
      </section>)}
      {draft.screenshots.length > 0 && <section className="bw-card"><h3>截图录入</h3>{draft.screenshots.map(s => <div className="bw-file" key={s.id}><span>{draft.assets.find(a => a.id === s.assetId)?.name} · {s.reviewed ? '已处理' : '需核对录入'}</span><button disabled={frozen} onClick={() => { setSelectedScreenshot(s.id); setEditor({ ...emptyLine(), ...screenshotPrefill(s.text) }); setStep(1); }}>查看并录入</button></div>)}</section>}
      {draft.warnings.length > 0 && <section className="bw-card"><details open><summary>导入记录与提示（{draft.warnings.length}）</summary><ul>{draft.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details></section>}
    </>}
    {step === 1 && <>
      {screenshot && <section className="bw-card bw-preview-grid"><AssetPreview asset={draft.assets.find(a => a.id === screenshot.assetId)} /><div><h3>对照截图，确认每件商品</h3><pre>{screenshot.text || '未识别到文字，可对照图片录入。'}</pre><p>多件商品需分别添加。全部录入后再标记截图完成。</p><div className="bw-actions"><button disabled={frozen} onClick={() => setEditor({ ...emptyLine(), ...screenshotPrefill(screenshot.text) })}>继续添加截图商品</button><button disabled={frozen || !screenshot.lineIds?.length} onClick={() => { change({ ...draft, screenshots: draft.screenshots.map(s => s.id === screenshot.id ? { ...s, reviewed: true } : s) }); setSelectedScreenshot(null); setEditor(null); }}>完成截图录入</button><button disabled={frozen} onClick={() => { change({ ...draft, screenshots: draft.screenshots.map(s => s.id === screenshot.id ? { ...s, reviewed: true } : s) }); setSelectedScreenshot(null); setEditor(null); }}>排除此截图</button></div></div></section>}
      {editor && !frozen && <OrderEditor key={editor.id} initial={editor} onSave={saveLine} onCancel={() => setEditor(null)} />}
      <section className="bw-card"><div className="bw-section-head"><div><h2>订单商品</h2><p>缺少信息或重复的行需要修正。排除的订单不会进入本批生产单。</p></div><button disabled={frozen} onClick={() => setEditor(emptyLine())}>＋ 添加商品</button></div>
        <label className="bw-checkbox"><input type="checkbox" checked={onlyIssues} onChange={e => setOnlyIssues(e.target.checked)} />仅显示待核对商品</label><label className="bw-checkbox"><input type="checkbox" checked={showAllOrders} onChange={e => setShowAllOrders(e.target.checked)} />查看全部导入数据（含无标签订单）</label>
        <div className="bw-table-wrap"><table><thead><tr><th>账号 / 订单</th><th>产品 / 颜色 / 尺寸</th><th>数量</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {draft.lines.filter(l => (showAllOrders || activeIds.has(l.id)) && (!onlyIssues || (activeIds.has(l.id) && lineProblems(l).length))).map(line => <tr className={line.excluded ? 'excluded' : ''} key={line.id}><td>{line.seller || '未指定账号'}<br /><strong>{line.orderId || '缺少订单号'}</strong><small>{line.recipient}<br />{line.source}</small></td><td>{line.product}<br />{line.color || '缺少颜色'} · {line.size || '缺少尺寸'}<small>{line.note}</small></td><td>{line.qty}</td><td>{line.excluded ? '已排除' : !activeIds.has(line.id) ? '无对应标签 · 已忽略' : lineProblems(line).join('；') || '可匹配'}</td><td><div className="bw-actions"><button disabled={frozen} onClick={() => setEditor(line)}>编辑</button><button disabled={frozen} onClick={() => change({ ...draft, assignments: {}, lines: draft.lines.map(l => l.id === line.id ? { ...l, excluded: !l.excluded } : l) })}>{line.excluded ? '恢复' : '排除'}</button></div></td></tr>)}
          {!activeLines.length && !showAllOrders && <tr><td colSpan={5}>暂无标签对应订单。上传标签或补充订单数据后自动匹配；可勾选查看全部导入数据。</td></tr>}
        </tbody></table></div><div className="bw-actions"><button onClick={() => setStep(0)}>← 继续导入</button><button className="bw-primary" onClick={() => setStep(2)}>核对标签匹配 →</button></div>
      </section>
    </>}
    {step === 2 && <>
      <section className="bw-card"><div className="bw-section-head"><div><h2>需要补充的信息</h2><p>正常匹配的订单无需核对，只处理以下异常。</p></div><button disabled={frozen || issues.length > 0} className="bw-primary" onClick={() => void release()}>继续打印</button></div>
        {!frozen && outsideCount > 0 && <p className="bw-muted">已自动忽略 {outsideCount} 个无对应标签的商品行，不计入本批数量、问题或工作单。</p>}
        {!frozen && issues.length > 0 && <details className="bw-issues"><summary>查看待处理详情（{issues.length}）</summary><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul><div className="bw-actions"><button onClick={() => setStep(1)}>核对订单</button><button onClick={() => setStep(0)}>导入缺少的文件</button></div></details>}
        <details className="bw-label-details"><summary>逐个查看标签（{draft.labels.length}）</summary>{draft.labels.map(label => { const match = shipments.find(s => s.label.id === label.id); return <div className="bw-file" key={label.id}><div><strong>{label.sourceName} · 第 {label.pageNumber} 页</strong><small>{label.excluded ? '已排除' : match?.reason} {match?.allocations.map(a => draft.lines.find(l => l.id === a.lineId)?.orderId).filter((v, i, arr) => arr.indexOf(v) === i).join(', ')}</small></div><div className="bw-actions"><button disabled={label.excluded || frozen} onClick={() => setSelectedLabel(label.id)}>查看 / 分配</button><button disabled={frozen} onClick={() => { change({ ...draft, labels: draft.labels.map(l => l.id === label.id ? { ...l, excluded: !l.excluded } : l) }); setSelectedLabel(null); }}>{label.excluded ? '恢复' : '排除标签'}</button></div></div>; })}</details>
      </section>
      {chosenShipment && !frozen && <section className="bw-card bw-preview-grid"><AssetPreview asset={draft.assets.find(a => a.id === chosenShipment.label.assetId)} page={chosenShipment.label.pageNumber} /><div><h3>核对标签原件</h3><p>{chosenShipment.reason}</p><ShipmentEditor key={`${chosenShipment.label.id}:${JSON.stringify(chosenShipment.allocations)}`} shipment={chosenShipment} lines={draft.lines} onSave={allocations => { change({ ...draft, assignments: { ...draft.assignments, [chosenShipment.label.id]: { allocations, confirmed: true } } }); setSelectedLabel(null); }} /></div></section>}
    </>}
    {step === 3 && <section className="bw-card"><div className="bw-section-head"><div><h2>打印中心</h2></div><select aria-label="选择历史批次" value={historyId ?? draft.releasedId ?? ''} onChange={e => { setHistoryId(e.target.value); setSelectedPrint([]); }}><option value="">选择已发布批次</option>{draft.history.map(b => <option key={b.id} value={b.id}>{b.id.slice(0, 8)} · {new Date(b.createdAt).toLocaleString()}</option>)}</select></div>
      {released ? <><p>批次 {released.id.slice(0, 8)} · {released.shipments.length} 个包裹 · 数据已锁定{released.revises ? ` · 修订自 ${released.revises.slice(0, 8)}` : ''}</p>{draft.history.some(b => b.revises === released.id) && <p className="bw-error">此批次已有更新版本，请选择最新批次打印。</p>}<div className="bw-actions"><button className="bw-primary" onClick={() => void exportPdf('labels')}>打印全部标签 PDF</button><button onClick={() => void exportPdf('list')}>2. 打印顺序对照单</button><button onClick={() => void exportPdf('worksheet')}>3. 打印生产工作单</button><button disabled={Boolean(busy)} onClick={() => void exportPdf('worksheet', true)}>预览生产工作单</button></div>
        {worksheetPreview?.batchId === released.id && <section className="bw-card" aria-label="生产工作单预览"><div className="bw-actions"><h3>生产工作单预览</h3><button onClick={() => setWorksheetPreview(null)}>关闭预览</button><button onClick={() => void exportPdf('worksheet')}>下载打印 PDF</button></div><AssetPreview asset={worksheetPreview.asset} /></section>}
        <div className="bw-table-wrap"><table><thead><tr><th>补打</th><th>序号</th><th>商家 / 品牌</th><th>标签背面：颜色 · 尺寸 · 数量</th><th>订单号</th></tr></thead><tbody>{released.shipments.map((s, index) => <tr key={s.label.id}><td><input aria-label={`选择补打 ${index + 1}`} type="checkbox" checked={selectedPrint.includes(index)} onChange={e => setSelectedPrint(e.target.checked ? [...selectedPrint, index].sort((a, b) => a - b) : selectedPrint.filter(i => i !== index))} /></td><td>{String(index + 1).padStart(3, '0')}</td><td>{displayMerchant(released.lines.find(l => l.id === s.allocations[0].lineId)!)}</td><td>{s.allocations.map(a => { const l = released.lines.find(line => line.id === a.lineId)!; return <div key={a.lineId}>{l.color} · {l.size} · ×{a.qty}{l.note.includes('★') ? ' · 加急' : ''}</div>; })}</td><td>{released.lines.find(l => l.id === s.allocations[0].lineId)?.orderId}</td></tr>)}</tbody></table></div>
        <button disabled={!selectedPrint.length} onClick={() => void exportPdf('selected')}>只补打选中的标签（{selectedPrint.length}）</button><div className="bw-actions"><button disabled={(!frozen && (draft.lines.length > 0 || draft.labels.length > 0 || draft.pending.length > 0 || draft.screenshots.some(s => !s.reviewed))) || draft.history.some(b => b.revises === released.id)} onClick={() => { try { setDraft(reviseBatch(draft, released)); setUndo(null); setHistoryId(null); setStep(1); setMessage('已创建修订草稿。修改后重新发布，并重新打印受影响的文件；旧版仍保留在历史记录。'); } catch (error) { setMessage(String(error)); } }}>修改此批次（创建修订）</button></div><details><summary>文件生成记录（不代表实体打印完成）</summary><ul>{released.downloads.map((d, i) => <li key={i}>{new Date(d.at).toLocaleString()} · {d.kind}</li>)}</ul></details>
      </> : <p>上传订单和标签后，点击“打印”即可。</p>}
    </section>}
    </fieldset>
  </main>;
}
