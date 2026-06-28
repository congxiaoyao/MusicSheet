// 共享布局：统一坐标系。五线谱与简谱共用同一套 x 坐标与小节线。
//
// 水平布局（标准记谱：五线贯穿左右，谱号/调号/拍号叠加在线上）：
//   五线左端 staffLeftX                                    五线右端 contentRight
//   |  [谱号][调号][拍号]  | 小节1 | 小节2 | 小节3 | 小节4 |
//   ^^起始线(PAD_LEFT)     ^contentLeft(第一个小节内部起点/第一根小节分隔线)
//
// 小节内的音符：按「时值占比」分配宽度，每个音符居中在自己的时值格子里。
// 这样不论音符多寡、时值长短，都能均匀填满整个小节，不会有大段右侧留白。
// 下一个待输入位置的「格子宽度」也由当前时值决定 → 圆角框宽度随时值变化。

import { Piece, DurationValue, durationBeats, noteValueBeats } from '../core/types';
import { beatsPerBar } from '../core/types';
import { noteStartBeats, capacityBeats, measureOfBeat, totalBeats, computeMaxJianpuHeight } from '../core/model';
import { resolvePitch } from '../core/theory';
import { advanceSS } from './glyphs';

export interface Layout {
  width: number;
  height: number;
  fontSize: number;
  staffSpace: number;

  staffTop: number;
  staffBottom: number;
  bottomLineY: number;
  /** SVG viewBox 的 y 起点(0 或负值):极端高音时顶部向上扩展,viewBox 从负 y 起。
   *  staffTop/bottomLineY 是内部坐标(不变),viewBoxYOffset 让 viewBox 包含更高的符头。 */
  viewBoxYOffset: number;

  prefixRight: number;
  contentLeft: number;
  contentRight: number;
  contentWidth: number;
  /** 五条横线的最左端 x（= PAD_LEFT）。谱号/调号/拍号叠加在此区域内的线上。 */
  staffLeftX: number;

  clefX: number;
  keyStartX: number;
  timeSigX: number;
  hasKey: boolean;

  barLines: number[];
  /** 每个音符的中心 x */
  noteX: number[];
  /** 每个音符的格子宽度（供 staff.ts 画 stem/flag 对齐、jianpu 对齐用） */
  noteSlotW: number[];
  /** 下一个待输入位置：中心 x 与格子宽度 */
  nextSlotX: number;
  nextSlotW: number;
  /** 符头中心相对拍位起点的偏移(= 符头几何半宽 + 小节内 padding)。
   *  sms 待输入框宽 = 2*noteHeadHalf 时,框以 nextSlotX 为中心、左沿自动落在拍位起点(小节线)。 */
  noteHeadHalf: number;
  /** 是否已写满（写满后不显示指示器） */
  isFull: boolean;

  jianpuTop: number;
  jianpuBaseline: number;
  jianpuBottom: number;
}

// SMuFL 标准：1 em(font-size) = 4 staff space，staff space = 五线谱相邻两线的距离。
// 故 FONT = 4 × SS = 92，使字形按标准比例渲染。
const FONT = 46;   // 字号减半(原92):等比缩放五线谱,缓解16/32分音符横向拥挤
const SS = FONT / 4;   // = 23，真实 staff space（线间距）
// 小节内左留白:符头不贴小节线/拍位起点,留出舒适间距(传统乐谱式)。
// 这个 padding 同时是 sms 待输入框的左右内边距 —— 框宽 = 符头宽 + 2*NOTE_PAD,
// 框以 nextSlotX(=拍位起点+NOTE_HEAD_HALF)为中心居中,故框左沿自动落在拍位起点(小节线)。
const NOTE_PAD = 0.5 * SS;
// 符头中心相对拍位起点的偏移 = 符头几何半宽 + 小节内 padding。
// noteX = 拍位起点 + NOTE_HEAD_HALF。同 beat 起点的不同时值音符头中心严格垂直对齐。
const NOTE_HEAD_HALF = advanceSS('noteheadBlack') / 2 * SS + NOTE_PAD;
const PAD_LEFT = 8;    // 五线谱横线/起始线的左边缘(顶格,仅极小留白防贴死)
const PAD_RIGHT = 12;  // 随谱表等比缩小(原24)
const STAFF_TOP = 75;    // 谱表顶端y:字号减半后需容纳朝上符干(stdLen=3.5ss≈40px)+梁厚度+clamp阈值,原58导致梁被裁顶
// JIANPU_GAP = 34.5:默认简谱顶距 staffBottom。让默认 jianpuTop = 121+34.5 = 155.5,
// 恰好等于 C4(中央C,step=-2)下加线场景(lowLedgerY 132.5 + PAD 23 = 155.5)。
// 这样「空谱 → 输入 C4」简谱位置不变,不触发上缩跳动(C4 是最常用音之一)。
// 更低音(下加线 y 更大)仍按 dynamicJianpuTop 正常下移。
const JIANPU_GAP = 34.5;
// prefix 区宽度按字形实际 advance（staff space 单位）定，不盲目翻倍。
// gClef advance=2.684 → 谱号区 3.0；升降号 advance≈1 → 0.9；拍号数字 1.88 → 1.8；留白 1.2。
const CLEF_W = 3.0 * SS;
const KEY_PER_GLYPH = 0.95 * SS;   // 每个升降号占位（flat 宽 0.66ss + 间隙 0.29ss，不粘连）
const KEY_GAP = 0.5 * SS;          // 谱号→调号的间隔
const KEY_TO_TIMESIG = 0.35 * SS;  // 调号末号→拍号的小间隔
const TIMESIG_W = 1.8 * SS;
const GAP_AFTER_PREFIX = 0.5 * SS;
const CLEF_GAP = 0.92 * SS;  // 谱号中心→起始线(减半微调)
const JIANPU_HEIGHT = 74;

