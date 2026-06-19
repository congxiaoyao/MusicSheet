// 乐理：音高 ↔ 五线谱位置、调号、简谱（首调）映射

import { Clef, KeyName, KeySig, Note } from './types';

// 自然音阶的半音偏移（以 C 为 0）：C D E F G A B
const NATURAL_SEMITONE = [0, 2, 4, 5, 7, 9, 11];

// 调号内的升降号，统一用「字母索引 0..6」表示（C=0..B=6）
// 这样与自然音字母一一对应，避免半音歧义。

interface ClefAnchor {
  letter: number; // step 0 的字母
  octave: number; // step 0 的八度
}

const CLEF_ANCHOR: Record<Clef, ClefAnchor> = {
  treble: { letter: 2, octave: 4 }, // 最下线 E4
  bass: { letter: 4, octave: 2 }, // 最下线 G2
};

/** (谱号, step) → MIDI（不带临时记号） */
export function staffStepToMidi(clef: Clef, step: number): number {
  const a = CLEF_ANCHOR[clef];
  const letter = a.letter + step;
  const octave = a.octave + Math.floor(letter / 7);
  const l = ((letter % 7) + 7) % 7;
  return (octave + 1) * 12 + NATURAL_SEMITONE[l];
}

/** MIDI → (谱号下的 step, 字母) */
export function midiToStaffStep(clef: Clef, midi: number): { step: number; letter: number } {
  const a = CLEF_ANCHOR[clef];
  const pc = midi % 12;
  // 找最接近的自然字母
  let letter = 0;
  let bestErr = 99;
  for (let l = 0; l < 7; l++) {
    const err = Math.abs(NATURAL_SEMITONE[l] - pc);
    if (err < bestErr) {
      bestErr = err;
      letter = l;
    }
  }
  const octave = Math.floor(midi / 12) - 1;
  const step = (letter - a.letter) + (octave - a.octave) * 7;
  return { step, letter };
}

// ────────────────────────────────────────────────────────────
// 调号。用「主音字母」+「升号字母集合」+「降号字母集合」表示。

export const KEYS: Record<KeyName, KeySig> = {
  C: { name: 'C', tonic: 0, sharps: [], flats: [] },
  G: { name: 'G', tonic: 4, sharps: [3], flats: [] }, // F#
  D: { name: 'D', tonic: 1, sharps: [3, 0], flats: [] }, // F# C#
  A: { name: 'A', tonic: 5, sharps: [3, 0, 6], flats: [] }, // F# C# G#
  E: { name: 'E', tonic: 2, sharps: [3, 0, 6, 2], flats: [] }, // F# C# G# D#
  B: { name: 'B', tonic: 6, sharps: [3, 0, 6, 2, 5], flats: [] }, // F# C# G# D# A#
  'F#': { name: 'F#', tonic: 3, sharps: [3, 0, 6, 2, 5, 1], flats: [] }, // ...E#
  F: { name: 'F', tonic: 3, sharps: [], flats: [6] }, // Bb
  Bb: { name: 'Bb', tonic: 6, sharps: [], flats: [6, 2] }, // Bb Eb
  Eb: { name: 'Eb', tonic: 2, sharps: [], flats: [6, 2, 5] }, // Bb Eb Ab
  Ab: { name: 'Ab', tonic: 5, sharps: [], flats: [6, 2, 5, 1] }, // Bb Eb Ab Db
  Db: { name: 'Db', tonic: 1, sharps: [], flats: [6, 2, 5, 1, 4] }, // Bb Eb Ab Db Gb
  Gb: { name: 'Gb', tonic: 4, sharps: [], flats: [6, 2, 5, 1, 4, 0] }, // ...Cb
};

// 注：types.ts 里的 KeySig.tonic 字段现在表示「字母索引」；sharps/flats 也是字母索引。
// （与早期版本表示 pitch-class 不同，已统一。）

export function isInKeySharp(key: KeySig, letter: number): boolean {
  return key.sharps.includes(letter);
}
export function isInKeyFlat(key: KeySig, letter: number): boolean {
  return key.flats.includes(letter);
}

export interface PitchInfo {
  midi: number;
  letter: number;
  octave: number;
  accidental: 'sharp' | 'flat' | 'natural' | null;
  step: number;
}

/** 把一个 MIDI 音「夹」到离当前谱号中心较近的八度区。
 *  用于切换谱号时，避免高音区旋律在低音谱号下飞出画面（反之亦然）。
 *  规则：以谱号中线音为基准，若音符超出 ±1 个八度，则按 12 半音倍数移近。
 *  返回调整后的 midi（可能等于原值）。 */
export function clampToClefRange(midi: number, clef: Clef): number {
  // 高音谱号中线 = B4(71)；低音谱号中线 = D3(50)
  const center = clef === 'treble' ? 71 : 50;
  let m = midi;
  while (m - center > 7) m -= 12;   // 太高，降八度
  while (center - m > 7) m += 12;   // 太低，升八度
  return m;
}

