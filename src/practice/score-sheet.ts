// ScoreSheet —— 练琴页核心谱面组件(多行大谱表 + 提词器式滚动 + 卡拉OK渐变 + 谱面播放头)。
//
// 设计文档:docs/ScoreSheet组件设计.md。本文件按文档「十一、实施步骤」逐步实现:
//   Step 1 骨架 ✅
//   Step 2 渲染层 档1(纯五线大谱表):planSystems 密度切行 + renderSystem + 连谱号。✅(本步)
//   Step 3 渲染层 档2/档3(简谱/对照)。
//   Step 4 动态层(onTick 滚动 + 渐变 + 符头高亮)。
//   Step 5 交互(点击小节 onSeek + setMode 三档切换)。
//
// 复用边界(文档 §8):
//   - 直接 import(零改动):glyphs/layout/jianpu/score(model)/model/types
//   - staff.ts:子函数未导出 → 不复制代码,直接调 renderStaffSVG,通过覆盖 layout.isFull=true
//     + 传 hover:null 消除编辑耦合(nextSlot 指示器 + hover ghost 不画),零侵入 staff.ts。
//   - 连谱号 { 是新写(glyphs.G 表已补 brace 码点 U+E000)。
//
// 组件模式:命令式工厂 + Handle(同 playback-card.ts),不调用 App 方法,只通过 callbacks 报事件。

import { Score } from '../core/score';
import './score-sheet.css';
import { rangeToPiece } from '../core/score';
import { Note, Piece } from '../core/types';
import { resolvePitch } from '../core/theory';
import { durationBeats } from '../core/types';
import { beatsPerBar } from '../core/types';
import { computeLayout, Layout, NOTE_INK_HALF } from '../render/layout';
import { G } from '../render/glyphs';
import { renderStaffSVG, RenderInput } from '../render/staff';
import { renderJianpuSVG } from '../render/jianpu';
import { noteStartBeats, measureOfBeat, BEAT_EPS } from '../core/model';

// ── 谱面档 ──────────────────────────────────────────────────

/** 谱面档:纯五线大谱表 / 纯简谱双行 / 五线+简谱对照。 */
export type ScoreMode = 'staff' | 'jianpu' | 'both';

// ── 接口(文档 §7) ──────────────────────────────────────────

/** 初始数据 + 初始档。 */
export interface ScoreSheetInitial {
  score: Score;          // 完整乐谱数据(treble + bass)
  mode: ScoreMode;       // 初始谱面档
  /** 初始密度预设(默认 normal)。key 对应 DENSITY_PRESETS。 */
  density?: string;
}

/** 当前行底部位置变化时通知(供瀑布流组件算方块区上边界);点击小节跳转。 */
export interface ScoreSheetCallbacks {
  /** 当前行底部位置变化时通知。瀑布流组件据此算方块区上边界。 */
  onLineLayout?: (info: { lineBottomY: number; linePx: number }) => void;
  /** 点击某小节 → 跳转(进度融进谱面的交互)。 */
  onSeek?: (measure: number) => void;
}

/** 组件句柄:谱面 DOM + 播放驱动 + 切档/换谱。由 controller 在 onTick 里调 onTick。 */
export interface ScoreSheetHandle {
  /** 谱面 DOM(滚动容器 + 渐变遮罩)。 */
  el: HTMLElement;
  /** 播放驱动:算当前行→滚动;算当前音→符头高亮。由 controller 在 onTick 里调。 */
  onTick(beat: number): void;
  /** 切换三档(staff/jianpu/both)。切换后重新布局。 */
  setMode(mode: ScoreMode): void;
  /** 切换密度预设(loose/normal/compact)。切换后重新切行布局。 */
  setDensity(key: string): void;
  /** 乐谱变更时重渲染。 */
  setScore(score: Score): void;
}

// ── 换行算法:密度预设配置(文档 §5.3) ────
// 单位 = 像素(与 lineWidth 同域;lineWidth 来自容器 clientWidth)。
// 三档预设:宽松/正常/紧密,由用户切换。数值越小每行容越多小节(越密)。

/** 密度预设:控制换行算法的三个常数。 */
export interface DensityPreset {
  /** 预设名(宽松/正常/紧密)。 */
  name: string;
  /** 单小节最小理想宽度(px)。空小节/极少音的小节也至少这么宽。 */
  minBarW: number;
  /** 每个音符对理想宽度的贡献(px × 音符数)。音越多小节越宽。 */
  noteWFactor: number;
  /** 含短时值音符(≤十六分)的小节额外奖励宽度(px)。 */
  shortBonus: number;
}

/** 预设配置表。调校基准(行宽940):
 *  - 紧凑(默认):土耳其(10音十六分小节,理想270px)一行3小节=810<940;小星星一行5小节
 *  - 正常:小星星一行4小节、土耳其一行2小节
 *  - 宽松:小星星一行3小节(舒展,适合初学读谱) */
export const DENSITY_PRESETS: Record<string, DensityPreset> = {
  compact: { name: '紧密', minBarW: 100, noteWFactor: 12, shortBonus: 50 },
  normal: { name: '正常', minBarW: 150, noteWFactor: 24, shortBonus: 80 },
  loose: { name: '宽松', minBarW: 200, noteWFactor: 34, shortBonus: 120 },
};

/** 判定"短时值"的阈值:≤ 该时值的音符触发 shortBonus。 */
const SHORT_DUR_MAX_BEATS = durationBeats({ midi: 0, duration: 'sixteenth', dotted: false, accidental: null });

// ── planSystems:密度驱动换行(文档 §5) ─────────────────────

/** 一行(system)的小节范围。startMeasure/count 是整曲内 0-based。 */
export interface SystemPlan {
  startMeasure: number;
  count: number;
  /** 该行各小节的理想宽度(px),按密度比例分配实际宽度时用。
   *  planSystems 切行时一并算好,避免 renderScore 再调 systemIdealWidths 重算一遍。 */
  idealWidths?: number[];
}

/** 估算单小节的"理想宽度"(px)。音密的小节理想宽度更大。
 *  理想宽度 = minBarW + 音符数 × noteWFactor + (含短时值 ? shortBonus : 0)。 */
function idealBarWidth(treble: Note[], bass: Note[], preset: DensityPreset): number {
  const noteCount = treble.length + bass.length;
  const all = [...treble, ...bass];
  const hasShort = all.some(n => durationBeats(n) <= SHORT_DUR_MAX_BEATS);
  return preset.minBarW + noteCount * preset.noteWFactor + (hasShort ? preset.shortBonus : 0);
}

