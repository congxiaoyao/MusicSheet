// 乐曲状态：追加式录入（类似短信验证码输入）
// - 只能往末尾追加音符
// - 只能从末尾删除
// - 没有「任意光标」，下一个待输入位置永远是 notes.length

import { beatsPerBar, durationBeats, Note, Piece } from './types';
import { noteToJianpu } from './theory';

export function createPiece(): Piece {
  const treble: Note[] = [];
  const bass: Note[] = [];
  return {
    clef: 'treble',
    key: { name: 'C', tonic: 0, sharps: [], flats: [] },
    time: { num: 4, den: 4 },
    measureCount: 2,
    notes: treble,   // 活跃组视图:默认指向 treble(App 切模式时重指向)
    treble,
    bass,
  };
}

/** 总拍数（四分音符为单位）。和弦尾音不占额外时长(与首音同时),不累加。
 *  注意:这是「当前活跃组」(piece.notes)的拍数。播放需要两组并行时,用 totalBeatsBoth。
 *  范围视图:基于 noteStartBeats(读 trebleBeats/bassBeats 预设)算末音 endBeat,
 *  使空小节/半填小节的固定容器拍数计入 → SMS 待输入框(nextSlotX)、容量、进度条位置正确。 */
export function totalBeats(piece: Piece): number {
  const notes = piece.notes;
  if (notes.length === 0) return 0;
  const starts = noteStartBeats(piece);
  const lastIdx = notes.length - 1;
  const last = notes[lastIdx];
  const tail = isChordTail(last, lastIdx > 0 ? notes[lastIdx - 1] : null);
  if (!tail) return starts[lastIdx] + durationBeats(last);
  // 末音是和弦尾音:和弦占一个时间位(首音时值),下一个待输入位在「首音起点 + 首音时值」。
  // 之前返回 starts[lastIdx](= 首音起点),忽略了首音时值 → 关闭和音模式后 SMS 选框
  // 仍停留在和弦首音处,没有移动到和弦之后。和音模式开启时 layout 走 chordAnchorBeat 分支,
  // 不经过 totalBeats;只有关闭后(无 anchor)才用 totalBeats 算 nextSlot,故此处修正。
  const cid = last.chordId;
  let headIdx = lastIdx;
  while (headIdx > 0 && notes[headIdx - 1].chordId === cid) headIdx--;
  return starts[headIdx] + durationBeats(notes[headIdx]);
}

/** 给定一组音符算总拍数(不含和弦尾音)。供 player 分别算 treble/bass 组用。 */
export function totalBeatsOf(notes: Note[]): number {
  let sum = 0;
  for (let i = 0; i < notes.length; i++) {
    if (isChordTail(notes[i], i > 0 ? notes[i - 1] : null)) continue;
    sum += durationBeats(notes[i]);
  }
  return sum;
}

/** 两组(treble+bass)并行播放的总拍数 = max(两组各自拍数)。
 *  两组共享时间轴(都从 beat 0 起),短的一组播完后长的一组继续。
 *  播放层(player)用这个;单卡编辑的进度条/容量用 totalBeats(活跃组)。 */
export function totalBeatsBoth(piece: Piece): number {
  return Math.max(totalBeatsOf(piece.treble), totalBeatsOf(piece.bass));
}

/** 当前音是否是和弦的「尾音」——同 chordId 且前一音也同 chordId。
 *  追加式录入下,连续同 chordId 的第一个是首音(占时长),其余是尾音(不占时长)。
 *  尾音在时间位累加/播放/布局中都不推进时间,与首音共享同一时刻。
 *  注意:prev 必须是「数组中紧邻的前一个音」(不论是否同和弦)。 */
export function isChordTail(note: Note, prev: Note | null): boolean {
  return !!(note.chordId && prev?.chordId === note.chordId);
}

/** 最大可容纳拍数 = measureCount 个小节 */
export function capacityBeats(piece: Piece): number {
  return beatsPerBar(piece.time) * piece.measureCount;
}

/** 还能再插入多少拍 */
export function remainingBeats(piece: Piece): number {
  return Math.max(0, capacityBeats(piece) - totalBeats(piece));
}

// ── 浮点鲁棒工具 ──────────────────────────────────────────
// tuplet(三连音 0.1666... 拍)、附点等非 2 的幂时值累加会产生 ~1e-16 浮点误差,
// 让「恰填满小节/拍边界」的拍位(如 3.9999... 而非 4.0)在 floor/%/比较时误判,
// 连锁导致:连梁分组错、编辑锁死、播放末音高亮丢失、小节号显示错位等。
// EPS 取 1e-6:够吸收累加误差,又远小于最小时值粒度(三十二分=0.125 拍)。
export const BEAT_EPS = 1e-6;

