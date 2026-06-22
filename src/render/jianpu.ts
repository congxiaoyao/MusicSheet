// 简谱渲染：数字、八度点、下划线、短横、附点、临时记号

import { noteToJianpu } from '../core/theory';
import { Note } from '../core/types';
import { RenderInput } from './staff';
import { tupletGroups } from '../core/model';

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

function text(content: string, x: number, y: number, fs: number, opts: { anchor?: string; fill?: string; family?: string; weight?: string; class?: string; dataIdx?: number } = {}): string {
  const anchor = opts.anchor ?? 'middle';
  const fill = opts.fill ?? '#1f2430';
  const family = opts.family ?? NUMBER_FONT;
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : '';
  const cls = opts.class ? ` class="${opts.class}"` : '';
  const data = opts.dataIdx !== undefined ? ` data-idx="${opts.dataIdx}"` : '';
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family='${family}' font-size="${fs}" text-anchor="${anchor}" dominant-baseline="alphabetic" fill="${fill}"${weight}${cls}${data}>${content}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, opts: { dataIdx?: number; class?: string } = {}): string {
  const cls = opts.class ? ` class="${opts.class}"` : '';
  const data = opts.dataIdx !== undefined ? ` data-idx="${opts.dataIdx}"` : '';
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${cls}${data}/>`;
}

function circle(cx: number, cy: number, r: number, fill: string, opts: { dataIdx?: number; class?: string } = {}): string {
  const cls = opts.class ? ` class="${opts.class}"` : '';
  const data = opts.dataIdx !== undefined ? ` data-idx="${opts.dataIdx}"` : '';
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}"${cls}${data}/>`;
}

/** SVG 路径：简谱连音线(tie)弧线用。 */
function path(d: string, stroke: string, width: number): string {
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
}