/** 把整曲按密度切行:逐小节累加理想宽度,超过行宽上限就换行。
 *  返回每行的 SystemPlan(含 idealWidths,供 applyDensityBars 按比例分配,避免重算)。 */
export function planSystems(score: Score, lineWidth: number, preset: DensityPreset = DENSITY_PRESETS.compact): SystemPlan[] {
  const total = score.meta.totalMeasures;
  if (total <= 0) return [{ startMeasure: 0, count: 1, idealWidths: [preset.minBarW] }];
  const measures = score.measures;
  const systems: SystemPlan[] = [];
  let lineStart = 0;
  let accW = 0;
  let lineWs: number[] = [];   // 当前行各小节理想宽度(切行时缓存,避免重算)
  for (let i = 0; i < total; i++) {
    const m = measures[i] || { treble: [], bass: [] };
    const w = idealBarWidth(m.treble, m.bass, preset);
    if (accW + w > lineWidth && i > lineStart) {
      // 当前行 [lineStart, i) 已满,i 成为下一行首小节
      systems.push({ startMeasure: lineStart, count: i - lineStart, idealWidths: lineWs });
      lineStart = i;
      accW = 0;
      lineWs = [];
    }
    accW += w;
    lineWs.push(w);
  }
  // 收尾:最后一行
  systems.push({ startMeasure: lineStart, count: total - lineStart, idealWidths: lineWs });
  return systems;
}

// ── 行 Piece 构造(复用 rangeToPiece,自带正确的 trebleBeats/bassBeats) ──

/** 把某行的小节构造成单谱表 Piece(指定 treble/bass)。
 *  复用 score.rangeToPiece:它预算了 trebleBeats/bassBeats,修复空/半填小节的拍位问题。 */
function systemToPiece(score: Score, sys: SystemPlan, staff: 'treble' | 'bass'): Piece {
  return rangeToPiece(score, sys.startMeasure, sys.count, staff);
}

// ── 符头几何基础设施 ──────────────────────────────────────
// 解决"无法从 DOM 准确拿符头位置"的问题:getBBox/getBoundingClientRect 对 <text> 返回
// 字体度量框(含大量留白),不是符头墨迹。这里用纯函数基于 layout 已知数据(noteX + step→y
// + 实测墨迹比例)算每个符头的精确墨迹矩形,供防重叠/瀑布流对齐/点击命中用。
//
// 实测数据(canvas 像素采样 noteheadBlack,font-size=200,ss=50):
//   墨迹宽 1.16ss(半宽 0.58ss),墨迹高 0.98ss(半高 0.49ss)
//   与 staff.ts 的 INK_HALF_W_RATIO(0.497×advance=0.587ss) 吻合。

/** 符头墨迹矩形(layout 坐标系,中心点 + 半宽半高)。 */
export interface NoteHeadRect {
  /** 符头中心 x(= layout.noteX[i]) */
  cx: number;
  /** 符头中心 y(= stepToY(step),= bottomLineY - step*ss/2) */
  cy: number;
  /** 墨迹半宽(0.58ss) */
  halfW: number;
  /** 墨迹半高(0.49ss) */
  halfH: number;
  /** 矩形顶 y(cy - halfH) */
  top: number;
  /** 矩形底 y(cy + halfH) */
  bottom: number;
}

/** noteheadBlack 墨迹尺寸比例(实测,staff space 单位)。 */
const HEAD_HALF_W_SS = 0.58;
const HEAD_HALF_H_SS = 0.49;

/** 算某个 piece(行内 treble 或 bass 组)所有音符的符头墨迹矩形。
 *  返回数组与 piece.notes 一一对应(休止符 midi=null 跳过,该位为 null)。
 *  注:y 用 stepToY 公式(= bottomLineY - step*ss/2),与 staff.ts 渲染一致;
 *      加线不算入符头矩形(加线是辅助线,非符头本体)。 */
export function noteHeadRects(piece: Piece, layout: Layout): (NoteHeadRect | null)[] {
  const ss = layout.staffSpace;
  const halfW = HEAD_HALF_W_SS * ss;
  const halfH = HEAD_HALF_H_SS * ss;
  return piece.notes.map((note, i) => {
    if (note.midi === null) return null;   // 休止符无符头
    const cx = layout.noteX[i];
    const step = resolvePitch(note.midi, piece.clef, piece.key, note.accidental).step;
    const cy = layout.bottomLineY - step * ss / 2;
    return { cx, cy, halfW, halfH, top: cy - halfH, bottom: cy + halfH };
  });
}

/** 检测两组符头(行内 treble + bass)是否重叠:treble 最低符头底 vs bass 最高符头顶。
 *  返回所需额外间距(px,正=需增大间距,0=无需调整)。gapPad 是最小安全间距(px)。 */
export function staffOverlapGap(trebleRects: (NoteHeadRect|null)[], bassRects: (NoteHeadRect|null)[], gapPad: number): number {
  const tValid = trebleRects.filter((r): r is NoteHeadRect => r !== null);
  const bValid = bassRects.filter((r): r is NoteHeadRect => r !== null);
  if (tValid.length === 0 || bValid.length === 0) return 0;
  const tLowBot = Math.max(...tValid.map(r => r.bottom));   // treble 最低符头底
  const bHighTop = Math.min(...bValid.map(r => r.top));      // bass 最高符头顶
  // 若 treble 底已在 bass 顶之下(tLowBot > bHighTop),需增大间距让 bass 下移
  const overlap = tLowBot + gapPad - bHighTop;
  return Math.max(0, overlap);
}

// ── layout 覆盖:密度驱动的小节宽度 + 前缀分级 + 终止线受控 ────

/** 把一个 layout 的 barLines 按该行各小节的"理想宽度比例"重新分配,使各行小节宽度
 *  反映密度(音密的小节更宽),且整行 contentWidth 填满。noteX 同步重算。
 *
 *  computeLayout 默认 barWidth = contentWidth / measures(等分)。这里覆盖为按比例分配。
 *  重算逻辑:按理想宽度比例分配 contentWidth,barLines[k] = contentLeft + 累积比例×contentWidth;
 *  noteX 用原 positionInBar 的"拍位起点 + 符头半宽"公式重新落在新的小节宽度上。
 *
 *  返回新的 layout(浅拷贝 + 覆盖 barLines/noteX);原 layout 其他字段不变。 */
