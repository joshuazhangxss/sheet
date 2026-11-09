import { batchProductType } from './batchProductType';
import { extractColor, isPrivacyFenceType } from './orderProcessing';
import type { OrderLine } from './batchWorkflow';
export function labelStripText(line: OrderLine, qty: number): string {
  const colors: Record<string, string> = { '黄色': 'Yellow', '灰色': 'Gray', '米色': 'Beige', '棕色': 'Brown', '蓝色': 'Blue', '绿色': 'Green', '黑色': 'Black', '白色': 'White', '红色': 'Red', '橙色': 'Orange', '紫色': 'Purple', '双色': 'Brown/Khaki', '深绿色': 'Dark Green' };
  const color = colors[line.color.trim()] || colors[extractColor(line.color, '')] || line.color.trim();
  const type = batchProductType(line);
  // Privacy-screen dimensions can mix feet and inches; never discard their units.
  const size = isPrivacyFenceType(type)
    ? line.size.replace(/(?:feet|foot|ft|英尺)/gi, '′').replace(/(?:inches|inch|英寸|(?<=\d)\s*in\b|\bin\b)/gi, '″')
      .replace(/['‘’`]/g, '′').replace(/["“”]/g, '″').replace(/\s*[xX×]\s*/g, ' x ').trim()
    : line.size.replace(/\s*(?:feet|foot|ft|英尺|['’′])\s*/gi, '').replace(/\s*[xX×]\s*/g, 'x');
  const ring = /\bgrommets?\b|加环|打环|直\s*[+＋]\s*环|(?:^|\s)环(?:\s|$)/i.test(`${line.product} ${line.sku} ${line.note}`);
  const mark = type === '直边加环' ? 'z+k' : type === '直边' ? 'z' : isPrivacyFenceType(type) ? 'bal' : ring ? 'k' : '';
  const rush = /★|加急|\brush\b|\bexpedited\b|\bpriority\b/i.test(`${line.note} ${line.shippingService}`);
  return `${color} ${size}${mark ? ` ${mark}` : ''}${qty > 1 ? ` ×${qty}` : ''}${rush ? ' ★' : ''}`;
}