/** 每种时值对应的「最小格子宽度」系数（staff space 的倍数）。保证不挤。 */
const SLOT_MIN: Record<DurationValue, number> = {
  whole: 6.0,
  half: 4.2,
  quarter: 3.2,
  eighth: 2.8,
  sixteenth: 2.7,
  thirtysecond: 2.6,
};

export function computeLayout(piece: Piece, containerWidth: number, currentDuration: DurationValue = 'quarter', chordAnchorBeat?: number, chordAnchorDuration?: DurationValue, hoverMidi?: number): Layout {
  const fontSize = FONT;
  const staffSpace = SS;
  // SVG 总宽下限。提到 1056:让 contentWidth 达 ~885,使两小节 32 分音符(拍位宽9.7px)
  // 末音不溢出小节线(NOTE_HEAD_HALF 偏移需 barWidth≥32×NHH≈400,两小节≥800+前缀)。
  // 窗口够宽(≥1084px)时谱表自然达此宽;窗口窄时 SVG 用 preserveAspectRatio:none 横向压缩
  // 到 host 宽度(不裁切不滚动条),但短时值仍会挤(物理限制)。
  const width = Math.max(containerWidth, 1056);

  const staffTop = STAFF_TOP;
  // 谱表高度 = 4 个线距 = 8 个半距。SS 现在是真实 staff space(线距)，故 ×4。
  const bottomLineY = staffTop + 4 * staffSpace;
  const staffBottom = bottomLineY;

  const keyCount = piece.key.sharps.length || piece.key.flats.length;
  // keyW = 纯调号占用宽度（count 个号位），不含到拍号的间隔
  const keyW = keyCount > 0 ? keyCount * KEY_PER_GLYPH : 0;
  // 调号→拍号间隔：有调号时用 KEY_TO_TIMESIG，无调号时谱号直接到拍号用 KEY_GAP
  const keyToTime = keyCount > 0 ? KEY_TO_TIMESIG : KEY_GAP;
  const prefixW = CLEF_GAP + CLEF_W + keyW + keyToTime + TIMESIG_W;  // CLEF_GAP=谱号离起始线间距

  const contentLeft = PAD_LEFT + prefixW + GAP_AFTER_PREFIX;
  const contentRight = width - PAD_RIGHT;
  const contentWidth = contentRight - contentLeft;
  const prefixRight = contentLeft - GAP_AFTER_PREFIX * 0.5;
  const bpb = beatsPerBar(piece.time);

  const clefX = PAD_LEFT + CLEF_GAP + CLEF_W / 2;  // 谱号在五线谱内部右移 CLEF_GAP
  const keyStartX = PAD_LEFT + CLEF_GAP + CLEF_W + KEY_GAP;
  const timeSigX = PAD_LEFT + CLEF_GAP + CLEF_W + keyW + keyToTime + TIMESIG_W / 2;

  const measures = piece.measureCount;
  const barWidth = contentWidth / measures;
  const barLines = Array.from({ length: measures + 1 }, (_, i) => contentLeft + i * barWidth);

  // 计算每个音符的中心 x（按时值占比居中）
  const starts = noteStartBeats(piece);
  const noteX: number[] = [];
  const noteSlotW: number[] = [];
  for (let i = 0; i < piece.notes.length; i++) {
    const startBeat = starts[i];
    // measureOfBeat 浮点鲁棒:三连音等非 2 的幂时值累加有 ~1e-16 误差,
    // 裸 floor 会让「恰填满小节」的音漂到下一小节视觉区。
    const barIdx = Math.min(measureOfBeat(startBeat, bpb), measures - 1);
    const { x, slotW } = positionInBar(piece.notes, startBeat, barIdx, barWidth, bpb, i, barLines);
    noteX.push(x);
    noteSlotW.push(slotW);
  }

  // 下一个待输入位置 = totalBeats(跳过和弦尾音,它们与首音同时不占额外拍)。
  // 旧实现用「末音 endBeat」,但和弦尾音 endBeat=首音start+时值,会多算一拍 →
  // 和弦模式输入首音后 nextSlot 立即推进,且关和弦后位置错乱。
  const capBeats = capacityBeats(piece);
  const totalNow = totalBeats(piece);
  // 和弦输入中:nextSlot 锁定在当前和弦组首音起点,让用户视觉上知道「还在这个位置加声部」,
  // 关和弦后(app 不再传 chordAnchorBeat)nextSlot 才跳到 totalBeats(首音结束处)。
  const nextBeat = chordAnchorBeat !== undefined ? chordAnchorBeat : totalNow;
  const isFull = nextBeat >= capBeats - 1e-6;
  // measureOfBeat 浮点鲁棒:三连音填满小节时 nextBeat≈3.9999...,裸 floor 会把
  // 待输入格子算进原小节末尾(余量~4e-16)而非下一小节起点 → 指示框压在小节线上。
  const clampedBeat = Math.min(nextBeat, capBeats - 0.001);
  const nextBarIdx = Math.min(measureOfBeat(clampedBeat, bpb), measures - 1);
  const nextBeatInBar = clampedBeat - nextBarIdx * bpb;
  // nextDur:和弦输入中(anchor 生效)用和弦首音时值,否则用工具栏当前时值。
  // 删除到和音位置时,slot 宽度应跟随和音时值(而非工具栏可能已切换的时值)。
  const nextDur = nextBeat < capBeats
    ? (chordAnchorBeat !== undefined && chordAnchorDuration ? chordAnchorDuration : currentDuration)
    : 'quarter';
  const nextSlotW = isFull ? 0 : slotWidthFor(nextDur, bpb, barWidth);
  // 与 noteX 同基准(锚定拍位起点+符头半宽,非 slotW/2 居中):空谱时待输入位与首个音符头重合。
  const nextSlotX = barLines[nextBarIdx] + nextBeatInBar / bpb * barWidth + NOTE_HEAD_HALF;

  const jianpuTop = staffBottom + JIANPU_GAP;
  const baseHeight = jianpuTop + JIANPU_HEIGHT + 20;

  // ── 动态高度:按实际音域扩展顶部(容纳高音加线)+ 底部(低音加线让简谱下移)──
  // 扫描所有音符 + hover 预览音的 step,算最高/最低音,据此调整 viewBox 顶部偏移和 jianpuTop。
  // 五线谱/简谱内部坐标(staffTop/bottomLineY/jianpuBaseline)不变,只动 viewBox 范围和简谱整体下移。
  const headHalf = advanceSS('noteheadBlack') / 2 * staffSpace;  // 符头半高(近似方形)
  const PAD = 2 * staffSpace;  // 符头/加线到 viewBox 边界的留白
  // 收集所有需要布局容纳的 step(notes + hover)
  const steps: number[] = [];
  for (const n of piece.notes) if (n.midi !== null) steps.push(resolvePitch(n.midi, piece.clef, piece.key, n.accidental).step);
  if (hoverMidi !== undefined && hoverMidi !== null) steps.push(resolvePitch(hoverMidi, piece.clef, piece.key, null).step);
  const maxStep = steps.length ? Math.max(...steps) : 8;   // 默认五线谱顶线
  const minStep = steps.length ? Math.min(...steps) : 0;   // 默认五线谱底线
  // 顶部:最高音符头 y(若超出 staffTop 留白,viewBox 顶部向上扩展)
  const topNoteY = bottomLineY - maxStep * staffSpace / 2;   // stepToY(maxStep)
  // 默认顶部留白 = staffTop(75),已含朝上符干空间。高音符头 y < PAD 时需扩展
  let viewBoxYOffset = 0;
  if (topNoteY - headHalf - PAD < 0) {
    viewBoxYOffset = Math.ceil(PAD + headHalf - topNoteY);   // 顶部多出的空间
  }
  // 底部:最低音向下取偶 step 的加线 y(低音加线只画 step < 0 的偶数)
  // minStep >= 0(在五线谱内)无下加线,不触发底部扩展
  const lowLedgerStep = minStep < 0 ? (minStep % 2 === 0 ? minStep : minStep - 1) : null;
  const lowLedgerY = lowLedgerStep !== null ? bottomLineY - lowLedgerStep * staffSpace / 2 : staffBottom;
  // 默认 jianpuTop = staffBottom + JIANPU_GAP。低音加线 y > staffBottom 时,简谱下移避开
  let dynamicJianpuTop = jianpuTop;
  if (lowLedgerStep !== null && lowLedgerY + PAD > staffBottom) {
    dynamicJianpuTop = lowLedgerY + PAD;
  }
  // 简谱区域高度随和弦声部数动态扩展:多声部和弦简谱 totalH 可达 78~106px,
  // 超过固定 JIANPU_HEIGHT(74) 会被裁切。锚定 jianpuTop 不变(不与五线谱重叠),
  // baseline/bottom 随 needHalf 对称扩展(简谱数字以 baseline 为中心对称分布)。
  // 下限 37:max(37, ceil(maxH/2))*2 = 74 与原 JIANPU_HEIGHT 一致(单音/2和弦/C3+G5 完全回归),
  // 37 而非 36 是因原固定区域是 baseline=top+36 / bottom=top+74(上36下38,均值37)。
  const maxJianpuH = computeMaxJianpuHeight(piece);
  const needHalf = Math.max(37, Math.ceil(maxJianpuH / 2));
  const dynamicJianpuBaseline = dynamicJianpuTop + needHalf;
  const dynamicJianpuBottom = dynamicJianpuTop + needHalf * 2;
  const height = baseHeight + viewBoxYOffset + (dynamicJianpuTop - jianpuTop) + (needHalf * 2 - JIANPU_HEIGHT);

  return {
    width, height, fontSize, staffSpace,
    staffTop, staffBottom, bottomLineY,
    viewBoxYOffset,   // SVG viewBox 的 y 起点(负值或0),供 buildSVG 用
    prefixRight, contentLeft, contentRight, contentWidth, staffLeftX: PAD_LEFT,
    clefX, keyStartX, timeSigX, hasKey: keyCount > 0,
    barLines,
    noteX, noteSlotW,
    nextSlotX, nextSlotW, noteHeadHalf: NOTE_HEAD_HALF, isFull,
    jianpuTop: dynamicJianpuTop, jianpuBaseline: dynamicJianpuBaseline, jianpuBottom: dynamicJianpuBottom,
  };
}

