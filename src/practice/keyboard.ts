// Keyboard —— 练琴页钢琴组件(白键/黑键 + 标注 + 高亮 + 浮空调整卡片)。
//
// 设计文档:docs/钢琴与方块组件设计.md §3。本文件按文档「八、实施步骤」Step 2 实现:
//   - 从 playback-card 抽取键盘构建/高亮/标注/指法映射(不删不改 playback-card)
//   - 黑键定位改用纯函数 key-coords(去掉 rAF 兜底,修正 padding 坑)
//   - 浮空调整卡片(桥接容器 + JS 控制,反复试错验证过,不用 CSS :hover)
//   - 键宽/高度调整(滑块连续控制键宽 + 高度图标上下拖)
//
// 复用边界(文档 §6.1):
//   - 直接 import:core/theory(noteToJianpu)、core/types(Note/KeySig/Piece)、key-coords
//   - 从 playback-card 复刻逻辑(本文件内重写,不 import playback-card):
//       highlightMidi(cfixed/follow)、midiName、midiSolfege、whiteKeyOffset、whiteKeyRange、keyboardSig
//   - 浮空卡片交互迁移自 practice-prototype.html(setupResizer, L770-781)
//
// 组件模式:命令式工厂 + Handle(同 playback-card.ts),不调用 App 方法,只通过 callbacks 报事件。

import './keyboard.css';
import { Note, Piece, KeySig } from '../core/types';
import { noteToJianpu } from '../core/theory';
import {
  KeyRange, whiteKeys, blackKeys, midiToX,
} from './key-coords';
import { Fingering, highlightMidi, whiteKeyOffset, CENTER_C } from './fingering';

// ── 指法模式(从 fingering.ts import) ─────────────────────
// cfixed:移调指法(简谱 1-7 映射 C 调白键,配合电钢琴移调);follow:原调指法,真实音高(含黑键)。

/** 键面标注方式。 */
export type KeyLabels = 'name' | 'solfege' | 'octave' | 'none';

// ── 常量(从 playback-card 复刻) ─────────────────────────
const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const ACCIDENTAL_GLYPH: Record<string, string> = { sharp: '♯', flat: '♭' };
const SOLFEGE_SYLLABLES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'];
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];

/** 键宽上下限(px,文档 §3.3):28~80。 */
/** 键宽上下限(px,文档 §3.3)。MIN 降到 16:使窄屏/宽屏下都能触发 88 键封顶
 *  (ceil(容器宽/16) > 52 白键 → 封顶 52,自动减小键宽铺满)。 */
const KEY_W_MIN = 16;
const KEY_W_MAX = 80;
/** 键盘高度上下限(px,文档 §3.3):80 ~ 视口 40%。 */
const KB_H_MIN = 80;
const KB_H_MAX_RATIO = 0.4;
/** 默认键盘高度(px)。 */
const KB_H_DEFAULT = 140;
/** 默认白键宽(px)。 */
const KEY_W_DEFAULT = 44;

// ── 小工具(从 playback-card 复刻) ───────────────────────
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function midiName(midi: number): { name: string; octave: number; isBlack: boolean } {
  const pc = ((midi % 12) + 12) % 12;
  return { name: NAMES_SHARP[pc], octave: Math.floor(midi / 12) - 1, isBlack: !WHITE_PCS.includes(pc) };
}

function isC(midi: number): boolean { return ((midi % 12) + 12) % 12 === 0; }

/** midi → 首调唱名(do re mi,黑键带升号)。(复刻 playback-card L138-144) */
function midiSolfege(midi: number, key: KeySig): string {
  const g = noteToJianpu({ midi, duration: 'quarter', dotted: false, accidental: null } as Note, key);
  if (!g || g.digit === 0) return '';
  const acc = g.accidental ? ACCIDENTAL_GLYPH[g.accidental] : '';
  return `${acc}${SOLFEGE_SYLLABLES[g.digit - 1]}`;
}

