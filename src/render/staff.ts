// 五线谱渲染：谱号、调号、拍号、小节线、音符、下一个待输入位置的圆角矩形指示器

import { Piece, Note } from '../core/types';
import { staffStepToMidi, resolvePitch } from '../core/theory';
import { Layout } from './layout';
import { G, advanceSS } from './glyphs';
import { computeBeams, BeamGroup } from './beam';

// 连梁几何常量（单位 staff space）
const BEAM_THICKNESS = 0.5;   // 单根横梁厚度（SMuFL beamThickness）
const BEAM_GAP = 0.75;        // 双横梁中心距 = beamThickness(0.5) + beamSpacing(0.25)（SMuFL）
const STEM_MIN_BEAM = 3;      // 连梁时符干最短长度，避免梁贴着符头
const BEAM_OVERHANG = 2.5;    // 横梁允许超出五线谱顶/底线的距离（staff space）
const MAX_BEAM_SLOPE = 1.5;   // 倾斜梁首尾最大垂直差（≈ 一个三度），超过削平
// 符干水平内偏移：符干贴符头侧边时会顶出符头一点，往左（朝符头中心）挪此值，
// 让符头遮住符干内侧，视觉更干净（朝上/朝下都往左挪）。
const STEM_INSET = 0.1;      // 单位 staff space

// 线宽常量（staff space 单位，遵循 SMuFL engravingDefaults 推荐值）。
// staff line 0.13；barline 细 0.16 / 粗(终止) 0.5；ledger line 0.16；stem 0.12。
const W_STAFF = 0.13;
const W_BARLINE = 0.16;
const W_BARLINE_FINAL = 0.5;
const W_LEDGER = 0.16;
const W_STEM = 0.12;

export interface RenderInput {
  piece: Piece;
  layout: Layout;
  /** 当前播放高亮的音符索引（-1 = 无） */
  playingIndex: number;
  /** 悬停预览的音高（null = 无悬停）。点击落点 x 用于画 ghost。 */
  hover: { midi: number; x: number } | null;
}

// ── SVG 基元 ────────────────────────────────────────────────

function text(content: string, x: number, y: number, fontSize: number, opts: { anchor?: string; fill?: string; family?: string; class?: string } = {}): string {
  const anchor = opts.anchor ?? 'middle';
  const fill = opts.fill ?? '#1f2430';
  const family = opts.family ?? 'Bravura';
  const cls = opts.class ? ` class="${opts.class}"` : '';
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${family}" font-size="${fontSize}" text-anchor="${anchor}" dominant-baseline="alphabetic" fill="${fill}"${cls}>${content}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke = '#475569', width = 1.3, opts: { class?: string } = {}): string {
  const cls = opts.class ? ` class="${opts.class}"` : '';
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${cls}/>`;
}

function rect(x: number, y: number, w: number, h: number, opts: { fill?: string; fillOpacity?: number; stroke?: string; sw?: number; rx?: number; class?: string; opacity?: number } = {}): string {
  const fill = opts.fill ?? 'none';
  const fillOp = opts.fillOpacity !== undefined ? ` fill-opacity="${opts.fillOpacity}"` : '';
  const stroke = opts.stroke ? ` stroke="${opts.stroke}" stroke-width="${opts.sw ?? 1}"` : '';
  const rx = opts.rx ? ` rx="${opts.rx}" ry="${opts.rx}"` : '';
  const cls = opts.class ? ` class="${opts.class}"` : '';
  const op = opts.opacity !== undefined ? ` opacity="${opts.opacity}"` : '';
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"${fillOp}${stroke}${rx}${cls}${op}/>`;
}

