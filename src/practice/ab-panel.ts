// AbPanel —— AB 循环设置面板(小节网格选择器)。
//
// 模型:一个 switch(总闸)+ 一个永远非空的 selection。
//   - switch 关:面板主体隐藏,显示置灰提示;不循环。
//   - switch 开:选区永不为空——从未拖过则全选,拖过则是拖的范围。
//   - 无"清空"状态,拖拽最少 1 小节。唯一快捷动作 = [整曲循环]。
//
// 交互(即时生效,无确定按钮):
//   - 拖选:按下小节格→拖到另一格→松手,选连续范围(含两端),首=A 末=B。
//   - 单击(无拖动位移):A=B=该小节,单小节自循环。
//   - 点已选范围内小节:不变;点范围外小节:重起新拖选。
//   - [整曲循环]:selection = 0..total-1。
//   - switch toggle:开时若 selection=null 自动设全选;关时不动 selection(保留)。
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
}

export interface AbPanelCallbacks {
  /** switch 切换(on)。 */
  onToggleLoop(on: boolean): void;
  /** 选区变化(松手时触发)。null 仅在 switch 从关→开且无记忆时由 App 决定全选;面板自身不会产出 null。 */
  onSelectionChange(sel: AbSelection): void;
  /** 面板开/关(点顶栏 AB 按钮)。 */
  onOpenChange(open: boolean): void;
}

export interface AbPanelHandle {
  el: HTMLElement;
  setOpen(open: boolean): void;
  setOn(on: boolean): void;
  setSelection(sel: AbSelection | null): void;
}

/** 判定单次 down→up 是否算"拖动"(位移阈值,px)。超过则按拖选处理,否则按单击。 */
const DRAG_THRESHOLD = 4;

