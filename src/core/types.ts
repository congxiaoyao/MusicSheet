// 核心数据类型 —— 乐谱编辑器的共享模型

/** 谱号 */
export type Clef = 'treble' | 'bass';

/** 临时记号 */
export type Accidental = 'sharp' | 'flat' | 'natural' | null;

/** 音符时值（以四分音符为单位）。null 表示这是用户显式指定的休止符。 */
export type DurationValue = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtysecond';

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
  /** 扁平的音符数组，按时间顺序（追加式录入） */
  notes: Note[];
}

/** 时值 → 四分音符拍数 */
export function durationBeats(d: DurationValue, dotted: boolean): number {
  const base: Record<DurationValue, number> = {
    whole: 4,
    half: 2,
    quarter: 1,
    eighth: 0.5,
    sixteenth: 0.25,
    thirtysecond: 0.125,
  };
  const v = base[d];
  return dotted ? v * 1.5 : v;
}

/** 每个小节的总拍数 = num * (4 / den) */
export function beatsPerBar(time: TimeSig): number {
  return time.num * (4 / time.den);
}
