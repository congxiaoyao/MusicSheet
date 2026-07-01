// 全曲多行排版引擎 —— 把整曲 Score 排成多行(像纸质琴谱),供预览弹窗与未来图片导出复用。
//
// 核心思路(零侵入现有渲染层):整曲按「每行 measuresPerLine 个小节」切行,每行构造成一个
// segment Piece(treble + bass),复用现有 computeLayout + renderStaffSVG/renderJianpuSVG 渲染,
// 然后用 <g transform="translate(0, 累积高)"> 垂直堆叠(推广 buildGrandSVG 的 translate 模式)。
// 每行的小节组挂 data-measure="n",供点击定位(点该小节 → 跳编辑区到第 n 小节)。
//
// treble/bass 双谱表:每行内用 buildGrandSVG 同款的 treble/bass 上下堆叠(grand 视图模式)。
// staff/jianpu 切换:mode='staff'/'jianpu'/'both',与现有 previewMode 同义。

import { Piece, Note } from '../core/types';
import { Score, emptyMeasure } from '../core/score';
import { computeLayout, Layout } from './layout';
import { renderStaffSVG, RenderInput } from './staff';
import { renderJianpuSVG } from './jianpu';

export type FullScoreMode = 'staff' | 'jianpu' | 'both';

/** 排版一行的小节范围。 */
interface LinePlan {
  startMeasure: number;   // 0-based,整曲内
  count: number;          // 该行小节数(末行可能不足 measuresPerLine)
}

/** 把整曲按 measuresPerLine 切行。 */
export function planLines(totalMeasures: number, measuresPerLine: number): LinePlan[] {
  const lines: LinePlan[] = [];
  const perLine = Math.max(1, measuresPerLine);
  for (let s = 0; s < totalMeasures; s += perLine) {
    const count = Math.min(perLine, totalMeasures - s);
    lines.push({ startMeasure: s, count });
  }
  return lines.length ? lines : [{ startMeasure: 0, count: 1 }];
}

/** 把某行的小节构造成一个 segment Piece(指定谱表组)。
 *  measureCount = 该行小节数;notes = 该行各小节的对应组拼接。 */
function lineToPiece(score: Score, line: LinePlan, group: 'treble' | 'bass'): Piece {
  const notes: Note[] = [];
  for (let i = line.startMeasure; i < line.startMeasure + line.count; i++) {
    const m = score.measures[i] || emptyMeasure();
    notes.push(...m[group]);
  }
  return {
    clef: group,
    key: score.meta.key,
    time: score.meta.time,
    measureCount: line.count,
    notes,
    treble: group === 'treble' ? notes : [],
    bass: group === 'bass' ? notes : [],
  };
}

/** 一行的渲染结果(inner SVG + 该行的可见高度 + 宽度)。 */
interface RenderedLine {
  svg: string;       // <g class="fs-line" data-measure-start=... transform=...>...</g> 的内部内容(不含外层 g)
  height: number;    // 该行可见区高度(用于堆叠)
  width: number;
  viewBoxYOffset: number;
}

/** 渲染一行:treble/bass 两谱表 + staff/jianpu,按 mode 决定显示哪些。
 *  isLastLine:是否整曲最后一行(影响终止线,见下)。 */
