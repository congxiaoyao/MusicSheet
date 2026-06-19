// 简谱渲染：数字、八度点、下划线、短横、附点、临时记号

import { noteToJianpu } from '../core/theory';
import { RenderInput } from './staff';

const NUMBER_FONT = '"Bravura", "Times New Roman", serif';
const DIGIT_FS = 26;
// 临时记号相对数字中心的左偏移：随音符格子宽度变化——
// 四分及以上音符格子宽，用 ACCIDENTAL_BASE；八分/十六分格子窄，
// 按比例缩小（避免临时记号侵入相邻音符或小节线），但不低于 ACCIDENTAL_MIN。
const ACCIDENTAL_BASE = 10;
const ACCIDENTAL_MIN = 5;
// 格子宽度降到这个值以下时，临时记号偏移取最小值。
const ACCIDENTAL_NARROW_SLOT = 30;
// 临时记号垂直上抬量（相对数字基线）。国标「左上方」：记号字号是数字的 0.7，
// 视觉高度比数字矮约 5.5px，故上抬约 5px 让记号中心落在数字上 1/3 处。
const ACCIDENTAL_LIFT = 10;
// 升号 ♯ 字形重心比降号 ♭ 略低，需额外上抬一点对齐视觉中心。
const SHARP_EXTRA_LIFT = 2;

function text(content: string, x: number, y: number, fs: number, opts: { anchor?: string; fill?: string; family?: string; weight?: string; class?: string } = {}): string {
  const anchor = opts.anchor ?? 'middle';
  const fill = opts.fill ?? '#1f2430';
  const family = opts.family ?? NUMBER_FONT;
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : '';
  const cls = opts.class ? ` class="${opts.class}"` : '';
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family='${family}' font-size="${fs}" text-anchor="${anchor}" dominant-baseline="alphabetic" fill="${fill}"${weight}${cls}>${content}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number): string {
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"/>`;
}

function circle(cx: number, cy: number, r: number, fill: string): string {
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}"/>`;
}

/** 时值 → 下划线数（0=四分及以上，1=八分，2=十六分） */
function underlineCount(duration: string, dotted: boolean): number {
  let n: number;
  if (duration === 'whole' || duration === 'half' || duration === 'quarter') n = 0;
  else if (duration === 'eighth') n = 1;
  else n = 2;
  // 附点不改下划线数
  void dotted;
  return n;
}

/** 时值 → 数字后的短横数（二分=1，全分=3，四分及以下=0） */
function dashCount(duration: string, dotted: boolean): number {
  let n: number;
  if (duration === 'whole') n = 3;
  else if (duration === 'half') n = 1;
  else n = 0;
  if (dotted) n += 1;
  return n;
}

/** 渲染简谱行（SVG 内容） */
export function renderJianpuSVG(input: RenderInput): string {
  const { piece, layout, playingIndex } = input;
  const baseY = layout.jianpuBaseline;
  let s = '';

  // 小节竖线（淡色，与五线谱对齐）
  for (let i = 1; i < layout.barLines.length - 1; i++) {
    const x = layout.barLines[i];
    s += line(x, layout.jianpuTop + 6, x, layout.jianpuBottom - 6, '#cbd5e1', 1);
  }
  // 起止竖线
  s += line(layout.barLines[0], layout.jianpuTop + 6, layout.barLines[0], layout.jianpuBottom - 6, '#94a3b8', 1.4);
  s += line(layout.barLines[layout.barLines.length - 1], layout.jianpuTop + 6, layout.barLines[layout.barLines.length - 1], layout.jianpuBottom - 6, '#94a3b8', 2.2);

  for (let i = 0; i < piece.notes.length; i++) {
    const note = piece.notes[i];
    const x = layout.noteX[i];
    const highlight = i === playingIndex;
    const fill = highlight ? '#4f46e5' : '#1f2430';
    const jp = noteToJianpu(note, piece.key);
    if (!jp) continue;

    // 临时记号（数字前）：偏移随时值动态收缩，避免窄格子里离数字太远
    const slotW = layout.noteSlotW[i];
    const accOffset = Math.max(ACCIDENTAL_MIN, ACCIDENTAL_BASE - Math.max(0, (ACCIDENTAL_NARROW_SLOT - slotW)) * 0.35);
    const accY = baseY - ACCIDENTAL_LIFT;
    if (jp.accidental === 'sharp') s += text('♯', x - accOffset, accY - SHARP_EXTRA_LIFT, DIGIT_FS * 0.7, { fill });
    else if (jp.accidental === 'flat') s += text('♭', x - accOffset, accY, DIGIT_FS * 0.7, { fill });

    // 数字（休止用 0）
    const digitStr = jp.digit === 0 ? '0' : String(jp.digit);
    s += text(digitStr, x, baseY, DIGIT_FS, { fill, weight: '500' });

    // 附点
    if (note.dotted) {
      s += circle(x + 11, baseY - 6, 2.2, fill);
    }

    // 八度点（上方/下方）
    const dotR = 2.2;
    if (jp.octaveDots > 0) {
      for (let d = 0; d < jp.octaveDots; d++) {
        s += circle(x, baseY - 24 - d * 7, dotR, fill);
      }
    } else if (jp.octaveDots < 0) {
      for (let d = 0; d < -jp.octaveDots; d++) {
        s += circle(x, baseY + 10 + d * 7, dotR, fill);
      }
    }

    // 下划线（时值 < 四分）
    const ucount = underlineCount(note.duration, note.dotted);
    const numHalfW = 7;
    for (let u = 0; u < ucount; u++) {
      const uy = baseY + 4 + u * 5;
      s += line(x - numHalfW, uy, x + numHalfW, uy, fill, 1.4);
    }

    // 短横（时值 > 四分）：画在数字右侧的横线，每条占约一个数字宽
    const dcount = dashCount(note.duration, note.dotted);
    for (let d = 0; d < dcount; d++) {
      const dx = x + 16 + d * 14;
      s += line(dx - 6, baseY - 4, dx + 6, baseY - 4, fill, 1.8);
    }
  }

  // 下一个待输入位置在简谱行的对应圆角矩形指示器（宽度随时值变化；写满不显示）
  if (!layout.isFull) {
    const slotW = Math.max(22, Math.min(layout.nextSlotW, layout.staffSpace * 4));
    s += `<rect x="${(layout.nextSlotX - slotW / 2).toFixed(1)}" y="${(layout.jianpuTop + 8).toFixed(1)}" width="${slotW.toFixed(1)}" height="${(layout.jianpuBottom - layout.jianpuTop - 16).toFixed(1)}" fill="#4f46e5" stroke="#4f46e5" stroke-width="1.4" rx="5" class="next-slot"/>`;
  }

  return s;
}
