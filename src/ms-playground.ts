// MeasureSelector 调试场入口。隔离调试组件 + 真机验收跨格动画,不依赖 library-demo 主链路。
import { buildMeasureSelector, MeasureSelectorHandle } from './ui/measure-selector';

const host = document.getElementById('ms-host')!;
const readout = document.getElementById('readout')!;
const ruler = document.getElementById('ruler')!;

// 调试用状态(独立维护,不依赖 score/storage)。
let total = 6;
let start = 2;
let count = 2;
let contentOn = true;

function randomContent(t: number): boolean[] {
  return Array.from({ length: t }, () => Math.random() < 0.55);
}

let handle: MeasureSelectorHandle = buildMeasureSelector(
  { totalMeasures: total, start, count, hasContent: contentOn ? randomContent(total) : [] },
  {
    onChange: (s, c) => { start = s; count = c; syncControls(); dump(); },
    onDeleteMeasure: () => {
      if (total <= 1) return;
      total -= 1;
      start = Math.min(start, total - 1);
      count = Math.min(count, total - start);
      refresh();
    },
    onAddMeasure: () => { if (total < 256) { total += 1; refresh(); } },
  },
);
host.appendChild(handle.el);
(window as unknown as { __ms?: unknown }).__ms = handle;   // 暴露供自动化截图脚本用

function refresh() {
  handle.refresh({ totalMeasures: total, start, count, hasContent: contentOn ? randomContent(total) : [] });
  syncControls();
  pulse();
}

function syncControls() {
  (document.getElementById('ctl-total') as HTMLInputElement).value = String(total);
  (document.getElementById('ctl-start') as HTMLInputElement).value = String(start);
  (document.getElementById('ctl-count') as HTMLInputElement).value = String(count);
}

/** 实时读数:每书签 cx/left、inside、selX/selW、addX、scrollLeft。用 rAF 持续刷新(动画中也更新)。 */
function dump() {
  const sel = document.querySelector('.ms-sel') as HTMLElement;
  const wrap = document.querySelector('.ms-wrap') as HTMLElement;
  const addBtn = document.querySelector('.ms-add') as HTMLElement;
  const wrapLeft = wrap.getBoundingClientRect().left;
  const selR = sel.getBoundingClientRect();
  const addR = addBtn.getBoundingClientRect();
  const blks = [...document.querySelectorAll<HTMLElement>('.ms-blk:not(.ms-leave)')].sort((a, b) => +a.dataset.idx! - +b.dataset.idx!);
  const lines: string[] = [];
  lines.push(`total=${total} start=${start} count=${count}  scrollLeft=${Math.round(wrap.scrollLeft)}  scrollWidth=${wrap.scrollWidth} clientWidth=${wrap.clientWidth}`);
  lines.push(`sel: left=${Math.round(selR.left - wrapLeft)} right=${Math.round(selR.right - wrapLeft)} width=${Math.round(selR.width)}  (selX/selW,装饰层)`);
  lines.push(`add: left=${Math.round(addR.left - wrapLeft)} right=${Math.round(addR.right - wrapLeft)}  (addX,应在最后书签右缘+15)`);
  lines.push('书签(idx | inside | left→right | 中心):');
  blks.forEach(b => {
    const r = b.getBoundingClientRect();
    const inside = b.classList.contains('inside');
    lines.push(`  ${b.dataset.idx!.padStart(2)} | ${inside ? '内' : '外'} | ${Math.round(r.left - wrapLeft)}→${Math.round(r.right - wrapLeft)} | ${Math.round(r.left + r.width / 2 - wrapLeft)}`);
  });
  // 跨框间距检查:相邻书签中心距,标注跨框(内外不同)的
  const cxs = blks.map(b => { const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2 - wrapLeft); });
  const ins = blks.map(b => b.classList.contains('inside'));
  const gaps: string[] = [];
  for (let i = 0; i < cxs.length - 1; i++) {
    const d = cxs[i + 1] - cxs[i];
    gaps.push(`${i}↔${i + 1}:${d}${ins[i] !== ins[i + 1] ? '(跨框)' : ''}`);
  }
  lines.push('间距: ' + gaps.join('  '));
  readout.textContent = lines.join('\n');

  // 标尺:每 50px 一个刻度
  ruler.innerHTML = '';
  const max = Math.max(wrap.scrollWidth, wrap.clientWidth);
  for (let x = 0; x <= max; x += 50) {
    const s = document.createElement('span');
    s.textContent = String(x);
    s.style.left = x + 'px';
    ruler.appendChild(s);
  }
}

