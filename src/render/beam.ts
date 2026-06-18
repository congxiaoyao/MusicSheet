// 连梁（beaming）分组算法：纯函数，扫描 notes 输出 BeamGroup[]，供 staff 渲染层消费。
//
// 分组规则（拍子感知，符合常见乐谱记谱习惯）：
//   1. 只有 eighth / sixteenth 且非休止的音符参与连梁。
//   2. 跨小节强制断开。
//   3. 按拍号分母决定每拍的八分音符数（beatGroup），同一 beatGroup 内的同种时值才连：
//        4/4、3/4、2/4 → 每拍 2 个八分（beatGroup=2）
//        6/8、3/8、9/8 → 每组 3 个八分（beatGroup=3，复合拍以附点四分为一拍）
//        其他 → 默认 2
//   4. 相邻两音符时值不同（eighth vs sixteenth）→ 断开。
//   5. 遇到 quarter/half/whole 或休止符 → 强制结束当前组。
//   6. level：组内全 eighth → single；全 sixteenth → double。

import { Note, Piece } from '../core/types';
import { noteStartBeats, barLineBeats } from '../core/model';

export type BeamLevel = 'single' | 'double';

export interface BeamGroup {
  /** 组内首音符在 notes 数组中的索引（含） */
  startIdx: number;
  /** 组内末音符索引（含） */
  endIdx: number;
  /** single=单横梁（八分）；double=双横梁（十六分） */
  level: BeamLevel;
}

/** 每拍（或复合拍的每组）包含几个八分音符。决定连梁边界。 */
function beatGroupSize(time: Piece['time']): number {
  // 八分音符为单位的拍子（分母为 8）：以 3 个八分为一组（附点四分拍）
  if (time.den === 8) return 3;
  // 否则（4/4、3/4、2/4 等）每拍 = 2 个八分
  return 2;
}

/** 时值 → 八分音符数（不含附点）。whole/half/quarter 返回 -1 表示不参与连梁。 */
function eighthCount(duration: Note['duration']): number {
  switch (duration) {
    case 'eighth': return 1;
    case 'sixteenth': return 0.5;
    default: return -1; // whole/half/quarter 都不连梁
  }
}

/**
 * 扫描音符数组，产出连梁分组。
 * 注意：单音符不成组（连梁至少需要 2 个相邻的连梁候选）。
 */
export function computeBeams(piece: Piece): BeamGroup[] {
  const { notes, time } = piece;
  const groups: BeamGroup[] = [];
  const starts = noteStartBeats(piece);
  const bars = barLineBeats(piece);
  const beatGroup = beatGroupSize(time);

  // 当前正在累积的组：用 startIdx + 期望的时值标记
  let groupStart = -1;
  let groupLevel: BeamLevel | null = null;
  let groupBeatOrigin = -1; // 组首音符所在的 beatGroup 序号（用于判断是否跨组）

  /** beatGroup 序号 = 从乐曲开头算，第几个 beatGroup（每 beatGroup 个八分为一组） */
  const groupIndexOfBeat = (beat: number) => Math.floor(beat * 2 / beatGroup);

  const closeGroup = (endIdxExclusive: number) => {
    // 组内至少 2 个音符才算一个连梁组；否则丢弃（孤立音符保持 flag）
    if (groupStart >= 0 && endIdxExclusive - groupStart >= 2 && groupLevel) {
      groups.push({ startIdx: groupStart, endIdx: endIdxExclusive - 1, level: groupLevel });
    }
    groupStart = -1;
    groupLevel = null;
    groupBeatOrigin = -1;
  };

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const isRest = note.midi === null;
    const eighths = eighthCount(note.duration);
    const canBeam = !isRest && eighths >= 0; // eighth / sixteenth 且非休止

    if (!canBeam) {
      // 长时值或休止：强制结束当前组
      closeGroup(i);
      continue;
    }

    const startBeat = starts[i];
    const thisGroupIdx = groupIndexOfBeat(startBeat);

    if (groupStart < 0) {
      // 开新组
      groupStart = i;
      groupLevel = note.duration === 'sixteenth' ? 'double' : 'single';
      groupBeatOrigin = thisGroupIdx;
      continue;
    }

    // 已在组内：判断是否还能延续
    const sameDuration = notes[groupStart].duration === note.duration;
    const sameBeatGroup = thisGroupIdx === groupBeatOrigin;

    // 跨小节判定：检查本音符起始拍是否越过下一条小节线
    const prevBeat = starts[i - 1];
    const crossesBar = bars.some(b => prevBeat < b - 1e-6 && startBeat >= b - 1e-6);

    if (sameDuration && sameBeatGroup && !crossesBar) {
      // 继续累积
      continue;
    } else {
      // 不满足：先关闭旧组（到 i-1），再从 i 开新组
      closeGroup(i);
      groupStart = i;
      groupLevel = note.duration === 'sixteenth' ? 'double' : 'single';
      groupBeatOrigin = thisGroupIdx;
    }
  }
  // 收尾
  closeGroup(notes.length);

  return groups;
}

/** 把音符索引映射到它所属的 BeamGroup（用于渲染时查表）。孤立音符不在任何组里。 */
export function indexBeamMap(groups: BeamGroup[]): Map<number, BeamGroup> {
  const m = new Map<number, BeamGroup>();
  for (const g of groups) {
    for (let i = g.startIdx; i <= g.endIdx; i++) m.set(i, g);
  }
  return m;
}