/** 把接近网格点(beat 整数倍于 grid)的拍位吸附到精确网格值。
 *  如 snapBeat(3.9999999, 4) → 4.0;snapBeat(0.9999999, 1) → 1.0。
 *  用于消除累加误差后再做严格比较/边界判定。 */
export function snapBeat(beat: number, grid: number): number {
  const k = Math.round(beat / grid);
  return Math.abs(beat - k * grid) < BEAT_EPS ? k * grid : beat;
}

/** 拍位 → 所在小节序号(0-based)。浮点鲁棒:接近小节右边界(误差内)时吸附归位。
 *  裸 Math.floor(beat/bpb) 会把「恰填满小节 3.9999... 拍」误判成仍在原小节末尾,
 *  导致「下一小节剩余容量」算成 ~4e-16 → 编辑锁死。 */
export function measureOfBeat(beat: number, bpb: number): number {
  return Math.floor(snapBeat(beat, bpb) / bpb);
}

/** 拍位 → 所属拍组(beatGroup)序号。beatGroup=每组的八分音符数(4/4→2,6/8→3)。
 *  浮点鲁棒:三连音累加让 startBeat=0.9999... 时裸 floor 会误判成拍组0而非1,
 *  导致连梁跨拍误并组(如「八分+三连音」末音被并入前拍组)。 */
export function beatGroupIndexOf(beat: number, beatGroup: number): number {
  // 拍组宽度 = beatGroup/2 拍(每组 beatGroup 个八分位)
  const groupWidth = beatGroup / 2;
  return Math.floor(snapBeat(beat, groupWidth) / groupWidth);
}

/** 下一个待写音符所在小节还能容纳多少拍。
 *  若当前小节未满,返回当前小节剩余;若当前小节正好填满,返回下一小节全容量
 *  (因为下一个音符会从新小节开始)。受全局容量限制。
 *  用于交互层防超拍:让正常录入永远不会产生跨小节的超拍数据。 */
export function remainingBeatsInCurrentBar(piece: Piece): number {
  const bpb = beatsPerBar(piece.time);
  const total = totalBeats(piece);
  if (total <= 0) return Math.min(bpb, remainingBeats(piece));
  const mIdx = measureOfBeat(total, bpb);
  const barEnd = (mIdx + 1) * bpb;
  const barFull = barEnd - total <= BEAT_EPS;     // 当前小节正好填满(浮点鲁棒)
  // 当前小节满 → 下一个音符进新小节,剩 bpb;否则剩当前小节余量
  const barRemain = barFull ? bpb : Math.max(0, barEnd - total);
  return Math.max(0, Math.min(barRemain, remainingBeats(piece)));
}

/** 追加一个音符到末尾（短信验证码式）。若超出容量或本小节放不下则失败。 */
export function appendNote(piece: Piece, note: Note): boolean {
  // 和弦尾音:与首音同时、不占额外时长 → 跳过容量校验直接追加。
  const tail = isChordTail(note, piece.notes.length > 0 ? piece.notes[piece.notes.length - 1] : null);
  if (tail) {
    piece.notes.push(note);
    return true;
  }
  const beats = durationBeats(note);
  if (beats > remainingBeats(piece)) return false;                    // 全局容量(保留)
  // 连音组(tuplet)内的音放宽本小节校验：组内各音要挤进整组占的时长里，
  // 单个音的本小节判定会误判（三连音每个 1/3 拍，但组要占满 1 拍）。
  // 组凑齐后的整体超拍由诊断层(diagnoseOverfill)报告。非 tuplet 音仍严格校验。
  if (!note.tuplet && beats > remainingBeatsInCurrentBar(piece) + 1e-6) return false; // 本小节放不下
  piece.notes.push(note);
  return true;
}

/** 删除末尾的最后一个音符（短信验证码式 backspace）。 */
export function popNote(piece: Piece): boolean {
  if (piece.notes.length === 0) return false;
  const removed = piece.notes.pop()!;
  // 连音线清理：被删的是 tie 终点 → 前音的 tieStart 失去配对，清掉（避免孤立 tieStart）。
  // 被删的是 tieStart 时它本就是末尾、无对应 tieEnd，无需处理。
  if (removed.tieEnd && piece.notes.length > 0) {
    piece.notes[piece.notes.length - 1].tieStart = false;
  }
  return true;
}

