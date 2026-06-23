// 导出：合成合并版 SVG → 内嵌 base64 字体 → PNG 下载

import { Piece } from '../core/types';
import { Layout } from './layout';
import { renderStaffSVG, RenderInput } from './staff';
import { renderJianpuSVG } from './jianpu';
import { ensureFontLoaded } from './glyphs';
import { diagnoseAll, Issue } from './diagnostics';

/** buildSVG 的选项 */
export interface BuildOpts {
  exportMode?: boolean;
  hover?: { midi: number; x: number } | null;
  /** 渲染后(已兜底)回调，告知发现了哪些 issues。
   *  不传时走默认实现：console.warn 打印问题清单(layout 已 clamp 兜底，不影响渲染)。 */
  onIssues?: (issues: Issue[]) => void;
}

/** 默认 onIssues：静默兜底已由 layout 完成，这里只 console.warn 便于开发者察觉 */
function defaultOnIssues(issues: Issue[]): void {
  console.warn(`[MusicSheet] 检测到 ${issues.length} 个谱面问题(已兜底):\n` +
    issues.map(i => `  - ${i.message}`).join('\n'));
}

/** 构造完整 SVG 字符串（含 <svg> 包裹），可同时用于屏幕与导出 */
export function buildSVG(piece: Piece, layout: Layout, playingIndex: number, opts: BuildOpts = {}): string {
  const input: RenderInput = { piece, layout, playingIndex, hover: opts.exportMode ? null : (opts.hover ?? null) };
  const staff = renderStaffSVG(input);
  const jianpu = renderJianpuSVG(input);
  const vby = -layout.viewBoxYOffset;   // viewBox y 起点(0 或负值):viewBoxYOffset 是顶部扩展量(正),起点取负
  const bg = opts.exportMode ? `<rect x="0" y="${vby}" width="${layout.width}" height="${layout.height}" fill="#ffffff"/>` : '';
  const title = opts.exportMode
    ? `<text x="${layout.contentLeft}" y="${vby + 18}" font-family='system-ui,sans-serif' font-size="13" fill="#64748b">五线谱 — 简谱对照</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 ${vby} ${layout.width} ${layout.height}">${bg}${title}<g class="staff-group">${staff}</g><g class="jianpu-group">${jianpu}</g></svg>`;
  // 渲染完成(已 clamp 兜底)后，抛 issues 回调。diagnose 读 piece 原始数据，不受 clamp 影响。
  const issues = diagnoseAll(piece);
  if (issues.length) {
    const handler = opts.onIssues ?? defaultOnIssues;
    handler(issues);
  }
  return svg;
}

let cachedFontDataUrl: string | null = null;

async function loadFontAsDataUrl(): Promise<string> {
  if (cachedFontDataUrl) return cachedFontDataUrl;
  await ensureFontLoaded();
  const res = await fetch('./bravura.woff2');
  const buf = await res.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  cachedFontDataUrl = `data:font/woff2;base64,${b64}`;
  return cachedFontDataUrl;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(binary);
}

/** 导出 PNG：内嵌字体 → 加载 SVG 为 image → 画到 canvas → 下载 */
export async function exportPNG(piece: Piece, layout: Layout): Promise<void> {
  const fontDataUrl = await loadFontAsDataUrl();
  // 内嵌字体的 SVG
  const styleTag = `<style>@font-face{font-family:"Bravura";src:url("${fontDataUrl}") format("woff2");}</style>`;
  let svg = buildSVG(piece, layout, -1, { exportMode: true });
  svg = svg.replace('<svg ', `<svg xmlns:xlink="http://www.w3.org/1999/xlink" `).replace('>', `><defs>${styleTag}</defs>`, );

  const scale = 2; // 2x 清晰度
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const img = new Image();
  img.width = layout.width;
  img.height = layout.height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图像加载失败'));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = layout.width * scale;
  canvas.height = layout.height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);

  await new Promise<void>((resolve) => {
    canvas.toBlob((b) => {
      if (b) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'musicsheet.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      resolve();
    }, 'image/png');
  });
}
