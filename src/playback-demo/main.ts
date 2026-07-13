// 放音功能区卡片 · 静态预览页
// 访问：http://localhost:5173/playback-demo.html
//
// 目的：把"播放控制 + seek 进度条 + 实时键位高亮"的 UI 做成一张独立卡片，
//       用假数据模拟"播放中"状态，截图确认设计。UI 敲定后，再在主应用接入真实播放。
//
// 关键：必须引入 style.css，它声明了 @font-face Bravura（参考 beam-test/main.ts 的说明）。

import '../style.css';
import { Piece, durationBeats, beatsPerBar } from '../core/types';
import { noteToJianpu } from '../core/theory';
import { noteStartBeats } from '../core/model';
import { computeLayout } from '../render/layout';
import { buildSVG } from '../render/export';
import { ensureFontLoaded } from '../render/glyphs';
import { twinkleExample } from '../ui/examples';

// ── 常量 ─────────────────────────────────────────────
// midi % 12 → 音名（用 ♯ 表示升号，与项目其它音乐符号一致）
const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
// midi % 12 是否黑键
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const ACCIDENTAL_GLYPH: Record<string, string> = { sharp: '♯', flat: '♭' };
// 简谱音级 1-7 → 唱名音节（do re mi fa sol la si）
const SOLFEGE_SYLLABLES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'];

// ── 演示状态（全部是"假数据"，模拟播放中） ────────────────
interface DemoState {
  bpm: number;
  currentIndex: number;                        // 当前播放到的音符下标（静态固定）
  fingering: 'follow' | 'cfixed';              // 原调指法 / 移调指法
  show: { name: boolean; solfege: boolean; octave: boolean };
}

const state: DemoState = {
  bpm: 100,
  currentIndex: 6,          // 小星星第 7 个音 = G4，落在第 2 小节第 3 拍（视觉位置好，不贴边）
  fingering: 'cfixed',
  show: { name: true, solfege: true, octave: true },
};

// ── 数据：小星星（C 大调 4 小节） ────────────────────────
const piece: Piece = twinkleExample(4);
const layout = computeLayout(piece, 1000);

// ── 时间轴预算（演示用） ────────────────────────────────
const totalBeats = piece.notes.reduce((s, n) => s + durationBeats(n), 0);
const totalSec = totalBeats * 60 / state.bpm;
const starts = noteStartBeats(piece);
const currentBeat = starts[state.currentIndex];
const progress = currentBeat / totalBeats;     // 0..1，拇指位置
const currentSec = currentBeat * 60 / state.bpm;

// ── 工具函数 ─────────────────────────────────────────
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** midi → { 音名, 八度, 是否黑键 }（直接用 midi%12 映射，比 resolvePitch 对黑键更可靠） */
function midiName(midi: number) {
  const pc = midi % 12;
  return {
    name: NAMES_SHARP[pc],
    octave: Math.floor(midi / 12) - 1,
    isBlack: BLACK_PCS.has(pc),
  };
}

/** midi → 首调唱名（do re mi fa sol la si，黑键带升号），用现成的 noteToJianpu */
function midiSolfege(midi: number): string {
  const g = noteToJianpu(
    { midi, duration: 'quarter', dotted: false, accidental: null },
    piece.key,
  );
  if (!g || g.digit === 0) return '';
  const acc = g.accidental ? ACCIDENTAL_GLYPH[g.accidental] : '';
  return `${acc}${SOLFEGE_SYLLABLES[g.digit - 1]}`;
}

// ── DOM 容器 ─────────────────────────────────────────
const root = document.getElementById('playback-demo')!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ════════════════════════════════════════════════════════════
// ① 顶部：五线谱 + 播放头竖线（真实叠加效果）
// ════════════════════════════════════════════════════════════
function renderStage(): HTMLElement {
  const wrap = h('div', 'pb-demo-stage');
  const host = h('div', 'svg-host');

  // buildSVG：playingIndex 传当前音，让符头也跟着高亮（更接近真实播放）
  let svg = buildSVG(piece, layout, state.currentIndex);
  // 在 </svg> 前插入播放头竖线：x = 当前音符中心，y 贯穿五线谱 + 简谱
  const playheadX = layout.noteX[state.currentIndex];
  const y1 = layout.staffTop - 10;
  const y2 = layout.jianpuBottom + 10;
  const line = `<line class="pb-playhead" x1="${playheadX}" y1="${y1}" x2="${playheadX}" y2="${y2}"/>`;
  svg = svg.replace('</svg>', `${line}</svg>`);
  host.innerHTML = svg;
  wrap.appendChild(host);
  return wrap;
}

