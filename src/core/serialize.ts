// 乐谱序列化 —— 导出/导入的文件格式与读写逻辑。
//
// 格式：带版本头的 JSON，扩展名 .msheet
//   { "format": "musicsheet", "version": 1, "exportedAt": <ms>, "piece": <Piece> }
//
// 设计原则：
// - Piece 原样 JSON 化，零信息丢失（tie/tuplet/chord 全保）。
// - 版本头保证未来向后兼容：version 升级时在 migrate() 里做迁移。
// - deserialize 做严格校验，任何字段不合法都抛带提示的 Error，不破坏调用方当前乐谱。

import { Accidental, Clef, DurationValue, KeyName, Note, Piece, TimeSig, ViewMode } from './types';
import { Score, ScoreMeta, MeasureData } from './score';

export const SHEET_FORMAT = 'musicsheet';
export const SHEET_VERSION = 1;
export const SHEET_EXTENSION = '.msheet';

/** 整曲(Score)打包格式版本。与 SHEET_VERSION(单 Piece 文件)分开,因为 Score 结构不同。 */
export const SCORE_FORMAT = 'musicsheet-score';
export const SCORE_VERSION = 1;

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
  if (typeof o.measureCount !== 'number' || o.measureCount < 1 || o.measureCount > 256 || !Number.isInteger(o.measureCount)) {
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

// ── 整曲(Score)/小节(Measure)级序列化 ────────────────────────────
// 用途:
//  - serializeScore/deserializeScore:整曲打包导入导出(.mscore 文件,带 SCORE_FORMAT 头)。
//  - serializeMeasure/deserializeMeasure:服务端按小节存盘(m0001.json),支持局部覆写。
// 复用 validateNote/validateKey/validateTime 保证音符结构合法,零信息丢失。

/** 小节文件名(m{4位}.json,零填充便于目录排序)。 */
export function measureFileName(measureIndex0Based: number): string {
  return 'm' + String(measureIndex0Based + 1).padStart(4, '0') + '.json';
}

/** 把单个小节序列化为 JSON 字符符(m0001.json 内容)。 */
export function serializeMeasure(m: MeasureData): string {
  return JSON.stringify({ treble: m.treble, bass: m.bass });
}

/** 解析单个小节 JSON。任何不合法抛 Error(带中文提示)。 */
export function deserializeMeasure(text: string): MeasureData {
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch { throw new Error('小节文件不是有效的 JSON'); }
  if (!obj || typeof obj !== 'object') throw new Error('小节文件内容为空或非对象');
  const o = obj as Record<string, unknown>;
  const trebleRaw = Array.isArray(o.treble) ? o.treble : null;
  const bassRaw = Array.isArray(o.bass) ? o.bass : null;
  if (!trebleRaw && !bassRaw) throw new Error('小节缺少音符数据(treble/bass)');
  const treble = trebleRaw ? (trebleRaw as unknown[]).map((n, i) => validateNote(n, i)) : [] as Note[];
  const bass = bassRaw ? (bassRaw as unknown[]).map((n, i) => validateNote(n, i)) : [] as Note[];
  return { treble, bass };
}

/** manifest.json 序列化(整曲元数据)。 */
export function serializeMeta(meta: ScoreMeta): string {
  return JSON.stringify(meta, null, 2);
}

/** 解析 manifest.json。任何不合法抛 Error。 */
export function deserializeMeta(text: string): ScoreMeta {
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch { throw new Error('manifest 不是有效的 JSON'); }
  if (!obj || typeof obj !== 'object') throw new Error('manifest 内容为空或非对象');
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) throw new Error('manifest 缺少 id');
  if (typeof o.title !== 'string') throw new Error('manifest title 无效');
  validateKey(o.key);
  validateTime(o.time);
  if (typeof o.totalMeasures !== 'number' || o.totalMeasures < 1 || o.totalMeasures > 256 || !Number.isInteger(o.totalMeasures)) {
    throw new Error(`manifest totalMeasures 无效: ${String(o.totalMeasures)}`);
  }
  const VALID_VIEWS: readonly ViewMode[] = ['treble', 'bass', 'grand', 'preview'];
  if (!VALID_VIEWS.includes(o.viewMode as ViewMode)) throw new Error(`manifest viewMode 无效: ${String(o.viewMode)}`);
  if (typeof o.updatedAt !== 'number') throw new Error('manifest updatedAt 无效');
  return {
    id: o.id,
    title: o.title,
    key: o.key as ScoreMeta['key'],
    time: o.time as TimeSig,
    totalMeasures: o.totalMeasures,
    viewMode: o.viewMode as ViewMode,
    updatedAt: o.updatedAt,
  };
}

interface ScoreFile {
  format: string;
  version: number;
  exportedAt: number;
  score: { meta: ScoreMeta; measures: MeasureData[] };
}

/** 整曲打包序列化为字符串(整曲导入导出)。 */
export function serializeScore(score: Score): string {
  const file: ScoreFile = {
    format: SCORE_FORMAT,
    version: SCORE_VERSION,
    exportedAt: Date.now(),
    score: { meta: score.meta, measures: score.measures },
  };
  return JSON.stringify(file, null, 2);
}

/** 解析整曲打包字符串。任何不合法抛 Error。 */
export function deserializeScore(text: string): Score {
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch { throw new Error('不是有效的 JSON 文件'); }
  if (!obj || typeof obj !== 'object') throw new Error('文件内容为空或不是对象');
  const f = obj as Partial<ScoreFile>;
  if (f.format !== SCORE_FORMAT) {
    throw new Error('不是 MusicSheet 整曲文件(缺少 ' + SCORE_FORMAT + ' 标识)');
  }
  if (typeof f.version !== 'number') throw new Error('缺少版本号');
  if (f.version !== SCORE_VERSION) {
    throw new Error(`不支持的整曲版本 v${f.version}(当前支持 v${SCORE_VERSION})`);
  }
  if (!f.score) throw new Error('缺少整曲数据(score)');
  const meta = deserializeMeta(JSON.stringify(f.score.meta));
  // f.score.measures 走 unknown 重新校验,不信任 wire 格式。
  const measuresRaw = (f.score as { measures: unknown }).measures;
  if (!Array.isArray(measuresRaw)) throw new Error('整曲 measures 不是数组');
  if (measuresRaw.length !== meta.totalMeasures) {
    throw new Error(`整曲小节数(${measuresRaw.length})与 totalMeasures(${meta.totalMeasures})不符`);
  }
  const measures: MeasureData[] = (measuresRaw as unknown[]).map((m, i) => {
    if (!m || typeof m !== 'object') throw new Error(`第 ${i + 1} 小节格式错误`);
    const mo = m as Record<string, unknown>;
    const trebleRaw = Array.isArray(mo.treble) ? mo.treble : null;
    const bassRaw = Array.isArray(mo.bass) ? mo.bass : null;
    const treble = trebleRaw ? (trebleRaw as unknown[]).map((n, j) => validateNote(n, j)) : [] as Note[];
    const bass = bassRaw ? (bassRaw as unknown[]).map((n, j) => validateNote(n, j)) : [] as Note[];
    return { treble, bass };
  });
  return { meta, measures };
}

/** 整曲导出文件名:标题-sanitized-YYYYMMDD-HHmm.mscore。 */
export function scoreFileName(title: string, d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  // 标题做文件名安全化:去掉路径分隔符/空白压缩,空标题用「未命名」。
  const safe = (title || '未命名').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_') || '未命名';
  return `${safe}-${stamp}.mscore`;
}
