// 五线谱渲染：谱号、调号、拍号、小节线、音符、下一个待输入位置的圆角矩形指示器

import { Piece, Note } from '../core/types';
import { staffStepToMidi, resolvePitch } from '../core/theory';
import { Layout } from './layout';
import { G, advanceSS } from './glyphs';

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

/** step（0=最下线，每步 1 个自然音级）→ y 坐标 */
function stepToY(step: number, layout: Layout): number {
  return layout.bottomLineY - step * layout.staffSpace;
}

// ── 组件渲染 ────────────────────────────────────────────────

function renderStaffLines(layout: Layout): string {
  let s = '';
  for (let i = 0; i < 5; i++) {
    const y = layout.staffTop + i * layout.staffSpace * 2;
    s += line(layout.barLines[0], y, layout.barLines[layout.barLines.length - 1], y, '#1f2430', 1.1);
  }
  return s;
}

/** 谱号。Bravura gClef 的「基准线锚点」对应 G4（高音谱号从下数第 2 条线）。
 *  我们把字符基线放到那条线上方一点，让谱号视觉上坐落在谱表上。 */
function renderClef(piece: Piece, layout: Layout): string {
  const fs = layout.fontSize;
  const { clefX } = layout;
  if (piece.clef === 'treble') {
    // 高音谱号：Bravura gClef 字形的基线放在「最上面那条线」附近时，
    // 它的卷曲中心会落在 G4（第 2 条线）上。经测试基线 ≈ topLine + 0.5ss。
    const y = layout.staffTop + layout.staffSpace * 0.5;
    return text(G.gClef, clefX, y, fs);
  } else {
    // 低音谱号 fClef：基线放在 F3（第 2 条线）附近
    const y = stepToY(2, layout) - layout.staffSpace * 0.5;
    return text(G.fClef, clefX, y, fs);
  }
}

/** 调号：升/降号依次排在谱号右侧。垂直位置遵循标准记谱约定（每个字母所在的线/间）。
 *  字母→相对于「最下线」的 step 映射，分高音/低音谱号。
 *  letters 存的是 0..6（C=0..B=6）的字母索引，已按升号或降号顺序。 */
function renderKeySignature(piece: Piece, layout: Layout): string {
  if (!layout.hasKey) return '';
  const fs = layout.fontSize * 0.7;
  const ss = layout.staffSpace;
  const letters = piece.key.sharps.length ? piece.key.sharps : piece.key.flats;
  const isSharp = piece.key.sharps.length > 0;

  // 标准调号位置（step，0=最下线）。
  // 升号顺序 F# C# G# D# A# E# B# ；降号顺序 Bb Eb Ab Db Gb Cb Fb
  // 字母索引：C=0 D=1 E=2 F=3 G=4 A=5 B=6
  const sharpOrder = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
  const flatOrder = [6, 2, 5, 1, 4, 0, 3];  // B E A D G C F

  // 高音谱号下各字母的「标准调号 step」（最下线 E4=0）
  // F5=8(顶线), C5=5, G5=9(上加间), D5=6, A4=3, E5=7(顶间), B4=4
  // 低音谱号下（最下线 G2=0）
  const stepMapTreble: Record<number, number> = { 0: 5, 1: 6, 2: 7, 3: 8, 4: 9, 5: 3, 6: 4 };
  // 实际上要按 sharpOrder/flatOrder 的标准位置：
  const trebleSharpStep: Record<number, number> = { 3: 8, 0: 5, 4: 9, 1: 6, 5: 3, 2: 7, 6: 4 }; // F C G D A E B
  const trebleFlatStep: Record<number, number> = { 6: 4, 2: 7, 5: 3, 1: 6, 4: 1, 0: 5, 3: 8 };   // B E A D G C F
  const bassSharpStep: Record<number, number> = { 3: 2, 0: 6, 4: 3, 1: 0, 5: 4, 2: 1, 6: 5 };     // 低音谱号下移
  const bassFlatStep: Record<number, number> = { 6: 5, 2: 1, 5: 4, 1: 0, 4: 3, 0: 2, 3: 6 };

  void sharpOrder; void flatOrder; void stepMapTreble;
  const map = piece.clef === 'treble'
    ? (isSharp ? trebleSharpStep : trebleFlatStep)
    : (isSharp ? bassSharpStep : bassFlatStep);

  let s = '';
  let x = layout.keyStartX;
  for (const letter of letters) {
    const step = map[letter] ?? 4;
    const y = stepToY(step, layout) + ss * 0.4;
    const glyph = isSharp ? G.accidentalSharp : G.accidentalFlat;
    s += text(glyph, x, y, fs);
    x += ss * 1.6;
  }
  return s;
}

