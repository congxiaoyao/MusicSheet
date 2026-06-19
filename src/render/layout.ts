// 共享布局：统一坐标系。五线谱与简谱共用同一套 x 坐标与小节线。
//
// 水平布局：
//   [左留白][谱号区][调号区][拍号区][间隔] | 小节1 | 小节2 | 小节3 | 小节4 | [右留白]
//
// 小节内的音符：按「时值占比」分配宽度，每个音符居中在自己的时值格子里。
// 这样不论音符多寡、时值长短，都能均匀填满整个小节，不会有大段右侧留白。
// 下一个待输入位置的「格子宽度」也由当前时值决定 → 圆角框宽度随时值变化。

import { Piece, DurationValue, durationBeats } from '../core/types';
import { beatsPerBar } from '../core/types';
import { noteStartBeats, capacityBeats } from '../core/model';

export interface Layout {
  width: number;
  height: number;
  fontSize: number;
  staffSpace: number;

  staffTop: number;
  staffBottom: number;
  bottomLineY: number;

  prefixRight: number;
  contentLeft: number;
  contentRight: number;
  contentWidth: number;

  clefX: number;
  keyStartX: number;
  timeSigX: number;
  hasKey: boolean;

  barLines: number[];
  /** 每个音符的中心 x */
  noteX: number[];
  /** 每个音符的格子宽度（供 staff.ts 画 stem/flag 对齐、jianpu 对齐用） */
  noteSlotW: number[];
  /** 下一个待输入位置：中心 x 与格子宽度 */
  nextSlotX: number;
  nextSlotW: number;
  /** 是否已写满（写满后不显示指示器） */
  isFull: boolean;

  jianpuTop: number;
  jianpuBaseline: number;
  jianpuBottom: number;
}

const FONT = 46;
const SS = FONT / 4;
const PAD_LEFT = 22;
const PAD_RIGHT = 24;
const STAFF_TOP = 42;
const JIANPU_GAP = 44;
const CLEF_W = 3.8 * SS;
const KEY_PER_GLYPH = 1.5 * SS;
const KEY_GAP = 0.9 * SS;
const TIMESIG_W = 2.6 * SS;
const GAP_AFTER_PREFIX = 4.0 * SS;
const JIANPU_HEIGHT = 74;

/** 每种时值对应的「最小格子宽度」系数（staff space 的倍数）。保证不挤。 */
const SLOT_MIN: Record<DurationValue, number> = {
  whole: 6.0,
  half: 4.2,
  quarter: 3.2,
  eighth: 2.8,
  sixteenth: 2.7,
};

export function computeLayout(piece: Piece, containerWidth: number, currentDuration: DurationValue = 'quarter'): Layout {
  const fontSize = FONT;
  const staffSpace = SS;
  const width = Math.max(containerWidth, 620);

  const staffTop = STAFF_TOP;
  const bottomLineY = staffTop + 8 * staffSpace;
  const staffBottom = bottomLineY;

  const keyCount = piece.key.sharps.length || piece.key.flats.length;
  const keyW = keyCount > 0 ? keyCount * KEY_PER_GLYPH + KEY_GAP : 0;
  const prefixW = CLEF_W + keyW + TIMESIG_W + (keyCount > 0 ? KEY_GAP : 0);

  const contentLeft = PAD_LEFT + prefixW + GAP_AFTER_PREFIX;
  const contentRight = width - PAD_RIGHT;
  const contentWidth = contentRight - contentLeft;
  const prefixRight = contentLeft - GAP_AFTER_PREFIX * 0.5;
  const bpb = beatsPerBar(piece.time);

  const clefX = PAD_LEFT + CLEF_W / 2;
  const keyStartX = PAD_LEFT + CLEF_W + KEY_GAP;
  const timeSigX = PAD_LEFT + CLEF_W + keyW + TIMESIG_W / 2 + (keyCount > 0 ? KEY_GAP : 0);

  const barWidth = contentWidth / 4;
  const barLines = [0, 1, 2, 3, 4].map(i => contentLeft + i * barWidth);

  // 计算每个音符的中心 x（按时值占比居中）
  const starts = noteStartBeats(piece);
  const noteX: number[] = [];
  const noteSlotW: number[] = [];
  for (let i = 0; i < piece.notes.length; i++) {
    const startBeat = starts[i];
    const barIdx = Math.min(Math.floor(startBeat / bpb), 3);
    const { x, slotW } = positionInBar(piece.notes, startBeat, barIdx, barWidth, bpb, i, barLines);
    noteX.push(x);
    noteSlotW.push(slotW);
  }

  // 下一个待输入位置（写满后不显示）
  const capBeats = capacityBeats(piece);
  let nextBeat = 0;
  if (piece.notes.length) {
    const last = piece.notes.length - 1;
    nextBeat = starts[last] + durationBeats(piece.notes[last].duration, piece.notes[last].dotted);
  }
  const isFull = nextBeat >= capBeats - 1e-6;
  const nextBarIdx = Math.min(Math.floor(Math.min(nextBeat, capBeats - 0.001) / bpb), 3);
  const nextBeatInBar = Math.min(nextBeat, capBeats - 0.001) - nextBarIdx * bpb;
  const nextDur = nextBeat < capBeats ? currentDuration : 'quarter';
  const nextSlotW = isFull ? 0 : slotWidthFor(nextDur, bpb, barWidth);
  const nextSlotX = barLines[nextBarIdx] + nextBeatInBar / bpb * barWidth + nextSlotW / 2;

  const jianpuTop = staffBottom + JIANPU_GAP;
  const jianpuBaseline = jianpuTop + 36;
  const jianpuBottom = jianpuTop + JIANPU_HEIGHT;
  const height = jianpuBottom + 20;

  return {
    width, height, fontSize, staffSpace,
    staffTop, staffBottom, bottomLineY,
    prefixRight, contentLeft, contentRight, contentWidth,
    clefX, keyStartX, timeSigX, hasKey: keyCount > 0,
    barLines,
    noteX, noteSlotW,
    nextSlotX, nextSlotW, isFull,
    jianpuTop, jianpuBaseline, jianpuBottom,
  };
}

/** 把某个音符放进它所在的小节：按「时值占比」居中。
 *  兜底：若音符的 beatInBar 超出小节容量(超拍数据)，clamp 到小节内，
 *  防止音符漂到下一小节视觉区/压小节线。可能和相邻音符挤一起，但至少在小节框内。 */
function positionInBar(notes: Piece['notes'], startBeat: number, barIdx: number, barWidth: number, bpb: number, noteIdx: number, barLines: number[]): { x: number; slotW: number } {
  const dur = durationBeats(notes[noteIdx].duration, notes[noteIdx].dotted);
  // clamp beatInBar 到 [0, bpb - dur]：超拍时不让音符漂出当前小节
  const rawBeatInBar = startBeat - barIdx * bpb;
  const beatInBar = Math.min(Math.max(0, rawBeatInBar), Math.max(0, bpb - dur));
  const slotW = (dur / bpb) * barWidth;
  const x = barLines[barIdx] + beatInBar / bpb * barWidth + slotW / 2;
  return { x, slotW };
}

/** 下一个待输入格子的宽度（按时值占比，但保证最小可读宽度）。 */
function slotWidthFor(duration: DurationValue, bpb: number, barWidth: number): number {
  const ratio = durationBeats(duration, false) / bpb;
  const minW = SLOT_MIN[duration] * SS;
  return Math.max(barWidth * ratio, minW);
}