/** 以中央 C(60) 为中心、向两侧对称扩展白键,直到覆盖乐谱音域。(复刻 playback-card L101-120)
 *  返回白键 midi 数组(用于构造 KeyRange + 渲染白键)。 */
export function whiteKeyRange(piece: Piece): number[] {
  const midis = [
    ...piece.notes.map(n => n.midi),
    ...piece.treble.map(n => n.midi),
    ...piece.bass.map(n => n.midi),
  ].filter((m): m is number => m !== null);
  const MIN_WING = 7;
  let needAbove = MIN_WING, needBelow = MIN_WING;
  if (midis.length) {
    const maxMidi = Math.max(...midis);
    const minMidi = Math.min(...midis);
    needAbove = Math.max(needAbove, Math.ceil((maxMidi - CENTER_C) / 1.75) + 1);
    needBelow = Math.max(needBelow, Math.ceil((CENTER_C - minMidi) / 1.75) + 1);
  }
  const wing = Math.max(needAbove, needBelow);
  const whites: number[] = [];
  for (let i = -wing; i <= wing; i++) whites.push(whiteKeyOffset(CENTER_C, i));
  return whites;
}

/** 从白键 midi 数组构造 KeyRange(low/high 取首尾白键)。 */
export function rangeFromWhites(whites: number[]): KeyRange {
  if (whites.length === 0) return { low: CENTER_C, high: CENTER_C + 12 };
  return { low: whites[0], high: whites[whites.length - 1] };
}

// ── 接口(文档 §3.7) ──────────────────────────────────────

export interface KeyboardInitial {
  /** 音域(默认按谱面自动,用户可浮空卡片调)。 */
  range: KeyRange;
  /** 键盘高度 px(用户可浮空卡片调)。 */
  height: number;
  /** 白键宽 px(用户可浮空卡片调,默认 44)。键数 = ceil(容器宽/白键宽) 补满。 */
  keyWidth?: number;
  /** 键面标注。 */
  labels: KeyLabels;
  /** 指法模式。 */
  fingering: Fingering;
  /** 调号(唱名/指法映射用)。 */
  key: KeySig;
}

export interface KeyboardCallbacks {
  /** 用户拖键宽滑块改了键宽/音域 → controller 据此更新方块的坐标(midiToX 重算)。
   *  方块需要 range 和 whiteW 才能算 px 坐标,两个一起传。 */
  onKeyLayoutChange?: (info: { range: KeyRange; whiteW: number }) => void;
  /** 用户拖高度图标改了高度 → controller 据此调 waterfall.setBounds(判定线移动)。 */
  onHeightChange?: (height: number) => void;
  onLabelChange?: (labels: KeyLabels) => void;
  onFingeringChange?: (f: string) => void;
}

/** 带左右手标识的活跃音(controller 算好后喂给键盘)。
 *  hand 决定高亮颜色:R=蓝(右手)、L=橙(左手),与方块颜色一致(文档 §5.2)。 */
export interface ActiveNote { midi: number; hand: 'R' | 'L'; }

export interface KeyboardHandle {
  el: HTMLElement;
  /** controller 每帧调:传入当前响的原始 midi 集合(带左右手)。键盘内部做指法映射后点灯。 */
  setActiveMidis(items: ActiveNote[]): void;
  setHeight(height: number): void;
  setLabels(labels: KeyLabels): void;
  setFingering(f: Fingering): void;
  /** 清除所有高亮(停止/暂停时)。 */
  clearHighlight(): void;
  /** 当前音域(供 controller 初始化方块用)。 */
  getRange(): KeyRange;
  /** 当前白键宽 px(供 controller 初始化方块坐标用)。 */
  getKeyWidth(): number;
  /** 当前高度(供 controller 算方块区下边界用)。 */
  getHeight(): number;
}

// ── 工厂:buildKeyboard ───────────────────────────────────

