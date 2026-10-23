import { extractProductType, isPrivacyFenceType } from './orderProcessing';
import type { OrderLine } from './batchWorkflow';

export function batchProductType(line: Pick<OrderLine, 'product' | 'sku' | 'note'>): string {
  const source = `${line.product} ${line.sku} ${line.note}`;
  const base = extractProductType(line.product, line.sku);
  if (isPrivacyFenceType(base)) return base;
  const straight = base === '直边' || /直边|直\s*[+＋]\s*环|(?:^|\s)直(?:\s|$)/.test(source);
  const ring = /\bgrommets?\b|加环|打环|直\s*[+＋]\s*环|(?:^|\s)环(?:\s|$)/i.test(source);
  return straight ? (ring ? '直边加环' : '直边') : base;
}
