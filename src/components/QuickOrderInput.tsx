import { useState } from 'react';
import type { ClipboardEvent } from 'react';
import { quickOrderPrefill } from '../lib/batchImport';
import type { OrderLine } from '../lib/batchWorkflow';

export function QuickOrderInput({ onExtract }: { onExtract: (values: Partial<OrderLine>) => void }) {
  const [text, setText] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function extract(value: string) {
    try { onExtract(quickOrderPrefill(value)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = [...event.clipboardData.items].find(item => item.type.startsWith('image/'))?.getAsFile();
    if (!file || busy) return;
    event.preventDefault(); setBusy(true); setError('');
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result)); reader.readAsDataURL(file);
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker(['eng', 'chi_sim']);
      try { const result = (await worker.recognize(file)).data.text; setText(result); extract(result); }
      finally { await worker.terminate(); }
    } catch { setError('截图识别失败，可粘贴文字或直接填写下方信息。'); }
    finally { setBusy(false); }
  }
  return <section className="bw-quick-entry">
    <label>粘贴订单文字或截图<textarea aria-label="粘贴订单文字或截图" rows={4} value={text} disabled={busy} onPaste={event => void paste(event)} onChange={event => setText(event.target.value)} placeholder={'在这里按 Ctrl+V / ⌘V 粘贴文字或截图。\n每次录入一个商品，识别后可修改下方信息。'} /></label>
    {image && <details><summary>查看粘贴的截图</summary><img className="bw-image" src={image} alt="粘贴的订单截图" /></details>}
    <button type="button" disabled={busy || !text.trim()} onClick={() => extract(text)}>{busy ? '正在识别截图…' : '识别并填入'}</button>
    {error && <p role="alert" className="bw-error">{error}</p>}
  </section>;
}
