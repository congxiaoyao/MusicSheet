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
export { CLEF_ANCHOR };

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
  A: { name: 'A', tonic: 5, sharps: [3, 0, 4], flats: [] }, // F# C# G#
  E: { name: 'E', tonic: 2, sharps: [3, 0, 4, 1], flats: [] }, // F# C# G# D#
  B: { name: 'B', tonic: 6, sharps: [3, 0, 4, 1, 5], flats: [] }, // F# C# G# D# A#
  'F#': { name: 'F#', tonic: 3, sharps: [3, 0, 4, 1, 5, 2], flats: [] }, // ...E#
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

/** 调号主音的半音值(pc 0-11)。tonic 是字母索引,再按升降号修正
 *  (主音字母在 sharps → +1,flats → -1)。如 Ab: tonic=5(A),A 在 flats → 9-1=8。 */
export function keyTonicPc(key: KeySig): number {
  let pc = NATURAL_SEMITONE[key.tonic];
  if (key.sharps.includes(key.tonic)) pc = (pc + 1) % 12;
  if (key.flats.includes(key.tonic)) pc = (pc + 11) % 12;
  return pc;
}

/** 旧调→新调的半音偏移(最短路径,±6 内)。用于转调:所有音符 midi += shift。 */
export function transposeShift(oldKey: KeySig, newKey: KeySig): number {
  const diff = keyTonicPc(newKey) - keyTonicPc(oldKey);
  return ((diff + 6) % 12 + 12) % 12 - 6;
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

  const octave = Math.floor(midi / 12) - 1;
  // step 用上面已算出的 letter（调号感知）重算,保证 letter 和 step 一致。
  // 旧实现调 midiToStaffStep(clef, midi),它不感知调号,对黑键 midi(如 Ab=56)会选错字母
  // (midi=56 → letter=G、step=-5 G位置),但调号 Ab 下 letter 该是 A → step 该是 -4(A位置)。
  // 用 letter 重算:step = (letter - 谱号letter) + (octave - 谱号octave) × 7。
  const a = CLEF_ANCHOR[clef];
  const step = (letter - a.letter) + (octave - a.octave) * 7;
  return { midi, letter, octave, accidental, step };
}

/** 给定 pitch-class，返回对应的自然字母（精确或最接近） */
function letterFromPc(pc: number): number {
  for (let l = 0; l < 7; l++) if (NATURAL_SEMITONE[l] === pc) return l;
  let best = 0;
  let bestErr = 99;
  for (let l = 0; l < 7; l++) {
    const err = Math.abs(NATURAL_SEMITONE[l] - pc);
    if (err < bestErr || (err === bestErr && NATURAL_SEMITONE[l] > NATURAL_SEMITONE[best])) {
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
  const tonicPc = keyTonicPc(key);   // 主音半音(含调号升降修正)

  // 用「音级中心法」决定简谱数字与字母，避免升/降调下字母解析的二义性：
  // 遍历 7 个音级，找哪个音级的自然半音距 pc 最近 → 该音级即简谱数字。
  // （升号调的 in-key 升音、降号调的 in-key 降音都会自然落到正确音级。）
  let bestDeg = 0;
  let bestDist = 99;
  for (let i = 0; i < 7; i++) {
    const nat = (tonicPc + SCALE_SEMITONES[i]) % 12;
    // 半音距离（环状）
    const d = Math.min((pc - nat + 12) % 12, (nat - pc + 12) % 12);
    if (d < bestDist) {
      bestDist = d; bestDeg = i;
    } else if (d === bestDist) {
      // 距离相同时（如 C4 同时接近 B 和 C#）：偏向「该音级字母是调内升降音」的那一级，
      // 这样调外自然音会落到正确的 in-key 升/降音级上（A 调 C4 → C# 那级 = 3，而非 B 那级 = 2）
      const letterI = ((tonicLetter + i) % 7 + 7) % 7;
      const letterBest = ((tonicLetter + bestDeg) % 7 + 7) % 7;
      const iInKey = key.sharps.includes(letterI) || key.flats.includes(letterI);
      const bestInKey = key.sharps.includes(letterBest) || key.flats.includes(letterBest);
      const natI = (tonicPc + SCALE_SEMITONES[i]) % 12;
      const iBelow = (natI - pc + 12) % 12 === 1;
      const preferI =
        (iInKey && !bestInKey) ||
        (iInKey && bestInKey && key.sharps.length > 0 && iBelow) ||
        (iInKey && bestInKey && key.flats.length > 0 && !iBelow);
      if (preferI) bestDeg = i;
    }
  }
  const digit = bestDeg + 1;
  // 字母 = 主音字母 + 音级偏移（固定基准，与 tonicLetter 同基准）
  const letter = ((tonicLetter + bestDeg) % 7 + 7) % 7;

  // 八度点：do-ti 一个八度（如 C4~B4）= 无点区。
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
  // 用户强制记号优先
  if (note.accidental === 'sharp') accidental = 'sharp';
  else if (note.accidental === 'flat') accidental = 'flat';
  // 调号内的升降音（该音级正好是调号里的升降音）：不另写记号
  if (accidental === 'sharp' && key.sharps.includes(letter)) accidental = null;
  if (accidental === 'flat' && key.flats.includes(letter)) accidental = null;

  return { digit, octaveDots: dots, accidental };
}