function applyDensityBars(piece: Piece, layout: Layout, trebleIdeal: number[], sys: SystemPlan): Layout {
  const measures = sys.count;
  const { contentLeft, contentWidth } = layout;
  const bpb = beatsPerBar(piece.time);
  // 该行各小节理想宽度(trebleIdeal 传入),按比例分配 contentWidth。
  const totalIdeal = trebleIdeal.reduce((a, b) => a + b, 0) || 1;
  const barWidths: number[] = [];
  for (let k = 0; k < measures; k++) barWidths.push(contentWidth * (trebleIdeal[k] / totalIdeal));
  // barLines[k] = contentLeft + 前k个小节宽度之和
  const barLines: number[] = [contentLeft];
  for (let k = 0; k < measures; k++) barLines.push(barLines[k] + barWidths[k]);
  // 重算 noteX:用原 positionInBar 同款"拍位起点+符头半宽"公式(复用 layout 的常量,不重算魔数)。
  const noteHeadHalf = layout.noteHeadHalf;   // = NOTE_HEAD_HALF(符头中心偏移)
  const starts = noteStartBeats(piece);
  const noteX: number[] = [];
  for (let i = 0; i < piece.notes.length; i++) {
    const startBeat = starts[i];
    const barIdx = Math.min(measureOfBeat(startBeat, bpb), measures - 1);
    const dur = durationBeats(piece.notes[i]);
    const rawBeatInBar = startBeat - barIdx * bpb;
    const beatInBar = Math.min(Math.max(0, rawBeatInBar), Math.max(0, bpb - dur));
    const roomToBarEnd = barWidths[barIdx] * (1 - beatInBar / bpb) - NOTE_INK_HALF;
    const offset = Math.min(noteHeadHalf, roomToBarEnd);
    noteX.push(barLines[barIdx] + beatInBar / bpb * barWidths[barIdx] + offset);
  }
  return { ...layout, barLines, noteX };
}

/** 覆盖 layout 的 isFull=true(消除 renderStaffSVG/renderJianpuSVG 的 nextSlot 待输入指示器)。
 *  ScoreSheet 是只读谱面,没有待输入位。覆盖 isFull 对其他渲染无副作用(仅 nextSlot 读它)。 */
function muteEditing(layout: Layout): Layout {
  return { ...layout, isFull: true };
}

/** 前缀分级:非首行去掉调号(标准记谱——调号只在首行画)。
 *  renderStaffSVG 的 renderKeySignature 检查 layout.hasKey,false 则不画调号。
 *  拍号每行仍画(renderTimeSignature 无条件画;后续视觉精修可考虑抑制非首行拍号)。
 *  覆盖 hasKey=false 对小节宽度布局无实质影响:contentRight 固定,小节仍填满到右端。 */
function stripKeySig(layout: Layout): Layout {
  return { ...layout, hasKey: false };
}

// ── 前缀分级 + 终止线受控 ──────────────────────────────────

/** 是否首行 system。首行全前缀(谱号+调号+拍号),后续行仅谱号(+拍号)。
 *  调号分级:非首行用 stripKeySig 覆盖 layout.hasKey=false 去掉调号(renderStaffSVG 原生支持)。
 *  拍号分级:renderTimeSignature 无条件画,当前每行都画(后续精修可抑制)。 */
function isFirstSystem(sysIndex: number): boolean {
  return sysIndex === 0;
}

// ── 连谱号 brace(新写,文档 §8.3) ──────────────────────────

/** 渲染连谱号 brace {。跨 treble 五线顶到 bass 五线底(整个 system 高度)。
 *  Bravura brace(U+E000)是高伸缩字形:标准用法是用 transform scaleY 拉伸到目标高度。
 *  这里画一个 <text> 用 viewBox 内坐标,靠 CSS/font 缩放;位置在最左侧(staffLeftX 附近)。
 *
 *  参数:topY/botY = brace 要跨的 y 范围(system 内坐标)。
 *  返回 SVG 片段。
 *
 *  Bravura brace(U+E000)实测墨迹几何(font-size=200 时):
 *    墨迹高 ≈ font-size(198),墨迹宽 ≈ 0.07×font-size(14,很窄)
 *    墨迹中心在 baseline 上方 fs/2 处(baselineAboveCenter = 100 = fs/2)
 *    advance ≈ 0.084×font-size
 *  故:让墨迹高 = 目标跨度 → font-size ≈ targetH;
 *      墨迹中心对准跨度中心 → baseline = 中心 + fs/2;
 *      x 用 text-anchor=middle 居中(advance 小,居中即可)。 */
function renderBrace(topY: number, botY: number, layout: Layout): string {
  const ss = layout.staffSpace;
  const targetH = botY - topY;
  // 字号 = 目标高度(实测墨迹高≈font-size)。留少量富余避免顶底贴边。
  const fs = targetH * 1.02;
  // 墨迹中心对准跨度中心:baseline = center + fs/2(墨迹中心在 baseline 上方 fs/2)。
  const cy = (topY + botY) / 2;
  const baselineY = cy + fs / 2;
  // x:brace 放在五线最左端左侧(标准记谱:brace 在 system 起始线左外侧)。
  // brace 到起始线(staffLeftX)的间距约 1 staff space(Dorico/Sibelius 惯例 0.5-1ss,取 1ss 避免挤)。
  const braceHalfW = (0.084 * fs) / 2;
  const x = layout.staffLeftX - braceHalfW - ss * 1.0;
  // data-top/data-bot 暴露期望跨度(诊断用:像素扫描对比实际墨迹 vs 期望 y)
  return `<text class="ss-brace" data-top="${topY.toFixed(1)}" data-bot="${botY.toFixed(1)}" x="${x.toFixed(1)}" y="${baselineY.toFixed(1)}" font-family="Bravura" font-size="${fs.toFixed(1)}" text-anchor="middle" fill="#1f2430">${G.brace}</text>`;
}

// ── renderSystem:单行 treble+bass 大谱表(档1 纯五线) ───────

/** 一行渲染结果(inner SVG + 该行可见高度 + 宽度)。 */
interface RenderedSystem {
  svg: string;       // <g class="ss-system" ...> 内部内容
  height: number;    // 该行可见高度(treble 到 bass 整个 system)
  width: number;
  /** treble 谱表可见区顶 y(system 内坐标,含高音加线扩展) */
  trebleTopY: number;
  /** bass 谱表可见区底 y(system 内坐标) */
  bassBotY: number;
  /** treble 五线第一线 y(system 内坐标,实际音乐顶 —— 播放头/滚动锚定用,不含加线留白) */
  staffTopY: number;
  /** bass 五线第五线 y(system 内坐标,实际音乐底) */
  staffBotY: number;
  /** treble/bass 五线的几何(供 brace 定位 + onTick 高亮换算) */
  trebleLayout: Layout;
  bassLayout: Layout;
  /** 行内 treble/bass Piece(供 onTick 反查当前 beat 落在哪个音符) */
  treblePiece: Piece;
  bassPiece: Piece;
}