/**
 * 计算每个音符累计的「起始拍」位置（从 0 开始）。和弦尾音与首音同时,startBeat = 首音 startBeat。
 *
 * 范围视图(整曲多小节)优化:若 piece 带 trebleBeats/bassBeats(rangeToPiece 预算),
 * 直接返回预设值 —— 这些值按"小节固定容器"算,空小节/半填小节也占 bpb 拍,
 * 避免旧裸累加把空小节当 0 拍导致后续音前移。无预设(单行 piece/示例)走下方累加。
 */
export function noteStartBeats(piece: Piece): number[] {
  // 范围视图:读 rangeToPiece 预算的绝对拍(按小节固定容器,空/半填小节不前移)。
  // 但编辑(appendNote/popNote)会改 notes 长度,使 preset 陈旧 → 长度不匹配时按下面策略处理。
  const preset = piece.notes === piece.bass ? piece.bassBeats : piece.trebleBeats;
  const notes = piece.notes;
  if (preset && preset.length === notes.length) return preset;   // 长度匹配:全用预算
  if (preset && preset.length > notes.length) {
    // 删除末尾后:preset 比 notes 长。删除的是末尾,前面的音位置不变 → 截取前 notes.length 个。
    return preset.slice(0, notes.length);
  }
  // 长度不匹配(appendNote 后 preset < notes)或无 preset:累加。
  const starts: number[] = [];
  let acc = 0;
  let curChordStart = 0;
  // 若有 preset 且 preset 非空,从 preset 末音的 endBeat 接续累加
  if (preset && preset.length > 0 && preset.length < notes.length) {
    // 复制 preset 覆盖的部分(这些音的 startBeat 用预算值,保证已落盘音位置正确)
    for (let i = 0; i < preset.length; i++) starts.push(preset[i]);
    // 接续累加:acc 从 preset 末音之后继续。末音的 endBeat = preset 末值 + 其 duration
    const lastPresetIdx = preset.length - 1;
    const lastNote = notes[lastPresetIdx];
    acc = preset[lastPresetIdx] + (isChordTail(lastNote, lastPresetIdx > 0 ? notes[lastPresetIdx - 1] : null) ? 0 : durationBeats(lastNote));
    if (lastNote.chordId) curChordStart = preset[lastPresetIdx];
    // 从 preset.length 开始继续累加
    for (let i = preset.length; i < notes.length; i++) {
      const n = notes[i];
      const tail = isChordTail(n, i > 0 ? notes[i - 1] : null);
      if (tail) { starts.push(curChordStart); }
      else { starts.push(acc); if (n.chordId) curChordStart = acc; acc += durationBeats(n); }
    }
    return starts;
  }
  // 无 preset(单行 piece/示例):从0裸累加(原逻辑)
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const tail = isChordTail(n, i > 0 ? notes[i - 1] : null);
    if (tail) {
      // 尾音:与首音同时,startBeat = 首音的 startBeat,不推进 acc
      starts.push(curChordStart);
    } else {
      // 首音或单音:占时长,startBeat = acc,推进 acc
      starts.push(acc);
      if (n.chordId) curChordStart = acc;
      acc += durationBeats(n);
    }
  }
  return starts;
}

/** 计算小节分割线的拍数位置：0, bpb, 2*bpb, ..., measureCount*bpb */
export function barLineBeats(piece: Piece): number[] {
  const bpb = beatsPerBar(piece.time);
  const bars = piece.measureCount;
  const out: number[] = [];
  for (let i = 0; i <= bars; i++) out.push(bpb * i);
  return out;
}

/** 连音组(tuplet)在 notes 数组中的范围。startIdx..endIdx 为组内音符索引（含两端）。 */
export interface TupletRange {
  startIdx: number;
  endIdx: number;
  /** 实际音符数（时间位数） */
  actual: number;
  /** 对应普通音符数 */
  normal: number;
  /** 组标识 */
  groupId: string;
}

/** 扫描 notes，按 tuplet.groupId 聚合出连音组范围（相邻同 groupId 的音归为一组）。
 *  供渲染层（画数字/括号）、连梁、布局消费。 */
export function tupletGroups(piece: Piece): TupletRange[] {
  const notes = piece.notes;
  const groups: TupletRange[] = [];
  let i = 0;
  while (i < notes.length) {
    const t = notes[i].tuplet;
    if (!t) { i++; continue; }
    // 从 i 开始，向后收集同 groupId 的连续音
    let j = i;
    while (j < notes.length && notes[j].tuplet && notes[j].tuplet!.groupId === t.groupId) j++;
    groups.push({ startIdx: i, endIdx: j - 1, actual: t.actual, normal: t.normal, groupId: t.groupId });
    i = j;
  }
  return groups;
}

