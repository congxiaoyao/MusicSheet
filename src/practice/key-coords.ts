// 公共坐标纯函数 —— 钢琴组件与方块组件的共同基准。
//
// 设计文档:docs/钢琴与方块组件设计.md §2。
// 核心问题:方块横轴 = 键盘位置。若 midiToX 属于某组件,另一个就得依赖它
// (时序耦合:键盘渲染后 midiToX 才准)。抽成纯函数后,两者各自调用,消除时序依赖,
// 且纯数学与 DOM 渲染用同一套数学,必然对齐,不需要 rAF 兜底。
//
// 坐标系基准(像素级键宽):
//   坐标用 px 绝对宽度。whiteW = 一个白键的宽度(px),由键盘组件的键宽滑块设定。
//   - 白键宽 = whiteW,黑键宽 = whiteW × 0.6(真实钢琴比例)
//   - midiToX 返回键中心相对键区左边缘的 px 值
//   - 键盘 DOM:白键 width=whiteW,黑键 left=midiToX、width=whiteW*0.6
//   - 方块 DOM:width=noteWidth、left=midiToX(居中),与键同套数学
//   键宽是精确 px(不铺满容器):键数 = ceil(容器宽/whiteW) 补满,超出部分由 .kb-keys
//   overflow:hidden 裁掉。键细了键就多了,键盘始终满屏。
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
 *  供键盘构建和方块对齐复用。 */
export function whiteKeys(range: KeyRange): number[] {
  const out: number[] = [];
  for (let m = range.low; m <= range.high; m++) {
    if (isWhite(m)) out.push(m);
  }
  return out;
}

/** 黑键宽度(px)= 白键宽 × 0.6(真实钢琴比例)。 */
function blackKeyWidth(whiteW: number): number {
  return whiteW * 0.6;
}

/** 某 midi 在白键序列中的索引(0-based);非白键返回 -1。 */
function whiteIdx(midi: number, range: KeyRange): number {
  return whiteKeys(range).indexOf(midi);
}

/**
 * midi → 键盘中心的横坐标(px),相对键区左边缘。
 *  - 白键:取自身中心 = (whiteIdx + 0.5) × whiteW
 *  - 黑键:位于左侧白键右沿(两白键交界处)= (whiteIdx(midi-1) + 1) × whiteW
 *
 * 黑键取「左侧白键右沿」而非自身中心,因为黑键视觉上嵌在两白键之间,
 * 中心对齐交界处(参考原型 keyCenterX,与 Synthesia 主流做法一致)。
 *
 * @param whiteW 一个白键的宽度(px)
 */
export function midiToX(midi: number, range: KeyRange, whiteW: number): number {
  if (isWhite(midi)) {
    return (whiteIdx(midi, range) + 0.5) * whiteW;
  }
  // 黑键:左侧白键 = midi-1(pitch class 上,黑键恒比左侧白键大 1)。
  return (whiteIdx(midi - 1, range) + 1) * whiteW;
}

/**
 * 某 midi 的方块宽度(px):白键→whiteW,黑键→whiteW×0.6。
 * 方块和对应键等宽,落下来正好「落进」键里(参考 Synthesia 主流做法)。
 *
 * range 保留为参数仅为与 midiToX 签名一致(noteWidth 只看 pitch class,不需 range)。
 *
 * @param whiteW 一个白键的宽度(px)
 */
export function noteWidth(midi: number, range: KeyRange, whiteW: number): number {
  void range;
  return isWhite(midi) ? whiteW : blackKeyWidth(whiteW);
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
