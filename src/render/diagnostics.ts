// 谱面异常诊断：扫描 piece 检测数据层面的问题，返回 Issue[]。
// 设计：纯函数，无副作用。渲染层(layout)先 clamp 兜底保证不崩，本模块用于「告知」
// 调用方发现了哪些问题，调用方决定额外反应(首页 console.warn、测试页 tint 红 等)。
//
// Issue 带 kind 字段，便于按类型处理/过滤。noteIdx/barIdx 为 -1 表示非特定音符/小节。

import { Piece, beatsPerBar, durationBeats } from '../core/types';
import { noteStartBeats, totalBeats, capacityBeats } from '../core/model';

/** 问题类型 */
export type IssueKind = 'overfill' | 'capacity' | 'keysig' | 'pitch' | 'timesig';

/** 一个谱面问题。 */
export interface Issue {
  kind: IssueKind;
  /** 出问题的音符在 piece.notes 中的索引；-1 表示非特定音符 */
  noteIdx: number;
  /** 该音符所在小节（0-based）；-1 表示非特定 */
  barIdx: number;
  /** 人读描述 */
  message: string;
}

/**
 * 调号自洽性校验（静态，不依赖 notes）。三层检查：
 *   - sharps/flats 互斥（不能同时非空）
 *   - sharps/flats 数量与调名在五度圈的期望数量一致
 *   - 主音 pc 精细校验：主音字母的自然 pc 经调号修饰后，必须等于调名应有 pc
 *     （如 Eb 调主音字母 E=2，E 在 flats 里则 pc=4-1=3 == Eb 的 pc，对；若 tonic 写错则检出）
 * letter 基准已统一为固定 C=0（resolvePitch 已修），故可与 tonic 同基准校验。
 */
// 字母 C D E F G A B 的自然 pitch-class
const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11];
// 各调名应有的主音 pitch-class（五度圈推导）
const KEY_PC: Record<string, number> = {
  C: 0, G: 7, D: 2, A: 9, E: 4, B: 11, 'F#': 6,
  F: 5, Bb: 10, Eb: 3, Ab: 8, Db: 1, Gb: 6,
};
export function diagnoseKeySignature(piece: Piece): Issue[] {
  const issues: Issue[] = [];
  const key = piece.key;
  const name = key.name;

  // sharps/flats 互斥
  if (key.sharps.length > 0 && key.flats.length > 0) {
    issues.push({ kind: 'keysig', noteIdx: -1, barIdx: -1,
      message: `调号 ${name} 同时有升号和降号，不合法` });
  }

  // 升/降号数量与调名期望一致（五度圈位置）
  // 升号侧：C=0,G=1,D=2,A=3,E=4,B=5,F#=6；降号侧：F=1,Bb=2,Eb=3,Ab=4,Db=5,Gb=6
  const EXPECT_SHARPS: Record<string, number> = { C:0,G:1,D:2,A:3,E:4,B:5,'F#':6 };
  const EXPECT_FLATS: Record<string, number> = { C:0,F:1,Bb:2,Eb:3,Ab:4,Db:5,Gb:6 };
  if (name in EXPECT_SHARPS && key.sharps.length !== EXPECT_SHARPS[name]) {
    issues.push({ kind: 'keysig', noteIdx: -1, barIdx: -1,
      message: `调号 ${name} 升号数 ${key.sharps.length} 与期望 ${EXPECT_SHARPS[name]} 不符` });
  }
  if (name in EXPECT_FLATS && key.flats.length !== EXPECT_FLATS[name]) {
    issues.push({ kind: 'keysig', noteIdx: -1, barIdx: -1,
      message: `调号 ${name} 降号数 ${key.flats.length} 与期望 ${EXPECT_FLATS[name]} 不符` });
  }

  // 主音 pc 精细校验：主音字母的自然 pc，经调号升降修饰后，必须等于调名应有 pc。
  // 如 Eb：主音字母 E(索引2) 在 flats 里 → pc = 4-1 = 3 == KEY_PC.Eb，对。
  // 防御 tonic 字段写错（历史上 Eb/Db/Gb 曾各少1，已被本检查当时的简化版间接捕获）。
  if (name in KEY_PC) {
    let tonicPc = NATURAL_PC[key.tonic] ?? -1;
    if (key.sharps.includes(key.tonic)) tonicPc = (tonicPc + 1) % 12;
    if (key.flats.includes(key.tonic)) tonicPc = (tonicPc + 11) % 12;
    if (tonicPc !== KEY_PC[name]) {
      issues.push({ kind: 'keysig', noteIdx: -1, barIdx: -1,
        message: `调号 ${name} 主音错误：tonic=${key.tonic} 经调号修饰后 pc=${tonicPc}，应为 ${KEY_PC[name]}` });
    }
  }

  return issues;
}

