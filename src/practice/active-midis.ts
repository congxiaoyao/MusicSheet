// active-midis —— 从 beat + 两组谱表算「当前正在响的原始 midi 集合」纯函数。
//
// 来源:playback-card.ts:377-397 的 computeActiveMidis 抽出，去掉 getView()/highlightMidi 耦合，
// 改成接收 beat + treble/bass 两组调度，返回原始 midi（不做指法映射——指法映射是键盘组件内部职责）。
// 蓝本:practice-demo.ts:80-115（已是 beat 入参 + 带 hand + 含和弦扩展），抽成独立模块供 controller 复用。
//
// 设计文档:docs/PracticeApp与顶栏节拍器设计.md §2.4。
// 关键:和弦组（同 chordId）的音都要返回（playback-card L384-388 的 chordId 遍历逻辑完整保留，不能简化）。

import { Note, durationBeats } from '../core/types';
import { BEAT_EPS } from '../core/model';
import { ActiveNote } from './keyboard';

/** 一组谱表（treble 或 bass）的播放调度：音符 + 预算的整曲绝对起始拍 + 左右手标识。
 *  starts 由 controller 用 noteStartBeats(rangeToPiece(...)) 算好传入。 */
export interface ActiveStaff {
  notes: Note[];
  starts: number[];
  hand: 'R' | 'L';
}

/** 算 beat 落在哪个音（数组内局部 idx）。返回 -1 = 该 beat 不在任何音发声区间内。
 *  复刻 score-sheet.ts / practice-demo.ts 的 noteIndexAtBeat：
 *  找最后一个 startBeat ≤ beat 且 beat 仍在 [start, start+dur) 内的音。 */
export function noteIndexAtBeat(beat: number, starts: number[], notes: Note[]): number {
  if (starts.length === 0) return -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] > beat + BEAT_EPS) break;
    const dur = durationBeats(notes[i]);
    if (beat < starts[i] + dur - BEAT_EPS) return i;
  }
  return -1;
}

/** 和弦扩展：同 chordId 的音都收集（复刻 playback-card L384-388 + practice-demo collectChord）。
 *  传入 head 音的 idx，若是和弦首音（有 chordId），返回该组所有非休止音的 midi；否则只返回 head 自己。
 *  idx 越界或 head 是休止符（midi===null）返回空。 */
export function collectChordMidis(notes: Note[], idx: number): number[] {
  if (idx < 0 || idx >= notes.length) return [];
  const head = notes[idx];
  if (head.midi === null) return [];
  if (!head.chordId) return [head.midi];
  const out: number[] = [];
  for (const n of notes) {
    if (n.chordId === head.chordId && n.midi !== null) out.push(n.midi);
  }
  return out;
}

/** controller 每帧算当前正在响的原始 midi 集合（带左右手标识）。
 *  从 beat + 两组 staff 算：每个 staff 找当前音 idx → 和弦扩展 → 收 midi + hand。
 *  handFilter 过滤单手隔离：'both' 收两只手，'R'/'L' 只收那只手。
 *  返回的 midi 是原始音高（未做指法映射），交给键盘后键盘内部按 fingering 模式映射点灯。
 *  空区间/休止符/越界都安全返回空数组。 */
export function computeActiveMidis(
  beat: number,
  staffs: ActiveStaff[],
  handFilter: 'both' | 'R' | 'L',
): ActiveNote[] {
  const out: ActiveNote[] = [];
  for (const st of staffs) {
    if (handFilter !== 'both' && st.hand !== handFilter) continue;
    const idx = noteIndexAtBeat(beat, st.starts, st.notes);
    for (const midi of collectChordMidis(st.notes, idx)) {
      out.push({ midi, hand: st.hand });
    }
  }
  return out;
}
