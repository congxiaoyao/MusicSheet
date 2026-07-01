// 全曲预览弹窗 —— 模态遮罩 + 整曲多行五线谱/简谱渲染 + 点小节定位。
//
// 用 buildFullScoreSVG 渲染整曲(像纸质琴谱),顶部 radio 切换 五线谱/简谱/两者。
// 每个小节可点 → onSelectMeasure(n):关闭弹窗,App 跳到「从第 n 小节起的编辑区」。

import { Score } from '../core/score';
import { buildFullScoreSVG, FullScoreMode, lineXToMeasure } from '../render/full-score';
import { computeLayout } from '../render/layout';
import { Piece } from '../core/types';

export interface PreviewModalHandle {
  /** 打开弹窗(渲染整曲)。 */
  open: () => void;
  /** 关闭弹窗。 */
  close: () => void;
  /** 弹窗是否打开。 */
  isOpen: () => boolean;
}

export interface PreviewModalCallbacks {
  /** 点某小节 → 跳编辑区到该小节。 */
  onSelectMeasure: (measure0Based: number) => void;
  /** 获取当前整曲(每次 open 时取最新)。 */
  getScore: () => Score | null;
}

/** 构建预览弹窗(惰性:DOM 在 open 时才挂到 body)。返回句柄。 */
export function buildPreviewModal(cb: PreviewModalCallbacks): PreviewModalHandle {
  let overlay: HTMLElement | null = null;
  let mode: FullScoreMode = 'both';

  const render = () => {
    if (!overlay) return;
    const score = cb.getScore();
    const body = overlay.querySelector('.fs-modal-body') as HTMLElement | null;
    if (!body) return;
    if (!score) { body.innerHTML = '<p class="fs-empty">无曲谱</p>'; return; }
    // 每行小节数:固定 4(纸质琴谱常见,一行 4 小节)。
    const measuresPerLine = 4;
    const containerW = Math.min(1100, Math.max(640, body.clientWidth || 940));
    const { svg } = buildFullScoreSVG(score, { mode, measuresPerLine, width: containerW });
    body.innerHTML = svg;
    const svgEl = body.querySelector('svg') as SVGSVGElement | null;
    if (svgEl) {
      svgEl.setAttribute('width', '100%');
      // height 不设(SVG 仅有 viewBox 时按 width/比例自动算高),设 'auto' 会触发 SVG 警告。
      svgEl.removeAttribute('height');
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    // 点击 → 所在小节(用点击 x 在该行 contentLeft..contentRight 内换算)。
    body.onclick = (e: MouseEvent) => {
      if (!svgEl || !score) return;
      const rect = svgEl.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right) return;
      // 点击的 y → 落在哪一行。
      const yPct = (e.clientY - rect.top) / rect.height;
      // 重新算一遍行布局拿行数(与 buildFullScoreSVG 内部一致)。
      const lines = planForClick(score.meta.totalMeasures, measuresPerLine);
      const lineIdx = Math.min(lines.length - 1, Math.max(0, Math.floor(yPct * lines.length)));
      const ln = lines[lineIdx];
      // x → 行内小节(用第一行 treble layout 的 contentLeft/Right 近似,各行同宽)。
      const fakePiece: Piece = {
        clef: 'treble', key: score.meta.key, time: score.meta.time,
        measureCount: ln.count, notes: [], treble: [], bass: [],
      };
      const lay = computeLayout(fakePiece, containerW, 'quarter');
      const svgX = (e.clientX - rect.left) / rect.width * lay.width;
      const m = lineXToMeasure(ln.startMeasure, ln.count, svgX, lay);
      cb.onSelectMeasure(m);
      close();
    };
  };

  // 行切分(复刻 full-score.planLines,避免 import 循环;这里只为点击定位算行数)。
  const planForClick = (totalMeasures: number, perLine: number) => {
    const out: { startMeasure: number; count: number }[] = [];
    for (let s = 0; s < totalMeasures; s += perLine) out.push({ startMeasure: s, count: Math.min(perLine, totalMeasures - s) });
    return out.length ? out : [{ startMeasure: 0, count: 1 }];
  };

  const open = () => {
    if (overlay) { render(); return; }   // 已打开:只重渲染
    overlay = document.createElement('div');
    overlay.className = 'fs-modal-overlay';

    const card = document.createElement('div');
    card.className = 'fs-modal-card';

    // 头部:标题 + radio(五线谱/简谱/两者) + 关闭
    const head = document.createElement('div');
    head.className = 'fs-modal-head';
    const title = document.createElement('span');
    title.className = 'fs-modal-title';
    title.textContent = '整曲预览';
    head.appendChild(title);

    const radio = document.createElement('div');
    radio.className = 'fs-modal-radio';
    const modes: { v: FullScoreMode; l: string }[] = [
      { v: 'both', l: '五线谱+简谱' },
      { v: 'staff', l: '五线谱' },
      { v: 'jianpu', l: '简谱' },
    ];
    for (const o of modes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = o.l;
      if (mode === o.v) b.classList.add('active');
      b.onclick = (ev) => { ev.stopPropagation(); mode = o.v; radio.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); render(); };
      radio.appendChild(b);
    }
    head.appendChild(radio);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fs-modal-close';
    closeBtn.innerHTML = '✕';
    closeBtn.title = '关闭';
    closeBtn.onclick = (ev) => { ev.stopPropagation(); close(); };
    head.appendChild(closeBtn);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'fs-modal-body';
    card.appendChild(body);

    overlay.appendChild(card);
    // 点遮罩空白关闭;点卡片不关闭(避免点谱子误关)。
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.body.appendChild(overlay);
    // ESC 关闭。
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    // 入场动画。
    requestAnimationFrame(() => overlay?.classList.add('open'));
    render();
  };

  const close = () => {
    if (!overlay) return;
    const el = overlay;
    overlay = null;
    el.classList.remove('open');
    el.classList.add('closing');
    setTimeout(() => el.remove(), 160);
  };

  return { open, close, isOpen: () => overlay !== null };
}
