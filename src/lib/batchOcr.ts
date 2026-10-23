import type { LabelPage } from '../types';

// OCR augments matching text only; exported labels always copy untouched original PDF pages.
export async function recognizeLabelPages(file: File, pages: LabelPage[], progress: (message: string) => void): Promise<LabelPage[]> {
  const candidates = pages.filter(p => p.text.trim().length < 30);
  if (!candidates.length) return pages;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createWorker } = await import('tesseract.js');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWorkerFetch: false }).promise;
  try {
    const worker = await createWorker('eng');
    try {
      const replacements = new Map<number, string>();
      for (const candidate of candidates) {
        progress(`识别扫描标签 ${file.name} · 第 ${candidate.pageNumber} 页…`);
        const page = await pdf.getPage(candidate.pageNumber);
        const scale = Math.min(2, 2000 / Math.max(candidate.width, candidate.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        replacements.set(candidate.pageNumber, (await worker.recognize(canvas)).data.text);
        canvas.width = 0; canvas.height = 0; page.cleanup();
      }
      return pages.map(p => replacements.has(p.pageNumber) ? { ...p, text: `${p.text} ${replacements.get(p.pageNumber)}`, normalizedText: `${p.normalizedText} ${replacements.get(p.pageNumber)}` } : p);
    } finally { await worker.terminate(); }
  } finally { await pdf.destroy(); }
}