/** 时值 → 下划线数（0=四分及以上，1=八分，2=十六分，3=三十二分） */
function underlineCount(duration: string, dotted: boolean): number {
  let n: number;
  if (duration === 'whole' || duration === 'half' || duration === 'quarter') n = 0;
  else if (duration === 'eighth') n = 1;
  else if (duration === 'sixteenth') n = 2;
  else if (duration === 'thirtysecond') n = 3;
  else n = 2; // 兜底（未知短时值按十六分处理）
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
  const { piece, layout } = input;
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

  // 把 notes 切成「时间位」:连续同 chordId 归一段;无 chordId 单音自成一段 [start,end]
  const slots: [number, number][] = [];
  for (let i = 0; i < piece.notes.length;) {
    const cid = piece.notes[i].chordId;
    let j = cid ? i : i + 1;
    if (cid) while (j < piece.notes.length && piece.notes[j].chordId === cid) j++;
    slots.push([i, j - 1]);
    i = j;
  }
  // 和弦内数字纵排:按音高从高到低(简谱数字大→小的音高顺序)从上往下叠。
  // 行高动态:字形高约 DIGIT_FS*0.7=18px,基础行高需留间隙;带八度点的声部还需
  // 额外空间(高音点在数字上方、低音点在下方),按各声部实际占高分配,避免重叠。
  const DIGIT_HEIGHT = DIGIT_FS * 0.72;   // 数字字形高(baseline 到顶)
  const DIGIT_DESCEND = DIGIT_FS * 0.18;  // 数字字形下伸(baseline 到底,数字无下伸但留余量)
  const DOT_GAP = 6;                       // 八度点间距
  const DOT_R = 2.2;
  // 八度点中心相对数字 baseline 的偏移:高音点在字形顶上方,低音点在字形底下方。
  // 第 n 个点(1-indexed)距 baseline:高音 = DIGIT_HEIGHT + 6 + (n-1)*DOT_GAP(往上,y 减);
  // 低音 = DIGIT_DESCEND + 6 + (n-1)*DOT_GAP(往下,y 加)。
  const dotUpFromBase = (n: number) => DIGIT_HEIGHT + 6 + (n - 1) * DOT_GAP;
  const dotDnFromBase = (n: number) => DIGIT_DESCEND + 6 + (n - 1) * DOT_GAP;

  for (const [s0, s1] of slots) {
    const head = piece.notes[s0];           // 首音(时值/附点/tuplet 以它为准)
    const x = layout.noteX[s0];
    // 高亮改由运行时 CSS class 控制(.jp-elem.playing),渲染时统一 currentColor。
    // 简谱整组高亮,所有元素 data-idx 用首音 s0(updateHighlight 对和弦组会加首音 .playing)。
    const fill = 'currentColor';
    const jpOpts = { fill, class: 'jp-elem', dataIdx: s0 };
    const jpLineOpts = { class: 'jp-elem', dataIdx: s0 };
    // 组内各声部(含单音):休止过滤
    const members: { idx: number; note: Note; jp: NonNullable<ReturnType<typeof noteToJianpu>> }[] = [];
    for (let k = s0; k <= s1; k++) {
      const jp = noteToJianpu(piece.notes[k], piece.key);
      if (!jp) continue;
      members.push({ idx: k, note: piece.notes[k], jp });
    }
    if (members.length === 0) continue;

    // 和弦纵排:按 midi 升序(高音在上=数字纵排顶部)。动态行高:
    // 每个声部的「占高」= 数字字形高 + 上方八度点空间 + 下方八度点空间 + 声部间间隙。
    // 总高 = sum(各声部占高),各声部 baseline 按累计高度居中分布,确保不重叠。
    const sorted = members.slice().sort((a, b) => (a.note.midi ?? 0) - (b.note.midi ?? 0));
    const nM = sorted.length;
    const GAP = 4;   // 声部间最小间隙
    // 各声部「占高」(从该声部最高点到最低点):
    // 高音点(若有)= dotUpFromBase(n) + DOT_R(从 baseline 往上);
    // 数字 = DIGIT_HEIGHT(从 baseline 往上);
    // 低音点(若有)= dotDnFromBase(n) + DOT_R(从 baseline 往下) + DIGIT_DESCEND。
    // 占高 = max(高音点顶, 数字顶) - min(低音点底, 数字底),相对 baseline 上下。
    type Member = { idx: number; note: Note; jp: NonNullable<ReturnType<typeof noteToJianpu>> };
    const upExtent = (m: Member): number => {   // baseline 上方占据(正数)
      const n = m.jp.octaveDots > 0 ? m.jp.octaveDots : 0;
      return n > 0 ? dotUpFromBase(n) + DOT_R : DIGIT_HEIGHT;
    };
    const dnExtent = (m: Member): number => {   // baseline 下方占据(正数)
      const n = m.jp.octaveDots < 0 ? -m.jp.octaveDots : 0;
      const dots = n > 0 ? dotDnFromBase(n) + DOT_R : 0;
      return Math.max(dots, DIGIT_DESCEND);
    };
    const slotHeights = sorted.map(m => upExtent(m) + dnExtent(m));
    const totalH = slotHeights.reduce((a, b) => a + b, 0) + GAP * (nM - 1);
    // 各声部 baseline(相对组中心):从顶部往下累计。
    // 第 r 声部顶部 = acc;r 声部 baseline = acc + upExtent(其上方点+字形高);
    // 然后 acc += 字形下伸 + 下方点 + GAP,到下一声部顶部。
    const offsets = new Map<number, number>();
    let topAcc = -totalH / 2;   // 第一个声部顶部,相对组中心(baseY)
    for (let r = 0; r < nM; r++) {
      const m = sorted[r];
      offsets.set(m.idx, topAcc + upExtent(m));   // baseline = 顶部 + 上方占高
      topAcc += upExtent(m) + dnExtent(m) + GAP;   // 移到下一声部顶部
    }

    const slotW = layout.noteSlotW[s0];
    const accOffset = Math.max(ACCIDENTAL_MIN, ACCIDENTAL_BASE - Math.max(0, (ACCIDENTAL_NARROW_SLOT - slotW)) * 0.35);
    const accYBase = baseY - ACCIDENTAL_LIFT;

    // 逐声部画数字 + 八度点 + 临时记号(各声部独立);时值修饰(下划线/短横/附点)整组画一次
    for (const m of members) {
      const yRow = baseY + (offsets.get(m.idx) ?? 0);
      const jp = m.jp;
      // 临时记号
      if (jp.accidental === 'sharp') s += text('♯', x - accOffset, accYBase + (offsets.get(m.idx) ?? 0) - SHARP_EXTRA_LIFT, DIGIT_FS * 0.7, jpOpts);
      else if (jp.accidental === 'flat') s += text('♭', x - accOffset, accYBase + (offsets.get(m.idx) ?? 0), DIGIT_FS * 0.7, jpOpts);
      // 数字(休止用 0)
      const digitStr = jp.digit === 0 ? '0' : String(jp.digit);
      s += text(digitStr, x, yRow, DIGIT_FS, { ...jpOpts, weight: '500' });
      // 八度点(各声部独立,基于该声部 yRow):画在字形外,偏移与上方动态行高分配一致。
      // 高音点 y = baseline - dotUpFromBase(n);低音点 y = baseline + dotDnFromBase(n)。
      if (jp.octaveDots > 0) {
        for (let d = 0; d < jp.octaveDots; d++) s += circle(x, yRow - dotUpFromBase(d + 1), DOT_R, fill, jpOpts);
      } else if (jp.octaveDots < 0) {
        for (let d = 0; d < -jp.octaveDots; d++) s += circle(x, yRow + dotDnFromBase(d + 1), DOT_R, fill, jpOpts);
      }
    }

    // 时值修饰(附点/下划线/短横)整组画一次,画在「整组最低声部」下方而非固定 baseY。
    // 和弦纵排时,下划线画在 baseY 会与中间声部数字挤;画在最低声部下方则与所有数字分离。
    // 单音时 lowestYRow = baseY(offset=0),行为与旧实现一致。
    const lowestMember = sorted[nM - 1];
    const lowestYRow = baseY + (offsets.get(lowestMember.idx) ?? 0);

    // 附点:整组画一次(用首音),位置在数字右侧,垂直居中于整组中线
    if (head.dotted) {
      s += circle(x + 11, lowestYRow - 6, 2.2, fill, jpOpts);
    }

    // 下划线(时值<四分):整组画一次(用首音时值),位置在最低声部下方。
    // 若最低声部有低音点,下划线要从低音点下方开始(否则与低音点挤在一起重叠)。
    const ucount = underlineCount(head.duration, head.dotted);
    const numHalfW = 7;
    const lowDots = lowestMember.jp.octaveDots < 0 ? -lowestMember.jp.octaveDots : 0;
    // 下划线起始 y:无低音点=lowestYRow+8;有低音点=lowestYRow+低音点最下+间隙
    const underlineBaseY = lowDots > 0
      ? lowestYRow + dotDnFromBase(lowDots) + DOT_R + 3   // 低音点下方 + 3px 间隙
      : lowestYRow + 8;
    for (let u = 0; u < ucount; u++) {
      const uy = underlineBaseY + u * 5;
      s += line(x - numHalfW, uy, x + numHalfW, uy, fill, 1.4, jpLineOpts);
    }

    // 短横(时值>四分):整组画一次,画在最低声部中线
    const dcount = dashCount(head.duration, head.dotted);
    for (let d = 0; d < dcount; d++) {
      const dx = x + 16 + d * 14;
      s += line(dx - 6, lowestYRow - 4, dx + 6, lowestYRow - 4, fill, 1.8, jpLineOpts);
    }
  }

  // 连音线(tie):按时间位配对(同五线谱逻辑)。在前位每个 tieStart 声部与后位同 midi 的 tieEnd 声部间画弧。
  const numHalfW2 = 7;
  for (let si = 0; si < slots.length - 1; si++) {
    const [a0, a1] = slots[si];
    const [b0, b1] = slots[si + 1];
    for (let ai = a0; ai <= a1; ai++) {
      const a = piece.notes[ai];
      if (!a.tieStart || a.midi === null) continue;
      for (let bi = b0; bi <= b1; bi++) {
        const b = piece.notes[bi];
        if (!b.tieEnd || b.midi === null || a.midi !== b.midi) continue;
        const prevX = layout.noteX[ai];
        const curX = layout.noteX[bi];
        const tieY = baseY - 13;
        const xa = prevX + numHalfW2 + 1;
        const xb = curX - numHalfW2 - 1;
        const mx = (xa + xb) / 2;
        const my = tieY - 6;
        s += path(`M ${xa.toFixed(1)} ${tieY.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${xb.toFixed(1)} ${tieY.toFixed(1)}`, '#1f2430', 1.3);
        break;
      }
    }
  }

  // 连音组(tuplet)标记。简谱规范：数字 + 弧线（连接组首到组末，在数字下方/音符上方），
  // 不论时值都画弧线（简谱的下划线是时值线，与连音弧线是两回事）。
  for (const g of tupletGroups(piece)) {
    const x1 = layout.noteX[g.startIdx] - 6;
    const x2 = layout.noteX[g.endIdx] + 6;
    const mx = (x1 + x2) / 2;
    const numY = baseY - 28;                       // 数字 y（上方）
    const arcY = baseY - 20;                       // 弧线 y（数字下方、音符上方，往上提）
    // 数字（actual）
    s += text(String(g.actual), mx, numY, DIGIT_FS * 0.7, { fill: '#1f2430', weight: '500' });
    // 弧线：朝上凸，连接组首到组末
    const my = arcY - 5;
    s += path(`M ${x1.toFixed(1)} ${arcY.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${arcY.toFixed(1)}`, '#1f2430', 1.2);
  }

  // 下一个待输入位置在简谱行的对应圆角矩形指示器（宽度随时值变化；写满不显示）
  if (!layout.isFull) {
    const slotW = Math.max(22, Math.min(layout.nextSlotW, layout.staffSpace * 4));
    s += `<rect x="${(layout.nextSlotX - slotW / 2).toFixed(1)}" y="${(layout.jianpuTop + 8).toFixed(1)}" width="${slotW.toFixed(1)}" height="${(layout.jianpuBottom - layout.jianpuTop - 16).toFixed(1)}" fill="none" stroke="#4f46e5" stroke-width="1.4" rx="5" class="next-slot"/>`;
  }

  return s;
}