/** 构建练琴页钢琴组件。返回 Handle。 */
export function buildKeyboard(initial: KeyboardInitial, cb: KeyboardCallbacks): KeyboardHandle {
  const callbacks = cb;
  let range: KeyRange = initial.range;
  let height: number = Math.max(KB_H_MIN, Math.min(initial.height || KB_H_DEFAULT, window.innerHeight * KB_H_MAX_RATIO));
  let whiteW: number = Math.max(KEY_W_MIN, Math.min(initial.keyWidth ?? KEY_W_DEFAULT, KEY_W_MAX));
  let labels: KeyLabels = initial.labels;
  let fingering: Fingering = initial.fingering;
  let key: KeySig = initial.key;

  // 外层容器(承载键盘 + 浮空卡片)。
  const el = h('div', 'kb-keyboard');
  el.style.height = height + 'px';

  // 键区(无 padding,overflow 裁超出键;flex center 居中 inner)。
  const keysEl = h('div', 'kb-keys');
  el.appendChild(keysEl);
  // 内层容器:装白键+黑键,宽度 = 键盘总宽(白键数×whiteW),被 keysEl 居中。
  // 黑键 absolute 相对 inner 左缘,白键在 inner 内左对齐 —— 黑白键同源,无需手动偏移。
  // 方块组件的容器也需和 inner 同款居中(由 controller 用 getKbOffset 算偏移)。
  let keysInner: HTMLElement = h('div', 'kb-keys-inner');
  keysEl.appendChild(keysInner);

  // midi → 键元素 映射(重建时填充),供高亮切 class。
  let keyElByMidi = new Map<number, HTMLElement>();
  // 当前重建签名(音域+标注),变化才重建。
  let keyboardSig = '';

  // 当前高亮的活跃音(带左右手,原始 midi),供标注/指法切换后重算高亮。
  let activeRawMidisItems: ActiveNote[] = [];

  /** 构建键盘 DOM:白键固定宽 px + 黑键 px 定位。
   *  不用 rAF——纯函数与 DOM 同一套数学(文档 §3.2)。
   *  键宽 = whiteW(精确 px),键数 = ceil(容器宽/whiteW) 补满,超出由 .kb-keys overflow 裁。 */
  function buildKeyboardDOM(): void {
    keysEl.innerHTML = '';
    // 重建 inner(innerHTML 清空了)。
    keysInner = h('div', 'kb-keys-inner');
    keysEl.appendChild(keysInner);
    keyElByMidi = new Map();
    const whites = whiteKeys(range);
    const blks = blackKeys(range);
    const bw = whiteW * 0.6;   // 黑键宽 = 白键宽 × 0.6
    // inner 宽度 = 白键数 × whiteW(键盘总宽)。keysEl flex center 居中 inner。
    keysInner.style.width = (whites.length * whiteW) + 'px';

    // 白键:固定宽 px,在 inner 内从左铺起。
    for (const wmidi of whites) {
      const k = h('div', 'kb-key-w');
      k.dataset.midi = String(wmidi);
      if (wmidi === CENTER_C) k.classList.add('kb-center-c');
      k.style.width = whiteW + 'px';
      // 标注
      appendLabel(k, wmidi);
      keysInner.appendChild(k);
      keyElByMidi.set(wmidi, k);
    }
    // 黑键:绝对定位 px(在白键之上,z-index 3)。left 相对 inner 左缘 = midiToX,与方块同基准。
    for (const bmidi of blks) {
      const b = h('div', 'kb-key-b');
      b.dataset.midi = String(bmidi);
      b.style.left = midiToX(bmidi, range, whiteW) + 'px';
      b.style.width = bw + 'px';
      appendLabel(b, bmidi);
      keysInner.appendChild(b);
      keyElByMidi.set(bmidi, b);
    }
    // 签名:音域 + 标注(键宽变化走轻量 updateKeyWidths,不进签名)。
    keyboardSig = sigFor(range, labels);
  }

  /** 给一个键追加标注子元素。 */
  function appendLabel(kEl: HTMLElement, midi: number): void {
    if (labels === 'none') return;
    if (labels === 'octave') {
      if (isC(midi)) kEl.appendChild(h('div', 'kb-koctave', `C${midiName(midi).octave}`));
      return;
    }
    if (labels === 'name') {
      const nm = midiName(midi);
      kEl.appendChild(h('div', 'kb-klabel', `${nm.name}${nm.octave}`));
      return;
    }
    // solfege
    const sf = midiSolfege(midi, key);
    if (sf) kEl.appendChild(h('div', 'kb-ksolfege', sf));
  }

  /** 重建签名(音域 + 标注)。不含键宽 —— 键宽变化走轻量 updateKeyWidths,不重建 DOM。 */
  function sigFor(r: KeyRange, lbl: KeyLabels): string {
    return `${r.low}-${r.high}|${lbl}`;
  }

  /** 音域/标注变化时重建(签名比对);键宽变化只轻量更新 width/left,不重建。 */
  function maybeRebuild(): void {
    const sig = sigFor(range, labels);
    if (sig !== keyboardSig) {
      buildKeyboardDOM();
      // 重建后重应用高亮(keyElByMidi 换了新元素)。
      applyHighlight();
    } else {
      // 键数没变,只更新现有键的 width/left(轻量,拖动不卡)。
      updateKeyWidths();
    }
  }

  /** 轻量更新所有键的 width/left + inner 宽度(键宽变化但键数不变时用,不重建 DOM)。 */
  function updateKeyWidths(): void {
    const bw = whiteW * 0.6;
    // inner 宽度 = 白键数 × whiteW(键宽变了 inner 宽度也要跟着变,否则居中错位)。
    keysInner.style.width = (whiteKeys(range).length * whiteW) + 'px';
    keyElByMidi.forEach((el, midi) => {
      if (el.classList.contains('kb-key-w')) {
        el.style.width = whiteW + 'px';
      } else {
        el.style.left = midiToX(midi, range, whiteW) + 'px';
        el.style.width = bw + 'px';
      }
    });
  }

  /** 指法映射后切 .glow-R/.glow-L class(不重建,零闪烁)。
   *  原始 midi 经 highlightMidi(cfixed/follow)映射成要点亮的键 midi,
   *  按 hand 决定颜色:R=蓝、L=橙(文档 §5.2,与方块颜色一致)。 */
  function applyHighlight(): void {
    keyElByMidi.forEach(el => { el.classList.remove('glow-R', 'glow-L'); });
    for (const item of activeRawMidisItems) {
      const target = highlightMidi({ midi: item.midi, duration: 'quarter', dotted: false, accidental: null } as Note, key, fingering);
      if (target === null) continue;
      const el = keyElByMidi.get(target);
      if (el) el.classList.add('glow-' + item.hand);
    }
  }

  // ── 浮空调整卡片(桥接容器 + JS 控制,文档 §3.3) ──
  // 迁移自 practice-prototype.html setupResizer(L770-781) + DOM(L519-538)。
  const bridge = h('div', 'kb-resizer-bridge');
  const zone = h('div', 'kb-resizer-zone');
  const card = h('div', 'kb-resizer-card');
  // 卡片内:左键宽滑块 + 右高度图标
  const keywidthBox = h('div', 'kb-resizer-keywidth');
  const kwLabel = h('span', 'kb-resizer-label');
  kwLabel.innerHTML = '键宽 <b>0</b>';
  const track = h('div', 'kb-resizer-track');
  const fill = h('div', 'kb-resizer-fill');
  const thumb = h('div', 'kb-resizer-thumb');
  track.append(fill, thumb);
  keywidthBox.append(kwLabel, track);

  const heightBox = h('div', 'kb-resizer-height');
  heightBox.title = '上下拖改键盘高度';
  const chevUp = h('div', 'kb-h-chev-up');
  const gripLabel = h('div', 'kb-grip-label', '高度');
  const chevDown = h('div', 'kb-h-chev-down');
  heightBox.append(chevUp, gripLabel, chevDown);

  card.append(keywidthBox, heightBox);
  bridge.append(zone, card);
  el.appendChild(bridge);

  // 显隐逻辑(JS 控制,不用 CSS :hover —— 文档反复试错验证过的结论)。
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const show = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    card.classList.add('open');
    bridge.style.pointerEvents = 'auto';
  };
  const hideLater = () => {
    hideTimer = setTimeout(() => {
      card.classList.remove('open');
      bridge.style.pointerEvents = 'none';
    }, 150);
  };
  zone.addEventListener('mouseenter', show);
  bridge.addEventListener('mouseenter', show);   // 鼠标在 bridge 内(含卡片)时保持
  bridge.addEventListener('mouseleave', hideLater);

  // ── 键宽滑块拖动(左右拖改键宽 px,键数 ceil 补满) ──
  // 文档 §3.3:用户拖滑块控制每个白键宽(连续值,精确 px),键数 = ceil(容器宽/白键宽) 补满。
  // 键细了键就多了,键盘总宽 = 键数×白键宽,超出容器部分由 .kb-keys overflow 裁掉。
  let dragKeyW = false;
  const onKeyWDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragKeyW = true;
    show();   // 拖动期间保持卡片显示
    window.addEventListener('mousemove', onKeyWMove);
    window.addEventListener('mouseup', onKeyWUp);
  };
  const onKeyWMove = (e: MouseEvent) => {
    if (!dragKeyW) return;
    // 鼠标 x 相对轨道 → 白键宽 px(保留一位小数,连续精细调节)。
    const tr = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - tr.left) / tr.width));
    // 轨道两端对应 KEY_W_MIN ~ KEY_W_MAX。
    const newW = Math.round((KEY_W_MIN + ratio * (KEY_W_MAX - KEY_W_MIN)) * 10) / 10;
    applyKeyWidth(newW);
  };
  const onKeyWUp = () => {
    dragKeyW = false;
    window.removeEventListener('mousemove', onKeyWMove);
    window.removeEventListener('mouseup', onKeyWUp);
  };
  track.addEventListener('mousedown', onKeyWDown);
  thumb.addEventListener('mousedown', onKeyWDown);

  /** 应用键宽。
   *  逻辑:
   *  1. 期望键数 = ceil(容器宽/白键宽)。
   *  2. 若 ≤ 52(88键白键上限):键数 = 期望值,白键宽 = 设定值,超出容器裁掉。
   *  3. 若 > 52:封顶 52 键(全88键)。白键宽仍 = 设定值(尊重用户)。
   *     - 若 52×设定宽 > 容器宽(88键超出):正常裁掉。
   *     - 若 52×设定宽 < 容器宽(88键比容器窄):键盘居中,两侧留白。
   *  以中央 C 为中心向两侧对称扩展算音域。触发 onKeyLayoutChange。 */
  function applyKeyWidth(newWhiteW: number): void {
    const containerW = keysEl.clientWidth;
    if (containerW <= 0) return;
    const MAX_WHITE = 52;   // 88 键的白键数(A0..C8)
    let whiteCount = Math.max(1, Math.ceil(containerW / newWhiteW));
    // 超过 88 键白键上限:封顶 52,白键宽保持设定值(不加大,尊重用户;窄了居中)。
    if (whiteCount > MAX_WHITE) whiteCount = MAX_WHITE;
    // 算音域:以中央 C 为中心,向两侧对称扩展 whiteCount 个白键。
    const half = Math.floor((whiteCount - 1) / 2);
    let newLow = whiteKeyOffset(CENTER_C, -half);
    let newHigh = whiteKeyOffset(CENTER_C, whiteCount - 1 - half);
    // clamp 88 键边界,撞边界向另一侧补。
    if (newLow < 21) {
      newLow = 21;
      newHigh = whiteKeyOffset(newLow, whiteCount - 1);
      if (newHigh > 108) newHigh = 108;
    } else if (newHigh > 108) {
      newHigh = 108;
      newLow = whiteKeyOffset(newHigh, -(whiteCount - 1));
      if (newLow < 21) newLow = 21;
    }
    range = { low: newLow, high: newHigh };
    whiteW = newWhiteW;
    // inner 宽度 = 键盘总宽,由 CSS margin:0 auto 居中(88键封顶键盘比容器窄时居中留白,
    // 超出容器时 keysEl overflow 裁掉)。黑白键都在 inner 内,同源对齐,无需 JS 偏移。
    maybeRebuild();
    updateSliderUI();
    callbacks.onKeyLayoutChange?.({ range, whiteW });
  }

  /** 更新滑块 UI(fill 宽 + thumb 位置 + 数值显示)。
   *  显示值 = whiteW(直接读设定值,一位小数)。 */
  function updateSliderUI(): void {
    const ratio = Math.max(0, Math.min(1, (whiteW - KEY_W_MIN) / (KEY_W_MAX - KEY_W_MIN)));
    fill.style.width = (ratio * 100) + '%';
    thumb.style.left = (ratio * 100) + '%';
    const b = kwLabel.querySelector('b');
    if (b) b.textContent = whiteW.toFixed(1);
  }

  // ── 高度图标拖动(上下拖改键盘高度,底边固定顶边移) ──
  let dragHeight = false;
  let heightStartY = 0;
  let heightStartH = 0;
  const onHeightDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragHeight = true;
    heightStartY = e.clientY;
    heightStartH = height;
    show();
    window.addEventListener('mousemove', onHeightMove);
    window.addEventListener('mouseup', onHeightUp);
  };
  const onHeightMove = (e: MouseEvent) => {
    if (!dragHeight) return;
    // 向上拖(dy 负)→ 增高。
    const dy = heightStartY - e.clientY;
    const maxH = window.innerHeight * KB_H_MAX_RATIO;
    const newH = Math.max(KB_H_MIN, Math.min(maxH, heightStartH + dy));
    applyHeight(newH);
  };
  const onHeightUp = () => {
    dragHeight = false;
    window.removeEventListener('mousemove', onHeightMove);
    window.removeEventListener('mouseup', onHeightUp);
  };
  heightBox.addEventListener('mousedown', onHeightDown);

  /** 应用键盘高度。触发 onHeightChange。 */
  function applyHeight(newH: number): void {
    height = newH;
    el.style.height = height + 'px';
    callbacks.onHeightChange?.(height);
  }

  // ── 初始化 ──
  buildKeyboardDOM();
  // 延迟:等布局完成(clientWidth 才准)后,按容器宽重算键数铺满(applyKeyWidth 用 ceil(容器宽/whiteW)),
  // 并更新滑块 UI。初始 buildKeyboardDOM 用传入 range 建(可能比容器窄/宽),这里校正到铺满。
  requestAnimationFrame(() => {
    applyKeyWidth(whiteW);
    updateSliderUI();
  });

  // resize 时重算滑块 UI(容器宽变了,白键宽 px 变)。
  window.addEventListener('resize', () => {
    updateSliderUI();
    // 高度上限随视口变。
    const maxH = window.innerHeight * KB_H_MAX_RATIO;
    if (height > maxH) applyHeight(maxH);
  });

  return {
    el,
    setActiveMidis(items: ActiveNote[]) {
      activeRawMidisItems = items;
      applyHighlight();
    },
    setHeight(newH: number) {
      applyHeight(newH);
    },
    setLabels(lbl: KeyLabels) {
      labels = lbl;
      maybeRebuild();
      callbacks.onLabelChange?.(labels);
    },
    setFingering(f: Fingering) {
      fingering = f;
      // 指法变化只影响高亮映射,不重建键盘。
      applyHighlight();
      callbacks.onFingeringChange?.(fingering);
    },
    clearHighlight() {
      activeRawMidisItems = [];
      keyElByMidi.forEach(el => { el.classList.remove('glow-R', 'glow-L'); });
    },
    getRange() { return range; },
    getKeyWidth() { return whiteW; },
    getHeight() { return height; },
  };
}