/** 拍号 */
function renderTimeSignature(piece: Piece, layout: Layout): string {
  const fs = layout.fontSize;
  const { timeSigX } = layout;
  const topY = stepToY(2, layout) + layout.staffSpace * 0.5;
  const botY = stepToY(4, layout) - layout.staffSpace * 0.5;
  return text(G.timeSig(piece.time.num), timeSigX, topY, fs) + text(G.timeSig(piece.time.den), timeSigX, botY, fs);
}

/** 小节线 */
function renderBarLines(layout: Layout): string {
  let s = '';
  for (let i = 0; i < layout.barLines.length; i++) {
    const x = layout.barLines[i];
    const isLast = i === layout.barLines.length - 1;
    const isFirst = i === 0;
    const w = isLast ? 2.6 : 1.1;
    s += line(x, layout.staffTop, x, layout.staffBottom, '#1f2430', w);
    if (isLast) {
      // 终止线：细线 + 粗线
      s += line(x - 4, layout.staffTop, x - 4, layout.staffBottom, '#1f2430', 1.1);
    }
    if (isFirst) {
      // 起始单线
    }
  }
  return s;
}

/** 渲染单个音符（含符头、符干、符尾、加线、临时记号、附点） */
function renderNote(note: Note, x: number, piece: Piece, layout: Layout, highlight: boolean): string {
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
      s += line(x - ss * 1.7, ly, x + ss * 1.7, ly, '#1f2430', 1.2);
    }
  } else if (step < 0) {
    for (let st = -2; st >= step; st -= 2) {
      const ly = stepToY(st, layout);
      s += line(x - ss * 1.7, ly, x + ss * 1.7, ly, '#1f2430', 1.2);
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

  // 符干 + 符尾（whole 无）。符干方向：高于中线 → 朝下，否则朝上。
  if (note.duration !== 'whole') {
    const stemUp = step <= 6; // 中线及以下朝上
    const stemW = Math.max(1.5, ss * 0.17);
    // 符干贴住符头侧边
    const stemX = stemUp ? x + headHalfW - stemW / 2 : x - headHalfW + stemW / 2;
    // 标准符干长度 = 一个八度（3.5 线距 = 7 staff space）
    const stemLen = ss * 7;
    const stemTop = stemUp ? y - stemLen : y;
    const stemBot = stemUp ? y : y + stemLen;
    s += rect(stemX, stemTop, stemW, stemLen, { fill });
    // 符尾：锚定在符干末端
    if (note.duration === 'eighth' || note.duration === 'sixteenth') {
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
  const w = Math.min(layout.nextSlotW, layout.staffSpace * 12);
  const h = (layout.staffBottom - layout.staffTop) + layout.staffSpace * 2;
  const x = layout.nextSlotX - w / 2;
  const y = layout.staffTop - layout.staffSpace;
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
  for (let i = 0; i < piece.notes.length; i++) {
    s += renderNote(piece.notes[i], layout.noteX[i], piece, layout, i === playingIndex);
  }
  return s;
}

// ── 点击 → 音高 / x ─────────────────────────────────────────

/** 把点击的 y 坐标换算成 MIDI（吸附到最近线/间） */
export function clickYToMidi(y: number, piece: Piece, layout: Layout): number {
  const step = Math.round((layout.bottomLineY - y) / layout.staffSpace);
  return staffStepToMidi(piece.clef, step);
}