// ════════════════════════════════════════════════════════════
// ② 播放行：控制按钮 + 进度条 整合在一条
// ════════════════════════════════════════════════════════════
function mkTBtn(symbol: string, kind: 'sm' | 'main'): HTMLButtonElement {
  const b = h('button', `pb-tbtn ${kind}`, symbol);
  b.type = 'button';
  return b;
}

function renderPlayRow(): HTMLElement {
  const row = h('div', 'pb-play-row');

  // 控制按钮：⏮ 起点 · ⏸播放/暂停(主) · ⏹ 停止
  const transport = h('div', 'pb-transport');
  transport.append(
    mkTBtn('⏮', 'sm'),
    mkTBtn('⏸', 'main'),     // 演示态：正在播放 → 显示暂停符号
    mkTBtn('⏹', 'sm'),
  );
  row.appendChild(transport);

  // 进度条区（时间 + 轨道 + 刻度 + 音符点 + 小节号）
  const seek = h('div', 'pb-seek');
  const seekRow = h('div', 'pb-seek-row');

  const nowLabel = h('span', 'pb-time now', fmtTime(currentSec));
  const trackWrap = h('div', 'pb-track-wrap');
  const track = h('div', 'pb-track');
  const fill = h('div', 'pb-fill');
  fill.style.width = `${progress * 100}%`;
  const thumb = h('div', 'pb-thumb');
  thumb.style.left = `${progress * 100}%`;
  track.append(fill, thumb);

  // 小节刻度：每小节边界一条短竖线 + 小节号
  const measures = piece.measureCount;
  for (let i = 0; i <= measures; i++) {
    const ratio = i / measures;
    const tick = h('div', 'pb-tick');
    tick.style.left = `${ratio * 100}%`;
    track.appendChild(tick);
    if (i < measures) {
      const lbl = h('div', 'pb-tick-label', String(i + 1));
      lbl.style.left = `${(i + 0.5) / measures * 100}%`;
      track.appendChild(lbl);
    }
  }

  // 音符位置点
  starts.forEach((b, i) => {
    const dot = h('div', 'pb-note-dot');
    if (i <= state.currentIndex) dot.classList.add('played');
    dot.style.left = `${b / totalBeats * 100}%`;
    track.appendChild(dot);
  });

  trackWrap.appendChild(track);

  const bpb = beatsPerBar(piece.time);
  const curMeasure = Math.min(Math.floor(currentBeat / bpb) + 1, measures);
  const barLabel = h('span', 'pb-bar-label', `小节 ${curMeasure}/${measures}`);

  seekRow.append(nowLabel, trackWrap, h('span', 'pb-time', fmtTime(totalSec)), barLabel);
  seek.appendChild(seekRow);
  row.appendChild(seek);

  return row;
}

// ════════════════════════════════════════════════════════════
// ④ 键位区（钢琴键；配置全部移到齿轮面板）
// ════════════════════════════════════════════════════════════

/** 计算要渲染的白键序列：以中央 C(midi 60) 为视觉中心，向两侧对称扩展白键，
 *  直到覆盖乐谱用到的所有音。返回白键 midi 数组（C4 在正中），黑键由渲染时按需叠加。
 *  对称性：C4 左右白键数相等 → C4 永远落在键盘正中。 */
function whiteKeyRange(): { whites: number[]; centerMidi: number } {
  const CENTER = 60;   // 中央 C4
  const midis = piece.notes.map(n => n.midi).filter((m): m is number => m !== null);

  // 算出 C4 上下各需要多少个白键才能覆盖乐谱音域
  let needAbove = 3;   // 至少 C4 上方 3 个白键（到 F4），避免键盘太窄
  let needBelow = 3;   // C4 下方 3 个白键（到 A3）
  if (midis.length) {
    const maxMidi = Math.max(...midis);
    const minMidi = Math.min(...midis);
    // 上下各需要的白键数：把半音差换算成白键跨度（粗估：每白键 ≈ 1.75 半音，再 +1 余量）
    needAbove = Math.max(needAbove, Math.ceil((maxMidi - CENTER) / 1.75) + 1);
    needBelow = Math.max(needBelow, Math.ceil((CENTER - minMidi) / 1.75) + 1);
  }
  // 取两侧较大值，让 C4 真正居中
  const wing = Math.max(needAbove, needBelow);

  // 从 C4 向两侧各延伸 wing 个白键
  const whites: number[] = [];
  for (let i = -wing; i <= wing; i++) whites.push(whiteKeyOffset(CENTER, i));
  return { whites, centerMidi: CENTER };
}

