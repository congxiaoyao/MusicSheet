// 核心数据类型 —— 乐谱编辑器的共享模型

/** 谱号 */
export type Clef = 'treble' | 'bass';

/** 临时记号 */
export type Accidental = 'sharp' | 'flat' | 'natural' | null;

/** 音符时值（以四分音符为单位）。null 表示这是用户显式指定的休止符。 */
export type DurationValue = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtysecond';

/** 连音组(tuplet)信息。如三连音=3个音占2个普通音位。挂在每个组内音符上,同组共享同值。 */
export interface TupletInfo {
  /** 实际音符数（时间位数）。语义为「时间位数」:未来支持和弦时,一个时间位可含多个音,actual 仍按位数算 */
  actual: number;
  /** 对应的普通音符数（同时间位数）。actual:normal = 3:2 即三连音 */
  normal: number;
  /** 同一组的唯一标识。扁平 notes 里相邻且同 groupId 的音归为一组 */
  groupId: string;
}

/** 一个音符或休止符 */
export interface Note {
  /** MIDI 音高；null = 休止符 */
  midi: number | null;
  /** 原始时值（不含附点） */
  duration: DurationValue;
  /** 附点（增加原时值的一半） */
  dotted: boolean;
  /** 用户手动指定的临时记号（覆盖调号）。null = 遵循调号 */
  accidental: Accidental;
  /** 这个音符是某条连音线(tie)的起点 —— 向后连到下一个同音高音。
   *  tie 把两个同音高音的时值合并，第二个不重新起振。 */
  tieStart?: boolean;
  /** 这个音符是某条连音线(tie)的终点 —— 从上一个同音高音连来。 */
  tieEnd?: boolean;
  /** 若属于连音组(tuplet),则有此字段。同组相邻音符共享同一 groupId。 */
  tuplet?: TupletInfo;
  /** 和弦(chord)分组 id。同 chordId 的音共享同一时间位(同时发声)。
   *  追加式录入下,连续同 chordId 的第一个是首音(占时长),其余是尾音(不占时长,与首音同时)。
   *  组内所有音的 duration 必须一致(输入层强制),保证整组占一个时间位。 */
  chordId?: string;
}

/** 调号名称 */
export type KeyName =
  | 'C' | 'G' | 'D' | 'A' | 'E' | 'B' | 'F#'
  | 'F' | 'Bb' | 'Eb' | 'Ab' | 'Db' | 'Gb';

export interface KeySig {
  name: KeyName;
  /** 大调主音的 MIDI 音级（0-11，以 C=0）；C 大调=0，G 大调=7→7%12=7 */
  tonic: number; // 0=C, 2=D, 4=E, 5=F, 7=G, 9=A, 11=B
  /** 升号音级集合（相对 C 的半音偏移），如 G 大调 = {6}（F#） */
  sharps: number[];
  /** 降号音级集合，如 F 大调 = {10}（Bb） */
  flats: number[];
}

export interface TimeSig {
  num: number; // 每小节拍数
  den: number; // 以何种音符为一拍（我们固定 4，即四分音符为一拍）
}

/** 整个乐谱 */
export interface Piece {
  clef: Clef;
  key: KeySig;
  time: TimeSig;
  /** 总小节数（单行）。写满后不可再输入。两组(treble/bass)共享。 */
  measureCount: number;
  /** 扁平的音符数组，按时间顺序（追加式录入）。
   *  渐进式重构:这是「当前活跃组」的视图别名,由 App 在切模式时指向 treble 或 bass。
   *  渲染层(render/layout/staff/beam/jianpu)只读 notes,自动跟随活跃组,无需感知双组。
   *  编辑层(appendNote/popNote)操作 notes = 操作活跃组。 */
  notes: Note[];
  /** 高音谱表(右手)音符组。单卡高音模式时 notes 指向它。 */
  treble: Note[];
  /** 低音谱表(左手)音符组。单卡低音模式时 notes 指向它。 */
  bass: Note[];
}

const DURATION_BASE: Record<DurationValue, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  sixteenth: 0.25,
  thirtysecond: 0.125,
};

/** 底层纯时值（不含连音缩放）。给「假想音符」场景用：待输入位宽度、按钮 disable 判定等
 *  （这些场景拿不到完整 note，且不需要连音缩放）。 */
export function noteValueBeats(d: DurationValue, dotted: boolean): number {
  const v = DURATION_BASE[d];
  return dotted ? v * 1.5 : v;
}

/** 音符实际时值（含连音 tuplet 缩放）。绝大多数调用点用这个。
 *  三连音八分 = noteValueBeats(eighth) × 2/3 = 1/3 拍。 */
export function durationBeats(note: Note): number {
  let v = noteValueBeats(note.duration, note.dotted);
  if (note.tuplet) v = v * note.tuplet.normal / note.tuplet.actual;
  return v;
}

/** 每个小节的总拍数 = num * (4 / den) */
export function beatsPerBar(time: TimeSig): number {
  return time.num * (4 / time.den);
}
