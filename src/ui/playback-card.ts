// 放音功能区卡片组件 —— 播放控制 + seek 进度条 + 实时键位高亮 + 设置面板。
// 样式全部用 style.css 里的 .pb-* （与 playback-demo 共用）。
//
// 用法（App 侧）：
//   const card = buildPlaybackCard(() => appViewSnapshot, callbacks);
//   root.appendChild(card);
//   (card as any)._refresh(view);          // 全量更新
//   (card as any)._setProgress(beat);      // 细粒度：只推进进度条/竖线（rAF 高频用，不抖）

import { Piece, beatsPerBar, KeySig, Note } from '../core/types';
import { noteToJianpu } from '../core/theory';
import { noteStartBeats } from '../core/model';

export type Fingering = 'cfixed' | 'follow';
export interface ShowFlags { name: boolean; solfege: boolean; octave: boolean; }

/** App 注入的当前视图快照 */
export interface PlaybackView {
  piece: Piece;
  playState: 'stopped' | 'playing' | 'paused';
  bpm: number;
  currentBeat: number;
  totalBeats: number;
  playingIndex: number;
  fingering: Fingering;
  show: ShowFlags;
}

export interface PlaybackCardCallbacks {
  onTogglePlay: () => void;
  onStop: () => void;
  onRestart: () => void;
  onSeek: (beat: number) => void;
  onBpm: (bpm: number) => void;
  onFingering: (f: Fingering) => void;
  onShow: (key: keyof ShowFlags, on: boolean) => void;
}

// ── 常量 ─────────────────────────────────────────────
const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const ACCIDENTAL_GLYPH: Record<string, string> = { sharp: '♯', flat: '♭' };
const SOLFEGE_SYLLABLES = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si'];
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const CENTER_C = 60;

// ── localStorage 持久化 ──────────────────────────────
const LS_PREFIX = 'musicsheet:pb:';
function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(LS_PREFIX + key); return v === null ? fallback : JSON.parse(v) as T; }
  catch { return fallback; }
}
export function saveShow(show: ShowFlags): void {
  try { localStorage.setItem(LS_PREFIX + 'show', JSON.stringify(show)); } catch { /* ignore */ }
}
export function saveFingering(f: Fingering): void {
  try { localStorage.setItem(LS_PREFIX + 'fingering', JSON.stringify(f)); } catch { /* ignore */ }
}
export function loadShow(): ShowFlags {
  return lsGet<ShowFlags>('show', { name: true, solfege: true, octave: true });
}
export function loadFingering(): Fingering {
  return lsGet<Fingering>('fingering', 'cfixed');
}

// ── 小工具 ───────────────────────────────────────────
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function midiName(midi: number) {
  const pc = ((midi % 12) + 12) % 12;
  return { name: NAMES_SHARP[pc], octave: Math.floor(midi / 12) - 1, isBlack: BLACK_PCS.has(pc) };
}
function isC(midi: number): boolean { return ((midi % 12) + 12) % 12 === 0; }
/** 从基准白键出发偏移 n 个白键后的 midi（n 可负） */
function whiteKeyOffset(baseWhiteMidi: number, n: number): number {
  const basePc = ((baseWhiteMidi % 12) + 12) % 12;
  const baseIdx = WHITE_PCS.indexOf(basePc);
  const baseOctave = Math.floor(baseWhiteMidi / 12);
  const total = baseIdx + n;
  const octave = baseOctave + Math.floor(total / 7);
  const idx = ((total % 7) + 7) % 7;
  return octave * 12 + WHITE_PCS[idx];
}

/** 以中央 C(60) 为中心、向两侧对称扩展白键，直到覆盖乐谱音域。
 *  最低保底范围 C3(48) ~ C5(84)：无论乐谱音域多窄，至少覆盖这两个八度。 */