/** 从基准白键出发，偏移 n 个白键后的 midi（n 可负） */
function whiteKeyOffset(baseWhiteMidi: number, n: number): number {
  // 白键的 pitch-class 集合
  const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
  const basePc = baseWhiteMidi % 12;
  const baseIdx = WHITE_PCS.indexOf(basePc);
  const baseOctave = Math.floor(baseWhiteMidi / 12);
  const total = baseIdx + n;
  let octave = baseOctave + Math.floor(total / 7);
  let idx = ((total % 7) + 7) % 7;
  return octave * 12 + WHITE_PCS[idx];
}

/** 当前应高亮的 midi（演示固定 = 当前音符） */
function activeMidi(): number | null {
  const n = piece.notes[state.currentIndex];
  return n ? n.midi : null;
}

function renderKeyboard(): HTMLElement {
  const box = h('div', 'pb-keys');
  const kb = h('div', 'pb-keyboard');

  // 中央参考线（C4 正中）
  kb.appendChild(h('div', 'pb-center-mark'));

  const { whites, centerMidi } = whiteKeyRange();
  const whiteCount = whites.length;
  const active = activeMidi();

  // 收集黑键：每个白键右侧若有黑键（C→C♯、D→D♯、F→F♯、G→G♯、A→A♯），记录其 midi 与左侧白键索引
  type BlackInfo = { midi: number; leftWhiteIdx: number };
  const blackKeys: { el: HTMLElement; info: BlackInfo }[] = [];

  whites.forEach((wmidi, wi) => {
    const el = h('div', 'pb-key white');
    if (wmidi === active) el.classList.add('active');
    if (wmidi === centerMidi) el.classList.add('center-c');

    if (state.show.octave && m_isC(wmidi)) {
      el.appendChild(h('div', 'pb-key-octave', `C${Math.floor(wmidi / 12) - 1}`));
    }
    if (state.show.name) {
      const nm = midiName(wmidi);
      el.appendChild(h('div', 'pb-key-label', `${nm.name}${nm.octave}`));
    }
    if (state.show.solfege) {
      const sf = midiSolfege(wmidi);
      if (sf) el.appendChild(h('div', 'pb-key-solfege', sf));
    }
    kb.appendChild(el);

    // 该白键右侧的黑键：E 和 B 右侧无黑键
    const pc = wmidi % 12;
    if (![4, 11].includes(pc)) {
      const bmidi = wmidi + 1;
      const bEl = h('div', 'pb-key black');
      if (bmidi === active) bEl.classList.add('active');
      if (state.show.name) {
        const nm = midiName(bmidi);
        bEl.appendChild(h('div', 'pb-key-label', `${nm.name}${nm.octave}`));
      }
      if (state.show.solfege) {
        const sf = midiSolfege(bmidi);
        if (sf) bEl.appendChild(h('div', 'pb-key-solfege', sf));
      }
      blackKeys.push({ el: bEl, info: { midi: bmidi, leftWhiteIdx: wi } });
    }
  });

  // 黑键绝对定位：骑在「左侧白键的右边界」上（第 wi 个白键的右边界 = (wi+1)/whiteCount）
  // width = 白键宽度的 60%，translateX(-50%) 让黑键中心对齐边界
  for (const { el, info } of blackKeys) {
    const leftPct = (info.leftWhiteIdx + 1) / whiteCount * 100;
    const widthPct = 1 / whiteCount * 100 * 0.6;
    el.style.left = `${leftPct}%`;
    el.style.width = `${widthPct}%`;
    kb.appendChild(el);
  }

  box.appendChild(kb);
  return box;
}

function m_isC(midi: number): boolean { return midi % 12 === 0; }

// ════════════════════════════════════════════════════════════
// ⑤ 设置面板（齿轮入口）：速度 / 指法 / 标注开关
// ════════════════════════════════════════════════════════════
let settingsPanel: HTMLElement | null = null;

