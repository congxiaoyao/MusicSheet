// 曲谱项目(Score)数据模型 —— 支持整曲多小节 + 「某小节起的连续 N 个」编辑区。
//
// 核心思路(零侵入现有渲染/编辑层):
//   整曲存 N 个小节(score.measures[]),编辑时只把「第 startMeasure 起的 count 个小节」
//   拼成一个临时 Piece(rangeToPiece)喂给现有 computeLayout/renderStaffSVG/appendNote/popNote
//   /player —— 它们继续吃「N 小节单行 Piece」,完全不用改。
//   编辑后用 pieceBackToScore 把这块 Piece 按小节拍边界切回 score.measures[startMeasure..]。
//
// 小节边界 tie/tuplet:录入时第 count 个小节拍满即止(现有 remainingReatsInCurrentBar 已保证),
// tie/tuplet 不跨小节块。故 pieceBackToScore 切分时不会割断 tie/tuplet。

import { KeySig, Note, Piece, TimeSig, ViewMode, beatsPerBar } from './types';
import { noteStartBeats, snapBeat } from './model';

/** 单个小节:treble/bass 两组音符(各是一段独立的追加式录入序列)。 */
export interface MeasureData {
  treble: Note[];
  bass: Note[];
}

/** 曲谱元数据(整曲级,manifest.json)。 */
export interface ScoreMeta {
  /** 唯一 id(服务端生成,目录名)。 */
  id: string;
  /** 曲谱标题。 */
  title: string;
  /** 调号(整曲共享)。 */
  key: KeySig;
  /** 拍号(整曲共享)。 */
  time: TimeSig;
  /** 整曲总小节数。 */
  totalMeasures: number;
  /** 视图模式(高音/低音/双谱/预览)。 */
  viewMode: ViewMode;
  /** 最后更新时间(ms)。 */
  updatedAt: number;
}

/** 整曲。measures 长度 = totalMeasures,空小节存 {treble:[],bass:[]}。 */
export interface Score {
  meta: ScoreMeta;
  measures: MeasureData[];
}

/** 空小节。 */
export function emptyMeasure(): MeasureData {
  return { treble: [], bass: [] };
}

/** 用 meta 生成一个全空的新 Score。 */
export function createScore(meta: ScoreMeta): Score {
  const measures: MeasureData[] = [];
  for (let i = 0; i < meta.totalMeasures; i++) measures.push(emptyMeasure());
  return { meta, measures };
}

// ── 范围 ↔ Piece 转换 ────────────────────────────────────────

/** 把 score 第 startMeasure 起的 count 个小节拼成一个临时 Piece,供现有渲染/编辑层使用。
 *  - measureCount = count(编辑区显示的小节数)
 *  - treble/bass = 这 count 个小节的对应组依次拼接
 *  - clef/notes 由 viewMode + active staff 决定(调用方按 viewMode 再调整 clef/notes 指向)
 *  - key/time = 整曲级
 *  注意:startMeasure + count 会 clamp 到 [0, totalMeasures]。count 不足(到末尾)时,
 *  measureCount 取实际能取到的小节数,保证编辑区不出现空白尾。 */
export function rangeToPiece(score: Score, startMeasure: number, count: number, activeStaff: 'treble' | 'bass' = 'treble'): Piece {
  const start = Math.max(0, Math.min(startMeasure, score.meta.totalMeasures - 1));
  const end = Math.min(start + count, score.meta.totalMeasures);
  const realCount = Math.max(1, end - start);
  const treble: Note[] = [];
  const bass: Note[] = [];
  for (let i = start; i < end; i++) {
    const m = score.measures[i];
    if (m) { treble.push(...m.treble); bass.push(...m.bass); }
  }
  // clef/notes 按活跃组指向(与现有 Piece.notes 视图别名一致)。
  const clef = activeStaff;
  const notes = activeStaff === 'bass' ? bass : treble;
  return {
    clef,
    key: score.meta.key,
    time: score.meta.time,
    measureCount: realCount,
    notes,
    treble,
    bass,
  };
}

/** 把编辑后的范围 Piece 切回 score.measures[startMeasure..]。
 *  按小节拍边界切分:遍历拼接后的 treble/bass,用 noteStartBeats 算每个音的起始拍,
 *  落在第 k 小节(measureOfBeat)的音归到 score.measures[startMeasure + k]。
 *  - 和弦尾音(isChordTail)复用首音的 startBeat,与首音同小节,天然正确。
 *  - tie/tuplet 不跨小节(录入层保证),切分不会割断。
 *  - 浮点鲁棒:用 snapBeat 吸附小节右边界(tuplet 累加误差)。 */
export function pieceBackToScore(score: Score, piece: Piece, startMeasure: number): void {
  const start = Math.max(0, Math.min(startMeasure, score.meta.totalMeasures - 1));
  const bpb = beatsPerBar(piece.time);
  const count = piece.measureCount;

  // 先把范围内的小节清空(准备重填)。注意只清范围,范围外保留。
  for (let i = start; i < start + count && i < score.meta.totalMeasures; i++) {
    score.measures[i] = emptyMeasure();
  }

  const splitStaff = (notes: Note[], groupKey: 'treble' | 'bass') => {
    if (notes.length === 0) return;
    const starts = noteStartBeats({ ...piece, notes });
    for (let i = 0; i < notes.length; i++) {
      const startBeat = starts[i];
      // snapBeat 吸附:三连音填满小节时 startBeat≈3.9999...,裸 floor 会漂到下一小节。
      const snapped = snapBeat(startBeat, bpb);
      const localMeasure = Math.floor(snapped / bpb);   // 0-based,相对范围起点
      const targetIdx = start + localMeasure;
      if (targetIdx < 0 || targetIdx >= score.meta.totalMeasures || targetIdx >= start + count) continue;
      if (!score.measures[targetIdx]) score.measures[targetIdx] = emptyMeasure();
      score.measures[targetIdx][groupKey].push(notes[i]);
    }
  };
  splitStaff(piece.treble, 'treble');
  splitStaff(piece.bass, 'bass');
}

// ── 辅助:范围编辑相关几何 ────────────────────────────────────

/** 判断 piece(范围视图)里某个音索引是否是它所在小节的「最后一个时间位」。
 *  用于编辑层判断「这块还能不能再加音」。复用现有 model 逻辑即可,此处不重复实现。 */

/** 找出 piece(范围视图)相对 score 起点的全局小节索引列表(每个音一个)。
 *  供播放/高亮定位用(未来扩展)。 */
export function noteGlobalMeasureIndices(score: Score, piece: Piece, startMeasure: number): number[] {
  const bpb = beatsPerBar(piece.time);
  const start = Math.max(0, Math.min(startMeasure, score.meta.totalMeasures - 1));
  const out: number[] = [];
  const collect = (notes: Note[]) => {
    if (notes.length === 0) return;
    const starts = noteStartBeats({ ...piece, notes });
    for (let i = 0; i < notes.length; i++) {
      const localM = Math.floor(snapBeat(starts[i], bpb) / bpb);
      out.push(start + localM);
    }
  };
  collect(piece.treble);
  return out;
}
