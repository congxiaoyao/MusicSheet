// MeasureSelector —— 小节选择器独立组件。最终方案。
//
// 核心几何:选框是一个「块」(视觉叠加层),和书签平级。
// 内部装「左把手 + 选中书签 + 右把手」。选框两侧间距 10(紧),正常书签间距 15,
// 框内书签间距 15。跨选框看相邻书签 → 距离远大于 15(因选框本身厚)→ 非等间距。
//
// ★ 动画关键(不挪窝方案):所有书签永远留在 track(position:absolute + transform:translateX
//    定位),进出选框只改 transform 目标值 + toggle .inside class,**绝不换层(appendChild)**。
//    换层会打断 CSS transition(旧 transform 失效、起点被重置成 flex 流位置)→ 跨格瞬移。
//    不挪窝后 transform 连续变化 → transition 全程连贯 → 跨格/补位丝滑。
//    选框 ms-sel 是纯装饰叠加层(pointer-events:none),只画背景/边框/投影。
//
// 动画(用户确认):
// 1. 选框边界(把手):拖拽时完全跟手(逐帧重算,无 transition)。手到哪框到哪。
// 2. 书签跨格(框外↔框内)与距离突变:统一 ~160ms 弹性 transition(不挪窝后自然连贯)。
//    几何推演:每次跨格只有 1~2 个书签移动 ±12px,其余不动 → 统一时长足够。
// 3. 点击书签跳转:选框滑动到新书签(~250ms)。
// 4. 增删小节:alpha(0.7→1,~200ms)。
// 5. 删除叉:hover 弹性缩放显隐(scale 0.5→1,~150ms)。

export interface MeasureSelectorState {
  totalMeasures: number;
  start: number;
  count: number;
  hasContent?: boolean[];
}

export interface MeasureSelectorCallbacks {
  onChange: (start: number, count: number) => void;
  onDeleteMeasure: (measureIndex0Based: number) => void;
  onAddMeasure: () => void;
}

export interface MeasureSelectorHandle {
  el: HTMLElement;
  refresh: (state: MeasureSelectorState) => void;
  setSelection: (start: number, count: number) => void;
}

// 尺寸常量(px)。
const BLOCK_W = 44;
const GAP_NORMAL = 15;      // 正常书签间距(框外/框内)
const GAP_SEL_SIDE = 10;    // 选框与左右书签的间距(更紧)
const GAP_GRIP = 6;         // 把手到框内书签的间距
const HANDLE_W = 5;
const SEL_PAD_X = 6;        // 选框左右 padding(安全区:把手到框边)
const CLICK_THRESHOLD = 4;
const PAD_EDGE = 18;        // 轨道两端内边距