/** 渲染一行 system(大谱表,三档 mode 可切):treble 组 + bass 组 + 连谱号 + 起始/连接竖线。
 *  - mode='staff':treble 五线 + bass 五线(档1 纯五线大谱表)。
 *  - mode='jianpu':treble 简谱 + bass 简谱(档2 纯简谱双行,紧凑)。
 *  - mode='both':每只手 五线 + 下方紧贴简谱(档3 对照,行高最大)。
 *  - treble/bass 各自 computeLayout(等宽),再 applyDensityBars 按密度分配小节宽度。
 *  - treble 在上,bass 在下,用 translate 堆叠(复刻 buildGrandSVG 的可见区计算)。
 *  - 连谱号 brace + 连接竖线 跨整个 system 可见高度。
 *  可见区 visTop/visBottom 按 mode 取 staff/jianpu 区段(与 buildGrandSVG 一致)。 */
function renderSystem(
  score: Score,
  sys: SystemPlan,
  sysIndex: number,
  systemCount: number,
  width: number,
  trebleIdeal: number[],
  mode: ScoreMode,
): RenderedSystem {
  const treblePiece = systemToPiece(score, sys, 'treble');
  const bassPiece = systemToPiece(score, sys, 'bass');
  // computeLayout:等宽基础布局(contentRight 固定,小节等分)。密度分配在 applyDensityBars 覆盖。
  let trebleLayout = computeLayout(treblePiece, width, 'quarter');
  let bassLayout = computeLayout(bassPiece, width, 'quarter');
  // 密度驱动:按理想宽度比例重算 barLines/noteX(两组用同一套 trebleIdeal,保证小节线 x 对齐)。
  trebleLayout = applyDensityBars(treblePiece, trebleLayout, trebleIdeal, sys);
  bassLayout = applyDensityBars(bassPiece, bassLayout, trebleIdeal, sys);
  // 消除编辑耦合(nextSlot 指示器)。
  trebleLayout = muteEditing(trebleLayout);
  bassLayout = muteEditing(bassLayout);
  // 前缀分级:非首行去掉调号(标准记谱)。首行全前缀(谱号+调号+拍号),后续行仅谱号(+拍号)。
  // 拍号当前每行都画(renderTimeSignature 无条件;后续精修)。调号仅首行。
  if (!isFirstSystem(sysIndex)) {
    trebleLayout = stripKeySig(trebleLayout);
    bassLayout = stripKeySig(bassLayout);
  }

  // 按 mode 决定渲染 staff/jianpu(复刻 buildGrandSVG 的 showStaff/showJianpu)。
  const showStaff = mode !== 'jianpu';
  const showJianpu = mode !== 'staff';
  // staff/jianpu 档都抑制各自渲染器的小节线 —— 由 ScoreSheet 统一画贯穿双谱表的系统线
  // (规范:大谱表小节线贯穿 treble+bass,起始线在 brace 右侧贯穿,终止线仅末行)。
  // 简谱双行同理(小节线贯穿上下对齐)。both 档的五线+简谱都抑制。
  const tInput: RenderInput = { piece: treblePiece, layout: trebleLayout, playingIndex: -1, hover: null, suppressBarLines: true };
  const bInput: RenderInput = { piece: bassPiece, layout: bassLayout, playingIndex: -1, hover: null, suppressBarLines: true };
  const tStaff = showStaff ? renderStaffSVG(tInput) : '';
  const tJianpu = showJianpu ? renderJianpuSVG(tInput) : '';
  const bStaff = showStaff ? renderStaffSVG(bInput) : '';
  const bJianpu = showJianpu ? renderJianpuSVG(bInput) : '';

  // 可见区顶/底(按 mode 取 staff/jianpu 区段)。
  //   staff/both: top=-viewBoxYOffset(高音加线扩展区),bottom=height(both 含简谱)或 jianpuTop(staff only)
  //   jianpu:    top=jianpuTop, bottom=jianpuBottom(简谱区)
  const ss = trebleLayout.staffSpace;
  const visTop = (lay: Layout) => showStaff ? -lay.viewBoxYOffset : lay.jianpuTop;
  const visBottom = (lay: Layout) => showStaff ? (showJianpu ? lay.height : lay.jianpuTop) : lay.jianpuBottom;
  // 简谱档上下加留白(简谱内容太贴近边缘,与 buildGrandSVG 一致)。
  const jpPad = showStaff && showJianpu ? 0 : (!showStaff ? 28 : 0);
  const tTop = visTop(trebleLayout) - jpPad;
  const tBot = visBottom(trebleLayout);
  const bTop = visTop(bassLayout) - jpPad;
  const bBot = visBottom(bassLayout) + jpPad;
  const tVisH = tBot - tTop;
  const lineW = Math.max(trebleLayout.width, bassLayout.width);

  // treble 组:translate 抵消可见区顶部(可见内容从 y=0 起)。按 mode 包含 staff-group/jianpu-group。
  const trebleGroup = `<g class="ss-treble" transform="translate(0, ${(-tTop).toFixed(2)})">${showStaff ? `<g class="staff-group">${tStaff}</g>` : ''}${showJianpu ? `<g class="jianpu-group">${tJianpu}</g>` : ''}</g>`;
  // bass 组:平移到 treble 可见高度之下。
  // staff 档(纯五线):treble五线底↔bass五线顶 间距 = STAFF_GAP_SS(标准 6 staff space)。
  //   STAFF_GAP_SS=8.4 是设定值,实测因坐标系偏差约等于 6ss。
  //   **动态防重叠**:用 noteHeadRects 算 treble/bass 符头精确墨迹位置,若默认间距下重叠,
  //   增大间距。treble 符头在 treble 坐标系(+trebleTranslate=-tTop),bass 在 bass 坐标系
  //   (+bassTranslateY);先算默认 bassTranslateY,测重叠,若重叠则加 overlap 量。
  const STAFF_GAP_SS = 8.4;
  let bassTranslateY: number;
  if (showStaff && !showJianpu) {
    const trebleStaffBotY = -tTop + trebleLayout.staffBottom;
    bassTranslateY = trebleStaffBotY + STAFF_GAP_SS * ss - bassLayout.staffTop;
    // 动态防重叠:算符头墨迹,treble 最低底 vs bass 最高顶(都在堆叠坐标系)
    const tRects = noteHeadRects(treblePiece, trebleLayout).filter((r): r is NoteHeadRect => r !== null);
    const bRects = noteHeadRects(bassPiece, bassLayout).filter((r): r is NoteHeadRect => r !== null);
    if (tRects.length > 0 && bRects.length > 0) {
      const trebleTranslateY = -tTop;
      const tLowBot = Math.max(...tRects.map(r => r.bottom)) + trebleTranslateY;
      const bHighTop = Math.min(...bRects.map(r => r.top)) + bassTranslateY;
      const gapPad = 1 * ss;   // 符头间最小安全间距 1ss
      const overlap = tLowBot + gapPad - bHighTop;
      if (overlap > 0) bassTranslateY += overlap;   // bass 下移,消除重叠
    }
  } else {
    bassTranslateY = tVisH - bTop;
  }
  const bassGroup = `<g class="ss-bass" transform="translate(0, ${bassTranslateY.toFixed(2)})">${showStaff ? `<g class="staff-group">${bStaff}</g>` : ''}${showJianpu ? `<g class="jianpu-group">${bJianpu}</g>` : ''}</g>`;
  // 五线谱在堆叠坐标的位置(staff/both 档用;简谱档用简谱区边界)。
  // 注意:bass 用 bassTranslateY(含 staff 档间距调整),非 tVisH-bTop(未调整)。
  const trebleStaffTopY = -tTop + trebleLayout.staffTop;       // treble 第一线(最上)
  const bassStaffBotY = bassTranslateY + bassLayout.staffBottom;// bass 第五线(最下)

  // 连谱号 brace:规范要求贴合上下谱表的最外层线(treble 第一线 / bass 第五线),
  // 曲线略超出包裹两谱表。staff/both 档用五线边界;jianpu 档用简谱区边界。
  const braceTopY = showStaff ? trebleStaffTopY : Math.max(0, -tTop + visTop(trebleLayout));
  const braceBotY = showStaff ? bassStaffBotY : (bassTranslateY + visBottom(bassLayout));
  const brace = renderBrace(braceTopY, braceBotY, trebleLayout);

  // 系统线:贯穿 treble+bass 的竖线(staff/jianpu/both 档都画)。规范:
  //   - 起始线:brace 右侧紧贴的一条贯穿竖线(system 起始)
  //   - 中间小节线:贯穿 treble 顶 到 bass 底(连接两谱表)
  //   - 终止线:仅整曲末行画(粗线+左细线);非末行末位画普通细小节线
  // staff.ts/jianpu.ts 已 suppressBarLines,全由 ScoreSheet 画贯穿线。
  //   staff/both 档:线顶=treble 五线第一线,线底=bass 五线第五线,深色 #1f2430
  //   jianpu 档:线顶=treble 简谱区顶,线底=bass 简谱区底,黑色 #1f2430(与五线谱统一)
  let systemLines = '';
  {
    const isLastSystem = sysIndex === systemCount - 1;
    // staff 档小节线延伸半个 staff 线宽超出最外线(与 staff.ts renderBarLines 一致,视觉对齐)。
    const lineExtend = showStaff ? 0.13 * ss / 2 : 0;
    const lineTop = (showStaff ? trebleStaffTopY : Math.max(0, -tTop + visTop(trebleLayout))) - lineExtend;
    const lineBot = (showStaff ? bassStaffBotY : (bassTranslateY + visBottom(bassLayout))) + lineExtend;
    const bl = trebleLayout.barLines;
    if (showStaff) {
      // 五线谱档:深色,标准小节线粗细
      const thin = 0.16 * ss;
      const thick = 0.5 * ss;
      const xOf = (x: number) => `<line x1="${x.toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#1f2430" stroke-width="${thin.toFixed(2)}"/>`;
      systemLines += xOf(trebleLayout.staffLeftX);   // 起始线
      for (let i = 1; i < bl.length; i++) {
        const isEnd = i === bl.length - 1;
        if (isEnd && isLastSystem) {
          const x = trebleLayout.contentRight;
          systemLines += `<line x1="${x.toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#1f2430" stroke-width="${thick.toFixed(2)}"/>`;
          systemLines += `<line x1="${(x - 0.75 * ss).toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${(x - 0.75 * ss).toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#1f2430" stroke-width="${thin.toFixed(2)}"/>`;
        } else {
          systemLines += xOf(bl[i]);
        }
      }
    } else {
      // 简谱档:小节线黑色(与五线谱统一),贯穿双行
      systemLines += `<line x1="${trebleLayout.staffLeftX.toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${trebleLayout.staffLeftX.toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#1f2430" stroke-width="1"/>`;
      for (let i = 1; i < bl.length; i++) {
        const isEnd = i === bl.length - 1;
        if (isEnd && isLastSystem) {
          // 简谱终止线:黑色粗线 + 左细线
          const x = trebleLayout.contentRight;
          systemLines += `<line x1="${x.toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#1f2430" stroke-width="2"/>`;
          systemLines += `<line x1="${(x - 0.75 * ss).toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${(x - 0.75 * ss).toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#1f2430" stroke-width="1"/>`;
        } else {
          systemLines += `<line x1="${bl[i].toFixed(1)}" y1="${lineTop.toFixed(1)}" x2="${bl[i].toFixed(1)}" y2="${lineBot.toFixed(1)}" stroke="#1f2430" stroke-width="1"/>`;
        }
      }
    }
  }

  const svg = trebleGroup + bassGroup + systemLines + brace;
  const height = tVisH + (bBot - bTop);
  return {
    svg,
    height,
    width: lineW,
    trebleTopY: tTop,
    bassBotY: bBot,
    staffTopY: trebleStaffTopY,
    staffBotY: bassStaffBotY,
    trebleLayout,
    bassLayout,
    treblePiece,
    bassPiece,
  };
}

