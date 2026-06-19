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
  for (const n of piece.notes) sum += durationBeats(n.duration, n.dotted);
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
  const beats = durationBeats(note.duration, note.dotted);
  if (beats > remainingBeats(piece)) return false;                    // 全局容量(保留)
  if (beats > remainingBeatsInCurrentBar(piece) + 1e-6) return false; // 本小节放不下(新增)
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

/** 计算小节分割线的拍数位置：0, bpb, 2*bpb, ..., measureCount*bpb */
export function barLineBeats(piece: Piece): number[] {
  const bpb = beatsPerBar(piece.time);
  const bars = piece.measureCount;
  const out: number[] = [];
  for (let i = 0; i <= bars; i++) out.push(bpb * i);
  return out;
}
