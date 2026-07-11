// 公共坐标纯函数 —— 钢琴组件与方块组件的共同基准。
//
// 设计文档:docs/钢琴与方块组件设计.md §2。
// 核心问题:方块横轴 = 键盘位置。若 midiToX 属于某组件,另一个就得依赖它
// (时序耦合:键盘渲染后 midiToX 才准)。抽成纯函数后,两者各自调用,消除时序依赖,
// 且纯数学与 DOM 渲染用同一套数学,必然对齐,不需要 rAF 兜底。
//
// 坐标系基准(文档 §2.3,关键):
//   所有百分比相对「键区 content box」(白键实际排列的区域),不含键盘容器的 padding。
//   原型 practice-prototype.html 的 .pr-keys 无 padding,故白键 flex 等分 + 黑键百分比
//   定位天然一致。playback-card.ts 的坑:keyboard 有 padding:6px,CSS 百分比相对 padding
//   box(含 padding),累积偏差越往外越大 → 才用 rAF 读 DOM 兜底。新组件用纯函数 + 无 padding
//   容器,从根上消除偏差。
//
// 纯数学,零 DOM 依赖。

/** 白键音级集合(pitch class,C=0)。C D E F G A B。 */
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);

/** 键盘音域范围(low/high 均为 MIDI 音符号,含两端)。 */
export interface KeyRange {
  low: number;
  high: number;
}

/** 该 midi 是否白键(按 pitch class,C=0)。 */
export function isWhite(midi: number): boolean {
  return WHITE_PCS.has((((midi % 12) + 12) % 12));
}

/** 该 midi 是否黑键(按 pitch class)。 */
export function isBlack(midi: number): boolean {
  return !isWhite(midi);
}

/** 该音域下的白键 midi 序列(从 low 到 high,含两端,只取白键)。
 *  供键盘构建(白键 flex 等分)和方块对齐复用。 */
export function whiteKeys(range: KeyRange): number[] {
  const out: number[] = [];
  for (let m = range.low; m <= range.high; m++) {
    if (isWhite(m)) out.push(m);
  }
  return out;
}

/** 一个白键占键区 content box 的宽度百分比 = 100 / 白键数。 */
export function whiteKeyWidth(range: KeyRange): number {
  const wc = whiteKeys(range).length;
  return wc > 0 ? 100 / wc : 0;
}

/** 一个黑键的宽度百分比 = 白键宽 × 0.6(真实钢琴比例,与 playback-card 黑键等宽)。 */
export function blackKeyWidth(range: KeyRange): number {
  return whiteKeyWidth(range) * 0.6;
}

/** 某 midi 在白键序列中的索引(0-based);非白键返回 -1。 */
function whiteIdx(midi: number, range: KeyRange): number {
  return whiteKeys(range).indexOf(midi);
}

/**
 * midi → 键盘中心的横坐标百分比(0~100),相对键区 content box。
 *  - 白键:取自身中心 = (whiteIdx + 0.5) × WK_PCT
 *  - 黑键:位于左侧白键右沿(两白键交界处)= (whiteIdx(midi-1) + 1) × WK_PCT
 *
 * 黑键取「左侧白键右沿」而非自身中心,因为黑键视觉上嵌在两白键之间,
 * 中心对齐交界处(参考原型 keyCenterX,与 Synthesia 主流做法一致)。
 */
export function midiToX(midi: number, range: KeyRange): number {
  const wk = whiteKeyWidth(range);
  if (isWhite(midi)) {
    return (whiteIdx(midi, range) + 0.5) * wk;
  }
  // 黑键:左侧白键 = midi-1(pitch class 上,黑键恒比左侧白键大 1)。
  return (whiteIdx(midi - 1, range) + 1) * wk;
}

/**
 * 某 midi 的方块宽度百分比:白键→whiteKeyWidth,黑键→blackKeyWidth。
 * 方块和对应键等宽,落下来正好「落进」键里(参考 Synthesia 主流做法)。
 */
export function noteWidth(midi: number, range: KeyRange): number {
  return isWhite(midi) ? whiteKeyWidth(range) : blackKeyWidth(range);
}

/** 该音域下的黑键 midi 序列(供键盘构建:每个黑键的左侧白键右沿定位)。
 *  黑键 = 白键 w 的右邻(w+1 是黑键且 ≤ high)。 */
export function blackKeys(range: KeyRange): number[] {
  const out: number[] = [];
  for (const w of whiteKeys(range)) {
    if (w + 1 <= range.high && isBlack(w + 1)) out.push(w + 1);
  }
  return out;
}