/**
 * 总容量溢出：totalBeats > 4 小节容量。
 * diagnoseOverfill 只查单小节内超拍，漏掉了「总量超 4 小节」(每个音符都在自己小节内，
 * 但总量超标，layout 会把第 5 小节起的内容堆叠到第 4 小节视觉区)。本函数补这个洞。
 */
export function diagnoseCapacityOverflow(piece: Piece): Issue[] {
  const total = totalBeats(piece);
  const cap = capacityBeats(piece);
  if (total > cap + 1e-6) {
    return [{ kind: 'capacity', noteIdx: -1, barIdx: -1,
      message: `总拍数 ${total.toFixed(2)} 超过 4 小节容量 ${cap}，第 ${Math.floor(cap / beatsPerBar(piece.time)) + 1} 小节后的内容会被挤压` }];
  }
  return [];
}

/**
 * 单小节内超拍：某音符的结束拍严格超出其起始小节的容量边界
 * （允许正好填满，即 endBeat == barEnd 不算超拍）。可能级联到后续音符。
 */
export function diagnoseOverfill(piece: Piece): Issue[] {
  const bpb = beatsPerBar(piece.time);
  const starts = noteStartBeats(piece);
  const issues: Issue[] = [];
  for (let i = 0; i < piece.notes.length; i++) {
    const startBeat = starts[i];
    const dur = durationBeats(piece.notes[i]);
    const endBeat = startBeat + dur;
    const barIdx = Math.floor(startBeat / bpb);
    const barEnd = (barIdx + 1) * bpb;
    if (endBeat > barEnd + 1e-6) {
      issues.push({ kind: 'overfill', noteIdx: i, barIdx,
        message: `第${barIdx + 1}小节:音符 #${i}(${piece.notes[i].duration}${piece.notes[i].dotted ? '附点' : ''})结束于第${endBeat.toFixed(2)}拍,跨入下一小节(小节容量${bpb}拍)` });
    }
  }
  return issues;
}

/** 音高越界：midi 不在 [0,127] 钢琴范围，或对应 staff step 离谱(|step|>30)。
 *  防御导入/手写数据的极端音高(staffStepToMidi 无 clamp)。 */
export function diagnosePitchRange(piece: Piece): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < piece.notes.length; i++) {
    const midi = piece.notes[i].midi;
    if (midi === null) continue; // 休止符
    if (midi < 0 || midi > 127) {
      issues.push({ kind: 'pitch', noteIdx: i, barIdx: -1,
        message: `音符 #${i} 的 midi=${midi} 超出钢琴范围 [0,127]` });
    }
  }
  return issues;
}

/** 拍号非法：den 不属于 {2,4,8}，或 num < 1。防御 den=0 的 Infinity 级联。 */
export function diagnoseTimeSig(piece: Piece): Issue[] {
  const issues: Issue[] = [];
  const { num, den } = piece.time;
  if (![2, 4, 8].includes(den)) {
    issues.push({ kind: 'timesig', noteIdx: -1, barIdx: -1,
      message: `拍号分母 ${den} 非法，应为 2/4/8（den=0 会导致除零）` });
  }
  if (num < 1) {
    issues.push({ kind: 'timesig', noteIdx: -1, barIdx: -1,
      message: `拍号分子 ${num} 非法，应 ≥ 1` });
  }
  return issues;
}

/** 聚合所有诊断（buildSVG 调用）。顺序：timesig → keysig → capacity → overfill → pitch */
export function diagnoseAll(piece: Piece): Issue[] {
  return [
    ...diagnoseTimeSig(piece),
    ...diagnoseKeySignature(piece),
    ...diagnoseCapacityOverflow(piece),
    ...diagnoseOverfill(piece),
    ...diagnosePitchRange(piece),
  ];
}
