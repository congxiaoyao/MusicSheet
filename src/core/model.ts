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
    notes: [],
  };
}

/** 总拍数（四分音符为单位） */
export function totalBeats(piece: Piece): number {
  let sum = 0;
  for (const n of piece.notes) sum += durationBeats(n.duration, n.dotted);
  return sum;
}

/** 最大可容纳拍数 = 4 个小节 */
export function capacityBeats(piece: Piece): number {
  return beatsPerBar(piece.time) * 4;
}

/** 还能再插入多少拍 */
export function remainingBeats(piece: Piece): number {
  return Math.max(0, capacityBeats(piece) - totalBeats(piece));
}

/** 追加一个音符到末尾（短信验证码式）。若超出容量则失败。 */
export function appendNote(piece: Piece, note: Note): boolean {
  const beats = durationBeats(note.duration, note.dotted);
  if (beats > remainingBeats(piece)) return false;
  piece.notes.push(note);
  return true;
}

/** 删除末尾的最后一个音符（短信验证码式 backspace）。 */
export function popNote(piece: Piece): boolean {
  if (piece.notes.length === 0) return false;
  piece.notes.pop();
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
    acc += durationBeats(n.duration, n.dotted);
  }
  return starts;
}

/** 计算小节分割线的拍数位置：0, bpb, 2*bpb, 3*bpb, 4*bpb */
export function barLineBeats(piece: Piece): number[] {
  const bpb = beatsPerBar(piece.time);
  return [0, bpb, bpb * 2, bpb * 3, bpb * 4];
}
