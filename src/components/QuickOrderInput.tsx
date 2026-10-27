import { useState } from 'react';
import type { ClipboardEvent } from 'react';
import { pastedOrderLines } from '../lib/batchImport';
import { emptyLine, lineProblems } from '../lib/batchWorkflow';
import { batchProductType } from '../lib/batchProductType';
import type { OrderLine } from '../lib/batchWorkflow';

export function QuickOrderInput({ onExtract, onAddMany }: { onExtract: (values: Partial<OrderLine>) => void; onAddMany: (lines: OrderLine[]) => void }) {
  const [rows, setRows] = useState<OrderLine[]>([]);
  const [text, setText] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function extract(value: string) {
    try {
      const values = pastedOrderLines(value);
      if (values.length === 1) { setRows([]); onExtract(values[0]); }
      else setRows(values.map(value => ({ ...emptyLine(), ...value })));
      setError('');
    }
    catch (e) { setRows([]); setError(e instanceof Error ? e.message : String(e)); }
  }
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = [...event.clipboardData.items].find(item => item.type.startsWith('image/'))?.getAsFile();
    if (!file || busy) return;
    event.preventDefault(); setBusy(true); setError('');
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result)); reader.readAsDataURL(file);
    try {
      const { recognizeOrderScreenshot } = await import('../lib/batchOcr');
      const result = await recognizeOrderScreenshot(file);
      setText(result); extract(result);
    } catch { setError('截图识别失败，可粘贴文字或直接填写下方信息。'); }
    finally { setBusy(false); }
  }
  return <section className="bw-quick-entry">
    <label>粘贴订单文字或截图<textarea aria-label="粘贴订单文字或截图" rows={4} value={text} disabled={busy} onPaste={event => void paste(event)} onChange={event => { setText(event.target.value); setRows([]); }} placeholder={'在这里按 Ctrl+V / ⌘V 粘贴文字或截图。\n支持粘贴多个订单；识别后可修改信息。'} /></label>
    {image && <details><summary>查看粘贴的截图</summary><img className="bw-image" src={image} alt="粘贴的订单截图" /></details>}
    <button type="button" disabled={busy || !text.trim()} onClick={() => extract(text)}>{busy ? '正在识别截图…' : '识别并填入'}</button>
    {rows.length > 0 && <div><p>已识别 {rows.length} 个订单，可直接修改下表。</p><div className="bw-table-wrap"><table aria-label="批量粘贴订单"><thead><tr><th>订单号</th><th>产品</th><th>颜色</th><th>尺寸</th><th>数量</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id}>{(['orderId', 'product', 'color', 'size', 'qty'] as const).map(key => <td key={key}><input aria-label={`第${index + 1}行${key}`} type={key === 'qty' ? 'number' : 'text'} min={key === 'qty' ? 1 : undefined} value={row[key]} onChange={event => setRows(current => current.map((item, i) => i === index ? { ...item, [key]: key === 'qty' ? Number(event.target.value) : event.target.value } : item))} />{key === 'product' && <small>{batchProductType(row)}</small>}</td>)}</tr>)}</tbody></table></div>
      <button type="button" onClick={() => { try { const invalid = rows.flatMap((row, i) => lineProblems(row).map(problem => `第 ${i + 1} 行：${problem}`)); if (invalid.length) throw new Error(invalid.join('；')); onAddMany(rows.map(row => ({ ...row, reviewed: true }))); setRows([]); setError(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>添加全部 {rows.length} 个订单</button></div>}
    {error && <p role="alert" className="bw-error">{error}</p>}
  </section>;
}
