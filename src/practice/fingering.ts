// 指法映射公共工具 —— 键盘高亮和方块定位共用。
//
// highlightMidi:把乐谱里的真实 midi 按指法模式映射成"应按的键 midi"。
// - follow(原调指法):直接返回真实 midi(按真实音高,含黑键)
// - cfixed(移调指法):简谱 1-7 映射到 C 调白键(配合电钢琴移调,全白键)
//
// 键盘组件和方块组件各自 import 此函数做映射(文档:两组件不直接通信,各自算)。

import { Note, KeySig } from '../core/types';
import { noteToJianpu } from '../core/theory';

/** 中央 C 的 MIDI 值。 */
export const CENTER_C = 60;

/** 白键音级集合(pitch class,C=0)。 */
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];

/** 指法模式:follow=原调指法(真实音高含黑键);cfixed=移调指法(固定C调全白键)。 */
export type Fingering = 'cfixed' | 'follow';

/** 从基准白键出发偏移 n 个白键后的 midi(n 可负)。 */
export function whiteKeyOffset(baseWhiteMidi: number, n: number): number {
  const basePc = ((baseWhiteMidi % 12) + 12) % 12;
  const baseIdx = WHITE_PCS.indexOf(basePc);
  const baseOctave = Math.floor(baseWhiteMidi / 12);
  const total = baseIdx + n;
  const octave = baseOctave + Math.floor(total / 7);
  const idx = ((total % 7) + 7) % 7;
  return octave * 12 + WHITE_PCS[idx];
}

/**
 * 把「乐谱里的某个音」按指法模式映射成「应高亮/应定位的键 midi」。
 * - follow:原音高
 * - cfixed:简谱唱名映射回 C 调指法位置(同音级,保持八度点,升号→C 调黑键)
 *
 * 返回 null 表示该音不可映射(休止符或映射失败)。
 */
export function highlightMidi(note: Note, key: KeySig, fingering: Fingering): number | null {
  if (note.midi === null) return null;
  if (fingering === 'follow') return note.midi;
  const g = noteToJianpu(note, key);
  if (!g || g.digit === 0) return null;
  let m = whiteKeyOffset(CENTER_C, g.digit - 1);
  m += g.octaveDots * 12;
  if (g.accidental === 'sharp') m += 1;
  else if (g.accidental === 'flat') m -= 1;
  return m;
}
