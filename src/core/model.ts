// 乐曲状态：追加式录入（类似短信验证码输入）
// - 只能往末尾追加音符
// - 只能从末尾删除
// - 没有「任意光标」，下一个待输入位置永远是 notes.length

import { beatsPerBar, durationBeats, Note, Piece } from './types';

export function createPiece(): Piece {
  return {
    clef: 'treble',
    key: { name: 'C', tonic: 0, sharps: [], flats: [] },
    time: { num: 4, den: 4 },
    measureCount: 2,
    notes: [],
  };
}

/** 总拍数（四分音符为单位） */
export function totalBeats(piece: Piece): number {
  let sum = 0;
  for (const n of piece.notes) sum += durationBeats(n);
  return sum;
}

/** 最大可容纳拍数 = measureCount 个小节 */
export function capacityBeats(piece: Piece): number {
  return beatsPerBar(piece.time) * piece.measureCount;
}

/** 还能再插入多少拍 */
export function remainingBeats(piece: Piece): number {
  return Math.max(0, capacityBeats(piece) - totalBeats(piece));
}

/** 下一个待写音符所在小节还能容纳多少拍。
 *  若当前小节未满，返回当前小节剩余；若当前小节正好填满，返回下一小节全容量
 *  (因为下一个音符会从新小节开始)。受全局容量限制。
 *  用于交互层防超拍：让正常录入永远不会产生跨小节的超拍数据。 */
export function remainingBeatsInCurrentBar(piece: Piece): number {
  const bpb = beatsPerBar(piece.time);
  const total = totalBeats(piece);
  const beatInBar = total % bpb;
  const barFull = Math.abs(beatInBar) < 1e-6 && total > 0; // 当前小节正好填满
  // 当前小节满 → 下一个音符进新小节，剩 bpb；否则剩当前小节余量
  const barRemain = barFull ? bpb : (bpb - beatInBar);
  return Math.max(0, Math.min(barRemain, remainingBeats(piece)));
}

/** 追加一个音符到末尾（短信验证码式）。若超出容量或本小节放不下则失败。 */
export function appendNote(piece: Piece, note: Note): boolean {
  const beats = durationBeats(note);
  if (beats > remainingBeats(piece)) return false;                    // 全局容量(保留)
  // 连音组(tuplet)内的音放宽本小节校验：组内各音要挤进整组占的时长里，
  // 单个音的本小节判定会误判（三连音每个 1/3 拍，但组要占满 1 拍）。
  // 组凑齐后的整体超拍由诊断层(diagnoseOverfill)报告。非 tuplet 音仍严格校验。
  if (!note.tuplet && beats > remainingBeatsInCurrentBar(piece) + 1e-6) return false; // 本小节放不下
  piece.notes.push(note);
  return true;
}

/** 删除末尾的最后一个音符（短信验证码式 backspace）。 */
export function popNote(piece: Piece): boolean {
  if (piece.notes.length === 0) return false;
  const removed = piece.notes.pop()!;
  // 连音线清理：被删的是 tie 终点 → 前音的 tieStart 失去配对，清掉（避免孤立 tieStart）。
  // 被删的是 tieStart 时它本就是末尾、无对应 tieEnd，无需处理。
  if (removed.tieEnd && piece.notes.length > 0) {
    piece.notes[piece.notes.length - 1].tieStart = false;
  }
  return true;
}

/**
 * 计算每个音符累计的「起始拍」位置（从 0 开始）。
 */
export function noteStartBeats(piece: Piece): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const n of piece.notes) {
    starts.push(acc);
    acc += durationBeats(n);
  }
  return starts;
}

/** 计算小节分割线的拍数位置：0, bpb, 2*bpb, ..., measureCount*bpb */
export function barLineBeats(piece: Piece): number[] {
  const bpb = beatsPerBar(piece.time);
  const bars = piece.measureCount;
  const out: number[] = [];
  for (let i = 0; i <= bars; i++) out.push(bpb * i);
  return out;
}

/** 连音组(tuplet)在 notes 数组中的范围。startIdx..endIdx 为组内音符索引（含两端）。 */
export interface TupletRange {
  startIdx: number;
  endIdx: number;
  /** 实际音符数（时间位数） */
  actual: number;
  /** 对应普通音符数 */
  normal: number;
  /** 组标识 */
  groupId: string;
}

/** 扫描 notes，按 tuplet.groupId 聚合出连音组范围（相邻同 groupId 的音归为一组）。
 *  供渲染层（画数字/括号）、连梁、布局消费。 */
export function tupletGroups(piece: Piece): TupletRange[] {
  const notes = piece.notes;
  const groups: TupletRange[] = [];
  let i = 0;
  while (i < notes.length) {
    const t = notes[i].tuplet;
    if (!t) { i++; continue; }
    // 从 i 开始，向后收集同 groupId 的连续音
    let j = i;
    while (j < notes.length && notes[j].tuplet && notes[j].tuplet!.groupId === t.groupId) j++;
    groups.push({ startIdx: i, endIdx: j - 1, actual: t.actual, normal: t.normal, groupId: t.groupId });
    i = j;
  }
  return groups;
}
