// 示例曲目：小星星（C 大调，4/4）

import { Note, Piece, durationBeats, beatsPerBar } from '../core/types';
import { KEYS } from '../core/theory';

function n(midi: number | null, duration: Note['duration'], dotted = false): Note {
  return { midi, duration, dotted, accidental: null };
}

/** 小星星示例。按 measureCount 截断到前 N 小节（跟随用户当前选择的小节数）。
 *  小星星每小节都填满 4 拍，截断后用末尾二分/四分自然收尾。 */
export function twinkleExample(measureCount: number = 4): Piece {
  // 1 1 5 5 6 6 5 - | 4 4 3 3 2 2 1 - | 5 5 4 4 3 3 2 - | 5 5 4 4 3 3 2 -
  // C 大调：1=C4(60) 2=D4(62) 3=E4(64) 4=F4(65) 5=G4(67) 6=A4(69) 7=B4(71)
  const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69;
  const q = 'quarter' as const;
  const h = 'half' as const;
  // 小星星（前 4 小节，正好填满 16 拍）：
  // | 1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - |
  const full: Note[] = [
    // 第 1 小节：1 1 5 5
    n(C4, q), n(C4, q), n(G4, q), n(G4, q),
    // 第 2 小节：6 6 5 -
    n(A4, q), n(A4, q), n(G4, h),
    // 第 3 小节：4 4 3 3
    n(F4, q), n(F4, q), n(E4, q), n(E4, q),
    // 第 4 小节：2 2 1 -
    n(D4, q), n(D4, q), n(C4, h),
  ];
  // 按小节边界截断：累计拍数到 measureCount * 每小节拍数 即停
  const barBeats = beatsPerBar({ num: 4, den: 4 });
  const cap = measureCount * barBeats;
  const notes: Note[] = [];
  let acc = 0;
  for (const note of full) {
    const beats = durationBeats(note);
    if (acc + beats > cap + 1e-6) break;   // 超出容量则停
    notes.push(note);
    acc += beats;
  }
  return {
    clef: 'treble',
    key: KEYS.C,
    time: { num: 4, den: 4 },
    measureCount,
    notes,         // 活跃组视图(= treble,小星星是高音旋律)
    treble: notes,
    bass: [],
  };
}
