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

// Enlarge small clipboard text and flatten transparency before OCR.
export async function recognizeOrderScreenshot(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(bitmap.width < 1000 ? 2 : 1, 3000 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法读取截图');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(['eng', 'chi_sim']);
    try { return (await worker.recognize(canvas)).data.text; }
    finally { await worker.terminate(); }
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
}
