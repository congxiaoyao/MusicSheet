// 连梁（beaming）分组算法：纯函数，扫描 notes 输出 BeamGroup[]，供 staff 渲染层消费。
//
// 分组规则（拍子感知，符合常见乐谱记谱习惯）：
//   1. 只有 eighth / sixteenth / thirtysecond 且非休止的音符参与连梁。
//   2. 跨小节强制断开。
//   3. 按拍号分母决定每拍的八分音符数（beatGroup），同一 beatGroup 内连梁：
//        4/4、3/4、2/4 → 每拍 2 个八分（beatGroup=2）
//        6/8、3/8、9/8 → 每组 3 个八分（beatGroup=3，复合拍以附点四分为一拍）
//        其他 → 默认 2
//   4. 【partial beam】相邻音符时值不同（如 eighth 与 sixteenth 混排）也连成同一组，
//        由渲染层按「梁容量」模型逐音、逐梁绘制部分梁。
//   5. 遇到 quarter/half/whole 或休止符 → 强制结束当前组。
//   6. maxBeamCount：组内各音梁容量的最大值（eighth=1 / sixteenth=2 / thirtysecond=3），
//        决定该组最多有几根梁。

import { Note, Piece } from '../core/types';
import { noteStartBeats, barLineBeats, isChordTail, beatGroupIndexOf } from '../core/model';

export interface BeamGroup {
  /** 组内首音符在 notes 数组中的索引（含） */
  startIdx: number;
  /** 组内末音符索引（含） */
  endIdx: number;
  /** 组内最大梁容量（1=单梁八分组 / 2=双梁十六分组 / 3=三梁三十二分组） */
  maxBeamCount: number;
}

/** 每个音符的「梁容量」：决定它参与几根梁。不参与连梁的时值返回 0。 */
export function beamCountForNote(duration: Note['duration']): number {
  if (duration === 'eighth') return 1;
  if (duration === 'sixteenth') return 2;
  if (duration === 'thirtysecond') return 3;
  return 0; // whole/half/quarter 不参与连梁
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
    case 'thirtysecond': return 0.25;
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

  // 当前正在累积的组：用 startIdx + 组内最大梁容量标记
  let groupStart = -1;
  let groupMaxCount = 0;
  let groupBeatOrigin = -1; // 组首音符所在的 beatGroup 序号（用于判断是否跨组）

  const closeGroup = (endIdxExclusive: number) => {
    // 组内至少 2 个音符才算一个连梁组；否则丢弃（孤立音符保持 flag）
    if (groupStart >= 0 && endIdxExclusive - groupStart >= 2 && groupMaxCount > 0) {
      groups.push({ startIdx: groupStart, endIdx: endIdxExclusive - 1, maxBeamCount: groupMaxCount });
    }
    groupStart = -1;
    groupMaxCount = 0;
    groupBeatOrigin = -1;
  };

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    // 和弦尾音:与首音同时,是首音所在时间位的一部分,不作为独立连梁单位参与判定(透明跳过)。
    // 和弦首音(非尾音)代表整个和弦参与连梁,其 step 由 renderBeams 取组内最极端值。
    if (isChordTail(note, i > 0 ? notes[i - 1] : null)) continue;
    const isRest = note.midi === null;
    const eighths = eighthCount(note.duration);
    const canBeam = !isRest && eighths >= 0; // eighth / sixteenth / thirtysecond 且非休止

    if (!canBeam) {
      // 长时值或休止：强制结束当前组
      closeGroup(i);
      continue;
    }

    const startBeat = starts[i];
    const thisGroupIdx = beatGroupIndexOf(startBeat, beatGroup);

    if (groupStart < 0) {
      // 开新组
      groupStart = i;
      groupMaxCount = beamCountForNote(note.duration);
      groupBeatOrigin = thisGroupIdx;
      continue;
    }

    // 已在组内：判断是否还能延续。partial beam 下不再要求相邻音时值相同，
    // 只看「同 beatGroup 且不跨小节」。
    const sameBeatGroup = thisGroupIdx === groupBeatOrigin;

    // 连音组(tuplet)强制同组连梁：当前音与组内前一音同 tuplet groupId 时，
    // 忽略 beatGroup 判定（三连音的音拍位可能横跨多个 beatGroup，但仍应连梁成一组）。
    const prevTupletId = notes[i - 1].tuplet?.groupId;
    const thisTupletId = note.tuplet?.groupId;
    const sameTuplet = !!(prevTupletId && thisTupletId && prevTupletId === thisTupletId);

    // 跨小节判定：检查本音符起始拍是否越过下一条小节线
    const prevBeat = starts[i - 1];
    const crossesBar = bars.some(b => prevBeat < b - 1e-6 && startBeat >= b - 1e-6);

    if ((sameBeatGroup || sameTuplet) && !crossesBar) {
      // 继续累积：组内最大梁容量取各音的最大值
      groupMaxCount = Math.max(groupMaxCount, beamCountForNote(note.duration));
    } else {
      // 不满足：先关闭旧组（到 i-1），再从 i 开新组
      closeGroup(i);
      groupStart = i;
      groupMaxCount = beamCountForNote(note.duration);
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
