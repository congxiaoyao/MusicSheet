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
import { Note, KeySig, durationBeats } from '../core/types';
import { noteStartBeats } from '../core/model';
import { KeyRange, whiteKeys, midiToX, noteWidth } from './key-coords';
import { Fingering, highlightMidi } from './fingering';

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
  /** 指法模式(原调/移调)。cfixed 时方块定位经 highlightMidi 映射到 C 调白键。 */
  fingering: Fingering;
  /** 调号(cfixed 映射用)。 */
  key: KeySig;
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
  /** 键宽/音域变化时重新算横轴 + inner 宽度(键盘拖滑块时 controller 调)。 */
  setKeyLayout(info: { range: KeyRange; whiteW: number }): void;
  /** 指法模式变化时重新映射方块横轴(切原调/移调时 controller 调)。 */
  setFingering(fingering: Fingering): void;
  /** 单手隔离:'both' | 'R' | 'L'。 */
  setHandFilter(hand: 'both' | 'R' | 'L'): void;
  /** 设置掉落区域上边界(ScoreSheet 当前行底部)+ 下边界(键盘顶部)。
   *  被动接口:topY/bottomY 谁算的不关心(本次测试页自给,真实页由 controller 算)。 */
  setBounds(info: { topY: number; bottomY: number }): void;
}

// ── 常量(从原型迁移,按用户反馈调校) ─────────────────────
/** 垂直像素/拍(下落速度)。原型 92。
 *  方块要更长就加大这个值(方块和间隔等比放大,不重叠);FACTOR 不能 >1(会侵入下一音重叠)。 */
const PX_PER_BEAT = 170;
/** 方块高度系数:height = max(BLOCK_H_MIN, duration × PX_PER_BEAT × 系数)。
 *  必须 ≤ 1.0:方块高度 = duration×PX_PER_BEAT×系数,而相邻音垂直间隔 = duration×PX_PER_BEAT,
 *  系数>1 时方块高度超过时间槽,几何上必然侵入下一个音导致重叠。1.0 = 刚好填满时间槽不重叠。 */
const BLOCK_H_FACTOR = 1.0;
/** 方块最小高度(px)。 */
const BLOCK_H_MIN = 20;
/** 可见窗上界:未来多少拍内可见。原型 5,缩到 3.5(方块长,预告窗缩短避免顶出)。 */
const VIS_DIST_MAX = 3.5;



// ── parseFallNotes:从乐谱解析方块音符(文档 §4.2) ────────

/** 把完整 Score 解析成 FallNote[]:treble→R、bass→L,用 rangeToPiece 算绝对 beat。
 *  rangeToPiece 预算 trebleBeats/bassBeats(按小节固定容器,空/半填小节不前移),
 *  保证和弦尾音/tuplet 的 beat 正确。
 *  每个音一个独立方块(不做合并 —— 反复弹的同音如震音/16分重复,合并会丢失节奏感)。 */
export function parseFallNotes(score: Score): FallNote[] {
  const total = score.meta.totalMeasures;
  if (total <= 0) return [];
  const treblePiece = rangeToPiece(score, 0, total, 'treble');
  const bassPiece = rangeToPiece(score, 0, total, 'bass');
  // noteStartBeats 读预设的 trebleBeats/bassBeats(若长度匹配)。
  const tStarts = noteStartBeats(treblePiece);
  const bStarts = noteStartBeats(bassPiece);
  const out: FallNote[] = [];
  treblePiece.treble.forEach((n, i) => {
    if (n.midi === null) return;   // 休止符无方块
    out.push({ midi: n.midi, beat: tStarts[i], duration: durationBeats(n), hand: 'R' });
  });
  bassPiece.bass.forEach((n, i) => {
    if (n.midi === null) return;
    out.push({ midi: n.midi, beat: bStarts[i], duration: durationBeats(n), hand: 'L' });
  });
  return out;
}

// ── 工厂:buildWaterfall ──────────────────────────────────