function renderSettings(): HTMLElement {
  const panel = h('div', 'pb-settings');

  // ── 速度 ──
  panel.appendChild(h('h4', undefined, '速度'));
  const speedRow = h('div', 'pb-set-row');
  const bpmInput = h('input') as HTMLInputElement;
  bpmInput.type = 'range'; bpmInput.min = '40'; bpmInput.max = '200';
  bpmInput.value = String(state.bpm);
  bpmInput.style.accentColor = 'var(--pb-accent)';
  const bpmVal = h('span', undefined, `${state.bpm} BPM`);
  bpmInput.addEventListener('input', () => {
    state.bpm = parseInt(bpmInput.value);
    bpmVal.textContent = `${state.bpm} BPM`;
  });
  speedRow.append(bpmInput, bpmVal);
  panel.appendChild(speedRow);

  // ── 指法 ──
  panel.appendChild(h('h4', undefined, '指法'));
  const fingeRow = h('div', 'pb-set-row');
  const fingeSeg = h('div', 'seg');
  const fOpts: { v: DemoState['fingering']; label: string; title: string }[] = [
    { v: 'cfixed', label: '移调指法', title: '简谱 1-7 永远映射到 C-D-E-F-G-A-B 白键，配合电钢琴移调' },
    { v: 'follow', label: '原调指法', title: '高亮乐谱真实音高（含黑键），电钢琴需关移调' },
  ];
  for (const o of fOpts) {
    const b = h('button', 'seg-btn', o.label);
    b.title = o.title;
    if (o.v === state.fingering) b.classList.add('active');
    b.addEventListener('click', () => {
      state.fingering = o.v;
      fingeSeg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      rerenderKeyboard();
    });
    fingeSeg.appendChild(b);
  }
  fingeRow.appendChild(fingeSeg);
  panel.appendChild(fingeRow);

  // ── 键面标注 ──
  panel.appendChild(h('h4', undefined, '键面标注'));
  const chipsRow = h('div', 'pb-set-chips');
  type ChipKey = 'name' | 'solfege' | 'octave';
  const chipDefs: { key: ChipKey; label: string }[] = [
    { key: 'name', label: '音名' },
    { key: 'solfege', label: '唱名' },
    { key: 'octave', label: '八度' },
  ];
  for (const def of chipDefs) {
    const c = h('button', 'chip toggle', def.label);
    if (state.show[def.key]) c.classList.add('active');
    c.addEventListener('click', () => {
      state.show[def.key] = !state.show[def.key];
      c.classList.toggle('active');
      rerenderKeyboard();
    });
    chipsRow.appendChild(c);
  }
  panel.appendChild(chipsRow);

  settingsPanel = panel;
  return panel;
}

function renderSettingsBtn(): HTMLElement {
  const btn = h('button', 'pb-settings-btn');
  btn.type = 'button';
  btn.title = '放音设置';
  btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = settingsPanel?.classList.toggle('open') ?? false;
    btn.classList.toggle('active', open);
  });
  // 点外部关闭
  document.addEventListener('click', () => {
    settingsPanel?.classList.remove('open');
    btn.classList.remove('active');
  });
  return btn;
}

// ════════════════════════════════════════════════════════════
// 卡片组装 + 重渲染
// ════════════════════════════════════════════════════════════
let cardEl: HTMLElement;

function renderCard(): HTMLElement {
  const card = h('div', 'playback-card');
  card.appendChild(renderSettingsBtn());
  card.appendChild(renderSettings());
  card.appendChild(renderPlayRow());      // 控制按钮 + 进度条（一行）
  cardEl = card;
  card.appendChild(renderKeyboard());
  return card;
}

/** 切换标注/指法后只重绘键盘区（控制条、进度条、竖线不变） */
function rerenderKeyboard(): void {
  if (!cardEl) return;
  const old = cardEl.querySelector('.pb-keys');
  if (old) old.replaceWith(renderKeyboard());
}

// ════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  await ensureFontLoaded();

  const demo = h('div', 'pb-demo');
  const header = h('div', 'pb-demo-header');
  header.innerHTML = `<h1>放音功能区卡片 <em>· 静态预览</em></h1>
    <p class="hint">用小星星模拟"播放中"状态（BPM ${state.bpm}，当前第 ${state.currentIndex + 1} 个音 G4）。
    点右上角齿轮调整速度/指法/键面标注。控制按钮与进度条仅静态展示。</p>`;
  demo.append(header, renderStage(), renderCard());
  root.appendChild(demo);
}

void main();