function renderLine(score: Score, line: LinePlan, width: number, mode: FullScoreMode, isLastLine: boolean): RenderedLine {
  const treblePiece = lineToPiece(score, line, 'treble');
  const bassPiece = lineToPiece(score, line, 'bass');
  const trebleLayout = computeLayout(treblePiece, width, 'quarter');
  const bassLayout = computeLayout(bassPiece, width, 'quarter');

  const showStaff = mode !== 'jianpu';
  const showJianpu = mode !== 'staff';

  const tInput: RenderInput = { piece: treblePiece, layout: trebleLayout, playingIndex: -1, hover: null };
  const bInput: RenderInput = { piece: bassPiece, layout: bassLayout, playingIndex: -1, hover: null };
  const tStaff = showStaff ? renderStaffSVG(tInput) : '';
  const tJianpu = showJianpu ? renderJianpuSVG(tInput) : '';
  const bStaff = showStaff ? renderStaffSVG(bInput) : '';
  const bJianpu = showJianpu ? renderJianpuSVG(bInput) : '';

  // 可见区顶/底(与 buildGrandSVG 同款逻辑,按 mode 取 staff/jianpu 区段)。
  const visTop = (lay: Layout) => showStaff ? lay.viewBoxYOffset : lay.jianpuTop;
  const visBottom = (lay: Layout) => showStaff ? (showJianpu ? lay.height : lay.jianpuTop) : lay.jianpuBottom;
  const jpPad = showStaff && showJianpu ? 0 : (!showStaff ? 24 : 0);
  const tTop = visTop(trebleLayout) - jpPad;
  const tBot = visBottom(trebleLayout);
  const bTop = visTop(bassLayout) - jpPad;
  const bBot = visBottom(bassLayout) + jpPad;
  const tVisH = tBot - tTop;
  const lineW = Math.max(trebleLayout.width, bassLayout.width);

  // treble 组:translate 抵消可见区顶部(可见内容从 y=0 起)。
  // 每个小节用 <g data-measure="n"> 包裹 treble 的该小节内容,供点击定位。
  // 但 renderStaffSVG 输出的是整段,无法按小节拆分 → 改在整行外层挂 data-line-start,
  // 点击定位由「点击 x → 所在小节」换算(见 score-preview-modal)。
  const trebleGroup = `<g class="fs-staff-treble" transform="translate(0, ${-tTop})">${showStaff ? `<g class="staff-group">${tStaff}</g>` : ''}${showJianpu ? `<g class="jianpu-group">${tJianpu}</g>` : ''}</g>`;
  const bassGroup = `<g class="fs-staff-bass" transform="translate(0, ${tVisH - bTop})">${showStaff ? `<g class="staff-group">${bStaff}</g>` : ''}${showJianpu ? `<g class="jianpu-group">${bJianpu}</g>` : ''}</g>`;
  const height = tVisH + (bBot - bTop);
  void isLastLine;   // 终止线:现有 renderBarLines 每行末尾画终止线,多行预览下每行都有,视觉可接受。
  return {
    svg: trebleGroup + bassGroup,
    height,
    width: lineW,
    viewBoxYOffset: trebleLayout.viewBoxYOffset,
  };
}

/** 构建整曲多行 SVG 字符串。每行外层 <g> 挂 data-line-start / data-line-count 供点击定位。 */
export function buildFullScoreSVG(score: Score, opts: {
  mode?: FullScoreMode;
  measuresPerLine?: number;
  width?: number;
  lineGap?: number;
}): { svg: string; width: number; height: number; lines: LinePlan[] } {
  const mode = opts.mode ?? 'both';
  const measuresPerLine = opts.measuresPerLine ?? 4;
  const width = opts.width ?? 1080;
  const lineGap = opts.lineGap ?? 28;   // 行间距(像纸质琴谱的系统间距)
  const lines = planLines(score.meta.totalMeasures, measuresPerLine);

  const rendered = lines.map((ln, i) => renderLine(score, ln, width, mode, i === lines.length - 1));
  const totalWidth = Math.max(width, ...rendered.map(r => r.width));
  let cumY = 0;
  const groups: string[] = [];
  for (let i = 0; i < rendered.length; i++) {
    const ln = lines[i];
    const r = rendered[i];
    groups.push(
      `<g class="fs-line" data-line-start="${ln.startMeasure}" data-line-count="${ln.count}" transform="translate(0, ${cumY.toFixed(2)})">${r.svg}</g>`,
    );
    cumY += r.height + lineGap;
  }
  const totalHeight = Math.max(0, cumY - lineGap) + 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight.toFixed(2)}" viewBox="0 0 ${totalWidth} ${totalHeight.toFixed(2)}">${groups.join('')}</svg>`;
  return { svg, width: totalWidth, height: totalHeight, lines };
}

/** 点击 x(在某行内,相对该行 SVG 内部坐标)→ 该行内的 0-based 小节序号(整曲内)。
 *  供预览弹窗点击定位:每行 contentLeft..contentRight 等分 count 份。 */
export function lineXToMeasure(lineStart: number, lineCount: number, svgX: number, layout: { contentLeft: number; contentRight: number }): number {
  const { contentLeft, contentRight } = layout;
  if (svgX < contentLeft) return lineStart;
  if (svgX > contentRight) return lineStart + lineCount - 1;
  const ratio = (svgX - contentLeft) / (contentRight - contentLeft);
  return lineStart + Math.min(lineCount - 1, Math.floor(ratio * lineCount));
}
