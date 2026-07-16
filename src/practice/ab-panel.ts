// AbPanel —— AB 循环设置面板(小节网格选择器,日历式区间)。
//
// 模型:一个 switch(总闸)+ 一个永远非空的 selection + 间隔(重播延迟)。
//   - switch 关:面板主体隐藏,显示置灰提示;不循环。
//   - switch 开:选区永不为空——从未拖过则全选,拖过则是拖的范围。
//   - 无"清空"状态,拖拽/点选最少 1 小节。快捷动作 = [整曲循环]。
//
// 视觉(日历区间,订房日历风格):
//   选区不是"各自高亮",而是连续圆角填充条 + 两端圆形 A/B 锚点。
//   每格按 position(before/in-start/in-middle/in-end/alone)渲染不同样式。
//
// 手势(即时生效):
//   - 拖拽:按下起点格→拖到终点格→松开,选连续范围。松手不在格子上(间距/网格外)
//       时用最后一次有效预览格,不退化为单选起点。
//   - 点击单格(无拖动位移):单小节自循环(A=B=该小节)。
//   - 拖 A/B 锚点:微调对应端(固定另一端);拖过另一端自动交换 A/B 标签。
//   - [整曲循环]:selection = 0..total-1。
//
// 组件模式:命令式工厂 + Handle(同 practice-controls),不调 App 方法,只通过 callbacks 报事件。

import './ab-panel.css';

/** AB 选区的小节表示(0-based,含两端;相等=单小节自循环)。供 practice-app / score-sheet 共用。 */
export interface AbSelection {
  startMeasure: number;
  endMeasure: number;
}

export interface AbPanelInitial {
  totalMeasures: number;
  on: boolean;
  selection: AbSelection | null;
  /** 重播间隔(拍数,0~8)。 */
  intervalBeats: number;
}

export interface AbPanelCallbacks {
  /** switch 切换(on)。 */
  onToggleLoop(on: boolean): void;
  /** 选区变化。 */
  onSelectionChange(sel: AbSelection): void;
  /** 间隔变化(滑块拖动,单位拍,实时)。 */
  onIntervalChange(beats: number): void;
  /** 面板开/关(点顶栏 AB 按钮)。 */
  onOpenChange(open: boolean): void;
}

export interface AbPanelHandle {
  el: HTMLElement;
  setOpen(open: boolean): void;
  setOn(on: boolean): void;
  setSelection(sel: AbSelection | null): void;
  setInterval(beats: number): void;
}

/** 判定单次 down→up 是否算"拖动"(位移阈值,px)。超过按拖选,否则按点击。 */
const DRAG_THRESHOLD = 4;
/** A/B 锚点半径(px,与 CSS .ab-anchor width:20px 对应)。锚点中心放在格子内缘此距离处,
 *  让锚点整个落在格内,不向格子外溢出(避免被 grid overflow 裁切,也无需 padding)。 */
const ANCHOR_R = 10;