export function buildMeasureSelector(initial: MeasureSelectorState, cb: MeasureSelectorCallbacks): MeasureSelectorHandle {
  const state: MeasureSelectorState = { ...initial, hasContent: initial.hasContent ?? [] };
  const wrap = document.createElement('div');
  wrap.className = 'ms-wrap';
  const track = document.createElement('div');   // 流式撑开 wrap 的可滚动宽度;absolute 子元素的定位上下文
  track.className = 'ms-track';

  // 元素(都挂在 track 上,平级)。
  // 选框分两层:sel=底色层(z:0,在书签下,框内书签可见);selBorder=边框层(z:3,在书签上,
  //   边框永不被滑过的框外书签白底盖住)。
  const sel = document.createElement('div'); sel.className = 'ms-sel';
  const selBorder = document.createElement('div'); selBorder.className = 'ms-sel-border';
  const leftGrip = document.createElement('div'); leftGrip.className = 'ms-grip ms-grip-l';
  const rightGrip = document.createElement('div'); rightGrip.className = 'ms-grip ms-grip-r';
  const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'ms-add'; addBtn.textContent = '+'; addBtn.title = '末尾加一小节';
  let blocks: { el: HTMLElement; idx: number }[] = [];

  let drag: { mode: 'l' | 'r' | 'm'; initStart: number; initCount: number; startX: number } | null = null;
  let downInfo: { x: number; y: number; idx: number } | null = null;

  const clamp = (s: number, c: number) => {
    const t = state.totalMeasures;
    s = Math.max(0, Math.min(s, t - 1));
    c = Math.max(1, Math.min(c, t - s));
    return { s, c };
  };

  /** 创建单个书签。enterAnim:创建时是否带进场动画(加小节用)。 */
  const makeBlock = (idx: number, enterAnim = false): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'ms-blk';
    el.dataset.idx = String(idx);
    el.innerHTML = `<span class="ms-num">${idx + 1}</span>`;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'ms-del'; del.textContent = '×';
    del.title = `删除第 ${idx + 1} 小节`;
    del.addEventListener('click', (e) => { e.stopPropagation(); cb.onDeleteMeasure(idx); });
    el.appendChild(del);
    el.addEventListener('pointerdown', (e) => { downInfo = { x: e.clientX, y: e.clientY, idx }; });
    if (enterAnim) el.classList.add('ms-enter');
    return el;
  };

  /** 同步书签到当前 totalMeasures(增量,保留旧元素以获得补位/退场过渡)。
   *  删除是按「原 idx」删一个,后续书签 idx 全部 -1 重排。实现:重建 dataset.idx + 数字,
   *  但复用 DOM 元素(保留 transition 起点)。尾部多出来的元素 = 退场目标。
   *  animateNew: 新增书签是否带进场动画(init 时传 false,初始书签直接显示)。 */
  const syncBlocks = (animateNew = true) => {
    const total = state.totalMeasures;
    const prev = blocks.length;
    if (total > prev) {
      for (let i = prev; i < total; i++) {
        const el = makeBlock(i, animateNew);
        track.appendChild(el);
        blocks.push({ el, idx: i });
      }
    } else if (total < prev) {
      const removed = blocks.splice(total);
      removed.forEach(b => {
        b.el.classList.add('ms-leave');
        const host = b.el;
        setTimeout(() => host.remove(), 220);
      });
    }
    blocks.forEach((b, i) => {
      b.idx = i;
      b.el.dataset.idx = String(i);
      const num = b.el.querySelector('.ms-num');
      if (num) num.textContent = String(i + 1);
      b.el.classList.toggle('has-content', !!state.hasContent?.[i]);
    });
  };

  /** 计算每个元素的 x 坐标 + 选框的位置/尺寸。
   *  布局:[pad][书签0..start-1 (gap15)][gap10][选框][gap10][书签start+count.. (gap15)][+]
   *  选框内(视觉):[pad6][把手][gap6][书签..(gap15)][gap6][把手][pad6]
   *  ★ 不挪窝:框内书签的 x 也由本函数算出(= selX + pad + handle + gap + 偏移),
   *    用 transform 定位,不走 selInner flex 流。
   *  返回:{ blockX: Map<idx,x>(含全部书签), selX, selW, selRight, addX, totalW, gripLX, gripRX } */
  const computeX = () => {
    const start = state.start, count = state.count, total = state.totalMeasures;
    const blockX = new Map<number, number>();
    let x = PAD_EDGE;
    // 框左外书签
    for (let i = 0; i < start; i++) { blockX.set(i, x); x += BLOCK_W + (i < start - 1 ? GAP_NORMAL : GAP_SEL_SIDE); }
    // 选框起点
    const selX = x;
    // 选框内部宽度:pad + 把手 + gap + count书签(每书签BLOCK_W + 之间gap15) + gap + 把手 + pad
    const innerBlocksW = count * BLOCK_W + (count - 1) * GAP_NORMAL;
    const selW = SEL_PAD_X + HANDLE_W + GAP_GRIP + innerBlocksW + GAP_GRIP + HANDLE_W + SEL_PAD_X;
    const selRight = selX + selW;
    // 框内书签 x(不挪窝:由 computeX 算,transform 定位)
    const innerStartX = selX + SEL_PAD_X + HANDLE_W + GAP_GRIP;
    for (let k = 0; k < count; k++) blockX.set(start + k, innerStartX + k * (BLOCK_W + GAP_NORMAL));
    // 框右外书签
    x = selRight + GAP_SEL_SIDE;
    for (let i = start + count; i < total; i++) { blockX.set(i, x); x += BLOCK_W + (i < total - 1 ? GAP_NORMAL : 0); }
    const addX = x + GAP_NORMAL;
    // 把手 x(跟随选框左右缘内侧)
    const gripLX = selX + SEL_PAD_X;
    const gripRX = selRight - SEL_PAD_X - HANDLE_W;
    return { blockX, selX, selW, selRight, addX, totalW: addX + BLOCK_W + PAD_EDGE, gripLX, gripRX };
  };

  /** 应用布局。selAnimated: 选框是否带 transition(拖拽中 false=跟手;其它 true)。
   *  ★ 书签始终带 transition(跨格/补位平滑);parent 恒为 track(不挪窝)。 */
  const apply = (selAnimated: boolean) => {
    const { blockX, selX, selW, addX, totalW, gripLX, gripRX } = computeX();
    track.style.width = totalW + 'px';
    // 所有书签:只改 transform + toggle inside class,绝不 appendChild(不挪窝)。
    blocks.forEach(b => {
      const inside = b.idx >= state.start && b.idx < state.start + state.count;
      b.el.classList.toggle('inside', inside);
      const px = blockX.get(b.idx);
      if (px !== undefined) b.el.style.transform = `translateX(${px}px)`;
    });
    // 选框底色层 + 边框层(同步位置/尺寸;边框层 z 高,边框不被书签盖)
    sel.style.transition = selAnimated ? '' : 'none';
    selBorder.style.transition = selAnimated ? '' : 'none';
    sel.style.transform = `translateX(${selX}px)`;
    selBorder.style.transform = `translateX(${selX}px)`;
    sel.style.width = selW + 'px';
    selBorder.style.width = selW + 'px';
    // 把手(跟随选框左右缘)
    leftGrip.style.transition = selAnimated ? '' : 'none';
    rightGrip.style.transition = selAnimated ? '' : 'none';
    leftGrip.style.transform = `translateX(${gripLX}px)`;
    rightGrip.style.transform = `translateX(${gripRX}px)`;
    // addBtn
    addBtn.style.transform = `translateX(${addX}px)`;
  };

  const init = () => {
    wrap.innerHTML = '';
    wrap.appendChild(track);
    track.appendChild(sel);          // 选框底色层(z:0,在书签下)
    track.appendChild(leftGrip);     // 把手(z:2,可命中)
    track.appendChild(rightGrip);
    track.appendChild(selBorder);    // 选框边框层(z:3,在书签上,边框永不被盖)—— 必须在书签挂载后追加(z 相同时 DOM 顺序后者在上)
    track.appendChild(rightGrip);
    syncBlocks(false);   // 初始构建:书签直接显示,无进场动画(动画只用于 refresh 加小节)
    track.appendChild(addBtn);
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); cb.onAddMeasure(); });
    leftGrip.addEventListener('pointerdown', (e) => startDrag(e, 'l'));
    rightGrip.addEventListener('pointerdown', (e) => startDrag(e, 'r'));
    // 框体拖拽:wrap 上 pointerdown,按坐标命中(选框不再是书签父节点,无法靠事件冒泡)。
    wrap.addEventListener('pointerdown', onWrapDown);
    apply(false);
  };

  const startDrag = (e: PointerEvent, mode: 'l' | 'r') => {
    e.preventDefault(); e.stopPropagation();
    drag = { mode, initStart: state.start, initCount: state.count, startX: e.clientX };
    wrap.classList.add('ms-dragging');
  };

  /** wrap pointerdown:坐标命中测试。
   *  - 落在把手 rect 内:不管(把手各自已接 pointerdown + stopPropagation)。
   *  - 落在某书签 rect 内:不管(书签各自已接 pointerdown 设 downInfo)。
   *  - 落在选框横向区间(selX..selRight)内且不在任何书签内:启动框体横移 'm'。 */
  const onWrapDown = (e: PointerEvent) => {
    if (drag) return;
    const target = e.target as HTMLElement;
    // 把手/书签自己处理(它们 stopPropagation 或设 downInfo);这里只处理选框内空白。
    if (target.closest('.ms-grip') || target.closest('.ms-blk') || target.closest('.ms-add')) return;
    // 判断 clientX 是否落在选框内(用 sel 的 rect,已含滚动)
    const selRect = sel.getBoundingClientRect();
    if (e.clientX >= selRect.left && e.clientX <= selRect.right) {
      // 进一步:不能落在任何书签上(书签在选框内/外都可能有)
      const onBlock = blocks.some(b => {
        const r = b.el.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (onBlock) return;
      e.preventDefault();
      drag = { mode: 'm', initStart: state.start, initCount: state.count, startX: e.clientX };
      wrap.classList.add('ms-dragging');
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!drag) {
      if (downInfo && (Math.abs(e.clientX - downInfo.x) > CLICK_THRESHOLD || Math.abs(e.clientY - downInfo.y) > CLICK_THRESHOLD)) downInfo = null;
      return;
    }
    // move(框体横移):先过 4px 阈值才动作,否则当作点击(框体内点击无操作)。
    if (drag.mode === 'm') {
      if (Math.abs(e.clientX - drag.startX) < CLICK_THRESHOLD) return;
      const idx = xToNearestBlock(e.clientX);
      const maxStart = Math.max(0, state.totalMeasures - state.count);
      const ns = Math.max(0, Math.min(idx, maxStart));
      if (ns === state.start) return;
      state.start = ns;
      apply(false);   // 拖框体横移也跟手
      return;
    }
    const idx = xToNearestBlock(e.clientX);
    if (drag.mode === 'l') {
      const oldRight = drag.initStart + drag.initCount - 1;
      const ns = Math.max(0, Math.min(idx, oldRight));
      const nc = oldRight - ns + 1;
      if (nc <= 0) { finishDrag(); cb.onDeleteMeasure(state.totalMeasures - 1); return; }
      const cl = clamp(ns, nc); state.start = cl.s; state.count = cl.c;
    } else {
      const nc = Math.max(1, idx - drag.initStart + 1);
      if (idx < drag.initStart) { finishDrag(); cb.onDeleteMeasure(state.totalMeasures - 1); return; }
      const cl = clamp(drag.initStart, nc); state.start = cl.s; state.count = cl.c;
    }
    apply(false);
  };

  const finishDrag = () => {
    if (!drag) return;
    drag = null;
    wrap.classList.remove('ms-dragging');
    downInfo = null;
    cb.onChange(state.start, state.count);
    requestAnimationFrame(() => apply(true));
  };

  const onUp = () => {
    if (drag) { finishDrag(); return; }
    if (downInfo) {
      const idx = downInfo.idx; downInfo = null;
      const { s } = clamp(idx, state.count);
      state.start = s;
      apply(true);
      cb.onChange(state.start, state.count);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  const xToNearestBlock = (clientX: number): number => {
    let best = 0, bestD = Infinity;
    blocks.forEach(b => {
      const r = b.el.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - clientX);
      if (d < bestD) { bestD = d; best = b.idx; }
    });
    return best;
  };

  init();

  return {
    el: wrap,
    refresh: (s: MeasureSelectorState) => {
      const totalChanged = s.totalMeasures !== state.totalMeasures;
      state.totalMeasures = s.totalMeasures;
      state.hasContent = s.hasContent ?? state.hasContent;
      const cl = clamp(s.start ?? state.start, s.count ?? state.count);
      state.start = cl.s;
      state.count = cl.c;
      if (totalChanged) syncBlocks();
      else blocks.forEach(b => b.el.classList.toggle('has-content', !!state.hasContent?.[b.idx]));
      apply(true);
      if (totalChanged) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          blocks.forEach(b => b.el.classList.remove('ms-enter'));
        }));
      }
    },
    setSelection: (start: number, count: number) => {
      const cl = clamp(start, count); state.start = cl.s; state.count = cl.c; apply(true);
    },
  };
}
