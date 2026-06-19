// 谱面异常诊断：扫描 piece 检测数据层面的问题（首版只检测超拍 overfill）。
//
// 设计：纯函数，无副作用。读 piece 原始数据，返回 Issue[]。
// 渲染层（layout）会先 clamp 兜底保证不崩，本函数用于「告知」调用方发现了什么，
// 调用方决定额外反应（首页 console.warn、测试页 tint 红 等）。

import { Piece, beatsPerBar, durationBeats } from '../core/types';
import { noteStartBeats } from '../core/model';

/** 一个谱面问题。noteIdx/barIdx 用于定位，message 供人读。 */
export interface Issue {
  /** 出问题的音符在 piece.notes 中的索引 */
  noteIdx: number;
  /** 该音符所在小节（0-based） */
  barIdx: number;
  /** 人读描述 */
  message: string;
}

/**
 * 扫描 piece，返回所有「超拍」问题。
 * 超拍定义：某音符的结束拍(endBeat)严格超出其起始小节的容量边界
 *           (允许正好填满，即 endBeat == barEnd 不算超拍)。
 */
export function diagnoseOverfill(piece: Piece): Issue[] {
  const bpb = beatsPerBar(piece.time);
  const starts = noteStartBeats(piece);
  const issues: Issue[] = [];
  for (let i = 0; i < piece.notes.length; i++) {
    const startBeat = starts[i];
    const dur = durationBeats(piece.notes[i].duration, piece.notes[i].dotted);
    const endBeat = startBeat + dur;
    const barIdx = Math.floor(startBeat / bpb);
    const barEnd = (barIdx + 1) * bpb;
    if (endBeat > barEnd + 1e-6) {
      issues.push({
        noteIdx: i,
        barIdx,
        message: `第${barIdx + 1}小节:音符 #${i}(${piece.notes[i].duration}${piece.notes[i].dotted ? '附点' : ''})结束于第${endBeat.toFixed(2)}拍,跨入下一小节(小节容量${bpb}拍)`,
      });
    }
  }
  return issues;
}