export function buildAbPanel(initial: AbPanelInitial, cb: AbPanelCallbacks): AbPanelHandle {
  const el = document.createElement('div');
  el.className = 'ab-panel' + (initial.on ? ' on' : '');

  const total = Math.max(1, initial.totalMeasures);
  let selection: AbSelection | null = initial.selection;
  /** 拖拽状态。mode='range' 从空拖出新范围(start=起点,lastCell=最后一次有效预览格,
   *  松手不在格子上时用它);mode='endpoint' 拖已有选区的端点(endpoint='a'|'b' 拖哪端,
   *  fixedEnd=另一端固定,anchorEl=被拖锚点,fixedAnchorEl=固定端锚点,交叉时翻转两者标签,
   *  lastCell=最后一次有效预览格)。 */
  let drag:
    | { mode: 'range'; start: number; lastCell: number }
    | { mode: 'endpoint'; endpoint: 'a' | 'b'; fixedEnd: number; anchorEl: HTMLElement; fixedAnchorEl: HTMLElement; lastCell: number }
    | null = null;
  let dragging = false;
  /** 拖拽到网格边缘时的自动滚动。lastY = 最近一次 pointermove 的 clientY(滚动循环据此判定方向)。 */
  let autoScrollRaf = 0;
  let lastMoveX = 0;
  let lastMoveY = 0;
  const AUTO_SCROLL_EDGE = 36;   // 距网格视口顶/底多少 px 内触发自动滚动
  const AUTO_SCROLL_SPEED = 7;   // 每帧滚动 px

  /** 启动/更新自动滚动循环(拖拽中调用)。指针在网格顶/底边缘内则持续滚动,
   *  滚动后重算当前格并更新预览(指针不动也要刷新,因为格子随滚动移位了)。 */
  const runAutoScroll = () => {
    if (autoScrollRaf) return;   // 已在跑
    const tick = () => {
      if (!drag) { autoScrollRaf = 0; return; }
      const gr = grid.getBoundingClientRect();
      const distTop = lastMoveY - gr.top;
      const distBottom = gr.bottom - lastMoveY;
      let delta = 0;
      if (distTop < AUTO_SCROLL_EDGE && distTop > -AUTO_SCROLL_EDGE * 2) {
        delta = -AUTO_SCROLL_SPEED * (1 - Math.max(0, distTop) / AUTO_SCROLL_EDGE);
      } else if (distBottom < AUTO_SCROLL_EDGE && distBottom > -AUTO_SCROLL_EDGE * 2) {
        delta = AUTO_SCROLL_SPEED * (1 - Math.max(0, distBottom) / AUTO_SCROLL_EDGE);
      }
      if (delta !== 0) {
        grid.scrollTop += delta;
        // 滚动后重算当前格 + 更新预览(格子屏幕位置变了)
        const cur = cellAtPoint(lastMoveX, lastMoveY);
        if (cur >= 0) {
          drag.lastCell = cur;
          if (drag.mode === 'endpoint') {
            clearPreview();
            applyPreview(drag.fixedEnd, cur);
            updateDraggingAnchor(cur);
          } else if (dragging) {
            clearPreview();
            applyPreview(drag.start, cur);
          }
        }
        autoScrollRaf = requestAnimationFrame(tick);
      } else {
        autoScrollRaf = 0;   // 不在边缘,停
      }
    };
    autoScrollRaf = requestAnimationFrame(tick);
  };
  const stopAutoScroll = () => {
    if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0; }
  };

  // ── 第 1 层:标题 + switch ──
  const head = document.createElement('div');
  head.className = 'ab-head';
  const title = document.createElement('span');
  title.className = 'ab-title';
  title.textContent = 'AB 循环';
  const sw = document.createElement('div');
  sw.className = 'ab-switch' + (initial.on ? ' on' : '');
  sw.title = '启用 / 关闭循环';
  sw.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = !sw.classList.contains('on');
    applyOn(on);
    cb.onToggleLoop(on);
  });
  head.append(title, sw);
  el.appendChild(head);

  // switch 关时的置灰提示
  const empty = document.createElement('div');
  empty.className = 'ab-empty';
  empty.textContent = '开启后可选择循环小节';
  el.appendChild(empty);

  // ── 第 2 层:网格主体 ──
  const body = document.createElement('div');
  body.className = 'ab-body';

  const hint = document.createElement('div');
  hint.className = 'ab-hint';
  hint.textContent = '拖选循环小节,点单小节自循环';
  body.appendChild(hint);

  const grid = document.createElement('div');
  grid.className = 'ab-grid';
  body.appendChild(grid);

  // ── 第 3 层:状态条 + 整曲循环 + 间隔滑块 ──
  const foot = document.createElement('div');
  foot.className = 'ab-foot';
  const rangeLabel = document.createElement('span');
  rangeLabel.className = 'ab-range';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'ab-all';
  allBtn.textContent = '整曲循环';
  allBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const sel: AbSelection = { startMeasure: 0, endMeasure: total - 1 };
    applySelection(sel);
    cb.onSelectionChange(sel);
  });
  foot.append(rangeLabel, allBtn);
  body.appendChild(foot);

  // 间隔滑块行
  const intervalRow = document.createElement('div');
  intervalRow.className = 'ab-interval';
  const intervalLabel = document.createElement('span');
  intervalLabel.className = 'ab-interval-label';
  intervalLabel.textContent = '间隔';
  const intervalSlider = document.createElement('input');
  intervalSlider.type = 'range';
  intervalSlider.min = '0'; intervalSlider.max = '8'; intervalSlider.step = '0.5';
  intervalSlider.value = String(initial.intervalBeats);
  const intervalVal = document.createElement('span');
  intervalVal.className = 'ab-interval-val';
  const fmtInterval = (beats: number) => beats === 0 ? '关' : beats.toFixed(1) + '拍';
  intervalVal.textContent = fmtInterval(initial.intervalBeats);
  intervalSlider.addEventListener('input', (e) => {
    e.stopPropagation();
    const beats = parseFloat(intervalSlider.value);
    intervalVal.textContent = fmtInterval(beats);
    cb.onIntervalChange(beats);
  });
  // 滑块拖动时阻止冒泡到 grid 的 pointer 处理
  intervalSlider.addEventListener('pointerdown', (e) => e.stopPropagation());
  intervalRow.append(intervalLabel, intervalSlider, intervalVal);
  body.appendChild(intervalRow);

  el.appendChild(body);

  // ── 小节格构建 ──
  // 格子只负责命中区域 + 数字;填充条 + 锚点用独立 overlay 元素(.ab-fill / .ab-anchor),
  // 跨越选中区间的首尾格子,不受 grid gap 影响 → 真正的连续填充条。
  const cellEls: HTMLElement[] = [];
  for (let i = 0; i < total; i++) {
    const c = document.createElement('div');
    c.className = 'ab-cell';
    c.dataset.m = String(i);
    const num = document.createElement('span');
    num.className = 'ab-num';
    num.textContent = String(i + 1);
    c.appendChild(num);
    grid.appendChild(c);
    cellEls.push(c);
  }
  // 填充条容器(选中区间的连续色条,逐行分段)。挂在 grid 上,装多个 .ab-fill 段。
  const fillHost = document.createElement('div');
  fillHost.className = 'ab-fill-host';
  grid.appendChild(fillHost);
  // 预览填充条容器(拖拽/待定时半透明显示)。
  const fillPreviewHost = document.createElement('div');
  fillPreviewHost.className = 'ab-fill-host preview-host';
  grid.appendChild(fillPreviewHost);

  /** 算选区跨行后的填充段(日历式:每行一段,跨行时首段到行末、末段从行首)。
   *  返回每段 {left,width,top,height,first,last}(first/last 决定圆角端:首段左圆、末段右圆)。
   *  lo/hi = 选区首尾格子 index。COLUMNS 列网格。 */
  const fillSegmentsOf = (lo: number, hi: number): { left: number; width: number; top: number; height: number; first: boolean; last: boolean }[] => {
    if (lo < 0 || hi < 0 || lo >= cellEls.length || hi >= cellEls.length) return [];
    const COLS = 4;
    const rowOf = (m: number) => Math.floor(m / COLS);
    const rowLo = rowOf(lo), rowHi = rowOf(hi);
    const segs: { left: number; width: number; top: number; height: number; first: boolean; last: boolean }[] = [];
    for (let row = rowLo; row <= rowHi; row++) {
      const rowStartM = row * COLS;
      const segLoM = row === rowLo ? lo : rowStartM;          // 首段从 lo,其余段从行首
      const segHiM = row === rowHi ? hi : rowStartM + COLS - 1; // 末段到 hi,其余段到行末
      const a = cellEls[segLoM], b = cellEls[segHiM];
      segs.push({
        left: a.offsetLeft,
        width: b.offsetLeft + b.offsetWidth - a.offsetLeft,
        top: a.offsetTop,
        height: a.offsetHeight,
        first: row === rowLo,    // 含 A 端(左圆角)
        last: row === rowHi,     // 含 B 端(右圆角)
      });
    }
    return segs;
  };

  /** 渲染填充段(多段 .ab-fill)到容器 host。preview=true 用半透明样式。 */
  const renderFills = (host: HTMLElement, segs: { left: number; width: number; top: number; height: number; first: boolean; last: boolean }[], preview: boolean) => {
    host.innerHTML = '';
    segs.forEach((s, i) => {
      const f = document.createElement('div');
      f.className = 'ab-fill' + (preview ? ' preview' : '');
      f.style.left = s.left + 'px';
      f.style.width = s.width + 'px';
      f.style.top = s.top + 'px';
      f.style.height = s.height + 'px';
      // 圆角:首段左端圆(含 A),末段右端圆(含 B),中间段两端都方(行内连续)。单段首末都是它→两端都圆。
      const r = '8px';
      const tl = s.first ? r : '0', bl = s.first ? r : '0';
      const tr = s.last ? r : '0', br = s.last ? r : '0';
      f.style.borderRadius = `${tl} ${tr} ${br} ${bl}`;
      // 单小节(首末同行同格):两端都圆角
      if (s.first && s.last && segs.length === 1) f.style.borderRadius = r;
      void i;
      host.appendChild(f);
    });
  };

  /** 应用选区到 DOM(逐行分段填充条 + 圆形锚点 + 状态文字 + 待定态)。不触发回调。 */
  const applySelection = (sel: AbSelection | null) => {
    selection = sel;
    // 清旧锚点
    grid.querySelectorAll('.ab-anchor').forEach(a => a.remove());
    // 格子状态:选中区内加 .selected(数字变白)
    cellEls.forEach((c, i) => {
      const inside = sel != null && i >= sel.startMeasure && i <= sel.endMeasure;
      c.classList.toggle('selected', inside);
    });
    // 填充段 + 锚点
    if (sel) {
      const segs = fillSegmentsOf(sel.startMeasure, sel.endMeasure);
      renderFills(fillHost, segs, false);
      // A/B 锚点:骑在首段左端 / 末段右端。data-end 标识可拖端点。
      const mkAnchor = (label: string, end: 'a' | 'b', x: number, y: number) => {
        const a = document.createElement('span');
        a.className = 'ab-anchor';
        a.dataset.end = end;
        a.textContent = label;
        a.style.left = x + 'px';
        a.style.top = y + 'px';
        grid.appendChild(a);
      };
      const single = sel.startMeasure === sel.endMeasure;
      if (single) {
        // 单小节自循环:居中一个 AB 锚点(不可拖,语义模糊)
        const c = cellEls[sel.startMeasure];
        const a = document.createElement('span');
        a.className = 'ab-anchor';
        a.textContent = 'AB';
        a.style.left = (c.offsetLeft + c.offsetWidth / 2) + 'px';
        a.style.top = (c.offsetTop + c.offsetHeight / 2) + 'px';
        grid.appendChild(a);
      } else {
        // A/B 锚点中心放在格子内缘(A 贴首段左缘内侧、B 贴末段右缘内侧),
        // 不向格子外溢出 → 不需 grid padding,不与面板其他控件错位。
        const firstSeg = segs[0], lastSeg = segs[segs.length - 1];
        mkAnchor('A', 'a', firstSeg.left + ANCHOR_R, firstSeg.top + firstSeg.height / 2);
        mkAnchor('B', 'b', lastSeg.left + lastSeg.width - ANCHOR_R, lastSeg.top + lastSeg.height / 2);
      }
      // 状态文字
      const count = sel.endMeasure - sel.startMeasure + 1;
      if (sel.startMeasure === 0 && sel.endMeasure === total - 1) {
        rangeLabel.innerHTML = `已选 <b>整曲</b>(共 ${count})`;
      } else if (single) {
        rangeLabel.innerHTML = `已选 <b>第 ${sel.startMeasure + 1} 小节</b>自循环`;
      } else {
        rangeLabel.innerHTML = `已选 <b>${sel.startMeasure + 1}–${sel.endMeasure + 1}</b>(共 ${count})`;
      }
    } else {
      fillHost.innerHTML = '';
      rangeLabel.textContent = '';
    }
  };
  applySelection(selection);

  /** 应用开关态到 DOM。 */
  const applyOn = (on: boolean) => {
    el.classList.toggle('on', on);
    sw.classList.toggle('on', on);
  };

  // ── 手势:两次点击定区间 / 拖拽 / 单击自循环 ──
  /** 预览:从 a 到 b 的半透明填充段(拖拽中 + 待定 B 第二次点击前)。 */
  const applyPreview = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    renderFills(fillPreviewHost, fillSegmentsOf(lo, hi), true);
  };
  const clearPreview = () => { fillPreviewHost.innerHTML = ''; };

  const cellAtPoint = (clientX: number, clientY: number): number => {
    const hits = document.elementsFromPoint(clientX, clientY);
    for (const h of hits) {
      if ((h as HTMLElement).classList?.contains('ab-cell')) {
        const m = parseInt((h as HTMLElement).dataset.m || '-1', 10);
        if (m >= 0) return m;
      }
    }
    return -1;
  };

  /** 更新被拖端点锚点的位置 + 标签(端点拖拽中调用)。
   *  交叉(cur 越过 fixedEnd)时两个锚点的标签 + 位置都翻转:被拖锚点移到 cur 对应内缘并变标签,
   *  固定锚点在 fixedEnd 格子翻转到对应内缘。始终保持"左 A 右 B"。
   *  锚点中心放格子内缘(不溢出)。松手 applySelection 按 min/max 归位。 */
  const updateDraggingAnchor = (cur: number) => {
    if (!drag || drag.mode !== 'endpoint') return;
    const crossed = drag.endpoint === 'a' ? cur > drag.fixedEnd : cur < drag.fixedEnd;
    // 被拖锚点:标签 + 位置(贴 cur 格子对应内缘)
    const dragEnd = crossed ? (drag.endpoint === 'a' ? 'b' : 'a') : drag.endpoint;
    drag.anchorEl.dataset.end = dragEnd;
    drag.anchorEl.textContent = dragEnd.toUpperCase();
    const cCur = cellEls[cur];
    drag.anchorEl.style.left = (dragEnd === 'a' ? cCur.offsetLeft + ANCHOR_R : cCur.offsetLeft + cCur.offsetWidth - ANCHOR_R) + 'px';
    drag.anchorEl.style.top = (cCur.offsetTop + cCur.offsetHeight / 2) + 'px';
    // 固定锚点:标签翻转 + 位置贴 fixedEnd 格子对应内缘(交叉时内缘侧也变)
    const fixedLabel = crossed ? drag.endpoint : (drag.endpoint === 'a' ? 'b' : 'a');
    drag.fixedAnchorEl.dataset.end = fixedLabel;
    drag.fixedAnchorEl.textContent = fixedLabel.toUpperCase();
    const cFix = cellEls[drag.fixedEnd];
    drag.fixedAnchorEl.style.left = (fixedLabel === 'a' ? cFix.offsetLeft + ANCHOR_R : cFix.offsetLeft + cFix.offsetWidth - ANCHOR_R) + 'px';
    drag.fixedAnchorEl.style.top = (cFix.offsetTop + cFix.offsetHeight / 2) + 'px';
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!el.classList.contains('on')) return;
    // 优先:点在 A/B 锚点上 → 拖端点(固定另一端)。
    const anchorEl = (e.target as HTMLElement).closest('.ab-anchor') as HTMLElement | null;
    if (anchorEl && anchorEl.dataset.end && selection && selection.startMeasure !== selection.endMeasure) {
      e.preventDefault();
      e.stopPropagation();
      const end = anchorEl.dataset.end as 'a' | 'b';
      const fixedEnd = end === 'a' ? selection.endMeasure : selection.startMeasure;
      // 记录两个锚点(被拖的 + 固定端的),交叉时翻转标签用。
      const fixedAnchorEl = grid.querySelector(`.ab-anchor[data-end="${end === 'a' ? 'b' : 'a'}"]`) as HTMLElement;
      drag = { mode: 'endpoint', endpoint: end, fixedEnd, anchorEl, fixedAnchorEl, lastCell: fixedEnd };
      dragging = true;   // 端点拖拽无"点击"语义,直接进入拖拽
      grid.classList.add('interacting');
      return;
    }
    // 否则:点在格子上 → 拖新范围(纯点击=单小节自循环,在 up 时处理)。
    const c = (e.target as HTMLElement).closest('.ab-cell') as HTMLElement | null;
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    const m = parseInt(c.dataset.m || '-1', 10);
    if (m < 0) return;
    drag = { mode: 'range', start: m, lastCell: m };
    dragging = false;
    grid.classList.add('interacting');
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    lastMoveX = e.clientX; lastMoveY = e.clientY;   // 记录指针供 autoScroll 用
    runAutoScroll();   // 指针在网格边缘则启动自动滚动
    if (drag.mode === 'endpoint') {
      // 端点拖拽:固定 fixedEnd,当前指针格作为拖动端,实时预览 + 锚点跟着指针移。
      const cur = cellAtPoint(e.clientX, e.clientY);
      if (cur >= 0) {
        drag.lastCell = cur;
        clearPreview();
        applyPreview(drag.fixedEnd, cur);
        updateDraggingAnchor(cur);
      }
      return;
    }
    // range 模式:用位移判定是否拖拽
    if (!dragging) {
      const startEl = cellEls[drag.start].getBoundingClientRect();
      const cx = startEl.left + startEl.width / 2, cy = startEl.top + startEl.height / 2;
      if (Math.hypot(e.clientX - cx, e.clientY - cy) < DRAG_THRESHOLD) return;
      dragging = true;
    }
    const cur = cellAtPoint(e.clientX, e.clientY);
    if (cur >= 0) {
      drag.lastCell = cur;
      clearPreview();
      applyPreview(drag.start, cur);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    stopAutoScroll();
    grid.classList.remove('interacting');
    if (d.mode === 'endpoint') {
      // 端点拖拽提交:fixedEnd + 当前格,自动排序。
      const cur = cellAtPoint(e.clientX, e.clientY);
      const movingEnd = cur >= 0 ? cur : d.lastCell;
      clearPreview();
      const lo = Math.min(d.fixedEnd, movingEnd), hi = Math.max(d.fixedEnd, movingEnd);
      const sel: AbSelection = { startMeasure: lo, endMeasure: hi };
      applySelection(sel);
      cb.onSelectionChange(sel);
      return;
    }
    if (dragging) {
      // range 拖拽提交:松手时若不在格子上(间距/网格外),用最后一次有效预览格,不退化为单选起点。
      dragging = false;
      const cur = cellAtPoint(e.clientX, e.clientY);
      const end = cur >= 0 ? cur : d.lastCell;
      clearPreview();
      const lo = Math.min(d.start, end), hi = Math.max(d.start, end);
      const sel: AbSelection = { startMeasure: lo, endMeasure: hi };
      applySelection(sel);
      cb.onSelectionChange(sel);
      return;
    }
    // 点击(无拖拽位移):单小节自循环(start==end)。
    clearPreview();
    const sel: AbSelection = { startMeasure: d.start, endMeasure: d.start };
    applySelection(sel);
    cb.onSelectionChange(sel);
  };

  grid.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  return {
    el,
    setOpen(open: boolean) {
      el.classList.toggle('open', open);
      cb.onOpenChange(open);
      // 面板从 display:none 切到 block 后,格子才完成布局;此前 fillSegmentsOf 读的
      // offsetLeft/Width 全是 0 → 填充段定位错。打开时等一帧布局完成,重算当前选区的填充。
      if (open) requestAnimationFrame(() => applySelection(selection));
    },
    setOn(on: boolean) { applyOn(on); },
    setSelection(sel: AbSelection | null) {
      applySelection(sel);
    },
    setInterval(beats: number) {
      intervalSlider.value = String(beats);
      intervalVal.textContent = fmtInterval(beats);
    },
  };
}
