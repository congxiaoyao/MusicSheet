// 乐谱序列化 —— 导出/导入的文件格式与读写逻辑。
//
// 格式：带版本头的 JSON，扩展名 .msheet
//   { "format": "musicsheet", "version": 1, "exportedAt": <ms>, "piece": <Piece> }
//
// 设计原则：
// - Piece 原样 JSON 化，零信息丢失（tie/tuplet/chord 全保）。
// - 版本头保证未来向后兼容：version 升级时在 migrate() 里做迁移。
// - deserialize 做严格校验，任何字段不合法都抛带提示的 Error，不破坏调用方当前乐谱。

import { Accidental, Clef, DurationValue, KeyName, Note, Piece } from './types';

export const SHEET_FORMAT = 'musicsheet';
export const SHEET_VERSION = 1;
export const SHEET_EXTENSION = '.msheet';

interface SheetFile {
  format: string;
  version: number;
  exportedAt: number;
  piece: Piece;
}

const VALID_CLEFS: readonly Clef[] = ['treble', 'bass'];
const VALID_DURATIONS: readonly DurationValue[] =
  ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirtysecond'];
const VALID_ACCIDENTALS: readonly Accidental[] = ['sharp', 'flat', 'natural', null];
const VALID_KEY_NAMES: readonly KeyName[] =
  ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];

/** 序列化为 .msheet 文件内容（字符串）。 */
export function serialize(piece: Piece): string {
  const file: SheetFile = {
    format: SHEET_FORMAT,
    version: SHEET_VERSION,
    exportedAt: Date.now(),
    piece,
  };
  return JSON.stringify(file, null, 2);
}

/** 解析 .msheet 文件内容，返回 Piece。任何不合法都抛 Error（带中文提示）。 */
export function deserialize(text: string): Piece {
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch { throw new Error('不是有效的 JSON 文件'); }

  if (!obj || typeof obj !== 'object') throw new Error('文件内容为空或不是对象');
  const f = obj as Partial<SheetFile>;
  if (f.format !== SHEET_FORMAT) {
    throw new Error('不是 MusicSheet 乐谱文件（缺少 format 标识）');
  }
  if (typeof f.version !== 'number') throw new Error('缺少版本号');
  // 版本迁移钩子：未来高版本→低版本或反向，在此处理。当前只有 v1。
  if (f.version !== SHEET_VERSION) {
    throw new Error(`不支持的版本 v${f.version}（当前支持 v${SHEET_VERSION}）`);
  }
  if (!f.piece) throw new Error('缺少乐谱数据(piece)');
  return validatePiece(f.piece);
}

/** 递归校验 Piece 结构，非法字段抛 Error。
 *  向后兼容:旧格式(只有 notes,无 treble/bass)→ notes 读入 treble 组,bass 空。 */
function validatePiece(p: unknown): Piece {
  if (!p || typeof p !== 'object') throw new Error('乐谱数据格式错误');
  const o = p as Record<string, unknown>;
  if (!VALID_CLEFS.includes(o.clef as Clef)) throw new Error(`无效谱号: ${String(o.clef)}`);
  validateKey(o.key);
  validateTime(o.time);
  if (typeof o.measureCount !== 'number' || o.measureCount < 1 || o.measureCount > 64 || !Number.isInteger(o.measureCount)) {
    throw new Error(`无效小节数: ${String(o.measureCount)}`);
  }
  // 双组(treble/bass):新格式。旧格式只有 notes → 兼容读入 treble。
  const trebleRaw = Array.isArray(o.treble) ? o.treble : (Array.isArray(o.notes) ? o.notes : null);
  const bassRaw = Array.isArray(o.bass) ? o.bass : null;
  if (!trebleRaw && !bassRaw) throw new Error('缺少音符数据(treble/bass/notes 均无)');
  const treble = trebleRaw ? (trebleRaw as unknown[]).map(validateNote) : [] as Note[];
  const bass = bassRaw ? (bassRaw as unknown[]).map(validateNote) : [] as Note[];
  // notes = 活跃组视图:按 clef 指向对应组(导入后 App 会按模式重指向,这里先按 clef 默认)
  const notes = o.clef === 'bass' ? bass : treble;
  return {
    clef: o.clef as Clef,
    key: o.key as Piece['key'],
    time: o.time as Piece['time'],
    measureCount: o.measureCount as number,
    notes,
    treble,
    bass,
  };
}