/** 和弦(chord)组在 notes 数组中的范围。startIdx=首音,endIdx=末音(含)。
 *  组内首音占时长、尾音与首音同时。供渲染层(staff 符干/jianpu 纵排/player)消费。
 *  连续同 chordId 的音归为一组;孤立 chordId(单音)也归一组(首=末)。 */
export interface ChordRange {
  startIdx: number;
  endIdx: number;
  groupId: string;
}
export function chordGroups(piece: Piece): ChordRange[] {
  const notes = piece.notes;
  const groups: ChordRange[] = [];
  let i = 0;
  while (i < notes.length) {
    const cid = notes[i].chordId;
    if (!cid) { i++; continue; }
    let j = i;
    while (j < notes.length && notes[j].chordId === cid) j++;
    groups.push({ startIdx: i, endIdx: j - 1, groupId: cid });
    i = j;
  }
  return groups;
}

/** 给定音符索引,返回它所在和弦组的 ChordRange(不在任何和弦里返回 null)。 */
export function chordGroupOf(piece: Piece, idx: number): ChordRange | null {
  for (const g of chordGroups(piece)) {
    if (idx >= g.startIdx && idx <= g.endIdx) return g;
  }
  return null;
}

// ── 简谱和弦占高计算(layout 用来动态扩高简谱区域) ──────────
// 几何常量须与 jianpu.ts:12 / 103-106 保持一致(DIGIT_FS、DOT_GAP、DOT_R 同源)。
// 不依赖 layout(纯 piece 几何),故放在 model 层供 layout 调用,无循环依赖。
const JP_DIGIT_FS = 26;
const JP_DIGIT_HEIGHT = JP_DIGIT_FS * 0.72;    // 数字字形高(baseline→顶)
const JP_DIGIT_DESCEND = JP_DIGIT_FS * 0.18;   // 数字下伸余量
const JP_DOT_GAP = 6;                          // 八度点间距
const JP_DOT_R = 2.2;                          // 八度点半径
const JP_VOICE_GAP = 4;                        // 和弦声部间最小间隙
const jpDotUpFromBase = (n: number) => JP_DIGIT_HEIGHT + 6 + (n - 1) * JP_DOT_GAP;
const jpDotDnFromBase = (n: number) => JP_DIGIT_DESCEND + 6 + (n - 1) * JP_DOT_GAP;
// 单声部相对 baseline 的上/下占高(供 layout 算默认 needHalf 下限)。
const jpUpExtent = (octDots: number) => octDots > 0 ? jpDotUpFromBase(octDots) + JP_DOT_R : JP_DIGIT_HEIGHT;
const jpDnExtent = (octDots: number) => {
  const n = octDots < 0 ? -octDots : 0;
  const dots = n > 0 ? jpDotDnFromBase(n) + JP_DOT_R : 0;
  return Math.max(dots, JP_DIGIT_DESCEND);
};

/** 一组八度点(每个声部一个 octaveDots)的简谱纵向占高。复刻 jianpu.ts:151-152。
 *  单声部 = upExtent + dnExtent;和弦 = Σ(各声部占高) + GAP*(声部数-1)。 */
function jianpuGroupHeight(octDotsList: number[]): number {
  const nM = octDotsList.length;
  if (nM === 0) return 0;
  const slotH = octDotsList.map(d => jpUpExtent(d) + jpDnExtent(d));
  return slotH.reduce((a, b) => a + b, 0) + JP_VOICE_GAP * (nM - 1);
}

/** 全曲最大的简谱和弦占高(含单音)。layout 据此动态扩展简谱区域高度,
 *  避免多声部和弦简谱被裁切(3 声部 totalH≈78px > 固定 74px 会裁)。
 *  - 无音符/全休止时返回单音占高下限(layout 取 max(36, totalH/2),安全)。
 *  - 依赖 noteToJianpu(纯函数),不 import layout,无循环依赖。 */
export function computeMaxJianpuHeight(piece: Piece): number {
  let maxH = jpUpExtent(0) + jpDnExtent(0);   // 单音默认占高
  for (const g of chordGroups(piece)) {
    const dots: number[] = [];
    for (let k = g.startIdx; k <= g.endIdx; k++) {
      const jp = noteToJianpu(piece.notes[k], piece.key);
      if (jp) dots.push(jp.octaveDots);
    }
    if (dots.length === 0) continue;
    const h = jianpuGroupHeight(dots);
    if (h > maxH) maxH = h;
  }
  return maxH;
}
