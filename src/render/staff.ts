// 五线谱渲染：谱号、调号、拍号、小节线、音符、下一个待输入位置的圆角矩形指示器

import { Piece, Note } from '../core/types';
import { staffStepToMidi, resolvePitch } from '../core/theory';
import { Layout } from './layout';
import { G, advanceSS } from './glyphs';
import { computeBeams, BeamGroup, beamCountForNote } from './beam';
import { tupletGroups, chordGroups, isChordTail } from '../core/model';

// 连梁几何常量（单位 staff space）
const BEAM_THICKNESS = 0.5;   // 单根横梁厚度（SMuFL beamThickness）
const BEAM_GAP = 0.75;        // 双横梁中心距 = beamThickness(0.5) + beamSpacing(0.25)（SMuFL）
const STEM_MIN_BEAM = 3;      // 连梁时符干最短长度，避免梁贴着符头
const BEAM_OVERHANG = 3.5;    // 横梁允许超出五线谱顶/底线的距离（staff space）
                                  // 需 ≥ stdLen(3.5ss) 朝上/朝下符干伸展空间，否则 clamp 会压短符干
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

/** SVG 路径：连音线(tie)弧线等用。d 为 path data 字符串。 */
function path(d: string, opts: { fill?: string; stroke?: string; sw?: number; class?: string } = {}): string {
  const fill = opts.fill ?? 'none';
  const stroke = opts.stroke ? ` stroke="${opts.stroke}"` : '';
  const sw = opts.sw !== undefined ? ` stroke-width="${opts.sw}"` : '';
  const cls = opts.class ? ` class="${opts.class}"` : '';
  return `<path d="${d}" fill="${fill}"${stroke}${sw}${cls}/>`;
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
    // 调号用 accidentalFlat/accidentalSharp(单字形)。sharp 上下对称(中心偏移≈0)直接对齐；
    // flat 不对称(墨迹质心在 baseline 上方 0.37ss,几何中心 0.53ss),
    // 用质心偏移 0.37ss 下移让视觉重心对齐目标线/间(用几何中心会偏下)。
    const off = isSharp ? 0 : 0.15;   // flat 偏移,经多轮视觉微调定为0.15ss
    const y = stepToY(step, layout) + off * ss;
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
  // 小节线/起始线/终止线延伸半个五线谱线宽，覆盖到最外线墨迹边缘（否则视觉上比五线谱短）
  const barTop = layout.staffTop - W_STAFF * ss / 2;
  const barBot = layout.staffBottom + W_STAFF * ss / 2;
  // 起始单线（画布最左）
  s += line(layout.staffLeftX, barTop, layout.staffLeftX, barBot, '#1f2430', thin);
  for (let i = 1; i < layout.barLines.length; i++) {
    const x = layout.barLines[i];
    const isLast = i === layout.barLines.length - 1;
    s += line(x, barTop, x, barBot, '#1f2430', isLast ? thick : thin);
    if (isLast) {
      // 终止线：粗线左侧约 0.4ss 处的细线
      s += line(x - 0.75 * ss, barTop, x - 0.75 * ss, barBot, '#1f2430', thin);
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
 *  - beam 非空时：符干对齐组端点，且不画 flag（flag 由连梁代替）。
 *  - isChordTail=true 时：和弦尾音只画符头,不画符干/flag(符干由组首音贯穿全组承担)。
 *  - chordStemHandled=true 时(和弦首音且不在连梁里)：符干由 renderChordStems 统一画,这里跳过。
 *    和弦首音在连梁里时,符干由 renderBeams 按代表 step 处理,chordStemHandled=false,正常走 stemCtx。 */
function renderNote(note: Note, x: number, piece: Piece, layout: Layout, highlight: boolean, beam: BeamCtx | undefined, isChordTail: boolean, chordStemHandled: boolean): string {
  const fs = layout.fontSize;
  const ss = layout.staffSpace;
  let s = '';

  if (note.midi === null) {
    // 休止符：用全字号(标准比例)，基线按字形分类对齐
    // 全/二分休止符挂第4线(step6)；四分及以下垂直居中于第3间(step4)附近
    const midY = stepToY(4, layout);   // 中线 B4
    const line4Y = stepToY(6, layout); // 第4线(从下数第4线=D5)
    const glyph = note.duration === 'whole' ? G.restWhole
      : note.duration === 'half' ? G.restHalf
      : note.duration === 'quarter' ? G.restQuarter
      : note.duration === 'eighth' ? G.rest8th
      : note.duration === 'sixteenth' ? G.rest16th
      : G.rest32nd;
    // baseline 位置：全休止符(挂在第4线下方,baseline≈line4Y)；二分(挂第4线上方,baseline≈line4Y+ss*0.5)；
    // 四分(中心居中,baseline=midY)；八分/十六分/三十二分(baseline偏下让中心居中)
    const baseline = note.duration === 'whole' ? line4Y
      : note.duration === 'half' ? line4Y + ss * 0.5
      : note.duration === 'quarter' ? midY
      : midY + ss * 0.3;   // 八分及以下字形 baseline 偏上,下移让视觉居中
    s += text(glyph, x, baseline, fs);
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
      s += line(x - ss * 1.15, ly, x + ss * 1.15, ly, '#1f2430', W_LEDGER * ss);  // 加线:符头半宽0.59+延伸0.56≈1.15ss
    }
  } else if (step < 0) {
    for (let st = -2; st >= step; st -= 2) {
      const ly = stepToY(st, layout);
      s += line(x - ss * 1.15, ly, x + ss * 1.15, ly, '#1f2430', W_LEDGER * ss);  // 加线:符头半宽0.59+延伸0.56≈1.15ss
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

  // 符干 + 符尾（whole 无符干；和弦尾音无符干——由组首音贯穿全组；
  //  和弦首音非连梁时也无符干——由 renderChordStems 统一画贯穿全组的符干。
  //  例外:和弦尾音若在连梁里(beam 存在),每个声部都需符干连到梁 → 仍画符干。)
  const drawStem = note.duration !== 'whole'
    && !(isChordTail && !beam)         // 非连梁和弦尾音:不画
    && !(chordStemHandled);            // 和弦首音非连梁:符干由 renderChordStems 画
  if (drawStem) {
    const { stemUp, stemW, stemX, stemTop, stemBot } = computeStem(step, x, headHalfW, layout, beam);
    s += rect(stemX, stemTop, stemW, stemBot - stemTop, { fill });
    // 符尾：只有未连梁、且非和弦尾音的八分/十六分/三十二分才画 flag
    // (和弦首音若不连梁且是八分及下面,flag 由 renderChordStems 画)
    if (!beam && (note.duration === 'eighth' || note.duration === 'sixteenth' || note.duration === 'thirtysecond')) {
      const flagGlyph = note.duration === 'eighth'
        ? (stemUp ? G.flag8thUp : G.flag8thDown)
        : note.duration === 'sixteenth'
        ? (stemUp ? G.flag16thUp : G.flag16thDown)
        : (stemUp ? G.flag32ndUp : G.flag32ndDown);
      const flagY = stemUp ? stemTop : stemBot;
      s += text(flagGlyph, stemX + stemW / 2, flagY, fs, { fill, anchor: 'start' });
    }
  }

  // 附点
  if (note.dotted) {
    s += text(G.augmentationDot, x + ss * 1.7, y, fs, { fill });  // 全字号(0.4ss直径),x偏移1.7ss(符头右侧)
  }

  return s;
}

/** 下一个待输入位置的圆角矩形指示器（短信验证码式）。宽度随时值变化；写满则不显示。
 *  无填充，仅边框做呼吸动画（stroke-opacity 由 CSS 驱动）。 */
function renderNextSlot(layout: Layout): string {
  if (layout.isFull) return '';
  const w = Math.min(layout.nextSlotW, layout.staffSpace * 6);
  const h = (layout.staffBottom - layout.staffTop) + layout.staffSpace;
  const x = layout.nextSlotX - w / 2;
  const y = layout.staffTop - layout.staffSpace / 2;
  return rect(x, y, w, h, { fill: 'none', stroke: '#4f46e5', sw: 1.5, rx: 7, class: 'next-slot' });
}

/** 悬停 ghost 音符（预览即将输入的音）。当音超出五线谱范围时，联动指示对应加线。 */
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
  s += line(layout.barLines[0], y, layout.barLines[layout.barLines.length - 1], y, '#a5b4fc', 1, { class: 'hover-guide' });
  // 联动加线指示：音超出五线谱时，用指示色画出对应加线
  // (do=C4 step-2 及更低 → 下加线 / 高音6=A5 step10 及更高 → 上加线)
  const acc = '#a5b4fc';
  if (step > 8) {
    for (let st = 10; st <= step; st += 2) {
      const ly = stepToY(st, layout);
      s += line(x - ss * 1.15, ly, x + ss * 1.15, ly, acc, W_LEDGER * ss, { class: 'hover-guide' });
    }
  } else if (step < 0) {
    for (let st = -2; st >= step; st -= 2) {
      const ly = stepToY(st, layout);
      s += line(x - ss * 1.15, ly, x + ss * 1.15, ly, acc, W_LEDGER * ss, { class: 'hover-guide' });
    }
  }
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
 *  采用「梁容量」模型：每个音符按 duration 有容量（eighth=1 / sixteenth=2 / thirtysecond=3）。
 *
 *  梁层级（从外往内编号 j=1..maxCount），遵循标准记谱法（primary beam 在最外侧）：
 *    - 第 1 根 = primary（主梁）：离符头最远、最外侧，贯穿整组首尾不断。
 *    - 第 j≥2 根 = secondary（次梁/三梁）：越靠内越短，只在「相邻两音容量都 ≥j」的连续段画。
 *  这样主梁最长（贯穿），次梁在更短时值处出现并更靠内 —— 读时值靠数每根符干连了几根梁。
 *
 *  几何规则（倾斜 primary 梁）：
 *    - 组内统一方向 = 组平均 step ≤ 6（中线 B4）→ up，否则 down
 *    - primary 首尾 y：由首/末符头按标准长度 ss*7 算端点，首端取「最远」端点，
 *      斜率 dy 封顶在 ±MAX_BEAM_SLOPE*ss（一个三度）
 *    - 最短符干约束：仅检查 primary 首尾端符干 < STEM_MIN_BEAM*ss 时整体平移补偿
 *    - 边界 clamp：primary 即最外侧梁，整组平移到谱表上下界内（overhang 固定，内侧梁更靠内不会越界）
 *    - 所有符干顶端都对齐到 primary（等长）—— 因 primary 是最外侧，符干必穿过内侧各次梁
 *    - 第 j≥2 根次梁 y = primary 在该 x 的 y + (j-1)*BEAM_GAP*ss 朝内偏移 */
function renderBeams(groups: BeamGroup[], piece: Piece, layout: Layout): { svg: string; ctxByIdx: Map<number, BeamCtx> } {
  const ss = layout.staffSpace;
  const ctxByIdx = new Map<number, BeamCtx>();
  let svg = '';
  const stemW = Math.max(1.5, W_STEM * ss);
  const headHalfW = advanceSS('noteheadBlack') / 2 * ss;
  const thick = BEAM_THICKNESS * ss;

  for (const g of groups) {
    // 收集组内「时间位首音」的原始数据。和弦首音代表整个和弦:收集组内所有声部 step。
    // 和弦尾音不在 BeamGroup 里(computeBeams 跳过了 tail),故无需在此处理。
    const idxs: number[] = [];        // 时间位首音索引
    const grpStepsArr: number[][] = []; // 每个时间位的全部声部 step(单音=[自身])
    const caps: number[] = [];         // beamCountForNote per 时间位首音
    const stemXs: number[] = [];       // 符干 x 占位(方向定后改写)
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      const note = piece.notes[i];
      if (note.midi === null) continue;
      // chordTail 不在 computeBeams 的分组判定里(computeBeams 跳过了它们),但 BeamGroup 范围
      // (startIdx..endIdx)仍覆盖它们(closeGroup 用循环变量 i)。这里再过滤一次:尾音是首音的
      // 声部之一,不应作为独立时间位处理——它们会在首音的 grp 收集里被包含。
      if (isChordTail(note, i > 0 ? piece.notes[i - 1] : null)) continue;
      idxs.push(i);
      caps.push(beamCountForNote(note.duration));
      let grp: number[];
      if (note.chordId) {
        grp = [];
        for (let k = i; k < piece.notes.length && piece.notes[k].chordId === note.chordId; k++) {
          const mk = piece.notes[k].midi;
          if (mk === null) continue;
          grp.push(resolvePitch(mk, piece.clef, piece.key, piece.notes[k].accidental).step);
        }
      } else {
        grp = [resolvePitch(note.midi, piece.clef, piece.key, note.accidental).step];
      }
      grpStepsArr.push(grp);
      const x = layout.noteX[i];
      stemXs.push(x + headHalfW - stemW / 2);
    }
    const n = idxs.length;
    if (n < 2) continue;

    // 方向:把所有时间位的全部声部 step 展平后取平均(和弦各声部都参与方向判定,符合标准记谱)
    const allSteps = grpStepsArr.flat();
    const avgStep = allSteps.reduce((a, b) => a + b, 0) / allSteps.length;
    const stemDir: 'up' | 'down' = avgStep <= 6 ? 'up' : 'down';
    // 每个时间位的代表 step + 符干连接端符头 y:
    //  up → 最高音(最大 step,最小 y);down → 最低音(最小 step,最大 y)
    const steps: number[] = [];
    const headYs: number[] = [];
    for (const grp of grpStepsArr) {
      const rep = stemDir === 'up' ? Math.max(...grp) : Math.min(...grp);
      steps.push(rep);
      headYs.push(stepToY(rep, layout));
    }

    const maxCount = g.maxBeamCount;

    // ── primary（第 1 根，最外侧）几何：首尾两端各自的 y ──
    // stdLen 用 ss*3.5：FONT=92 后 SS=23，物理符干长度与五线谱比例匹配（原 ss*7 是 FONT 未翻倍时的值）
    const stdLen = ss * 3.5;
    const endAt = (hy: number) => stemDir === 'up' ? hy - stdLen : hy + stdLen;
    const end0 = endAt(headYs[0]);
    const endN = endAt(headYs[n - 1]);
    const maxSlope = MAX_BEAM_SLOPE * ss;
    let dy = Math.max(-maxSlope, Math.min(maxSlope, endN - end0));
    // 首端取「最远」端点（primary 在最外侧），末端 = 首端 + dy
    let beamY1 = stemDir === 'up' ? Math.min(end0, endN) : Math.max(end0, endN);
    let beamY2 = beamY1 + dy;

    // 最短符干约束：仅检查 primary 首尾端，整体平移补偿
    const minLen = STEM_MIN_BEAM * ss;
    if (stemDir === 'up') {
      const shortBy = Math.min(headYs[0] - beamY1, headYs[n - 1] - beamY2);
      if (shortBy < minLen) { const shift = minLen - shortBy; beamY1 -= shift; beamY2 -= shift; }
    } else {
      const shortBy = Math.min(beamY1 - headYs[0], beamY2 - headYs[n - 1]);
      if (shortBy < minLen) { const shift = minLen - shortBy; beamY1 += shift; beamY2 += shift; }
    }

    // 边界 clamp：primary 即最外侧梁，整组平移到界内（内侧次梁更靠内不会越界，故 overhang 固定）
    const overhang = BEAM_OVERHANG * ss;
    const beamMinY = layout.staffTop - overhang;
    const beamMaxY = layout.staffBottom + overhang;
    if (stemDir === 'up') {
      const outerY = Math.min(beamY1, beamY2);
      if (outerY < beamMinY) { const shift = beamMinY - outerY; beamY1 += shift; beamY2 += shift; }
    } else {
      const outerY = Math.max(beamY1, beamY2);
      if (outerY > beamMaxY) { const shift = outerY - beamMaxY; beamY1 -= shift; beamY2 -= shift; }
    }
    dy = beamY2 - beamY1;

    // primary 在某音符（组内序号 k）处的 y：沿首尾连线线性插值
    const primaryYAt = (k: number) => beamY1 + dy * (n === 1 ? 0 : k / (n - 1));
    // 朝内方向偏移系数：次梁比 primary 更靠近符头。up 时梁在上方，「内」= y 更大（往下）→ +1；
    // down 时梁在下方，「内」= y 更小（往上）→ -1。
    const inSign = stemDir === 'up' ? 1 : -1;
    const gap = BEAM_GAP * ss;

    // 每个音符的符干端点都对齐到 primary（最外侧）→ 组内符干等长；
    // 同时确定每个符干的正确 x（含方向偏移与 inset）。
    for (let k = 0; k < n; k++) {
      const i = idxs[k];
      ctxByIdx.set(i, { stemDir, stemEndY: primaryYAt(k) });
      const x = layout.noteX[i];
      stemXs[k] = (stemDir === 'up' ? x + headHalfW - stemW / 2 : x - headHalfW + stemW / 2) - STEM_INSET * ss;
    }

    // primary 首尾两端的 x（必须在符干 x 确定后取，否则用的是占位值）
    const x1 = stemXs[0];
    const x2 = stemXs[n - 1] + stemW;
    // primary 线在任意 x 处的 y（按首尾端点线性插值，供短桩两端跟随主梁斜率，使短桩与主梁平行）
    const primaryLineY = (x: number) => beamY1 + dy * (x - x1) / (x2 - x1);

    // ── 画梁 ──
    // 第 1 根（primary，最外侧）贯穿整组首尾。
    // 第 j≥2 根（次梁，朝内偏移 (j-1)*BEAM_GAP*ss）：
    //   - 相邻两音都容量 ≥j → 连成一段（贯穿这些音）。
    //   - 容量 ≥j 但左右邻居都连不上该梁的「孤立」音 → 画一根短桩（stub），从符干伸出一个
    //     符头宽度，让读者能识别它是更短时值（如 16-8-16 两端的十六分各有一小段次梁）。
    //     短桩两端跟随 primary 主梁斜率（用 primaryLineY），与主梁平行。
    //     短桩朝向：朝相邻同组音的方向（右优先）；组末孤立音朝左。
    svg += drawBeam(x1, beamY1, x2, beamY2, thick);
    const stubLen = headHalfW * 2; // 短桩长度 ≈ 一个符头宽
    for (let level = 2; level <= maxCount; level++) {
      const off = (level - 1) * gap * inSign;
      const inBeam = (k: number) => caps[k] >= level;          // 该音是否参与第 level 梁
      const linkedRight = (k: number) => k < n - 1 && inBeam(k) && inBeam(k + 1); // 与右邻连该梁
      // 先画「连续段」：相邻参与音合并贯穿
      let segStart = -1;
      for (let k = 0; k < n; k++) {
        if (linkedRight(k)) {
          if (segStart < 0) segStart = k;
        } else {
          if (segStart >= 0) {
            // 段 segStart..k（含两端）画一根第 level 梁
            const yA = primaryYAt(segStart) + off;
            const yB = primaryYAt(k) + off;
            svg += drawBeam(stemXs[segStart], yA, stemXs[k] + stemW, yB, thick);
            segStart = -1;
          }
        }
      }
      // 再补「孤立短桩」：参与该梁但左右都没连上的音
      for (let k = 0; k < n; k++) {
        if (!inBeam(k)) continue;
        if (linkedRight(k)) continue;            // 已在连续段里
        if (k > 0 && inBeam(k - 1)) continue;    // 左邻参与 → 已被左侧连续段覆盖
        // 孤立参与音：画短桩，两端跟随 primary 斜率
        if (k < n - 1) {
          const sx0 = stemXs[k];
          const sx1 = stemXs[k] + stubLen;
          svg += drawBeam(sx0, primaryLineY(sx0) + off, sx1, primaryLineY(sx1) + off, thick);
        } else {
          const sx0 = stemXs[k] + stemW - stubLen;
          const sx1 = stemXs[k] + stemW;
          svg += drawBeam(sx0, primaryLineY(sx0) + off, sx1, primaryLineY(sx1) + off, thick);
        }
      }
    }
  }

  // 和弦尾音在连梁里时也需要符干(每个声部一根连到梁)。computeBeams 跳过了 tail,
  // 故 ctxByIdx 只含首音。把每个和弦首音的 ctx 复制给它同组的所有尾音(同时间位、同梁 y)。
  for (const [i, ctx] of ctxByIdx) {
    const head = piece.notes[i];
    if (!head.chordId) continue;
    for (let k = i + 1; k < piece.notes.length && piece.notes[k].chordId === head.chordId; k++) {
      if (!ctxByIdx.has(k)) ctxByIdx.set(k, ctx);
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

/** 渲染连音线(tie):按「时间位」(单音或和弦组)分组,在相邻两个时间位之间,
 *  对每个 tieStart(前位)↔ tieEnd(后位)且同音高的声部配对画弧线。
 *  这样和弦内部相邻声部(同时间位)不会误判为 tie。
 *  弧线从左符头右边缘连到右符头左边缘，凸向远离符干的一侧（标准记谱：符头在弧线凹侧）。
 *  - 符干朝上(step<=6)→ 弧线在符头下方，朝下凸
 *  - 符干朝下(step>6)→ 弧线在符头上方，朝上凸
 *  用二次贝塞尔 Q：两端 y = 符头 y + ε 偏移到符头外侧，控制点 y 再凸出 bowH。 */
function renderTies(piece: Piece, layout: Layout): string {
  const ss = layout.staffSpace;
  const notes = piece.notes;
  const headHalfW = advanceSS('noteheadBlack') / 2 * ss;
  let s = '';

  // 画单根 tie 弧线:从 (xA,yA音高) 到 (xB,yB音高)
  const drawArc = (stepA: number, stepB: number, xA: number, xB: number) => {
    const yA = stepToY(stepA, layout);
    const yB = stepToY(stepB, layout);
    const x1 = xA + headHalfW * 0.85;
    const x2 = xB - headHalfW * 0.85;
    const mx = (x1 + x2) / 2;
    const stemUp = Math.min(stepA, stepB) <= 6;
    const sign = stemUp ? 1 : -1;
    const headHalfH = ss * 0.4;
    const gap = ss * 0.08;
    const yAend = yA + sign * (headHalfH + gap);
    const yBend = yB + sign * (headHalfH + gap);
    const bowH = ss * 1.1;
    const cy = (yAend + yBend) / 2 + sign * bowH;
    const d = `M ${x1.toFixed(1)} ${yAend.toFixed(1)} Q ${mx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${yBend.toFixed(1)}`;
    s += path(d, { stroke: '#1f2430', sw: Math.max(1.4, ss * 0.18), fill: 'none' });
  };

  // 把 notes 切成「时间位」段:连续同 chordId 的音归一段;无 chordId 的单音自成一段。
  // 每段 [startIdx, endIdx]。
  const slots: [number, number][] = [];
  let i = 0;
  while (i < notes.length) {
    const cid = notes[i].chordId;
    let j = i;
    if (cid) {
      while (j < notes.length && notes[j].chordId === cid) j++;
    } else {
      j = i + 1;
    }
    slots.push([i, j - 1]);
    i = j;
  }

  // 遍历相邻时间位对,找 tieStart(前位声部)↔ tieEnd(后位声部)且同 midi 配对画弧
  for (let si = 0; si < slots.length - 1; si++) {
    const [a0, a1] = slots[si];
    const [b0, b1] = slots[si + 1];
    // 收集前位中标记 tieStart 的声部(按 midi 索引),后位中标记 tieEnd 的声部
    for (let ai = a0; ai <= a1; ai++) {
      const a = notes[ai];
      if (!a.tieStart || a.midi === null) continue;
      // 在后位找同 midi 且 tieEnd 的声部
      for (let bi = b0; bi <= b1; bi++) {
        const b = notes[bi];
        if (!b.tieEnd || b.midi === null) continue;
        if (a.midi !== b.midi) continue;
        const stepA = resolvePitch(a.midi, piece.clef, piece.key, a.accidental).step;
        const stepB = resolvePitch(b.midi, piece.clef, piece.key, b.accidental).step;
        drawArc(stepA, stepB, layout.noteX[ai], layout.noteX[bi]);
        break;   // 一个 tieStart 声部只配一个 tieEnd
      }
    }
  }
  return s;
}

/** 渲染连音组(tuplet)标记：每组上方画方括号 + 居中数字(actual，如三连音「3」)。
 *  bracket 顶部横线 + 两端短竖线，数字居中。y 在组内最高符头之上（避开符头/连梁）。 */
function renderTuplets(piece: Piece, layout: Layout, ctxByIdx: Map<number, BeamCtx>): string {
  const ss = layout.staffSpace;
  const groups = tupletGroups(piece);
  let s = '';
  const fs = ss * 2.6;                       // 数字字号（标准约 1.5-2 staff space 高）
  // 连梁候选时值（这些时值会被 computeBeams 连梁）
  const beamable = (d: Note['duration']) => d === 'eighth' || d === 'sixteenth' || d === 'thirtysecond';
  for (const g of groups) {
    // 组首末 x（含符头半宽，让标记略宽于音符）
    const headHalfW = advanceSS('noteheadBlack') / 2 * ss;
    const x1 = layout.noteX[g.startIdx] - headHalfW * 0.5;
    const x2 = layout.noteX[g.endIdx] + headHalfW * 0.5;
    // 组内最高符头 y（最小 y = 最靠上）→ 标记画在其上方
    let topY = Infinity;
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      const note = piece.notes[i];
      if (note.midi === null) continue;
      const step = resolvePitch(note.midi, piece.clef, piece.key, note.accidental).step;
      topY = Math.min(topY, stepToY(step, layout));
    }
    if (topY === Infinity) continue;
    const mx = (x1 + x2) / 2;
    // Gould《Behind Bars》：有连梁的连音组（八分/十六分/三十二分三连音）省略方括号，
    // 数字直接放梁上方；无连梁的组（如四分三连音）才画方括号 + 数字。
    const hasBeam = piece.notes.slice(g.startIdx, g.endIdx + 1).every(n => n.midi !== null && beamable(n.duration));
    if (!hasBeam) {
      // 无连梁：方括号 + 数字。bracket 横线在最高符头上方 2.4ss，数字在其上方。
      const markY = topY - ss * 2.4;
      const bracketH = ss * 0.7;
      const lw = Math.max(1.2, ss * 0.13);
      s += line(x1, markY, x2, markY, '#1f2430', lw);
      s += line(x1, markY, x1, markY + bracketH, '#1f2430', lw);
      s += line(x2, markY, x2, markY + bracketH, '#1f2430', lw);
      s += text(String(g.actual), mx, markY - ss * 0.4, fs, { fill: '#1f2430', anchor: 'middle' });
    } else {
      // 有连梁：只画数字，贴在 primary 梁上方。用 renderBeams 算出的真实 stemEndY
      // 数字居中在组中点 mx，其正下方的 primary 梁 y = 首末音 stemEndY 的中点
      // （primary 梁贯穿整组、斜率线性，首末端的 y 平均即中点 y，对任意音数精确）。
      const firstBeam = ctxByIdx.get(g.startIdx);
      const lastBeam = ctxByIdx.get(g.endIdx);
      if (firstBeam && lastBeam) {
        const beamMidY = (firstBeam.stemEndY + lastBeam.stemEndY) / 2;
        const stemDir = firstBeam.stemDir;
        const numY = stemDir === 'up' ? beamMidY - ss * 0.4 : beamMidY + ss * 0.4;
        s += text(String(g.actual), mx, numY, fs, { fill: '#1f2430', anchor: 'middle' });
      }
    }
  }
  return s;
}

/** 渲染和弦(chord)组的统一符干。每个和弦(2 音及以上、非全音符、且不在连梁里)画一根贯穿全组的符干:
 *  - 方向 = 组平均 step ≤ 6(中线 B4)→ up,否则 down(整组同向,符合标准记谱)
 *  - 符干一端连组内最极端符头(up=最高音/最小 y;down=最低音/最大 y),另一端延伸标准长度 ss*3.5
 *  - 符干 x 取组首音 noteX ± headHalfW(全组同 x)
 *  - 八分及以下时值,在符干端点画 flag(整组和弦共用一根 flag)
 *  返回 { svg, handled }:handled 为「符干已由此处处理的音符索引集」(= 组内所有非全音符音,无论是否在连梁里,
 *  连梁组的首/尾音代表 step 由 renderBeams 负责,这里不重复)。 */
function renderChordStems(piece: Piece, layout: Layout, beamIdx: Set<number>, playingChordId: string | undefined): { svg: string; handled: Set<number> } {
  const ss = layout.staffSpace;
  const fs = layout.fontSize;
  const groups = chordGroups(piece);
  let svg = '';
  const handled = new Set<number>();
  const stemW = Math.max(1.5, W_STEM * ss);
  const headHalfW = advanceSS('noteheadBlack') / 2 * ss;
  const stemLen = ss * 3.5;
  const inset = STEM_INSET * ss;

  for (const g of groups) {
    // 组内有效音(非休止)的 step;whole 时值不画符干
    const idxs: number[] = [];
    const steps: number[] = [];
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      const note = piece.notes[i];
      if (note.midi === null) continue;
      if (note.duration === 'whole') continue;
      idxs.push(i);
      steps.push(resolvePitch(note.midi, piece.clef, piece.key, note.accidental).step);
    }
    if (idxs.length < 2) continue;   // 单音和弦(实际是单音)交给 renderNote 正常画
    // 任一成员在连梁里 → 整组符干由 renderBeams 按代表 step 处理,跳过
    if (idxs.some(i => beamIdx.has(i))) continue;

    // 该组和弦正在播放 → 符干/符尾用高亮色,否则黑色
    const fill = (playingChordId && piece.notes[idxs[0]].chordId === playingChordId) ? '#4f46e5' : '#1f2430';
    const avgStep = steps.reduce((a, b) => a + b, 0) / steps.length;
    const stemUp = avgStep <= 6;
    const x = layout.noteX[idxs[0]];
    const stemX = (stemUp ? x + headHalfW - stemW / 2 : x - headHalfW + stemW / 2) - inset;
    // 符干要贯穿所有符头:竖线覆盖整个和弦的垂直跨度。
    // up: 底端=最低音符头(step最小,y最大),顶端=最高音符头 y - stemLen
    //      (顶端从最高音再往上延伸标准长度,竖线自然贯穿最低→最高→顶端)
    // down: 顶端=最高音符头(step最大,y最小),底端=最低音符头 y + stemLen
    const maxY = stepToY(Math.min(...steps), layout);   // 最低音 y 最大(最靠下)
    const minY = stepToY(Math.max(...steps), layout);   // 最高音 y 最小(最靠上)
    const stemTop = stemUp ? minY - stemLen : minY;
    const stemBot = stemUp ? maxY : maxY + stemLen;
    svg += rect(stemX, stemTop, stemW, stemBot - stemTop, { fill });

    // flag:整组和弦共用一根(取首音时值,组内一致)
    const dur = piece.notes[idxs[0]].duration;
    if (dur === 'eighth' || dur === 'sixteenth' || dur === 'thirtysecond') {
      const flagGlyph = dur === 'eighth'
        ? (stemUp ? G.flag8thUp : G.flag8thDown)
        : dur === 'sixteenth'
        ? (stemUp ? G.flag16thUp : G.flag16thDown)
        : (stemUp ? G.flag32ndUp : G.flag32ndDown);
      const flagY = stemUp ? stemTop : stemBot;
      svg += text(flagGlyph, stemX + stemW / 2, flagY, fs, { fill, anchor: 'start' });
    }
    // 标记组内所有音为「符干已处理」:首音(在主循环里 chordStemHandled=true),
    // 尾音在主循环里本就 isChordTail=true。这里把首音加入 handled(主循环查它)。
    handled.add(idxs[0]);
  }
  return { svg, handled };
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
  // 播放高亮:playingIndex 是当前时间位首音。若它在和弦组里,整组声部(符头+符干+符尾)都高亮。
  const playingChordId = (playingIndex >= 0 && playingIndex < piece.notes.length) ? piece.notes[playingIndex].chordId : undefined;
  // 和弦符干:连梁之后画(不和连梁和弦冲突),音符符头之前画(符头会盖住符干端)
  const beamIdx = new Set<number>(ctxByIdx.keys());
  const { svg: chordStemSvg, handled: chordHandled } = renderChordStems(piece, layout, beamIdx, playingChordId);
  s += chordStemSvg;
  for (let i = 0; i < piece.notes.length; i++) {
    const note = piece.notes[i];
    const prev = i > 0 ? piece.notes[i - 1] : null;
    const isChordTail = !!(note.chordId && prev?.chordId === note.chordId);
    const chordStemHandled = chordHandled.has(i);
    const highlight = playingChordId ? (note.chordId === playingChordId) : (i === playingIndex);
    s += renderNote(note, layout.noteX[i], piece, layout, highlight, ctxByIdx.get(i), isChordTail, chordStemHandled);
  }
  // 连音线(tie)：弧线画在符头之上，所以放在音符循环之后
  s += renderTies(piece, layout);
  // 连音组(tuplet)：方括号+数字画在最上层
  s += renderTuplets(piece, layout, ctxByIdx);
  return s;
}

// ── 点击 → 音高 / x ─────────────────────────────────────────

/** 把点击的 y 坐标换算成 MIDI（吸附到最近线/间）。stepToY 的反函数（1 step = staffSpace/2） */
export function clickYToMidi(y: number, piece: Piece, layout: Layout): number {
  const step = Math.round((layout.bottomLineY - y) / (layout.staffSpace / 2));
  return staffStepToMidi(piece.clef, step);
}