/** 构建练琴页瀑布流方块组件。返回 Handle。 */
export function buildWaterfall(initial: WaterfallInitial, cb: WaterfallCallbacks): WaterfallHandle {
  void cb;   // 方块组件一般无回调
  let notes: FallNote[] = initial.notes;
  let range: KeyRange = initial.range;
  let whiteW: number = initial.whiteW;
  let fingering: Fingering = initial.fingering;
  let key: KeySig = initial.key;
  let handFilter: 'both' | 'R' | 'L' = 'both';
  // 掉落区域(像素,相对 wf-fall 容器)。bottomY = 判定线(键盘上沿)。
  // topY = 上边界(ScoreSheet 当前行底部,接动态值时用于裁剪;测试页=0 不裁)。
  let topY = 0;
  let bottomY = 0;   // 0 = 用容器高度(布局后设)
  void topY;   // 保留:接 ScoreSheet 动态上边界时用于裁剪,当前测试页 topY=0 不触发

  // 容器(overflow 裁 + flex center 居中 inner)。
  const el = document.createElement('div');
  el.className = 'wf-fall';
  // 判定线(区域底,相对 el 定位)。
  const hitEl = document.createElement('div');
  hitEl.className = 'wf-hit';
  el.appendChild(hitEl);
  // 内层容器:装 canvas,宽度 = 键盘总宽(白键数×whiteW),被 el 居中。
  // 与键盘的 kb-keys-inner 同款机制 —— 两 inner 同宽同居中,左缘天然对齐,无需传 offset。
  const innerEl = document.createElement('div');
  innerEl.className = 'wf-fall-inner';
  el.appendChild(innerEl);
  // Canvas:所有方块绘制在一个 canvas 上(1 个合成层,避免 N 个 div 触发 layout/GPU 合成)。
  // 真机数据:DOM div 方块(即使 top/left)每帧触发全页 layout + 各自合成,是练琴页卡顿主因之一。
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  innerEl.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  // 预算每个音符的标签 + 颜色(不每帧重算)。
  interface BlockInfo { x: number; w: number; label: string; hand: 'R' | 'L'; }
  let blocks: BlockInfo[] = [];
  // canvas 像素尺寸(物理像素,scale = DPR)。布局后/resize 时同步。
  // 性能:不每帧读 getBoundingClientRect(触发 layout),用 dirty 标志 —— 仅在
  // setBounds(键盘高度变)/setKeyLayout(宽度变)/resize 时标 dirty,onTick 才重读。
  let canvasW = 0, canvasH = 0, dpr = 1;
  let canvasSizeDirty = true;
  function syncCanvasSize(): void {
    if (!canvasSizeDirty) return;
    canvasSizeDirty = false;
    const r = innerEl.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.round(r.width));
    const cssH = Math.max(1, Math.round(r.height));
    canvasW = Math.round(cssW * dpr);
    canvasH = Math.round(cssH * dpr);
    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }
  }

  // 颜色(对应 CSS 的渐变主色,简化为纯色以保证性能;active 时加白边)
  const COLOR_R = '#4f78c9', COLOR_L = '#d37a58';

  // 方块数据:每音一个,预创建。
  function buildBlocks(): void {
    blocks = [];
    for (const n of notes) {
      const mapped = highlightMidi({ midi: n.midi, duration: 'quarter', dotted: false, accidental: null } as Note, key, fingering);
      const dispMidi = mapped ?? n.midi;
      blocks.push({
        x: midiToX(dispMidi, range, whiteW),
        w: noteWidth(dispMidi, range, whiteW),
        label: midiName(mapped ?? n.midi),
        hand: n.hand,
      });
    }
  }
  buildBlocks();
  // 初始化 inner 宽度 = 键盘总宽。
  innerEl.style.width = (whiteKeys(range).length * whiteW) + 'px';
  // 窗口 resize(如电视分辨率变化)时标 dirty,让下次 onTick 重读 canvas 尺寸。
  window.addEventListener('resize', () => { canvasSizeDirty = true; });

  /** midi → 音名(C4、G♯4 等)。 */
  function midiName(midi: number): string {
    const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  /** 判定线 y(相对 wf-fall 容器顶):= bottomY(键盘上沿)。bottomY=0 时用容器高度。 */
  function hitLineY(): number {
    return bottomY > 0 ? bottomY : el.clientHeight;
  }

  return {
    el,
    onTick(beat: number) {
      const hitY = hitLineY();
      syncCanvasSize();
      const cx = ctx;
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cssW = canvasW / dpr, cssH = canvasH / dpr;
      cx.clearRect(0, 0, cssW, cssH);

      // 第一遍:算出可见方块(只遍历一次,记录绘制参数),按 active 分开(白边先画在底)。
      // 用预分配数组避免每帧 GC(容量够大,用 count 控制实际长度)。
      const N = notes.length;
      // 收集:普通方块(分 R/L 两组)+ active 方块(需白底)
      // 直接画,不缓存——但按"先 active 白底 → R 方块 → L 方块 → 标签"顺序减少状态切换。
      // 先画 active 白底
      cx.fillStyle = '#fff';
      for (let i = 0; i < N; i++) {
        const n = notes[i];
        if (handFilter !== 'both' && n.hand !== handFilter) continue;
        const dist = n.beat - beat;
        if (dist > -n.duration || dist <= -Math.max(n.duration, 0.5) || dist >= VIS_DIST_MAX) continue;
        const active = dist <= 0 && dist > -n.duration;
        if (!active) continue;
        const b = blocks[i];
        const bh = Math.max(BLOCK_H_MIN, n.duration * PX_PER_BEAT * BLOCK_H_FACTOR);
        const yTop = hitY - bh - dist * PX_PER_BEAT;
        let op = Math.max(0, 1 - (n.duration > 0 ? -dist / n.duration : 1));
        if (op <= 0) continue;
        cx.globalAlpha = op;
        cx.fillRect(b.x - b.w / 2 - 2, yTop - 2, b.w + 4, bh + 4);
      }
      // 画 R 方块
      cx.fillStyle = COLOR_R;
      for (let i = 0; i < N; i++) {
        const n = notes[i];
        if (n.hand !== 'R') continue;
        if (handFilter !== 'both' && n.hand !== handFilter) continue;
        const dist = n.beat - beat;
        const visBelow = dist > -Math.max(n.duration, 0.5);
        if (!visBelow || dist >= VIS_DIST_MAX) continue;
        const bh = Math.max(BLOCK_H_MIN, n.duration * PX_PER_BEAT * BLOCK_H_FACTOR);
        const yTop = hitY - bh - dist * PX_PER_BEAT;
        let op: number;
        if (dist >= 0) op = Math.min(1, 1 - dist * 0.13);
        else op = Math.max(0, 1 - (n.duration > 0 ? -dist / n.duration : 1));
        if (op <= 0) continue;
        cx.globalAlpha = op;
        cx.fillRect(blocks[i].x - blocks[i].w / 2, yTop, blocks[i].w, bh);
      }
      // 画 L 方块
      cx.fillStyle = COLOR_L;
      for (let i = 0; i < N; i++) {
        const n = notes[i];
        if (n.hand !== 'L') continue;
        if (handFilter !== 'both' && n.hand !== handFilter) continue;
        const dist = n.beat - beat;
        const visBelow = dist > -Math.max(n.duration, 0.5);
        if (!visBelow || dist >= VIS_DIST_MAX) continue;
        const bh = Math.max(BLOCK_H_MIN, n.duration * PX_PER_BEAT * BLOCK_H_FACTOR);
        const yTop = hitY - bh - dist * PX_PER_BEAT;
        let op: number;
        if (dist >= 0) op = Math.min(1, 1 - dist * 0.13);
        else op = Math.max(0, 1 - (n.duration > 0 ? -dist / n.duration : 1));
        if (op <= 0) continue;
        cx.globalAlpha = op;
        cx.fillRect(blocks[i].x - blocks[i].w / 2, yTop, blocks[i].w, bh);
      }
      // 画标签(统一 fillStyle=#fff,只在方块够高时画,避免小方块叠字)
      cx.fillStyle = '#fff';
      cx.textAlign = 'center';
      cx.textBaseline = 'alphabetic';
      cx.font = '700 9px system-ui, sans-serif';
      for (let i = 0; i < N; i++) {
        const n = notes[i];
        if (handFilter !== 'both' && n.hand !== handFilter) continue;
        const dist = n.beat - beat;
        const visBelow = dist > -Math.max(n.duration, 0.5);
        if (!visBelow || dist >= VIS_DIST_MAX) continue;
        const bh = Math.max(BLOCK_H_MIN, n.duration * PX_PER_BEAT * BLOCK_H_FACTOR);
        if (bh < 22) continue;   // 太矮不画字
        const yTop = hitY - bh - dist * PX_PER_BEAT;
        let op: number;
        if (dist >= 0) op = Math.min(1, 1 - dist * 0.13);
        else op = Math.max(0, 1 - (n.duration > 0 ? -dist / n.duration : 1));
        if (op <= 0) continue;
        cx.globalAlpha = op;
        cx.fillText(blocks[i].label, blocks[i].x, yTop + bh - 4);
      }
      cx.globalAlpha = 1;
    },
    setNotes(newNotes: FallNote[]) {
      notes = newNotes;
      buildBlocks();
    },
    setKeyLayout(info: { range: KeyRange; whiteW: number }) {
      range = info.range;
      whiteW = info.whiteW;
      // inner 宽度 = 键盘总宽(白键数×whiteW),与键盘 inner 同宽,两者各自被父容器居中 → 左缘对齐。
      innerEl.style.width = (whiteKeys(range).length * whiteW) + 'px';
      // 横轴缓存(blocks 里的 x/w)依赖 whiteW/range,需重建。
      buildBlocks();
      canvasSizeDirty = true;   // 宽度变 → canvas 尺寸变
    },
    setFingering(f: Fingering) {
      fingering = f;
      // 标签依赖映射后的音名,重建方块 DOM 刷新标签。横轴在下次 onTick 重算。
      buildBlocks();
    },
    setHandFilter(hand: 'both' | 'R' | 'L') {
      handFilter = hand;
    },
    setBounds(info: { topY: number; bottomY: number }) {
      topY = info.topY;
      canvasSizeDirty = true;   // 高度变(键盘高度调)→ canvas 尺寸变
      bottomY = info.bottomY;
      // 判定线贴 bottomY(键盘上沿)。bottomY 相对容器顶,判定线用绝对定位。
      hitEl.style.bottom = 'auto';
      hitEl.style.top = bottomY + 'px';
    },
  };
}
