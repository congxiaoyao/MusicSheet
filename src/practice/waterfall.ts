// Waterfall —— 练琴页瀑布流方块组件(方块下落 + 命中 + 左右手 + 区域裁剪)。
//
// 设计文档:docs/钢琴与方块组件设计.md §4。本文件按文档「八、实施步骤」Step 3-4 实现:
//   - 从原型 practice-prototype.html 迁移方块下落逻辑(frame, L788-831),TS 化
//   - 方块宽度用 noteWidth(对应键宽,文档 §4.3,修正原型写死 28px)
//   - 去掉 glowKey(不再驱动键盘,改 controller 喂数据给键盘,文档 §6.2)
//   - 加 setBounds/setHandFilter 接口
//
// 复用边界(文档 §6.2):
//   - 从原型迁移:blocks 循环、midiToX、命中判断
//   - 直接 import:key-coords(midiToX/noteWidth)、core/score(Score/rangeToPiece)、
//       core/types(Note/durationBeats/beatsPerBar)、core/model(noteStartBeats)
//   - 不动:playback-card.ts、原型 html
//
// 组件模式:命令式工厂 + Handle。被动接收驱动,一般不向外回调。

import './waterfall.css';
import { Score } from '../core/score';
import { rangeToPiece } from '../core/score';
import { durationBeats } from '../core/types';
import { noteStartBeats } from '../core/model';
import { KeyRange, midiToX, noteWidth } from './key-coords';

// ── 数据结构(文档 §4.2) ──────────────────────────────────

/** 方块从乐谱解析出的内部数据。 */
export interface FallNote {
  midi: number;
  beat: number;       // 起始拍(整曲绝对)
  duration: number;   // 时值(拍)
  hand: 'R' | 'L';    // 左右手(treble=R, bass=L)
}

// ── 接口(文档 §4.7) ──────────────────────────────────────

export interface WaterfallInitial {
  /** 从乐谱解析出的音符(或直接传 Score 内部解析)。 */
  notes: FallNote[];
  /** 音域(传给 midiToX 用)。 */
  range: KeyRange;
  /** 白键宽 px(传给 midiToX/noteWidth 用,与键盘同套坐标系)。 */
  whiteW: number;
}

export interface WaterfallCallbacks {
  // 方块组件一般不需要向外回调(它只接收驱动、自己渲染)。
}

export interface WaterfallHandle {
  el: HTMLElement;
  /** controller 每帧调:驱动方块下落 + 命中判断。 */
  onTick(beat: number): void;
  /** 乐谱变更时重新解析音符。 */
  setNotes(notes: FallNote[]): void;
  /** 键宽/音域变化时重新算横轴(键盘拖滑块时 controller 调)。 */
  setKeyLayout(info: { range: KeyRange; whiteW: number }): void;
  /** 单手隔离:'both' | 'R' | 'L'。 */
  setHandFilter(hand: 'both' | 'R' | 'L'): void;
  /** 设置掉落区域上边界(ScoreSheet 当前行底部)+ 下边界(键盘顶部)。
   *  被动接口:topY/bottomY 谁算的不关心(本次测试页自给,真实页由 controller 算)。 */
  setBounds(info: { topY: number; bottomY: number }): void;
}

// ── 常量(从原型迁移,按用户反馈调校) ─────────────────────
/** 垂直像素/拍(下落速度)。原型 92,提到 130(长方块快速掠过,视觉紧凑)。 */
const PX_PER_BEAT = 130;
/** 方块高度系数:height = max(BLOCK_H_MIN, duration × PX_PER_BEAT × 系数)。
 *  原型 0.65,提到 1.5(用户指定)。4分音符 = 1×130×1.5 = 195px。 */
const BLOCK_H_FACTOR = 1.5;
/** 方块最小高度(px)。 */
const BLOCK_H_MIN = 20;
/** 可见窗上界:未来多少拍内可见。原型 5,缩到 3(方块高,预告窗短避免顶出:
 *  4分音 yTop = 600-195-3×130 = 15 > 0)。 */
const VIS_DIST_MAX = 3;
/** 命中窗:|beat 差| < 0.15 → active(原型 L809)。 */
const HIT_WINDOW = 0.15;

// ── parseFallNotes:从乐谱解析方块音符(文档 §4.2) ────────

/** 把完整 Score 解析成 FallNote[]:treble→R、bass→L,用 rangeToPiece 算绝对 beat。
 *  rangeToPiece 预算 trebleBeats/bassBeats(按小节固定容器,空/半填小节不前移),
 *  保证和弦尾音/tuplet 的 beat 正确。
 *  连续相同音(midi 相同、紧邻无间隔)合并成一个长方块 —— 不做成独立碎块。 */
export function parseFallNotes(score: Score): FallNote[] {
  const total = score.meta.totalMeasures;
  if (total <= 0) return [];
  const treblePiece = rangeToPiece(score, 0, total, 'treble');
  const bassPiece = rangeToPiece(score, 0, total, 'bass');
  // noteStartBeats 读预设的 trebleBeats/bassBeats(若长度匹配)。
  const tStarts = noteStartBeats(treblePiece);
  const bStarts = noteStartBeats(bassPiece);
  const raw: FallNote[] = [];
  treblePiece.treble.forEach((n, i) => {
    if (n.midi === null) return;   // 休止符无方块
    raw.push({ midi: n.midi, beat: tStarts[i], duration: durationBeats(n), hand: 'R' });
  });
  bassPiece.bass.forEach((n, i) => {
    if (n.midi === null) return;
    raw.push({ midi: n.midi, beat: bStarts[i], duration: durationBeats(n), hand: 'L' });
  });
  return mergeConsecutive(raw);
}