// ── 主渲染:多行系统堆叠 ────────────────────────────────────

/** 渲染整个乐谱(多行 system 垂直堆叠)。返回 SVG 字符串 + 各行几何(供 onTick 用)。 */
interface ScoreRender {
  svg: string;
  width: number;
  height: number;
  systems: SystemGeom[];
}

/** 单行在整曲 SVG 内的几何(绝对 y 范围 + 行内小节→beat 映射),供 onTick 滚动/高亮换算。 */
interface SystemGeom {
  /** 该行 system 在整曲 SVG 内的 y 起点(堆叠后) */
  yTop: number;
  /** 该行高度 */
  height: number;
  /** 该行 treble 五线第一线 y(整曲 SVG 绝对坐标,= yTop + staffTopY) —— 滚动/播放头锚定用,
   *  对齐此线可消除 viewBoxYOffset(高音加线留白)导致的视觉不一致 */
  staffTopY: number;
  /** 该行 bass 五线第五线 y(整曲 SVG 绝对坐标,= yTop + staffBotY) */
  staffBotY: number;
  /** 该行 treble layout */
  trebleLayout: Layout;
  /** 该行 bass layout */
  bassLayout: Layout;
  /** 该行覆盖的小节范围 */
  plan: SystemPlan;
  /** 行内 treble/bass Piece(供 onTick 反查当前 beat 落在哪个音符) */
  treblePiece: Piece;
  bassPiece: Piece;
  /** 该行覆盖的整曲绝对 beat 范围 [beatStart, beatEnd)(= startMeasure×bpb .. +count×bpb) */
  beatStart: number;
  beatEnd: number;
}