/** 由 MIDI 决定显示字母与临时记号 */
export function resolvePitch(
  midi: number,
  clef: Clef,
  key: KeySig,
  forced: 'sharp' | 'flat' | 'natural' | null,
): PitchInfo {
  const pc = midi % 12;
  let letter: number;
  let accidental: 'sharp' | 'flat' | 'natural' | null = null;

  if (forced) {
    if (forced === 'sharp') {
      letter = letterFromPc((pc + 11) % 12);
      accidental = 'sharp';
    } else if (forced === 'flat') {
      letter = letterFromPc((pc + 1) % 12);
      accidental = 'flat';
    } else {
      letter = letterFromPc(pc);
      accidental = 'natural';
    }
  } else {
    // 调号优先
    const sharpLetter = key.sharps.find(l => (NATURAL_SEMITONE[l] + 1) % 12 === pc);
    const flatLetter = key.flats.find(l => (NATURAL_SEMITONE[l] + 11) % 12 === pc);
    if (sharpLetter !== undefined) letter = sharpLetter;
    else if (flatLetter !== undefined) letter = flatLetter;
    else letter = letterFromPc(pc);
    accidental = null;
  }

  const { step } = midiToStaffStep(clef, midi);
  const octave = Math.floor(midi / 12) - 1;
  return { midi, letter, octave, accidental, step };
}

/** 给定 pitch-class，返回对应的自然字母（精确或最接近） */
function letterFromPc(pc: number): number {
  for (let l = 0; l < 7; l++) if (NATURAL_SEMITONE[l] === pc) return l;
  let best = 0;
  let bestErr = 99;
  for (let l = 0; l < 7; l++) {
    const err = Math.abs(NATURAL_SEMITONE[l] - pc);
    if (err < bestErr) {
      bestErr = err;
      best = l;
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────
// 简谱（首调）映射：1 = 当前调主音

export interface JianpuGlyph {
  digit: number; // 0=休止，1..7=音级
  octaveDots: number; // 正=上方点数，负=下方点数，0=中音区
  accidental: 'sharp' | 'flat' | null;
}

const SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]; // do..si 相对主音

/**
 * 把音符映射成简谱数字（首调）。
 * 以调号主音字母为 1。八度点取该音与「最近同字母主音」之间的八度差。
 */
export function noteToJianpu(note: Note, key: KeySig): JianpuGlyph | null {
  if (note.midi === null) return { digit: 0, octaveDots: 0, accidental: null };
  const midi = note.midi;
  const pc = midi % 12;
  const tonicLetter = key.tonic;
  const tonicPc = NATURAL_SEMITONE[tonicLetter];

  // 决定字母
  let letter: number;
  if (note.accidental === 'sharp') {
    letter = letterFromPc((pc + 11) % 12);
  } else if (note.accidental === 'flat') {
    letter = letterFromPc((pc + 1) % 12);
  } else {
    const sharpLetter = key.sharps.find(l => (NATURAL_SEMITONE[l] + 1) % 12 === pc);
    const flatLetter = key.flats.find(l => (NATURAL_SEMITONE[l] + 11) % 12 === pc);
    if (sharpLetter !== undefined) letter = sharpLetter;
    else if (flatLetter !== undefined) letter = flatLetter;
    else letter = letterFromPc(pc);
  }

  // 数字（首调）
  const digit = (((letter - tonicLetter) % 7) + 7) % 7 + 1;

  // 八度点：用「自然音字母连续坐标」算。do-ti 一个八度（如 C4~B4）= 无点区。
  // 以「主音字母落在第 4 八度」为基准：C4..B4 = 无点，C5..B5 = 上一点，C3..B3 = 下一点。
  const noteOctave = Math.floor(midi / 12) - 1;
  const noteCoord = noteOctave * 7 + letter;
  const tonicCoord = 4 * 7 + tonicLetter;
  const dots = Math.floor((noteCoord - tonicCoord) / 7);

  // 临时记号：该数字的自然半音 vs 实际 pc
  const naturalPc = (tonicPc + SCALE_SEMITONES[digit - 1]) % 12;
  let accidental: 'sharp' | 'flat' | null = null;
  if (pc !== naturalPc) {
    if ((naturalPc + 1) % 12 === pc) accidental = 'sharp';
    else if ((naturalPc + 11) % 12 === pc) accidental = 'flat';
    else accidental = 'sharp';
  }
  // 调号内的升降音：不另写记号
  if (accidental === 'sharp' && key.sharps.includes(letter)) accidental = null;
  if (accidental === 'flat' && key.flats.includes(letter)) accidental = null;

  return { digit, octaveDots: dots, accidental };
}