function validateKey(k: unknown): void {
  if (!k || typeof k !== 'object') throw new Error('调号格式错误');
  const o = k as Record<string, unknown>;
  if (!VALID_KEY_NAMES.includes(o.name as KeyName)) throw new Error(`无效调号名: ${String(o.name)}`);
  if (typeof o.tonic !== 'number') throw new Error('调号 tonic 无效');
  if (!Array.isArray(o.sharps) || o.sharps.some(x => typeof x !== 'number')) throw new Error('调号 sharps 无效');
  if (!Array.isArray(o.flats) || o.flats.some(x => typeof x !== 'number')) throw new Error('调号 flats 无效');
}

function validateTime(t: unknown): void {
  if (!t || typeof t !== 'object') throw new Error('拍号格式错误');
  const o = t as Record<string, unknown>;
  if (typeof o.num !== 'number' || o.num < 1 || o.num > 32 || !Number.isInteger(o.num)) {
    throw new Error(`无效拍号分子: ${String(o.num)}`);
  }
  if (typeof o.den !== 'number' || ![1, 2, 4, 8, 16].includes(o.den)) {
    throw new Error(`无效拍号分母: ${String(o.den)}`);
  }
}

function validateNote(n: unknown, i: number): Note {
  if (!n || typeof n !== 'object') throw new Error(`第 ${i + 1} 个音符格式错误`);
  const o = n as Record<string, unknown>;
  if (o.midi !== null && (typeof o.midi !== 'number' || o.midi < 0 || o.midi > 127 || !Number.isInteger(o.midi))) {
    throw new Error(`第 ${i + 1} 个音符音高无效: ${String(o.midi)}`);
  }
  if (!VALID_DURATIONS.includes(o.duration as DurationValue)) {
    throw new Error(`第 ${i + 1} 个音符时值无效: ${String(o.duration)}`);
  }
  if (typeof o.dotted !== 'boolean') throw new Error(`第 ${i + 1} 个音符附点标记无效`);
  if (!VALID_ACCIDENTALS.includes(o.accidental as Accidental)) {
    throw new Error(`第 ${i + 1} 个音符临时记号无效`);
  }
  const note: Note = {
    midi: o.midi as Note['midi'],
    duration: o.duration as DurationValue,
    dotted: o.dotted,
    accidental: o.accidental as Accidental,
  };
  if (o.tieStart !== undefined) note.tieStart = Boolean(o.tieStart);
  if (o.tieEnd !== undefined) note.tieEnd = Boolean(o.tieEnd);
  if (o.tuplet !== undefined && o.tuplet !== null) note.tuplet = validateTuplet(o.tuplet, i);
  if (o.chordId !== undefined && o.chordId !== null) note.chordId = String(o.chordId);
  return note;
}

function validateTuplet(t: unknown, i: number): NonNullable<Note['tuplet']> {
  if (!t || typeof t !== 'object') throw new Error(`第 ${i + 1} 个音符连音组格式错误`);
  const o = t as Record<string, unknown>;
  if (typeof o.actual !== 'number' || o.actual < 2 || !Number.isInteger(o.actual)) {
    throw new Error(`第 ${i + 1} 个音符连音 actual 无效`);
  }
  if (typeof o.normal !== 'number' || o.normal < 1 || !Number.isInteger(o.normal)) {
    throw new Error(`第 ${i + 1} 个音符连音 normal 无效`);
  }
  if (typeof o.groupId !== 'string' || !o.groupId) {
    throw new Error(`第 ${i + 1} 个音符连音 groupId 无效`);
  }
  return { actual: o.actual, normal: o.normal, groupId: o.groupId };
}

/** 生成导出文件名：乐谱-YYYYMMDD-HHmm.msheet */
export function sheetFileName(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `乐谱-${stamp}${SHEET_EXTENSION}`;
}