/** 渲染整个乐谱为多行 SVG(三档 mode + 密度 preset)。各 system 用 translate 垂直堆叠。 */
export function renderScore(score: Score, width: number, mode: ScoreMode, preset: DensityPreset = DENSITY_PRESETS.compact): ScoreRender {
  const systems = planSystems(score, width, preset);
  const SYSTEM_GAP = 40;
  const rendered = systems.map((sys, i) => {
    const ideal = sys.idealWidths ?? [preset.minBarW];   // planSystems 已算好,直接用
    return renderSystem(score, sys, i, systems.length, width, ideal, mode);
  });
  const totalWidth = Math.max(width, ...rendered.map(r => r.width));
  const bpb = beatsPerBar(score.meta.time);
  let cumY = 0;
  const groups: string[] = [];
  const geom: SystemGeom[] = [];
  for (let i = 0; i < rendered.length; i++) {
    const r = rendered[i];
    const plan = systems[i];
    groups.push(
      `<g class="ss-system" data-sys="${i}" transform="translate(0, ${cumY.toFixed(2)})">${r.svg}</g>`,
    );
    geom.push({
      yTop: cumY,
      height: r.height,
      staffTopY: cumY + r.staffTopY,
      staffBotY: cumY + r.staffBotY,
      trebleLayout: r.trebleLayout,
      bassLayout: r.bassLayout,
      plan,
      treblePiece: r.treblePiece,
      bassPiece: r.bassPiece,
      beatStart: plan.startMeasure * bpb,
      beatEnd: (plan.startMeasure + plan.count) * bpb,
    });
    cumY += r.height + SYSTEM_GAP;
  }
  const totalHeight = Math.max(0, cumY - SYSTEM_GAP) + 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight.toFixed(2)}" viewBox="0 0 ${totalWidth} ${totalHeight.toFixed(2)}">${groups.join('')}</svg>`;
  return { svg, width: totalWidth, height: totalHeight, systems: geom };
}

// ── 工厂:buildScoreSheet ───────────────────────────────────