// 持续刷新(动画进行时也更新读数),500ms 后停止(动画结束)
let rafId = 0;
function loop() { dump(); rafId = requestAnimationFrame(loop); }
function pulse() { cancelAnimationFrame(rafId); loop(); setTimeout(() => cancelAnimationFrame(rafId), 600); }
// 初次刷新
dump();

// 控件
document.getElementById('ctl-apply')!.addEventListener('click', () => {
  total = Math.max(1, Math.min(256, parseInt((document.getElementById('ctl-total') as HTMLInputElement).value) || 1));
  count = Math.max(1, parseInt((document.getElementById('ctl-count') as HTMLInputElement).value) || 1);
  start = Math.max(0, Math.min(parseInt((document.getElementById('ctl-start') as HTMLInputElement).value) || 0, total - 1));
  count = Math.min(count, total - start);
  refresh();
});
document.getElementById('ctl-add')!.addEventListener('click', () => { if (total < 256) { total += 1; refresh(); } });
document.getElementById('ctl-del')!.addEventListener('click', () => { if (total > 1) { total -= 1; start = Math.min(start, total - 1); count = Math.min(count, total - start); refresh(); } });
document.getElementById('ctl-content')!.addEventListener('change', (e) => { contentOn = (e.target as HTMLInputElement).checked; refresh(); });
document.getElementById('ctl-scroll-right')!.addEventListener('click', () => { document.querySelector('.ms-wrap')!.scrollLeft = 99999; pulse(); });

// 预设场景:先设到 6 小节 [3,4](start=2,count=2),再触发对应交互
function setBase() { total = 6; start = 2; count = 2; refresh(); }
document.querySelectorAll<HTMLButtonElement>('.scene button').forEach(btn => {
  btn.addEventListener('click', () => {
    const sc = btn.dataset.scene;
    if (sc === 'full') { total = 6; start = 0; count = 6; refresh(); return; }
    if (sc === 'one') { total = 1; start = 0; count = 1; refresh(); return; }
    if (sc === 'scroll') { total = 16; start = 0; count = 2; refresh(); setTimeout(() => { document.querySelector('.ms-wrap')!.scrollLeft = 99999; pulse(); }, 300); return; }
    // 1A/1B/1C/2A/2B 都基于 6 小节 [3,4]
    setBase();
    setTimeout(() => {
      if (sc === '1A') dragTo('.ms-grip-r', 4);        // 拖右把手到 idx4 扩 count=3
      else if (sc === '1B') dragTo('.ms-grip-r', 2);   // 拖右把手到 idx2 缩 count=1
      else if (sc === '1C') dragTo('.ms-grip-l', 3);   // 拖左把手到 idx3 start 右移
      else if (sc === '2A') dragBodyTo(4);             // 拖框体到 idx4
      else if (sc === '2B') dragBodyTo(0);             // 拖框体到 idx0
    }, 400);
  });
});

// 模拟拖拽(用于预设场景自动演示;真机请手动拖)
async function dragTo(selector: string, targetIdx: number) {
  const grip = document.querySelector(selector) as HTMLElement;
  const target = document.querySelector(`.ms-blk[data-idx="${targetIdx}"]`) as HTMLElement;
  if (!grip || !target) return;
  const g = grip.getBoundingClientRect(), t = target.getBoundingClientRect();
  const x0 = g.left + g.width / 2, y0 = g.top + g.height / 2, x1 = t.left + t.width / 2;
  grip.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  for (let i = 1; i <= 10; i++) {
    const x = x0 + (x1 - x0) * (i / 10);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y0, bubbles: true }));
    await new Promise(r => setTimeout(r, 25));
    pulse();
  }
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: x1, clientY: y0, bubbles: true }));
  pulse();
}

async function dragBodyTo(targetIdx: number) {
  const sel = document.querySelector('.ms-sel') as HTMLElement;
  const target = document.querySelector(`.ms-blk[data-idx="${targetIdx}"]`) as HTMLElement;
  if (!sel || !target) return;
  const s = sel.getBoundingClientRect(), t = target.getBoundingClientRect();
  const x0 = s.left + 8, y0 = s.top + s.height / 2, x1 = t.left + t.width / 2;
  sel.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  for (let i = 1; i <= 10; i++) {
    const x = x0 + (x1 - x0) * (i / 10);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y0, bubbles: true }));
    await new Promise(r => setTimeout(r, 25));
    pulse();
  }
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: x1, clientY: y0, bubbles: true }));
  pulse();
}
