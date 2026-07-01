// 服务端数据校验(纯 JS,零依赖)。
// 与 src/core/serialize.ts 的校验逻辑同源(同样的字段/边界),但用纯 JS 重写,
// 因为 Node 原生 type-stripping 不支持无扩展名 import(现有 .ts 源用 './types' 而非 './types.ts')。
// 服务端只需校验 JSON 结构合法性,不依赖 TS 类型。

const VALID_DURATIONS = ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirtysecond'];
const VALID_ACCIDENTALS = ['sharp', 'flat', 'natural', null];
const VALID_KEY_NAMES = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
const VALID_CLEFS = ['treble', 'bass'];
const VALID_VIEWS = ['treble', 'bass', 'grand', 'preview'];

function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function isInt(x) { return typeof x === 'number' && Number.isInteger(x); }

export function validateNote(n, i) {
  if (!isObj(n)) throw new Error(`第 ${i + 1} 个音符格式错误`);
  if (n.midi !== null && !(typeof n.midi === 'number' && isInt(n.midi) && n.midi >= 0 && n.midi <= 127)) {
    throw new Error(`第 ${i + 1} 个音符音高无效: ${String(n.midi)}`);
  }
  if (!VALID_DURATIONS.includes(n.duration)) {
    throw new Error(`第 ${i + 1} 个音符时值无效: ${n.duration}`);
  }
  if (typeof n.dotted !== 'boolean') throw new Error(`第 ${i + 1} 个音符附点标记无效`);
  if (!VALID_ACCIDENTALS.includes(n.accidental)) {
    throw new Error(`第 ${i + 1} 个音符临时记号无效`);
  }
  const note = {
    midi: n.midi,
    duration: n.duration,
    dotted: n.dotted,
    accidental: n.accidental,
  };
  if (n.tieStart !== undefined) note.tieStart = Boolean(n.tieStart);
  if (n.tieEnd !== undefined) note.tieEnd = Boolean(n.tieEnd);
  if (n.tuplet !== undefined && n.tuplet !== null) note.tuplet = validateTuplet(n.tuplet, i);
  if (n.chordId !== undefined && n.chordId !== null) note.chordId = String(n.chordId);
  return note;
}

function validateTuplet(t, i) {
  if (!isObj(t)) throw new Error(`第 ${i + 1} 个音符连音组格式错误`);
  if (!isInt(t.actual) || t.actual < 2) throw new Error(`第 ${i + 1} 个音符连音 actual 无效`);
  if (!isInt(t.normal) || t.normal < 1) throw new Error(`第 ${i + 1} 个音符连音 normal 无效`);
  if (typeof t.groupId !== 'string' || !t.groupId) throw new Error(`第 ${i + 1} 个音符连音 groupId 无效`);
  return { actual: t.actual, normal: t.normal, groupId: t.groupId };
}

export function validateMeasure(m, idx) {
  if (!isObj(m)) throw new Error(`第 ${idx + 1} 小节格式错误`);
  const trebleRaw = Array.isArray(m.treble) ? m.treble : null;
  const bassRaw = Array.isArray(m.bass) ? m.bass : null;
  if (!trebleRaw && !bassRaw) throw new Error(`第 ${idx + 1} 小节缺少 treble/bass`);
  const treble = trebleRaw ? trebleRaw.map((n, j) => validateNote(n, j)) : [];
  const bass = bassRaw ? bassRaw.map((n, j) => validateNote(n, j)) : [];
  return { treble, bass };
}

export function validateKey(k) {
  if (!isObj(k)) throw new Error('调号格式错误');
  if (!VALID_KEY_NAMES.includes(k.name)) throw new Error(`无效调号名: ${k.name}`);
  if (typeof k.tonic !== 'number') throw new Error('调号 tonic 无效');
  if (!Array.isArray(k.sharps) || k.sharps.some(x => typeof x !== 'number')) throw new Error('调号 sharps 无效');
  if (!Array.isArray(k.flats) || k.flats.some(x => typeof x !== 'number')) throw new Error('调号 flats 无效');
  return k;
}

export function validateTime(t) {
  if (!isObj(t)) throw new Error('拍号格式错误');
  if (!isInt(t.num) || t.num < 1 || t.num > 32) throw new Error(`无效拍号分子: ${t.num}`);
  if (![1, 2, 4, 8, 16].includes(t.den)) throw new Error(`无效拍号分母: ${t.den}`);
  return t;
}

/** 校验 manifest meta,返回标准化后的 meta(补默认值 + updatedAt)。 */
export function validateMeta(meta) {
  if (!isObj(meta)) throw new Error('manifest 格式错误');
  if (typeof meta.id !== 'string' || !meta.id) throw new Error('manifest 缺少 id');
  if (typeof meta.title !== 'string') throw new Error('manifest title 无效');
  validateKey(meta.key || { name: 'C', tonic: 0, sharps: [], flats: [] });
  validateTime(meta.time || { num: 4, den: 4 });
  const tm = meta.totalMeasures;
  if (!isInt(tm) || tm < 1 || tm > 256) throw new Error(`manifest totalMeasures 无效: ${tm}`);
  if (!VALID_VIEWS.includes(meta.viewMode)) throw new Error(`manifest viewMode 无效: ${meta.viewMode}`);
  if (typeof meta.updatedAt !== 'number') meta.updatedAt = Date.now();
  return meta;
}

/** 校验整曲 score 打包(导入用)。返回标准化后的 {meta, measures}。 */
export function validateScore(score) {
  if (!isObj(score)) throw new Error('整曲数据格式错误');
  const meta = validateMeta(score.meta);
  const measuresRaw = score.measures;
  if (!Array.isArray(measuresRaw)) throw new Error('整曲 measures 不是数组');
  if (measuresRaw.length !== meta.totalMeasures) {
    throw new Error(`整曲小节数(${measuresRaw.length})与 totalMeasures(${meta.totalMeasures})不符`);
  }
  const measures = measuresRaw.map((m, i) => validateMeasure(m, i));
  return { meta, measures };
}