/** 合并连续相同音:相邻同 midi 同 hand 且前音结束=后音起始(无间隔)的,累加 duration 合并。
 *  例:C4(0拍,1拍)+C4(1拍,1拍) → C4(0拍,2拍)一个方块。
 *  有间隔(休止符隔开)或不同音的不合并。 */
function mergeConsecutive(notes: FallNote[]): FallNote[] {
  if (notes.length === 0) return [];
  // 先按 hand + beat 排序,保证相邻关系正确。
  const sorted = [...notes].sort((a, b) => a.hand === b.hand ? a.beat - b.beat : (a.hand < b.hand ? -1 : 1));
  const out: FallNote[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    // 同手 + 同 midi + 前音结束 = 后音起始 → 合并。
    if (n.hand === cur.hand && n.midi === cur.midi && Math.abs(n.beat - (cur.beat + cur.duration)) < 0.01) {
      cur.duration += n.duration;
    } else {
      out.push(cur);
      cur = { ...n };
    }
  }
  out.push(cur);
  return out;
}

// ── 工厂:buildWaterfall ──────────────────────────────────

/** 构建练琴页瀑布流方块组件。返回 Handle。 */
export function buildWaterfall(initial: WaterfallInitial, cb: WaterfallCallbacks): WaterfallHandle {
  void cb;   // 方块组件一般无回调
  let notes: FallNote[] = initial.notes;
  let range: KeyRange = initial.range;
  let whiteW: number = initial.whiteW;
  let handFilter: 'both' | 'R' | 'L' = 'both';
  // 掉落区域(像素,相对 wf-fall 容器)。默认 0~容器高度。
  let topY = 0;
  let bottomY = 0;   // 0 = 用容器高度(布局后设)

  // 容器。
  const el = document.createElement('div');
  el.className = 'wf-fall';
  // 判定线(区域底)。
  const hitEl = document.createElement('div');
  hitEl.className = 'wf-hit';
  el.appendChild(hitEl);

  // 方块 DOM:每音一个 div,预创建(复刻原型 L682-688)。
  let blockEls: HTMLDivElement[] = [];
  function buildBlocks(): void {
    // 清旧。
    for (const b of blockEls) b.remove();
    blockEls = [];
    for (const n of notes) {
      const b = document.createElement('div');
      b.className = 'wf-note ' + n.hand;
      b.textContent = midiName(n.midi);
      b.style.opacity = '0';
      el.appendChild(b);
      blockEls.push(b);
    }
  }
  buildBlocks();

  /** midi → 音名(C4、G♯4 等)。 */
  function midiName(midi: number): string {
    const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  /** 算容器可见高度(bottomY-topY)。bottomY=0 时用 clientHeight。 */
  function fallHeight(): number {
    const h = el.clientHeight;
    if (bottomY > topY) return bottomY - topY;
    return h;
  }

  return {
    el,
    onTick(beat: number) {
      const hitY = fallHeight();   // 判定线 y(容器内,从顶算)
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        const bEl = blockEls[i];
        if (!bEl) continue;
        // 左右手过滤。
        if (handFilter !== 'both' && n.hand !== handFilter) {
          bEl.style.opacity = '0';
          continue;
        }
        const dist = n.beat - beat;   // 未来为正,过去为负
        const bh = Math.max(BLOCK_H_MIN, n.duration * PX_PER_BEAT * BLOCK_H_FACTOR);
        const yTop = hitY - bh - dist * PX_PER_BEAT;
        // 可见窗:未来 VIS_DIST_MAX 拍内可见;过去音保持可见直到它真正结束(dist > -duration)。
        // 旧实现写死 dist > -0.5,导致长音(2/4 拍)还没走完时值就消失 —— 音还在响方块却没了。
        const visBelow = dist > -Math.max(n.duration, 0.5);   // 至少露 0.5 拍(短音也要看见)
        const vis = dist < VIS_DIST_MAX && visBelow;
        if (!vis) {
          bEl.style.opacity = '0';
          bEl.classList.remove('active');
          continue;
        }
        // 透明度:未来接近判定线渐显(dist 5→0,opacity 0.35→1);
        // 过去音从命中(dist=0,opacity 1)淡出到音结束(dist=-duration,opacity 0)。
        let opacity: number;
        if (dist >= 0) {
          opacity = Math.min(1, 1 - dist * 0.13);
        } else {
          // 过去段:按"音已走过的比例"淡出。
          const pastRatio = n.duration > 0 ? -dist / n.duration : 1;
          opacity = Math.max(0, 1 - pastRatio);
        }
        bEl.style.opacity = String(opacity);
        // 宽度 = 对应键宽(px),left = 键中心(px,居中)。与键盘同套纯函数坐标系。
        bEl.style.width = noteWidth(n.midi, range, whiteW) + 'px';
        bEl.style.left = midiToX(n.midi, range, whiteW) + 'px';
        bEl.style.height = bh + 'px';
        bEl.style.top = yTop + 'px';
        // 命中:接近判定线加 active(方块自己判断,不依赖键盘,文档 §4.4)。
        const active = Math.abs(dist) < HIT_WINDOW;
        bEl.classList.toggle('active', active);
      }
    },
    setNotes(newNotes: FallNote[]) {
      notes = newNotes;
      buildBlocks();
    },
    setKeyLayout(info: { range: KeyRange; whiteW: number }) {
      range = info.range;
      whiteW = info.whiteW;
      // 横轴在下次 onTick 重算,无需重建 DOM。
    },
    setHandFilter(hand: 'both' | 'R' | 'L') {
      handFilter = hand;
    },
    setBounds(info: { topY: number; bottomY: number }) {
      topY = info.topY;
      bottomY = info.bottomY;
      // 判定线贴区域底。
      hitEl.style.bottom = '0';
    },
  };
}