/** 把某个音符放进它所在的小节：符头锚定「拍位起点 + 符头半宽」(传统乐谱式)。
 *  noteX = 拍位起点(小节内) + NOTE_HEAD_HALF。这样同 beat 起点的不同时值音
 *  (如 treble 四分 + bass 八分1)符头中心严格垂直对齐,演奏读谱一目了然。
 *  slotW 仍按时值占比算(供播放头宽度/简谱临时记号偏移用),但不参与 noteX 计算。
 *  兜底：若音符的 beatInBar 超出小节容量(超拍数据)，clamp 到小节内，
 *  防止音符漂到下一小节视觉区/压小节线。可能和相邻音符挤一起，但至少在小节框内。 */
function positionInBar(notes: Piece['notes'], startBeat: number, barIdx: number, barWidth: number, bpb: number, noteIdx: number, barLines: number[]): { x: number; slotW: number } {
  const note = notes[noteIdx];
  const dur = durationBeats(note);
  // clamp beatInBar 到 [0, bpb - dur]：超拍时不让音符漂出当前小节
  const rawBeatInBar = startBeat - barIdx * bpb;
  const beatInBar = Math.min(Math.max(0, rawBeatInBar), Math.max(0, bpb - dur));
  // slotW 用 slotWidthFor(保留供播放头宽度/简谱临时记号偏移用),但 noteX 不再用 slotW/2 居中,
  // 改为锚定拍位起点+符头半宽,保证同 beat 起点的音符头对齐。
  const slotW = slotWidthFor(note.duration, bpb, barWidth);
  const x = barLines[barIdx] + beatInBar / bpb * barWidth + NOTE_HEAD_HALF;
  return { x, slotW };
}

/** 下一个待输入格子的宽度（按时值占比，但保证最小可读宽度）。 */
function slotWidthFor(duration: DurationValue, bpb: number, barWidth: number): number {
  const ratio = noteValueBeats(duration, false) / bpb;
  const minW = SLOT_MIN[duration] * SS;
  return Math.max(barWidth * ratio, minW);
}