function whiteKeyRange(piece: Piece): number[] {
  const midis = piece.notes.map(n => n.midi).filter((m): m is number => m !== null);
  // C3 / C5 距 C4 的白键跨度（各 7 个白键）
  const MIN_WING = 7;
  let needAbove = MIN_WING, needBelow = MIN_WING;
  if (midis.length) {
    const maxMidi = Math.max(...midis);
    const minMidi = Math.min(...midis);
    needAbove = Math.max(needAbove, Math.ceil((maxMidi - CENTER_C) / 1.75) + 1);
    needBelow = Math.max(needBelow, Math.ceil((CENTER_C - minMidi) / 1.75) + 1);
  }
  const wing = Math.max(needAbove, needBelow);
  const whites: number[] = [];
  for (let i = -wing; i <= wing; i++) whites.push(whiteKeyOffset(CENTER_C, i));
  return whites;
}

/** 把「乐谱里的某个音」按指法模式映射成「应高亮的 midi」。
 *  - follow：原音高
 *  - cfixed：简谱唱名映射回 C 调指法位置（同音级，保持八度点，升号→C 调黑键） */
function highlightMidi(note: Note, key: KeySig, fingering: Fingering): number | null {
  if (note.midi === null) return null;
  if (fingering === 'follow') return note.midi;
  const g = noteToJianpu(note, key);
  if (!g || g.digit === 0) return null;
  // 基准八度 C4，按唱名音级偏移白键，再加 octaveDots 个八度 + 升降半音
  let m = whiteKeyOffset(CENTER_C, g.digit - 1);
  m += g.octaveDots * 12;
  if (g.accidental === 'sharp') m += 1;
  else if (g.accidental === 'flat') m -= 1;
  return m;
}

/** midi → 首调唱名（do re mi，黑键带升号） */
function midiSolfege(midi: number, key: KeySig): string {
  const g = noteToJianpu({ midi, duration: 'quarter', dotted: false, accidental: null }, key);
  if (!g || g.digit === 0) return '';
  const acc = g.accidental ? ACCIDENTAL_GLYPH[g.accidental] : '';
  return `${acc}${SOLFEGE_SYLLABLES[g.digit - 1]}`;
}

