import { batchProductType } from './batchProductType';
import { extractColor, isPrivacyFenceType } from './orderProcessing';
import type { OrderLine } from './batchWorkflow';
export function labelStripText(line: OrderLine, qty: number): string {
  const color = (extractColor(line.color, '') || line.color).replace(/色$/, '');
  const size = line.size.replace(/\s*(?:feet|foot|ft|英尺|['’′])\s*/gi, '').replace(/\s*[xX×]\s*/g, 'x');
  const type = batchProductType(line);
  const mark = type === '直边加环' ? '直加环' : type === '直边' ? '直' : isPrivacyFenceType(type) ? '阳' : '';
  const rush = /★|加急|\brush\b|\bexpedited\b|\bpriority\b/i.test(`${line.note} ${line.shippingService}`);
  return `${color} ${size}${mark}${qty > 1 ? ` ×${qty}` : ''}${rush ? ' 急' : ''}`;
}