/** 多边形：连梁横梁用，画平行四边形使两端切口平直。points 为 [x,y][]。 */
function polygon(points: [number, number][], opts: { fill?: string; class?: string } = {}): string {
  const fill = opts.fill ?? '#1f2430';
  const cls = opts.class ? ` class="${opts.class}"` : '';
  const pts = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<polygon points="${pts}" fill="${fill}"${cls}/>`;
}

/** step（0=最下线，每步 1 个自然音级 = 半个线距）→ y 坐标。
 *  staffSpace 现在是真实线距(=2 个 step 高度)，故 1 step = staffSpace/2。 */
function stepToY(step: number, layout: Layout): number {
  return layout.bottomLineY - step * layout.staffSpace / 2;
}

// ── 组件渲染 ────────────────────────────────────────────────

function renderStaffLines(layout: Layout): string {
  let s = '';
  for (let i = 0; i < 5; i++) {
    const y = layout.staffTop + i * layout.staffSpace;   // staffSpace = 线距
    // 五条线贯穿整张画布：左端到画布最左(staffLeftX)，右端到末根小节线。
    // 谱号/调号/拍号会叠加画在这段线上（渲染顺序在后，盖住线），符合标准记谱。
    s += line(layout.staffLeftX, y, layout.barLines[layout.barLines.length - 1], y, '#1f2430', W_STAFF * layout.staffSpace);
  }
  return s;
}

/** 谱号。实测 Bravura 字形（font-size=46, ss=11.5，alphabetic baseline）：
 *  - gClef：baseline=G4(第2线) 时，G 圈压在第2线、字形向上延伸到接近顶线。ascent=4.43ss/descent=2.70ss。
 *  - fClef：两点在 baseline 上方约 1.13ss 处(ascent)，故 baseline 需在 F3(低音第2线)下方 1.13ss，两点才压在 F3。
 *           字形 descent=2.61ss，整体偏低，向 F3 下方偏移。 */
function renderClef(piece: Piece, layout: Layout): string {
  const fs = layout.fontSize;
  const { clefX } = layout;
  const ss = layout.staffSpace;
  if (piece.clef === 'treble') {
    return text(G.gClef, clefX, stepToY(2, layout), fs);          // baseline=G4
  }
  return text(G.fClef, clefX, stepToY(6, layout) + ss * 1.13, fs); // 两点压在 F3
}

/** 调号：升/降号依次排在谱号右侧，压在标准记谱约定的线/间上。
 *  letter 是 0..6（C=0..B=6）的字母索引；step 是相对「最下线」的位置（0=底线，每升一线/间 +1）。
 *  升号整体偏上（高音位置集 {3..9}），降号整体偏下（高音位置集 {1..8}）。
 *  高音谱号底线 E4=step0；低音谱号底线 G2=step0。 */
function renderKeySignature(piece: Piece, layout: Layout): string {
  if (!layout.hasKey) return '';
  const fs = layout.fontSize * 0.7;
  const ss = layout.staffSpace;
  const letters = piece.key.sharps.length ? piece.key.sharps : piece.key.flats;
  const isSharp = piece.key.sharps.length > 0;

  // 标准 step 位置：键=字母索引(C=0 D=1 E=2 F=3 G=4 A=5 B=6)。
  // 高音：升号 F#C#G#D#A#E#B# = 8,5,9,6,3,7,4 ；降号 BbEbAbDbGbCbFb = 4,7,3,6,8,5,1
  // 低音：升号 = 6,3,7,4,8,5,2 ；降号 = 2,5,1,4,0,3,6
  const trebleSharp: Record<number, number> = { 3: 8, 0: 5, 4: 9, 1: 6, 5: 3, 2: 7, 6: 4 };
  const trebleFlat: Record<number, number>  = { 6: 4, 2: 7, 5: 3, 1: 6, 4: 8, 0: 5, 3: 1 };
  const bassSharp: Record<number, number>   = { 3: 6, 0: 3, 4: 7, 1: 4, 5: 8, 2: 5, 6: 2 };
  const bassFlat: Record<number, number>    = { 6: 2, 2: 5, 5: 1, 1: 4, 4: 0, 0: 3, 3: 6 };
  const map = piece.clef === 'treble'
    ? (isSharp ? trebleSharp : trebleFlat)
    : (isSharp ? bassSharp : bassFlat);

  let s = '';
  let x = layout.keyStartX;
  for (const letter of letters) {
    const step = map[letter] ?? 4;
    // 实测：sharp baseline 在中心(ascent=descent)，直接压在目标 y；
    //        flat baseline 偏上(中心约 baseline-0.5ss)，下移 0.5ss 让中心对齐目标。
    const y = stepToY(step, layout) + (isSharp ? 0 : ss * 0.5);
    const glyph = isSharp ? G.accidentalSharp : G.accidentalFlat;
    s += text(glyph, x, y, fs);
    x += ss * 0.95;   // 与 layout.KEY_PER_GLYPH 一致：渲染步进 = 布局预留宽度，防溢出重叠
  }
  return s;
}

/** 拍号。实测 timeSig 数字字形 ascent≈descent≈1ss，即 baseline 在数字垂直中心。
 *  标准 4/4：两数字关于中线 B4 对称，各偏离 1ss（上数字中心在第4间、下数字中心在第2间）。 */
function renderTimeSignature(piece: Piece, layout: Layout): string {
  const fs = layout.fontSize;
  const { timeSigX } = layout;
  const ss = layout.staffSpace;
  const midY = stepToY(4, layout); // 中线 B4
  // y 向下增大：上数字中心在中线上方(midY-ss)，下数字在中线下方(midY+ss)。baseline=中心。
  return text(G.timeSig(piece.time.num), timeSigX, midY - ss, fs)
       + text(G.timeSig(piece.time.den), timeSigX, midY + ss, fs);
}

/** 小节线 + 起始线。
 *  barLines[0] = contentLeft（第1小节起点，不画——标准乐谱拍号后无分隔线）；
 *  barLines[1..N-1] = 小节分隔线；barLines[N] = 末尾终止线。
 *  起始单线单独画在 staffLeftX（画布最左，谱号左侧），与终止线呼应。 */
function renderBarLines(layout: Layout): string {
  let s = '';
  const ss = layout.staffSpace;
  const thin = W_BARLINE * ss;
  const thick = W_BARLINE_FINAL * ss;
  // 起始单线（画布最左）
  s += line(layout.staffLeftX, layout.staffTop, layout.staffLeftX, layout.staffBottom, '#1f2430', thin);
  for (let i = 1; i < layout.barLines.length; i++) {
    const x = layout.barLines[i];
    const isLast = i === layout.barLines.length - 1;
    s += line(x, layout.staffTop, x, layout.staffBottom, '#1f2430', isLast ? thick : thin);
    if (isLast) {
      // 终止线：粗线左侧约 0.4ss 处的细线
      s += line(x - 0.75 * ss, layout.staffTop, x - 0.75 * ss, layout.staffBottom, '#1f2430', thin);
    }
  }
  return s;
}

/** 连梁上下文：组内每个音符渲染时传入，决定符干方向、对齐端点、是否画 flag。
 *  stemEndY 是符干应延伸到的最远端点 y —— 双梁时是外侧那根梁的位置，
 *  保证符干贯穿两根梁；单梁时就是梁本身的位置。 */
interface BeamCtx {
  stemDir: 'up' | 'down';
  stemEndY: number;
}

/** 计算单个音符的符干几何。无 beam 时按自身音高定方向与长度；有 beam 时对齐到组统一端点。 */
function computeStem(step: number, x: number, headHalfW: number, layout: Layout, beam: BeamCtx | undefined): {
  stemUp: boolean; stemW: number; stemX: number; stemTop: number; stemBot: number;
} {
  const ss = layout.staffSpace;
  const stemW = Math.max(1.5, W_STEM * ss);
  const inset = STEM_INSET * ss;
  const headY = stepToY(step, layout);
  if (beam) {
    const stemUp = beam.stemDir === 'up';
    const stemX = (stemUp ? x + headHalfW - stemW / 2 : x - headHalfW + stemW / 2) - inset;
    if (stemUp) {
      return { stemUp, stemW, stemX, stemTop: beam.stemEndY, stemBot: headY };
    } else {
      return { stemUp, stemW, stemX, stemTop: headY, stemBot: beam.stemEndY };
    }
  }
  // 无连梁：原有逻辑
  const stemUp = step <= 6;
  const stemX = (stemUp ? x + headHalfW - stemW / 2 : x - headHalfW + stemW / 2) - inset;
  const stemLen = ss * 3.5;   // 标准符干长 ≈ 3.5 线距(ss 现为线距)
  return {
    stemUp, stemW, stemX,
    stemTop: stemUp ? headY - stemLen : headY,
    stemBot: stemUp ? headY : headY + stemLen,
  };
}

/** 渲染单个音符（含符头、符干、符尾、加线、临时记号、附点）。
 *  beam 非空时：符干对齐组端点，且不画 flag（flag 由连梁代替）。 */
function renderNote(note: Note, x: number, piece: Piece, layout: Layout, highlight: boolean, beam?: BeamCtx): string {
  const fs = layout.fontSize;
  const ss = layout.staffSpace;
  let s = '';

  if (note.midi === null) {
    // 休止符
    const restY = (layout.staffTop + layout.staffBottom) / 2;
    const glyph = note.duration === 'whole' ? G.restWhole
      : note.duration === 'half' ? G.restHalf
      : note.duration === 'quarter' ? G.restQuarter
      : note.duration === 'eighth' ? G.rest8th
      : G.rest16th;
    s += text(glyph, x, restY + ss * 2, fs * 0.72);
    return s;
  }

  const pitch = resolvePitch(note.midi, piece.clef, piece.key, note.accidental);
  const step = pitch.step;
  const y = stepToY(step, layout);
  const fill = highlight ? '#4f46e5' : '#1f2430';

  // 加线（超出五线谱范围）
  if (step > 8) {
    for (let st = 10; st <= step; st += 2) {
      const ly = stepToY(st, layout);
      s += line(x - ss * 1.7, ly, x + ss * 1.7, ly, '#1f2430', W_LEDGER * ss);
    }
  } else if (step < 0) {
    for (let st = -2; st >= step; st -= 2) {
      const ly = stepToY(st, layout);
      s += line(x - ss * 1.7, ly, x + ss * 1.7, ly, '#1f2430', W_LEDGER * ss);
    }
  }

  // 符头墨迹半宽（用 SMuFL advance 的一半）：noteheadBlack/Half ≈ 1.18ss
  const headHalfW = (note.duration === 'whole' ? advanceSS('noteheadWhole') : advanceSS('noteheadBlack')) / 2 * ss;

  // 临时记号（符头左侧）
  const accHalfW = (pitch.accidental === 'sharp' ? advanceSS('accidentalSharp')
    : pitch.accidental === 'flat' ? advanceSS('accidentalFlat')
    : advanceSS('accidentalNatural')) / 2 * ss;
  const accX = x - headHalfW - accHalfW - ss * 0.4;
  if (pitch.accidental === 'sharp') s += text(G.accidentalSharp, accX, y, fs * 0.62);
  else if (pitch.accidental === 'flat') s += text(G.accidentalFlat, accX, y, fs * 0.62);
  else if (pitch.accidental === 'natural') s += text(G.accidentalNatural, accX, y, fs * 0.62);

  // 符头
  const headGlyph = note.duration === 'whole' ? G.noteheadWhole
    : note.duration === 'half' ? G.noteheadHalf
    : G.noteheadBlack;
  s += text(headGlyph, x, y, fs, { fill });

  // 符干 + 符尾（whole 无）
  if (note.duration !== 'whole') {
    const { stemUp, stemW, stemX, stemTop, stemBot } = computeStem(step, x, headHalfW, layout, beam);
    s += rect(stemX, stemTop, stemW, stemBot - stemTop, { fill });
    // 符尾：只有未连梁的八分/十六分才画 flag（连梁的由横梁代替）
    if (!beam && (note.duration === 'eighth' || note.duration === 'sixteenth')) {
      const flagGlyph = note.duration === 'eighth'
        ? (stemUp ? G.flag8thUp : G.flag8thDown)
        : (stemUp ? G.flag16thUp : G.flag16thDown);
      const flagY = stemUp ? stemTop : stemBot;
      s += text(flagGlyph, stemX + stemW / 2, flagY, fs, { fill, anchor: 'start' });
    }
  }

  // 附点
  if (note.dotted) {
    s += text(G.augmentationDot, x + ss * 2.4, y, fs * 0.55, { fill });
  }

  return s;
}

/** 下一个待输入位置的圆角矩形指示器（短信验证码式）。宽度随时值变化；写满则不显示。
 *  填充透明度由 CSS 动画驱动（0.2↔0.5），边框保持不透明。 */
function renderNextSlot(layout: Layout): string {
  if (layout.isFull) return '';
  const w = Math.min(layout.nextSlotW, layout.staffSpace * 6);
  const h = (layout.staffBottom - layout.staffTop) + layout.staffSpace;
  const x = layout.nextSlotX - w / 2;
  const y = layout.staffTop - layout.staffSpace / 2;
  return rect(x, y, w, h, { fill: '#4f46e5', stroke: '#4f46e5', sw: 1.8, rx: 7, class: 'next-slot' });
}

/** 悬停 ghost 音符（预览即将输入的音） */
function renderHover(input: RenderInput, layout: Layout): string {
  if (!input.hover) return '';
  const { midi, x } = input.hover;
  const ss = layout.staffSpace;
  // y 由 midi → step
  const step = midiStep(midi, input.piece);
  const y = stepToY(step, layout);
  const glyph = input.piece.notes.length >= 0 ? G.noteheadBlack : G.noteheadBlack;
  // 用半透明音符头 + 一条贯穿的细辅助线
  let s = '';
  s += line(layout.barLines[0], y, layout.barLines[layout.barLines.length - 1], y, '#a5b4fc', 3, { class: 'hover-guide' });
  s += text(glyph, x, y, layout.fontSize, { fill: '#a5b4fc', class: 'hover-note' });
  void ss;
  return s;
}

/** midi → step（用于 hover） */
function midiStep(midi: number, piece: Piece): number {
  const p = resolvePitch(midi, piece.clef, piece.key, null);
  return p.step;
}

/** 计算并渲染连梁：返回「音符索引 → BeamCtx」映射，供 renderNote 对齐符干。
 *  几何规则（倾斜梁）：
 *    - 组内统一方向 = 组平均 step ≤ 6（中线 B4）→ up，否则 down
 *    - 首尾两端各自的梁 y：由首/末符头按标准长度 ss*7 算端点，首端取「最远」端点，
 *      斜率 dy = 末端端点 − 首端端点，封顶在 ±MAX_BEAM_SLOPE*ss（一个三度）
 *    - 最短符干约束：首尾任一端符干 < STEM_MIN_BEAM*ss 时整体平移补偿
 *    - 边界 clamp：首尾 y 各自 clamp 到谱表上下界内（可能改变 dy，边界优先）
 *    - 中间符干顶端沿首尾连线线性插值
 *    - level=double 画两根平行斜梁，第二根朝外平移 BEAM_GAP*ss，符干贯穿两根 */
function renderBeams(groups: BeamGroup[], piece: Piece, layout: Layout): { svg: string; ctxByIdx: Map<number, BeamCtx> } {
  const ss = layout.staffSpace;
  const ctxByIdx = new Map<number, BeamCtx>();
  let svg = '';
  const stemW = Math.max(1.5, W_STEM * ss);
  const headHalfW = advanceSS('noteheadBlack') / 2 * ss;

  for (const g of groups) {
    // 收集组内 step 与符头 y
    const steps: number[] = [];
    const headYs: number[] = [];
    const stemXs: number[] = [];
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      const note = piece.notes[i];
      if (note.midi === null) continue;
      const step = resolvePitch(note.midi, piece.clef, piece.key, note.accidental).step;
      steps.push(step);
      headYs.push(stepToY(step, layout));
      // 暂用 up 方向算 stemX（x 对齐用），方向定后不依赖此值
      const x = layout.noteX[i];
      stemXs.push(x + headHalfW - stemW / 2);
    }
    if (steps.length < 2) continue;

    const avgStep = steps.reduce((a, b) => a + b, 0) / steps.length;
    const stemDir: 'up' | 'down' = avgStep <= 6 ? 'up' : 'down';

    // ── 倾斜梁几何：首尾两端各自的 y，中间符干对齐首尾连线 ──
    const stdLen = ss * 3.5;
    const isDouble = g.level === 'double';
    // 标准端点：每个符头按 ss*7 算（up 端点在符头上方，down 在下方）
    const endAt = (hy: number) => stemDir === 'up' ? hy - stdLen : hy + stdLen;
    const end0 = endAt(headYs[0]);
    const endN = endAt(headYs[headYs.length - 1]);
    // 斜率：首尾端点差，封顶在 ±MAX_BEAM_SLOPE*ss（一个三度），超过削平
    const maxSlope = MAX_BEAM_SLOPE * ss;
    let dy = Math.max(-maxSlope, Math.min(maxSlope, endN - end0));
    // 首端取「最远」端点（保留水平梁时的逻辑：保证最短符干的一端也够长）。
    // 倾斜下改为：首端 beamY1 = 首尾标准端点中「最远」的那个，末端 = 首端 + dy。
    let beamY1 = stemDir === 'up' ? Math.min(end0, endN) : Math.max(end0, endN);
    let beamY2 = beamY1 + dy;

    // 最短符干约束：首尾两端任一符干 < STEM_MIN_BEAM*ss → 整体平移补偿
    const minLen = STEM_MIN_BEAM * ss;
    if (stemDir === 'up') {
      // 首尾符头到梁的距离 = headY - beamY，取两端最小者
      const shortBy = Math.min(headYs[0] - beamY1, headYs[headYs.length - 1] - beamY2);
      if (shortBy < minLen) {
        const shift = minLen - shortBy; // 梁需往上移 shift
        beamY1 -= shift; beamY2 -= shift;
      }
    } else {
      const shortBy = Math.min(beamY1 - headYs[0], beamY2 - headYs[headYs.length - 1]);
      if (shortBy < minLen) {
        const shift = minLen - shortBy;
        beamY1 += shift; beamY2 += shift;
      }
    }

    // 边界 clamp：保留倾斜斜率。若任一端超出边界，整体平移让「最远端」贴界，
    // 另一端 = 贴界端 + dy，从而保留斜率（而不是两端各自 clamp 抹平成水平）。
    // 双梁阈值减 gap（副梁更靠外）。
    const overhang = (BEAM_OVERHANG - (isDouble ? BEAM_GAP : 0)) * ss;
    const beamMinY = layout.staffTop - overhang;
    const beamMaxY = layout.staffBottom + overhang;
    if (stemDir === 'up') {
      // 朝上：梁在符头上方，y 小的端更靠外。取两端最小值看是否越界。
      const outerY = Math.min(beamY1, beamY2);
      if (outerY < beamMinY) {
        const shift = beamMinY - outerY; // 整体下移
        beamY1 += shift; beamY2 += shift;
      }
    } else {
      const outerY = Math.max(beamY1, beamY2);
      if (outerY > beamMaxY) {
        const shift = outerY - beamMaxY; // 整体上移
        beamY1 -= shift; beamY2 -= shift;
      }
    }
    // 重新算实际 dy（clamp 后）
    dy = beamY2 - beamY1;

    // 每个音符的符干端点：沿首尾连线线性插值。t = 该音符在组内的位置比例。
    // 双梁时符干延伸到外侧梁（朝上取减 gap，朝下取加 gap），保证贯穿两根。
    const n = steps.length;
    for (let k = 0; k < n; k++) {
      const i = g.startIdx + k;
      const x = layout.noteX[i];
      const t = n === 1 ? 0 : k / (n - 1);
      const mainBeamYatK = beamY1 + dy * t;       // 第一根梁在该音符处的 y
      const outerBeamYatK = isDouble
        ? (stemDir === 'up' ? mainBeamYatK - BEAM_GAP * ss : mainBeamYatK + BEAM_GAP * ss)
        : mainBeamYatK;
      ctxByIdx.set(i, { stemDir, stemEndY: outerBeamYatK });
      stemXs[k] = (stemDir === 'up' ? x + headHalfW - stemW / 2 : x - headHalfW + stemW / 2) - STEM_INSET * ss;
    }

    // 画横梁：x 范围覆盖首尾符干的全宽（左边缘→右边缘），保证梁盖住符干顶端，
    // 不让符干从梁的斜边旁露出来。双梁画两根，第二根两端 y 朝外平移 BEAM_GAP*ss。
    const x1 = stemXs[0];                      // 首符干左边缘
    const x2 = stemXs[n - 1] + stemW;          // 末符干右边缘
    const thick = BEAM_THICKNESS * ss;
    svg += drawBeam(x1, beamY1, x2, beamY2, thick);
    if (isDouble) {
      const off = BEAM_GAP * ss;
      svg += drawBeam(x1, beamY1 - (stemDir === 'up' ? off : -off),
                      x2, beamY2 - (stemDir === 'up' ? off : -off), thick);
    }
  }

  return { svg, ctxByIdx };
}

/** 画一根横梁：倾斜平行四边形。(x1,y1) 是首端梁中心、(x2,y2) 是末端梁中心，
 *  thick 是梁厚度。两端以各自 y 为中心上下各 thick/2，形成平行四边形（两端切口竖直）。 */
function drawBeam(x1: number, y1: number, x2: number, y2: number, thick: number): string {
  const half = thick / 2;
  const pts: [number, number][] = [
    [x1, y1 - half], [x2, y2 - half], // 上边：首→末
    [x2, y2 + half], [x1, y1 + half], // 下边：末→首
  ];
  return polygon(pts, { fill: '#1f2430' });
}

/** 主渲染：返回 SVG 内部内容（不含 <svg> 标签） */
export function renderStaffSVG(input: RenderInput): string {
  const { piece, layout, playingIndex } = input;
  let s = '';
  s += renderStaffLines(layout);
  s += renderClef(piece, layout);
  s += renderKeySignature(piece, layout);
  s += renderTimeSignature(piece, layout);
  s += renderBarLines(layout);
  s += renderNextSlot(layout);
  s += renderHover(input, layout);
  // 连梁：先算几何，画横梁（置于音符符头之下，符干之上 → 渲染顺序：梁先画，后画符头/符干会盖住梁端）
  // 但符干需要在梁之上（符干顶端连到梁）。采用顺序：先画梁，再画音符；音符的符干会从符头画到 beamY，
  // 与梁重叠，视觉上符干接入梁。
  const { svg: beamSvg, ctxByIdx } = renderBeams(computeBeams(piece), piece, layout);
  s += beamSvg;
  for (let i = 0; i < piece.notes.length; i++) {
    s += renderNote(piece.notes[i], layout.noteX[i], piece, layout, i === playingIndex, ctxByIdx.get(i));
  }
  return s;
}

// ── 点击 → 音高 / x ─────────────────────────────────────────

/** 把点击的 y 坐标换算成 MIDI（吸附到最近线/间）。stepToY 的反函数（1 step = staffSpace/2） */
export function clickYToMidi(y: number, piece: Piece, layout: Layout): number {
  const step = Math.round((layout.bottomLineY - y) / (layout.staffSpace / 2));
  return staffStepToMidi(piece.clef, step);
}