// ════════════════════════════════════════════════════════════
// 组件构建
// ════════════════════════════════════════════════════════════
export function buildPlaybackCard(
  getView: () => PlaybackView,
  cb: PlaybackCardCallbacks,
): HTMLElement {
  const card = h('div', 'playback-card');

  // 可变 DOM 引用（避免整卡重渲染）
  let playBtn: HTMLButtonElement;
  let fillEl: HTMLElement, thumbEl: HTMLElement;
  let nowLabel: HTMLElement, totalLabel: HTMLElement, barLabel: HTMLElement;
  let trackEl: HTMLElement;
  let keyboardBox: HTMLElement;
  let settingsPanel: HTMLElement, settingsBtn: HTMLButtonElement;
  let bpmVal: HTMLElement, bpmInput: HTMLInputElement;
  let dragActive = false;

  // ── 设置面板 ──
  function buildSettings(): HTMLElement {
    const v = getView();
    const panel = h('div', 'pb-settings');

    panel.appendChild(h('h4', undefined, '速度'));
    const speedRow = h('div', 'pb-set-row');
    bpmInput = h('input') as HTMLInputElement;
    bpmInput.type = 'range'; bpmInput.min = '40'; bpmInput.max = '200'; bpmInput.value = String(v.bpm);
    bpmInput.style.accentColor = 'var(--pb-ink)';
    bpmVal = h('span', undefined, `${v.bpm} BPM`);
    bpmInput.addEventListener('input', () => {
      const b = parseInt(bpmInput.value);
      bpmVal.textContent = `${b} BPM`;
      cb.onBpm(b);
    });
    speedRow.append(bpmInput, bpmVal);
    panel.appendChild(speedRow);

    panel.appendChild(h('h4', undefined, '指法'));
    const fingeRow = h('div', 'pb-set-row');
    const fingeSeg = h('div', 'seg');
    const fOpts: { v: Fingering; label: string; title: string }[] = [
      { v: 'cfixed', label: '固定 C 调', title: '简谱 1-7 永远映射到 C-D-E-F-G-A-B 白键，配合电钢琴移调' },
      { v: 'follow', label: '跟随调号', title: '高亮乐谱真实音高（含黑键），电钢琴需关移调' },
    ];
    const segBtns: HTMLButtonElement[] = [];
    for (const o of fOpts) {
      const b = h('button', 'seg-btn', o.label); b.type = 'button'; b.title = o.title;
      if (o.v === v.fingering) b.classList.add('active');
      b.addEventListener('click', () => {
        fingeSeg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        cb.onFingering(o.v);
      });
      fingeSeg.appendChild(b); segBtns.push(b);
    }
    fingeRow.appendChild(fingeSeg);
    panel.appendChild(fingeRow);

    panel.appendChild(h('h4', undefined, '键面标注'));
    const chipsRow = h('div', 'pb-set-chips');
    const chipDefs: { key: keyof ShowFlags; label: string }[] = [
      { key: 'name', label: '音名' }, { key: 'solfege', label: '唱名' }, { key: 'octave', label: '八度' },
    ];
    for (const def of chipDefs) {
      const c = h('button', 'chip toggle', def.label); c.type = 'button';
      if (v.show[def.key]) c.classList.add('active');
      c.addEventListener('click', () => {
        const now = !v.show[def.key];
        v.show[def.key] = now;
        c.classList.toggle('active', now);
        cb.onShow(def.key, now);
      });
      chipsRow.appendChild(c);
    }
    panel.appendChild(chipsRow);
    return panel;
  }

  function buildSettingsBtn(): HTMLButtonElement {
    const btn = h('button', 'pb-settings-btn'); btn.type = 'button'; btn.title = '放音设置';
    btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = settingsPanel.classList.toggle('open');
      btn.classList.toggle('active', open);
    });
    document.addEventListener('click', () => {
      settingsPanel.classList.remove('open');
      btn.classList.remove('active');
    });
    return btn;
  }

  // ── 播放行（控制按钮 + 进度条） ──
  function buildPlayRow(): HTMLElement {
    const v = getView();
    const row = h('div', 'pb-play-row');
    const transport = h('div', 'pb-transport');

    const restartBtn = h('button', 'pb-tbtn sm', '⏮'); restartBtn.type = 'button'; restartBtn.title = '回到起点';
    restartBtn.addEventListener('click', () => cb.onRestart());
    playBtn = h('button', 'pb-tbtn main', v.playState === 'playing' ? '⏸' : '▶');
    playBtn.type = 'button'; playBtn.title = '播放/暂停';
    playBtn.addEventListener('click', () => cb.onTogglePlay());
    const stopBtn = h('button', 'pb-tbtn sm', '⏹'); stopBtn.type = 'button'; stopBtn.title = '停止';
    stopBtn.addEventListener('click', () => cb.onStop());
    transport.append(restartBtn, playBtn, stopBtn);
    row.appendChild(transport);

    // 进度条
    const seek = h('div', 'pb-seek');
    const seekRow = h('div', 'pb-seek-row');
    nowLabel = h('span', 'pb-time now', '00:00');
    const trackWrap = h('div', 'pb-track-wrap');
    trackEl = h('div', 'pb-track');
    fillEl = h('div', 'pb-fill'); fillEl.style.width = '0%';
    thumbEl = h('div', 'pb-thumb'); thumbEl.style.left = '0%';
    trackEl.append(fillEl, thumbEl);
    // 刻度/音符点在 refresh 里画
    trackWrap.appendChild(trackEl);
    totalLabel = h('span', 'pb-time', '00:00');
    barLabel = h('span', 'pb-bar-label', '小节 1/1');
    seekRow.append(nowLabel, trackWrap, totalLabel, barLabel);
    seek.appendChild(seekRow);
    row.appendChild(seek);

    bindSeek(trackEl);
    return row;
  }

  /** 进度条拖动/点击：算 beat → onSeek */
  function beatFromClientX(clientX: number): number {
    const rect = trackEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = getView();
    return ratio * v.totalBeats;
  }
  function bindSeek(track: HTMLElement): void {
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      dragActive = true;
      const beat = beatFromClientX(e.clientX);
      cb.onSeek(beat);
      const onMove = (ev: MouseEvent) => {
        if (!dragActive) return;
        cb.onSeek(beatFromClientX(ev.clientX));
      };
      const onUp = () => {
        dragActive = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    track.addEventListener('mousedown', onDown);
  }

  // ── 键位区 ──
  function buildKeyboard(): HTMLElement {
    const v = getView();
    const box = h('div', 'pb-keys');
    const kb = h('div', 'pb-keyboard');
    kb.appendChild(h('div', 'pb-center-mark'));

    const whites = whiteKeyRange(v.piece);
    const whiteCount = whites.length;

    // 当前应高亮的 midi 集合。playingIndex 是当前时间位首音;
    // 若它在和弦组里,整组声部都高亮(和弦多键同亮)。
    const activeSet = new Set<number>();
    if (v.playingIndex >= 0 && v.playingIndex < v.piece.notes.length) {
      const head = v.piece.notes[v.playingIndex];
      if (head.chordId) {
        // 和弦:收集同组所有声部的 midi
        for (const n of v.piece.notes) {
          if (n.chordId !== head.chordId || n.midi === null) continue;
          const hm = highlightMidi(n, v.piece.key, v.fingering);
          if (hm !== null) activeSet.add(hm);
        }
      } else {
        const hm = highlightMidi(head, v.piece.key, v.fingering);
        if (hm !== null) activeSet.add(hm);
      }
    }

    const blackKeys: { el: HTMLElement; leftWhiteIdx: number }[] = [];
    whites.forEach((wmidi, wi) => {
      const el = h('div', 'pb-key white');
      if (activeSet.has(wmidi)) el.classList.add('active');
      if (wmidi === CENTER_C) el.classList.add('center-c');
      if (v.show.octave && isC(wmidi)) el.appendChild(h('div', 'pb-key-octave', `C${Math.floor(wmidi / 12) - 1}`));
      if (v.show.name) { const nm = midiName(wmidi); el.appendChild(h('div', 'pb-key-label', `${nm.name}${nm.octave}`)); }
      if (v.show.solfege) { const sf = midiSolfege(wmidi, v.piece.key); if (sf) el.appendChild(h('div', 'pb-key-solfege', sf)); }
      kb.appendChild(el);

      const pc = ((wmidi % 12) + 12) % 12;
      if (![4, 11].includes(pc)) {
        const bmidi = wmidi + 1;
        const bEl = h('div', 'pb-key black');
        if (activeSet.has(bmidi)) bEl.classList.add('active');
        if (v.show.name) { const nm = midiName(bmidi); bEl.appendChild(h('div', 'pb-key-label', `${nm.name}${nm.octave}`)); }
        if (v.show.solfege) { const sf = midiSolfege(bmidi, v.piece.key); if (sf) bEl.appendChild(h('div', 'pb-key-solfege', sf)); }
        blackKeys.push({ el: bEl, leftWhiteIdx: wi });
      }
    });
    for (const { el, leftWhiteIdx } of blackKeys) {
      el.style.left = `${(leftWhiteIdx + 1) / whiteCount * 100}%`;
      el.style.width = `${1 / whiteCount * 100 * 0.6}%`;
      kb.appendChild(el);
    }
    box.appendChild(kb);
    return box;
  }

  // ── 组装 ──
  settingsPanel = buildSettings();
  settingsBtn = buildSettingsBtn();
  card.append(settingsBtn, settingsPanel, buildPlayRow());
  keyboardBox = buildKeyboard();
  card.appendChild(keyboardBox);

  // ── 刷新逻辑 ──
  function redrawTrackTicks(): void {
    const v = getView();
    // 清掉旧的刻度/音符点（保留 fill/thumb）
    trackEl.querySelectorAll('.pb-tick, .pb-tick-label, .pb-note-dot').forEach(n => n.remove());
    if (v.totalBeats <= 0) { fillEl.style.width = '0%'; thumbEl.style.left = '0%'; return; }
    const measures = Math.max(1, v.piece.measureCount);
    const bpb = beatsPerBar(v.piece.time);
    // 小节刻度按实际拍位
    for (let m = 0; m <= measures; m++) {
      const beat = bpb * m;
      if (beat > v.totalBeats + 1e-6 && m === measures) break;
      const ratio = beat / v.totalBeats * 100;
      const tick = h('div', 'pb-tick'); tick.style.left = `${ratio}%`; trackEl.appendChild(tick);
      if (m < measures) {
        const lbl = h('div', 'pb-tick-label', String(m + 1));
        lbl.style.left = `${(beat + bpb / 2) / v.totalBeats * 100}%`;
        trackEl.appendChild(lbl);
      }
    }
    // 音符点
    const starts = noteStartBeats(v.piece);
    starts.forEach((b, i) => {
      const dot = h('div', 'pb-note-dot');
      if (i <= v.playingIndex) dot.classList.add('played');
      dot.style.left = `${b / v.totalBeats * 100}%`;
      trackEl.appendChild(dot);
    });
  }

  /** 细粒度：只推进进度条 + 时间文字（rAF 高频回调用，不重渲染键盘/SVG） */
  function setProgress(beat: number): void {
    const v = getView();
    const total = v.totalBeats;
    const ratio = total > 0 ? Math.max(0, Math.min(1, beat / total)) : 0;
    fillEl.style.width = `${ratio * 100}%`;
    thumbEl.style.left = `${ratio * 100}%`;
    nowLabel.textContent = fmtTime(beat * 60 / v.bpm);
    // 小节标注
    const bpb = beatsPerBar(v.piece.time);
    const measures = Math.max(1, v.piece.measureCount);
    const curM = Math.min(Math.floor(beat / bpb) + 1, measures);
    barLabel.textContent = `小节 ${curM}/${measures}`;
    // 音符点 played 态随推进更新
    const starts = noteStartBeats(v.piece);
    trackEl.querySelectorAll<HTMLElement>('.pb-note-dot').forEach((dot, i) => {
      if (i < starts.length && starts[i] <= beat + 1e-6) dot.classList.add('played');
      else dot.classList.remove('played');
    });
  }

  /** 全量刷新（播放状态切换、bpm、指法、标注、乐谱变化时调） */
  function refresh(): void {
    const v = getView();
    // 播放按钮图标
    playBtn.textContent = v.playState === 'playing' ? '⏸' : '▶';
    // bpm
    bpmInput.value = String(v.bpm);
    bpmVal.textContent = `${v.bpm} BPM`;
    // 总时长
    totalLabel.textContent = fmtTime(v.totalBeats * 60 / v.bpm);
    // 进度
    setProgress(v.currentBeat);
    redrawTrackTicks();
    // 键盘重建（音域/高亮/标注都可能变）
    const newKb = buildKeyboard();
    keyboardBox.replaceWith(newKb);
    keyboardBox = newKb;
  }

  // 暴露命令式 API（项目约定：挂 DOM 上）
  (card as any)._refresh = refresh;
  (card as any)._setProgress = setProgress;
  (card as any)._closeSettings = () => { settingsPanel.classList.remove('open'); settingsBtn.classList.remove('active'); };

  // 首次填充
  refresh();
  return card;
}