export function buildAbPanel(initial: AbPanelInitial, cb: AbPanelCallbacks): AbPanelHandle {
  const el = document.createElement('div');
  el.className = 'ab-panel' + (initial.on ? ' on' : '');

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

  // ── switch 关时的置灰提示 ──
  const empty = document.createElement('div');
  empty.className = 'ab-empty';
  empty.textContent = '开启后可选择循环小节';
  el.appendChild(empty);

  // ── 第 2 层:网格主体 ──
  const body = document.createElement('div');
  body.className = 'ab-body';

  const hint = document.createElement('div');
  hint.className = 'ab-hint';
  hint.textContent = '拖选要循环的小节';
  body.appendChild(hint);

  const grid = document.createElement('div');
  grid.className = 'ab-grid';
  body.appendChild(grid);

  // ── 第 3 层:状态条 + 整曲循环 ──
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

  el.appendChild(body);

  // ── 状态 ──
  const total = Math.max(1, initial.totalMeasures);
  let selection: AbSelection | null = initial.selection;

  // ── 小节格构建 ──
  const cells: HTMLElement[] = [];
  for (let i = 0; i < total; i++) {
    const c = document.createElement('div');
    c.className = 'ab-cell';
    c.dataset.m = String(i);
    c.textContent = String(i + 1);   // 1-based 显示
    grid.appendChild(c);
    cells.push(c);
  }

  /** 应用选区到 DOM(高亮 + 角标 + 状态文字)。不触发回调。 */
  const applySelection = (sel: AbSelection | null) => {
    selection = sel;
    cells.forEach((c, i) => {
      const inside = sel != null && i >= sel.startMeasure && i <= sel.endMeasure;
      c.classList.toggle('selected', inside);
      // 角标
      const old = c.querySelector('.ab-mark');
      if (old) old.remove();
      if (sel != null) {
        let mark: string | null = null;
        if (i === sel.startMeasure) mark = 'A';
        if (i === sel.endMeasure) mark = sel.startMeasure === sel.endMeasure ? 'AB' : 'B';
        if (mark) {
          const m = document.createElement('span');
          m.className = 'ab-mark';
          m.textContent = mark;
          c.appendChild(m);
        }
      }
    });
    if (sel != null) {
      const count = sel.endMeasure - sel.startMeasure + 1;
      if (sel.startMeasure === 0 && sel.endMeasure === total - 1) {
        rangeLabel.innerHTML = `已选 <b>整曲</b>(共 ${count})`;
      } else {
        rangeLabel.innerHTML = `已选 <b>${sel.startMeasure + 1}–${sel.endMeasure + 1}</b>(共 ${count})`;
      }
    } else {
      rangeLabel.textContent = '';
    }
  };
  applySelection(selection);

  /** 应用开关态到 DOM。 */
  const applyOn = (on: boolean) => {
    el.classList.toggle('on', on);
    sw.classList.toggle('on', on);
  };

  // ── 拖选交互 ──
  // pointerdown 在格上记录起点;pointermove 实时预览;pointerup 提交(或单击)。
  let down: { m: number; x: number; y: number } | null = null;
  let dragging = false;

  const clearPreview = () => cells.forEach(c => c.classList.remove('preview'));

  /** 算 [a,b] 范围并加 preview class。 */
  const previewRange = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    cells.forEach((c, i) => {
      c.classList.toggle('preview', i >= lo && i <= hi);
    });
  };

  const cellAtPoint = (clientX: number, clientY: number): number => {
    // 用 elementsFromPoint 找当前指针下的格(拖动时鼠标可能快速越过若干格)。
    const hits = document.elementsFromPoint(clientX, clientY);
    for (const h of hits) {
      if (h.classList && h.classList.contains('ab-cell')) {
        const m = parseInt((h as HTMLElement).dataset.m || '-1', 10);
        if (m >= 0) return m;
      }
    }
    return -1;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!el.classList.contains('on')) return;   // switch 关时不响应
    const c = (e.target as HTMLElement).closest('.ab-cell') as HTMLElement | null;
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    const m = parseInt(c.dataset.m || '-1', 10);
    if (m < 0) return;
    down = { m, x: e.clientX, y: e.clientY };
    dragging = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!down) return;
    if (!dragging) {
      if (Math.abs(e.clientX - down.x) < DRAG_THRESHOLD && Math.abs(e.clientY - down.y) < DRAG_THRESHOLD) return;
      dragging = true;
      el.classList.add('dragging');
    }
    const cur = cellAtPoint(e.clientX, e.clientY);
    if (cur >= 0) {
      clearPreview();
      previewRange(down.m, cur);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!down) return;
    el.classList.remove('dragging');
    if (dragging) {
      // 拖选:提交范围。若松手时指针不在任何格上,用最后一次有效预览范围(若没预览过则退化为单击)。
      const cur = cellAtPoint(e.clientX, e.clientY);
      const end = cur >= 0 ? cur : down.m;
      clearPreview();
      const lo = Math.min(down.m, end), hi = Math.max(down.m, end);
      const sel: AbSelection = { startMeasure: lo, endMeasure: hi };
      applySelection(sel);
      cb.onSelectionChange(sel);
    } else {
      // 单击:单小节自循环 A=B。
      clearPreview();
      const sel: AbSelection = { startMeasure: down.m, endMeasure: down.m };
      applySelection(sel);
      cb.onSelectionChange(sel);
    }
    down = null;
    dragging = false;
  };

  grid.addEventListener('pointerdown', onPointerDown);
  // move/up 绑在 window 上,避免拖出格后丢失事件。
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // 面板内任意 click 阻止冒泡,避免触发顶栏"点外部关闭"。
  el.addEventListener('click', (e) => e.stopPropagation());

  return {
    el,
    setOpen(open: boolean) {
      el.classList.toggle('open', open);
      cb.onOpenChange(open);
    },
    setOn(on: boolean) {
      applyOn(on);
    },
    setSelection(sel: AbSelection | null) {
      applySelection(sel);
    },
  };
}
