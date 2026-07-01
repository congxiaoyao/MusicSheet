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
const GAP_SEL_SIDE = GAP_NORMAL;  // 选框与左右书签的间距:与正常间距一致(消除翻转跳变;选框"紧贴"感靠选框内部 padding/handle 区)
const GAP_GRIP = 6;         // 把手到框内书签的间距
const HANDLE_W = 5;
const SEL_PAD_X = 6;        // 选框左右 padding(安全区:把手到框边)
const CLICK_THRESHOLD = 4;
const PAD_EDGE = 18;        // 轨道两端内边距
const MAX_COUNT = 8;        // 选框最大宽度(8个小节)
// 选框最小宽度:两把手间留一个把手宽(不碰)。= pad*2 + handle*2 + grip*2 + handle(中间空隙一个把手宽)
const MIN_SELW = SEL_PAD_X * 2 + HANDLE_W * 2 + GAP_GRIP * 2 + HANDLE_W;

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

  let drag: { mode: 'l' | 'r' | 'm'; initStart: number; initCount: number; startX: number; initSelX: number; initSelRight: number } | null = null;
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

  /** 计算给定 start/count 的布局(纯函数,不依赖 state,供阻尼算边界用)。
   *  布局:[pad][书签0..start-1][选框][书签start+count..][+]
   *  选框内:[pad6][把手][gap6][书签..(gap15)][gap6][把手][pad6] */
  const computeXAt = (start: number, count: number, total: number) => {
    const blockX = new Map<number, number>();
    let x = PAD_EDGE;
    for (let i = 0; i < start; i++) { blockX.set(i, x); x += BLOCK_W + (i < start - 1 ? GAP_NORMAL : GAP_SEL_SIDE); }
    const selX = x;
    const innerBlocksW = count * BLOCK_W + (count - 1) * GAP_NORMAL;
    const selW = SEL_PAD_X + HANDLE_W + GAP_GRIP + innerBlocksW + GAP_GRIP + HANDLE_W + SEL_PAD_X;
    const selRight = selX + selW;
    const innerStartX = selX + SEL_PAD_X + HANDLE_W + GAP_GRIP;
    for (let k = 0; k < count; k++) blockX.set(start + k, innerStartX + k * (BLOCK_W + GAP_NORMAL));
    x = selRight + GAP_SEL_SIDE;
    const hasRightOut = start + count < total;
    for (let i = start + count; i < total; i++) { blockX.set(i, x); x += BLOCK_W + (i < total - 1 ? GAP_NORMAL : 0); }
    const addX = hasRightOut ? x + GAP_NORMAL : selRight + GAP_SEL_SIDE;
    const gripLX = selX + SEL_PAD_X;
    const gripRX = selRight - SEL_PAD_X - HANDLE_W;
    return { blockX, selX, selW, selRight, addX, totalW: addX + BLOCK_W + PAD_EDGE, gripLX, gripRX };
  };

  /** 计算当前 state 的布局。 */
  const computeX = () => computeXAt(state.start, state.count, state.totalMeasures);

  /** 稳定的小节中心表(track 坐标):基于"假设 start=refStart"算每个 idx 的稳态中心,
   *  不依赖 DOM getBoundingClientRect(避免拖拽 transition 中位置抖动导致吸附判定不准)。
   *  几何:idx<refStart 框左外(等间距);idx≥refStart 按"框内序列"算(从 refStart 的 selX 起,
   *  每书签 BLOCK_W+GAP_NORMAL)。这样拖右把手时,下一个待吸入小节的中心是稳定值,
   *  selRight 扫过它才 count+1(扫过中心吸附,非"最近小节")。 */
  const blockAxisCenters = (refStart: number): Map<number, number> => {
    const m = new Map<number, number>();
    const total = state.totalMeasures;
    // 框左外(idx<refStart):PAD_EDGE 起,等间距 BLOCK_W+GAP_NORMAL
    let x = PAD_EDGE;
    for (let i = 0; i < refStart && i < total; i++) { m.set(i, x + BLOCK_W / 2); x += BLOCK_W + GAP_NORMAL; }
    // refStart 的 selX(框左外末尾 + GAP_SEL_SIDE)
    const selX = x + (refStart > 0 ? GAP_SEL_SIDE - GAP_NORMAL : 0);  // 修正:末尾间距已是 GAP_NORMAL,补差到 GAP_SEL_SIDE
    // 框内序列(idx≥refStart):innerStartX 起,每 BLOCK_W+GAP_NORMAL
    const innerStartX = selX + SEL_PAD_X + HANDLE_W + GAP_GRIP;
    for (let i = refStart; i < total; i++) { m.set(i, innerStartX + (i - refStart) * (BLOCK_W + GAP_NORMAL) + BLOCK_W / 2); }
    return m;
  };

  /** 应用布局。selAnimated: 选框/selBorder/grip 是否带 transition(拖拽中 false=缘跟手无 transition;抬手 true=吸附)。
   *  ★ 书签/addX 始终用 computeX 稳态位置(动态间距)。
   *  dragOverride: 拖拽中选框缘跟手(覆盖 computeX 的 selX/selW/grip)。
   *    edge='r': 右缘=pos(左端 selX 固定,selW=pos-selX);拖右把手。
   *    edge='l': 左缘=pos,右端固定(selRightFixed,selW=selRightFixed-pos);拖左把手。
   *    edge='move': 整体平移 selX=pos(selW 稳态 count);拖框体。 */
  /** 应用布局。
   *  selAnimated: 选框/selBorder/grip 是否带 transition(拖拽中 false=缘跟手无 transition;松手吸附 true)。
   *  dragOverride: 拖拽中选框缘跟手(覆盖 computeX)。书签/addX 始终用 computeX 稳态。
   *  setTarget: false 时只设 transition + reflow(不设 transform/width 目标值),供 finishDrag 分两帧吸附用
   *    (从 transition:none 切到 CSS transition 时,先恢复 transition+reflow,下一帧再设值,Chrome 才触发过渡)。 */
  const apply = (selAnimated: boolean, dragOverride?: { edge: 'l' | 'r' | 'move'; pos: number }, setTarget = true) => {
    const { blockX, selX, selW, addX, totalW, gripLX, gripRX } = computeX();
    if (setTarget) {
      track.style.width = totalW + 'px';
      blocks.forEach(b => {
        const inside = b.idx >= state.start && b.idx < state.start + state.count;
        b.el.classList.toggle('inside', inside);
        const px = blockX.get(b.idx);
        if (px !== undefined) b.el.style.transform = `translateX(${px}px)`;
      });
    }
    let finalSelX = selX, finalSelW = selW, finalGripLX = gripLX, finalGripRX = gripRX;
    if (dragOverride?.edge === 'r') {
      const r = dragOverride.pos;
      finalSelW = Math.max(MIN_SELW, r - selX);   // 最小宽度:两把手不碰
      finalGripRX = selX + finalSelW - SEL_PAD_X - HANDLE_W;
    } else if (dragOverride?.edge === 'l') {
      const selRF = selX + selW;
      finalSelX = dragOverride.pos;
      finalSelW = Math.max(MIN_SELW, selRF - dragOverride.pos);   // 最小宽度
      finalGripLX = dragOverride.pos + SEL_PAD_X;
      finalGripRX = selRF - SEL_PAD_X - HANDLE_W;
    } else if (dragOverride?.edge === 'move') {
      finalSelX = dragOverride.pos;
      finalGripLX = dragOverride.pos + SEL_PAD_X;
      finalGripRX = dragOverride.pos + selW - SEL_PAD_X - HANDLE_W;
    }
    // transition 处理:selAnimated=true(吸附)时,显式设 inline transition(从拖拽的 'none' 切到明确值),
    // 强制 reflow 让 transition 生效,再设目标值 → 触发过渡。不能设 ''(回退 CSS),因 inline 'none'→'' 与
    // transform 同帧设值时 Chrome 不触发过渡(吸附会瞬跳)。
    // transition:selAnimated=true 显式设 inline transition(从拖拽 'none' 切到明确值);false 设 'none'。
    const trans = selAnimated ? 'transform 0.25s cubic-bezier(.34,1.3,.64,1), width 0.25s cubic-bezier(.34,1.3,.64,1)' : 'none';
    sel.style.transition = trans;
    selBorder.style.transition = trans;
    leftGrip.style.transition = trans;
    rightGrip.style.transition = trans;
    // reflow 让 transition 生效(从 'none' 切来时尤其需要)。
    if (selAnimated) { void sel.offsetWidth; void selBorder.offsetWidth; void leftGrip.offsetWidth; void rightGrip.offsetWidth; }
    if (!setTarget) return;   // 只设 transition + reflow,不设值(finishDrag 第一步)
    sel.style.transform = `translateX(${finalSelX}px)`;
    selBorder.style.transform = `translateX(${finalSelX}px)`;
    sel.style.width = finalSelW + 'px';
    selBorder.style.width = finalSelW + 'px';
    leftGrip.style.transform = `translateX(${finalGripLX}px)`;
    rightGrip.style.transform = `translateX(${finalGripRX}px)`;
    addBtn.style.transform = `translateX(${addX}px)`;
  };

  const init = () => {
    wrap.innerHTML = '';
    wrap.appendChild(track);
    track.appendChild(sel);          // 选框底色层(z:0,在书签下)
    track.appendChild(leftGrip);     // 把手(z:2,可命中)
    track.appendChild(rightGrip);
    track.appendChild(selBorder);    // 选框边框层(z:3,在书签上,边框永不被盖)—— 必须在书签挂载后追加(z 相同时 DOM 顺序后者在上)
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
    const x = computeX();   // 拖拽起始布局
    drag = { mode, initStart: state.start, initCount: state.count, startX: e.clientX, initSelX: x.selX, initSelRight: x.selRight };
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
      { const x = computeX(); drag = { mode: 'm', initStart: state.start, initCount: state.count, startX: e.clientX, initSelX: x.selX, initSelRight: x.selRight }; }
      wrap.classList.add('ms-dragging');
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!drag) {
      // 书签 pointerdown 后拖动:若拖动超阈值且该书签在选框内 → 转为框体平移(任意处可拖)。
      if (downInfo && (Math.abs(e.clientX - downInfo.x) > CLICK_THRESHOLD || Math.abs(e.clientY - downInfo.y) > CLICK_THRESHOLD)) {
        const insideSel = downInfo.idx >= state.start && downInfo.idx < state.start + state.count;
        if (insideSel) {
          const x = computeX();
          drag = { mode: 'm', initStart: state.start, initCount: state.count, startX: e.clientX, initSelX: x.selX, initSelRight: x.selRight };
          wrap.classList.add('ms-dragging');
        }
        downInfo = null;
      }
      return;
    }
    const trackLeft = track.getBoundingClientRect().left;
    const mxTrack = e.clientX - trackLeft;
    const axis = blockAxisCenters(drag.initStart);   // 基于 initStart 的稳定中心表(不受 transition 影响)
    // 阻尼:超出 [min,max] 的部分打 0.3 折(越往外越难拖),放手后 apply(true) 回弹到 clamp 合法位。
    const damp = (v: number, min: number, max: number) => {
      if (v < min) return min + (v - min) * 0.3;
      if (v > max) return max + (v - max) * 0.3;
      return v;
    };

    // ── 拖框体横移:边界内整体缘跟手(edge:'move');到边界时一缘固定另一缘阻尼(等效把手)。 ──
    if (drag.mode === 'm') {
      if (Math.abs(e.clientX - drag.startX) < CLICK_THRESHOLD) return;
      const count = drag.initCount;
      const maxStart = Math.max(0, state.totalMeasures - count);
      const minSelX = computeXAt(0, count, state.totalMeasures).selX;
      const maxSelX = computeXAt(maxStart, count, state.totalMeasures).selX;
      const raw = drag.initSelX + (e.clientX - drag.startX);
      let ns = maxStart;
      for (let s = 0; s <= maxStart; s++) { if ((axis.get(s) ?? Infinity) >= raw) { ns = s; break; } }
      ns = Math.max(0, Math.min(ns, maxStart));
      state.start = ns; state.count = count;
      if (raw < minSelX) {
        // 拖到最左:左缘阻尼(超出 minSelX 部分打 0.3 折),edge:'l' 右端用 computeX 稳态。
        apply(false, { edge: 'l', pos: minSelX + (raw - minSelX) * 0.3 });
      } else if (raw > maxSelX) {
        // 拖到最右:右缘阻尼(超出 maxSelX 部分打 0.3 折),edge:'r' 左端用 computeX 稳态。
        const maxSelR = computeXAt(maxStart, count, state.totalMeasures).selRight;
        apply(false, { edge: 'r', pos: maxSelR + (raw - maxSelX) * 0.3 });
      } else {
        apply(false, { edge: 'move', pos: raw });
      }
      return;
    }

    // ── 拖右把手:左端(initStart)固定,右缘跟手(selR=mxTrack)。count = 右缘越过的中心数。超范围阻尼 ──
    if (drag.mode === 'r') {
      // count 范围 [1, min(MAX_COUNT, total-start)]:超出阻尼。
      const maxCount = Math.min(MAX_COUNT, state.totalMeasures - drag.initStart);
      const maxR = computeXAt(drag.initStart, maxCount, state.totalMeasures).selRight;
      const minR = computeXAt(drag.initStart, 1, state.totalMeasures).selRight;
      const selRightDrag = damp(mxTrack, minR, maxR);
      let lastIdx = drag.initStart;
      for (let i = drag.initStart; i < state.totalMeasures; i++) { if ((axis.get(i) ?? Infinity) <= selRightDrag) lastIdx = i; else break; }
      let nc = lastIdx - drag.initStart + 1;
      nc = Math.max(1, Math.min(nc, maxCount));
      const cl = clamp(drag.initStart, nc); state.start = cl.s; state.count = cl.c;
      apply(false, { edge: 'r', pos: selRightDrag });
      return;
    }

    // ── 拖左把手:右端(initEnd)固定,左缘跟手(selL=mxTrack)。start=左缘扫过的书签。超范围阻尼 ──
    const initEnd = drag.initStart + drag.initCount - 1;
    const minL = computeXAt(0, initEnd + 1, state.totalMeasures).selX;
    const maxL = computeXAt(initEnd, 1, state.totalMeasures).selX;
    const selLeftDrag = damp(mxTrack, minL, maxL);
    let ns = initEnd;
    for (let s = 0; s <= initEnd; s++) { if ((axis.get(s) ?? Infinity) >= selLeftDrag) { ns = s; break; } }
    ns = Math.max(0, Math.min(ns, initEnd));
    const nc2 = initEnd - ns + 1;
    const cl2 = clamp(ns, nc2); state.start = cl2.s; state.count = cl2.c;
    apply(false, { edge: 'l', pos: selLeftDrag });
  };

  const finishDrag = () => {
    if (!drag) return;
    drag = null;
    wrap.classList.remove('ms-dragging');
    downInfo = null;
    cb.onChange(state.start, state.count);
    // 抬手吸附:用 Web Animations API(element.animate)从拖拽位平滑到稳态。
    // 绕过 CSS transition 的时序问题(从 inline transition:none 切到 CSS 值时 Chrome 不触发过渡)。
    // 先读拖拽位(当前 transform/width),再 apply(true) 设稳态目标,然后用 animate 从拖拽位→稳态。
    const elems = [sel, selBorder, leftGrip, rightGrip];
    const froms = elems.map(el => {
      const r = el.getBoundingClientRect();
      const wrapEl = document.querySelector('.ms-wrap');
      const w = wrapEl ? wrapEl.getBoundingClientRect() : new DOMRect();
      const m = el.style.transform.match(/translateX\(([-\d.]+)px\)/);
      return { x: m ? parseFloat(m[1]) : r.left - w.left, w: parseFloat(el.style.width) || r.width };
    });
    // 清除 inline transition,用 computeX 算稳态目标(不设到 DOM,避免 animate 启动前渲染跳变)。
    elems.forEach(el => { el.style.transition = 'none'; });
    const cx = computeX();
    const tos = [
      { x: cx.selX, w: cx.selW },
      { x: cx.selX, w: cx.selW },
      { x: cx.gripLX, w: HANDLE_W },
      { x: cx.gripRX, w: HANDLE_W },
    ];
    elems.forEach((el, i) => {
      const f = froms[i], t = tos[i];
      if (Math.abs(f.x - t.x) < 0.5 && Math.abs(f.w - t.w) < 0.5) {
        el.style.transform = `translateX(${t.x}px)`; el.style.width = t.w + 'px'; return;
      }
      const anim = el.animate(
        [{ transform: `translateX(${f.x}px)`, width: f.w + 'px' }, { transform: `translateX(${t.x}px)`, width: t.w + 'px' }],
        { duration: 250, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'none' }
      );
      anim.onfinish = () => { el.style.transform = `translateX(${t.x}px)`; el.style.width = t.w + 'px'; };
    });
    // 书签/add 也设稳态(它们有 CSS transition,自然过渡)
    blocks.forEach(b => { b.el.style.transform = `translateX(${cx.blockX.get(b.idx) ?? 0}px)`; });
    addBtn.style.transform = `translateX(${cx.addX}px)`;
  };

  const onUp = () => {
    if (drag) { finishDrag(); return; }
    if (downInfo) {
      const idx = downInfo.idx; downInfo = null;
      // 点书签跳转:start 让点击的书签落在选框内(count 不变)。点击的书签作为选框末尾对齐:
      // start = min(idx, total-count),保证 [start..start+count) 含 idx 且不越界。
      const maxStart = Math.max(0, state.totalMeasures - state.count);
      state.start = Math.max(0, Math.min(idx, maxStart));
      apply(true);
      cb.onChange(state.start, state.count);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

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