/** 构建练琴页谱面组件。返回 Handle。 */
export function buildScoreSheet(
  initial: ScoreSheetInitial,
  cb: ScoreSheetCallbacks,
): ScoreSheetHandle {
  const el = document.createElement('div');
  el.className = 'score-sheet';

  // 内部状态。
  let score: Score = initial.score;
  let mode: ScoreMode = initial.mode;
  let density: DensityPreset = DENSITY_PRESETS[initial.density ?? 'compact'] ?? DENSITY_PRESETS.compact;
  const callbacks = cb;

  // 滚动容器 + 谱面宿主 + 渐变遮罩(卡拉OK:当前行清晰,后续半透明)。
  const scrollEl = document.createElement('div');
  scrollEl.className = 'score-sheet-scroll';
  const sheetEl = document.createElement('div');
  sheetEl.className = 'score-sheet-sheet';
  scrollEl.appendChild(sheetEl);
  el.appendChild(scrollEl);

  // 播放头层:覆盖 sheetEl,定位一个竖条盖在当前音符上(参考编辑器预览模式 pb-playhead)。
  const playheadEl = document.createElement('div');
  playheadEl.className = 'ss-playhead';
  playheadEl.style.display = 'none';
  sheetEl.appendChild(playheadEl);

  // 最近一次渲染几何(供 onTick 用)。
  let renderCache: ScoreRender | null = null;
  // 当前高亮的音符 idx 集合(行内局部 idx),避免每帧无变化时重复 DOM 操作。
  let lastHiTreble = new Set<number>();
  let lastHiBass = new Set<number>();
  let lastSysIdx = -1;

  // 渲染:算行宽(容器宽) → renderScore → 挂 SVG。
  // SVG 用 width:100% + height:auto(按 viewBox 自适应高度),保持 scaleX=scaleY=1。
  // 避免 preserveAspectRatio=meet 导致垂直 letterbox(scaleY≠scaleX,scroll/playhead 换算出错)。
  const render = () => {
    const width = Math.min(1200, Math.max(640, el.clientWidth || 940));
    renderCache = renderScore(score, width, mode, density);
    sheetEl.innerHTML = renderCache.svg;
    const svgEl = sheetEl.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('width', '100%');
      svgEl.setAttribute('height', 'auto');   // height auto:按 viewBox 比例自适应,scaleX=scaleY
      svgEl.removeAttribute('preserveAspectRatio');
    }
    // innerHTML 清空了子节点,重新挂回播放头层。
    sheetEl.appendChild(playheadEl);
    // 重渲染后清状态(行内 idx 体系可能变了)。
    lastHiTreble = new Set();
    lastHiBass = new Set();
    lastSysIdx = -1;
  };
  render();

  // 点击谱面小节 → onSeek(进度融进谱面的交互,文档 §7)。
  // 事件委托在 scrollEl(render 会重建 SVG 内部,绑在 SVG 上会丢失)。
  scrollEl.addEventListener('click', (e: MouseEvent) => {
    if (!renderCache || !callbacks.onSeek) return;
    const svgEl = sheetEl.querySelector('svg');
    if (!svgEl) return;
    const svgRect = svgEl.getBoundingClientRect();
    // 点击落在 SVG 外(如 padding 区)忽略。
    if (e.clientX < svgRect.left || e.clientX > svgRect.right || e.clientY < svgRect.top || e.clientY > svgRect.bottom) return;
    const scale = renderCache.width > 0 ? svgRect.width / renderCache.width : 1;
    // SVG 内坐标(与 layout 同基准)。
    const svgX = (e.clientX - svgRect.left) / scale;
    const svgY = (e.clientY - svgRect.top) / scale;
    // 找点击 y 落在哪个 system。
    let sysIdx = -1;
    for (let i = 0; i < renderCache.systems.length; i++) {
      const s = renderCache.systems[i];
      if (svgY >= s.yTop && svgY < s.yTop + s.height) { sysIdx = i; break; }
    }
    if (sysIdx < 0) return;
    const sys = renderCache.systems[sysIdx];
    // 行内小节:x 落在 barLines 的哪个区间 [barLines[k], barLines[k+1])。
    const bl = sys.trebleLayout.barLines;
    let m = 0;
    for (let k = 0; k < bl.length - 1; k++) {
      if (svgX >= bl[k] && svgX < bl[k + 1]) { m = k; break; }
      if (k === bl.length - 2) m = k;   // 末尾兜底
    }
    // 整曲 0-based 小节号 = 行起点 + 行内小节序号。
    callbacks.onSeek(sys.plan.startMeasure + m);
  });

  /** beat → 所在 system 索引(整曲绝对 beat 落在哪行)。末行兜底。 */
  const systemOfBeat = (beat: number): number => {
    if (!renderCache) return 0;
    const systems = renderCache.systems;
    for (let i = 0; i < systems.length; i++) {
      if (beat < systems[i].beatEnd) return i;
    }
    return systems.length - 1;
  };

  /** 行内 beat → 当前音符 idx(行内局部)。复刻 app.noteIndexAtBeatLayout:
   *  找最后一个 startBeat ≤ beat 且 beat 仍在 [start, start+dur) 区间内的音。
   *  返回 -1 表示该 beat 不在该组任何音发声区间内(短组已播完)。 */
  const noteIndexAtBeat = (beatInBar: number, starts: number[], notes: Note[]): number => {
    if (starts.length === 0) return -1;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] > beatInBar + BEAT_EPS) break;
      const dur = durationBeats(notes[i]);
      if (beatInBar < starts[i] + dur - BEAT_EPS) return i;
    }
    return -1;
  };

  /** 高亮当前行内符头(和弦扩展:同 chordId 的音都高亮)。清除旧行高亮。
   *  sysIdx=-1 表示停止态(清所有高亮)。 */
  const updateHighlight = (sysIdx: number, hiTreble: Set<number>, hiBass: Set<number>) => {
    const svg = sheetEl.querySelector('svg');
    if (!svg) return;
    // 清旧高亮(全量清,简单可靠)。
    svg.querySelectorAll('.note-elem.playing, .jp-elem.playing').forEach(e => e.classList.remove('playing'));
    if (sysIdx < 0) return;
    // 当前行 system 的两个 group:treble/bass(类名 ss-treble/ss-bass)。
    const sysEl = svg.querySelector(`g.ss-system[data-sys="${sysIdx}"]`);
    if (!sysEl) return;
    const apply = (groupClass: string, idxSet: Set<number>) => {
      if (idxSet.size === 0) return;
      sysEl.querySelectorAll<SVGElement>(`${groupClass} [data-idx]`).forEach(e => {
        const di = parseInt(e.getAttribute('data-idx') || '-1', 10);
        if (idxSet.has(di)) e.classList.add('playing');
      });
    };
    apply('.ss-treble', hiTreble);
    apply('.ss-bass', hiBass);
  };

  /** 行滚动锁定(提词器式):当前行【五线谱顶线】对齐到清晰带顶部(距 scrollEl 视口顶 CURRENT_TOP_PAD)。
   *  锚定 staffTopY(treble 五线第一线)而非 <g> 的 bbox-top:<g> bbox 因 <text> 符头字体度量框
   *  虚高 ~84px 且加线留白区随音符变化,用它对齐会导致各行视觉位置漂移。staffTopY 是纯几何,
   *  每行唯一的"音乐顶"参照,首行/末行/中间行锚定完全一致。
   *
   *  换算:用 SVG 在 scrollEl 内容坐标内的真实位置 + scale 把 staffTopY(SVG 内 y) 转成 scrollTop。
   *  scale 用 svgRect 高度 / viewBox 高(height:auto 下 scaleX=scaleY)。 */
  const CURRENT_TOP_PAD = 24;   // 当前行五线谱顶线距 scrollEl 视口顶的留白(谱号完整显示空间)
  const scrollToSystem = (sysIdx: number) => {
    if (!renderCache) return;
    const sys = renderCache.systems[sysIdx];
    if (!sys) return;
    const svgEl = sheetEl.querySelector('svg');
    if (!svgEl) return;
    const svgRect = svgEl.getBoundingClientRect();
    const scale = renderCache.height > 0 ? svgRect.height / renderCache.height : 1;
    // SVG 在 scrollEl 内容坐标内的 y 起点 = 当前屏幕 top - scrollEl 视口顶 + 已滚 scrollTop。
    const svgTopInContent = svgRect.top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    // staffTopY(整曲 SVG 绝对 y)→ 内容坐标 scrollTop 目标。
    const targetTop = svgTopInContent + sys.staffTopY * scale - CURRENT_TOP_PAD;
    scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  };

  /** 卡拉OK渐变:当前行及之前清晰,之后半透明。通过给每个 system 加 class 标记,
   *  CSS(.score-sheet-sheet .ss-system.future { opacity })控制。渐变范围随行高:
   *  当前行完全清晰,下一行起进入半透明(约一行高度内过渡,CSS 渐变实现)。 */
  const updateGradient = (sysIdx: number) => {
    if (!renderCache) return;
    const sysEls = sheetEl.querySelectorAll('g.ss-system');
    sysEls.forEach((e, i) => {
      e.classList.toggle('current', i === sysIdx);
      e.classList.toggle('past', i < sysIdx);
      e.classList.toggle('future', i > sysIdx);
    });
  };

  /** 播放头定位:竖条盖在当前音符上,纵向覆盖当前行【五线谱顶线到低音谱表底线】
   *  (实际音乐范围,不含加线留白/jianpu 区,避免上下被裁或过高)。
   *  参考 app.ts updatePreviewPlayhead:横向跟随时值更短的组音(短音是节奏主驱动),
   *  两组都无音时线性铺到内容区。全部用纯几何 + svgRect 缩放换算。 */
  const updatePlayhead = (sysIdx: number, beatInLine: number) => {
    if (!renderCache) return;
    const sys = renderCache.systems[sysIdx];
    if (!sys) { playheadEl.style.display = 'none'; return; }
    const svgEl = sheetEl.querySelector('svg');
    if (!svgEl) return;
    const svgRect = svgEl.getBoundingClientRect();
    const sheetRect = sheetEl.getBoundingClientRect();
    // SVG 内坐标 → 像素:height:auto 下 scaleX=scaleY,用任一边换算一致。
    const scale = renderCache.width > 0 ? svgRect.width / renderCache.width : 1;
    // SVG 在 sheetEl 内的左/上偏移(像素),作水平/垂直换算基点。
    const svgLeftInSheet = svgRect.left - sheetRect.left;
    const svgTopInSheet = svgRect.top - sheetRect.top;
    // 当前音符 idx(行内):复用 onTick 的 noteIndexAtBeat 逻辑
    const tStarts = noteStartBeats(sys.treblePiece);
    const bStarts = noteStartBeats(sys.bassPiece);
    const tIdx = noteIndexAtBeat(beatInLine, tStarts, sys.treblePiece.notes);
    const bIdx = noteIndexAtBeat(beatInLine, bStarts, sys.bassPiece.notes);
    const lay = sys.trebleLayout;   // 两组 barLines 同 x,noteX 各自;宽度基准用 treble layout
    // 横向中心 x0(SVG 内坐标)
    let x0: number;
    if (tIdx >= 0 && bIdx >= 0) {
      // 两组都在响:跟随时值更短的(短音节奏主驱动,参考 app.ts)
      const tDur = durationBeats(sys.treblePiece.notes[tIdx]);
      const bDur = durationBeats(sys.bassPiece.notes[bIdx]);
      x0 = bDur < tDur ? sys.bassLayout.noteX[bIdx] : lay.noteX[tIdx];
    } else if (tIdx >= 0) {
      x0 = lay.noteX[tIdx];
    } else if (bIdx >= 0) {
      x0 = sys.bassLayout.noteX[bIdx];
    } else {
      // 无音:线性铺到内容区
      const total = sys.beatEnd - sys.beatStart;
      const ratio = total > 0 ? Math.max(0, Math.min(1, beatInLine / total)) : 0;
      x0 = lay.contentLeft + ratio * lay.contentWidth;
    }
    // 横向:符头宽(盖住符头 2×noteHeadHalf)→ 像素,加 SVG 在 sheet 内的左偏移。
    const wPx = lay.noteHeadHalf * 2 * scale;
    const leftPx = svgLeftInSheet + x0 * scale - wPx / 2;
    // 纵向:覆盖五线谱顶线到低音谱表底线(实际音乐范围),不含加线留白。
    const topPx = svgTopInSheet + sys.staffTopY * scale;
    const heightPx = (sys.staffBotY - sys.staffTopY) * scale;
    playheadEl.style.display = '';
    playheadEl.style.left = leftPx.toFixed(1) + 'px';
    playheadEl.style.width = wPx.toFixed(1) + 'px';
    playheadEl.style.top = topPx.toFixed(1) + 'px';
    playheadEl.style.height = heightPx.toFixed(1) + 'px';
  };

  /** 通知 onLineLayout:当前行底部 y(相对 el,屏幕坐标)。
   *  瀑布流组件据此算方块区上边界(文档 §7 onLineLayout)。 */
  const notifyLineLayout = (sysIdx: number) => {
    if (!renderCache || !callbacks.onLineLayout) return;
    const sys = renderCache.systems[sysIdx];
    if (!sys) return;
    const svgEl = sheetEl.querySelector('svg');
    if (!svgEl) return;
    const svgRect = svgEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const scale = renderCache.width > 0 ? svgRect.width / renderCache.width : 1;
    // 当前行底部在 SVG 内 y = sys.yTop + sys.height → 像素 → 相对 el。
    const lineBottomY = (sys.yTop + sys.height) * scale + (svgRect.top - elRect.top);
    callbacks.onLineLayout({ lineBottomY, linePx: sys.height * scale });
  };

  return {
    el,
    onTick(beat: number) {
      if (!renderCache) return;
      const sysIdx = systemOfBeat(beat);
      const sys = renderCache.systems[sysIdx];
      if (!sys) return;
      // 行滚动 + 渐变:仅当行变化时更新(避免每帧 scrollTo 抖动)。
      if (sysIdx !== lastSysIdx) {
        scrollToSystem(sysIdx);
        updateGradient(sysIdx);
        notifyLineLayout(sysIdx);
        lastSysIdx = sysIdx;
      }
      const beatInLine = beat - sys.beatStart;
      // 播放头:每帧更新(跟当前音符跳动)
      updatePlayhead(sysIdx, beatInLine);
      const tStarts = noteStartBeats(sys.treblePiece);
      const bStarts = noteStartBeats(sys.bassPiece);
      const tIdx = noteIndexAtBeat(beatInLine, tStarts, sys.treblePiece.notes);
      const bIdx = noteIndexAtBeat(beatInLine, bStarts, sys.bassPiece.notes);
      // 和弦扩展:同 chordId 的音都高亮。
      const expand = (notes: Note[], idx: number): Set<number> => {
        const s = new Set<number>();
        if (idx < 0) return s;
        const cid = notes[idx]?.chordId;
        if (cid) { for (let i = 0; i < notes.length; i++) if (notes[i].chordId === cid) s.add(i); }
        else s.add(idx);
        return s;
      };
      const hiTreble = expand(sys.treblePiece.notes, tIdx);
      const hiBass = expand(sys.bassPiece.notes, bIdx);
      // 仅当高亮集合变化时更新 DOM(避免每帧无谓 querySelectorAll)。
      if (!setEq(hiTreble, lastHiTreble) || !setEq(hiBass, lastHiBass) || sysIdx !== lastSysIdx) {
        updateHighlight(sysIdx, hiTreble, hiBass);
        lastHiTreble = hiTreble;
        lastHiBass = hiBass;
      }
    },
    setMode(m: ScoreMode) {
      if (m === mode) return;
      mode = m;
      render();
      // mode 切换后行高变,若正在播放需重新对齐当前行。
      if (lastSysIdx >= 0) {
        scrollToSystem(lastSysIdx);
        updateGradient(lastSysIdx);
        notifyLineLayout(lastSysIdx);
      }
    },
    setDensity(key: string) {
      const preset = DENSITY_PRESETS[key];
      if (!preset || preset === density) return;
      density = preset;
      render();
      // 密度切换后切行变了,重新对齐当前行。
      if (lastSysIdx >= 0) {
        scrollToSystem(lastSysIdx);
        updateGradient(lastSysIdx);
        notifyLineLayout(lastSysIdx);
      }
    },
    setScore(s: Score) {
      score = s;
      render();
    },
  };
}

/** 两个 number Set 内容是否相同(顺序无关)。 */
function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
