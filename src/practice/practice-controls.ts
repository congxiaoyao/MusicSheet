// PracticeControls —— 练琴页顶栏控制组件(单行)。
//
// 职责:承载练琴页所有控制。布局参考 prototype 的 .pr-bar(已验证)。
// 设计文档:docs/PracticeApp与顶栏节拍器设计.md §3。
//
// 模式:命令式工厂 + Handle。不调 App 方法，只通过 callbacks 报告事件。
// 布局:左[返回+曲名+播放+调号拍号] spacer [AB开关+单手分段+节拍器(.dot)+变速滑块♩=N+⚙]。
// 设置面板(⚙):谱面模式/键面标注/指法分段 + 音域文字提示。点⚙ toggle，点外部关闭。
// 变速滑块常驻顶栏(非面板)——降速是练琴核心控制。
//
// 注意:dotEl 暴露给 Handle，供 PracticeApp 传给 Metronome 做脉冲。

import './practice-controls.css';
import { buildAbPanel, AbSelection, AbPanelHandle } from './ab-panel';

// ── 图标(内联 SVG,stroke=currentColor,与库页面/editor-bar 同款,严禁 emoji)──
const ICON = {
  // 返回(左箭头)
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  // 播放/暂停:实心圆角造型，提高小尺寸下的识别度。
  play: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7.2 5.6c0-1.5 1.65-2.42 2.92-1.61l9.1 5.78a2.64 2.64 0 0 1 0 4.46l-9.1 5.78c-1.27.81-2.92-.11-2.92-1.61V5.6Z"/></svg>',
  pause: '<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5.5" width="3.8" height="13" rx="1.7"/><rect x="13.2" y="5.5" width="3.8" height="13" rx="1.7"/></svg>',
  minus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>',
  plus: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>',
  metronome: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 4h7.6l3.1 16H5.1L8.2 4Z"/><path d="m12 7 3.2 6.2"/><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none"/><path d="M8.2 16h7.6"/></svg>',
  // 设置(齿轮)
  gear: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

export type HandFilter = 'both' | 'R' | 'L';
export type ScoreMode = 'staff' | 'jianpu' | 'both';
export type KeyLabels = 'name' | 'solfege' | 'octave' | 'none';
export type Fingering = 'cfixed' | 'follow';
export type PlayState = 'stopped' | 'playing' | 'paused';

export interface PracticeControlsInitial {
  title: string;
  /** 如 "C 大调"。 */
  keyLabel: string;
  /** 如 "4/4"。 */
  timeSig: string;
  /** 初始 ♩=bpm 显示值(已乘 speed 的当前值)。 */
  bpm: number;
  /** 变速倍率(0.4~1.6)。 */
  speed: number;
  handFilter: HandFilter;
  metroOn: boolean;
  abOn: boolean;
  // AB 循环面板
  /** 总小节数(构建面板网格用)。 */
  totalMeasures: number;
  /** AB 选区(null=未启用/无定义)。 */
  abSelection: AbSelection | null;
  /** AB 重播间隔(毫秒,0~3000)。 */
  abIntervalBeats: number;
  // 设置面板初始值
  mode: ScoreMode;
  labels: KeyLabels;
  fingering: Fingering;
  /** 键盘音域文字提示，如 "C3–C5 · 自动"(只读展示)。 */
  rangeLabel: string;
  /** 谱面区宽度 px(640~1200)。 */
  scoreWidth: number;
}

export interface PracticeControlsCallbacks {
  onBack: () => void;
  onTogglePlay: () => void;
  onHand: (hand: HandFilter) => void;
  onMetro: (on: boolean) => void;
  /** AB switch 切换(总闸)。 */
  onAbToggle: (on: boolean) => void;
  /** AB 选区变化(面板拖选/单击/整曲循环)。 */
  onAbSelectionChange: (sel: AbSelection) => void;
  /** AB 间隔变化(面板滑块)。 */
  onAbIntervalChange: (beats: number) => void;
  onSpeed: (speed: number) => void;
  // 设置面板
  onMode: (m: ScoreMode) => void;
  onLabels: (l: KeyLabels) => void;
  onFingering: (f: Fingering) => void;
  onScoreWidth: (w: number) => void;
}

export interface PracticeControlsHandle {
  el: HTMLElement;
  /** 节拍器指示点(传给 Metronome 做脉冲)。 */
  dotEl: HTMLElement;
  /** 更新播放按钮图标(stopped=▶, playing/paused=⏸)。 */
  setState(state: PlayState): void;
  /** 更新 ♩=N 显示(变速或切曲时 App 反算回显)。 */
  setBpm(bpm: number): void;
  /** 同步 AB 状态(按钮 .on + 面板 switch/selection)。由 PracticeApp 在状态变化时调。 */
  setAbState(state: { on: boolean; selection: AbSelection | null }): void;
}

/** 构建练琴页顶栏。返回 Handle。 */
export function buildPracticeControls(
  initial: PracticeControlsInitial,
  cb: PracticeControlsCallbacks,
): PracticeControlsHandle {
  // ── 根容器 ──
  const el = document.createElement('div');
  el.className = 'pr-bar';

  const primary = document.createElement('div');
  primary.className = 'pr-primary';
  el.appendChild(primary);

  // ── 左:返回 ──
  const back = document.createElement('span');
  back.className = 'pr-back';
  back.innerHTML = ICON.back;
  back.title = '返回编辑器';
  back.addEventListener('click', () => cb.onBack());
  primary.appendChild(back);

  // ── 曲名 + 调号拍号(作为一个信息组) ──
  const songInfo = document.createElement('div');
  songInfo.className = 'pr-song-info';
  const title = document.createElement('span');
  title.className = 'pr-title';
  title.textContent = initial.title;

  const meta = document.createElement('div');
  meta.className = 'pr-meta';
  const [keyName, ...keyRest] = initial.keyLabel.split(' ');
  meta.innerHTML = `<span><b>${esc(keyName)}</b>${keyRest.length ? ' ' + esc(keyRest.join(' ')) : ''}</span>`
    + `<span><b>${esc(initial.timeSig)}</b></span>`;
  songInfo.append(title, meta);
  primary.appendChild(songInfo);

  // ── 播放(顶栏唯一主操作) ──
  const play = document.createElement('button');
  play.className = 'pr-play';
  play.type = 'button';
  play.innerHTML = ICON.play;
  play.title = '播放 / 暂停';
  play.setAttribute('aria-label', '播放');
  play.addEventListener('click', () => cb.onTogglePlay());
  primary.appendChild(play);

  // ── spacer ──
  const spacer = document.createElement('span');
  spacer.className = 'pr-spacer';
  el.appendChild(spacer);

  const actions = document.createElement('div');
  actions.className = 'pr-actions';
  el.appendChild(actions);

  // ── AB 循环(容器:触发按钮 + 嵌入面板) ──
  // .pr-ab 作为 relative 容器,内嵌触发按钮 + ab-panel(absolute)。点按钮=开关面板,switch 在面板内。
  const ab = document.createElement('div');
  ab.className = 'pr-ab' + (initial.abOn ? ' on' : '');
  const abBtn = document.createElement('div');
  abBtn.className = 'pr-ab-btn';
  abBtn.title = 'AB 循环';
  abBtn.innerHTML = `<span class="ab-dot"></span><span>AB 循环</span>`;
  ab.appendChild(abBtn);

  const abPanel: AbPanelHandle = buildAbPanel(
    { totalMeasures: initial.totalMeasures, on: initial.abOn, selection: initial.abSelection, intervalBeats: initial.abIntervalBeats },
    {
      onToggleLoop: (on) => {
        ab.classList.toggle('on', on);
        cb.onAbToggle(on);
      },
      onSelectionChange: (sel) => cb.onAbSelectionChange(sel),
      onIntervalChange: (beats) => cb.onAbIntervalChange(beats),
      onOpenChange: () => {},
    },
  );
  ab.appendChild(abPanel.el);

  let abPanelOpen = false;
  const setPanelOpen = (open: boolean) => {
    abPanelOpen = open;
    abPanel.setOpen(open);   // 走 handle:setOpen 内部 toggle class + 首次打开重算填充
  };
  abBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelOpen(!abPanelOpen);
  });
  // 点外部关闭面板(同 .pr-settings 的外部关闭逻辑)。
  document.addEventListener('click', (e) => {
    if (!abPanelOpen) return;
    if (!ab.contains(e.target as Node)) setPanelOpen(false);
  });
  actions.appendChild(ab);

  // ── 单手分段 ──
  const hand = document.createElement('div');
  hand.className = 'pr-hand';
  hand.dataset.hand = initial.handFilter;
  const handLabels: Record<HandFilter, string> = { both: '双手', R: '右手', L: '左手' };
  let curHand = initial.handFilter;
  (['both', 'R', 'L'] as HandFilter[]).forEach(hf => {
    const s = document.createElement('span');
    s.textContent = handLabels[hf];
    s.dataset.val = hf;
    if (hf === curHand) s.classList.add('on');
    s.addEventListener('click', () => {
      if (hf === curHand) return;
      curHand = hf;
      hand.dataset.hand = hf;
      hand.querySelectorAll('span').forEach(x => x.classList.toggle('on', x.dataset.val === hf));
      cb.onHand(hf);
    });
    hand.appendChild(s);
  });
  actions.appendChild(hand);

  // ── 节拍器开关(图标本身承担节拍脉冲，避免无语义的小圆点) ──
  const metro = document.createElement('div');
  metro.className = 'pr-metro' + (initial.metroOn ? ' on' : '');
  metro.title = '节拍器';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.innerHTML = ICON.metronome;
  metro.appendChild(dot);
  const metroTxt = document.createElement('span');
  metroTxt.textContent = '节拍器';
  metro.appendChild(metroTxt);
  let metroOn = initial.metroOn;
  metro.addEventListener('click', () => {
    metroOn = !metroOn;
    metro.classList.toggle('on', metroOn);
    cb.onMetro(metroOn);
  });
  actions.appendChild(metro);

  // ── 速度:减/加微调 + 双行读数 + 常驻滑轨 ──
  const tempo = document.createElement('div');
  tempo.className = 'pr-tempo';
  tempo.title = '播放速度';
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'pr-tempo-step';
  minus.innerHTML = ICON.minus;
  minus.setAttribute('aria-label', '降低速度');
  const tempoMain = document.createElement('div');
  tempoMain.className = 'pr-tempo-main';
  const tempoReadout = document.createElement('div');
  tempoReadout.className = 'pr-tempo-readout';
  const bpmLabel = document.createElement('strong');
  bpmLabel.className = 'pr-bpm';
  const bpmValue = document.createElement('span');
  bpmValue.className = 'pr-bpm-value';
  bpmValue.textContent = String(Math.round(initial.bpm));
  const bpmUnit = document.createElement('small');
  bpmUnit.textContent = 'BPM';
  bpmLabel.append(bpmValue, bpmUnit);
  tempoReadout.append(bpmLabel);
  const speed = document.createElement('input');
  speed.type = 'range';
  speed.min = '0.4'; speed.max = '1.6'; speed.step = '0.05';
  speed.value = String(initial.speed);
  speed.title = '拖动设置播放速度';
  speed.setAttribute('aria-label', '播放速度');
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'pr-tempo-step';
  plus.innerHTML = ICON.plus;
  plus.setAttribute('aria-label', '提高速度');
  const updateSpeedVisual = () => {
    const value = parseFloat(speed.value);
    const progress = ((value - 0.4) / (1.6 - 0.4)) * 100;
    tempo.style.setProperty('--speed-progress', `${progress}%`);
  };
  updateSpeedVisual();
  const applySpeed = (value: number) => {
    const clamped = Math.max(0.4, Math.min(1.6, Math.round(value * 20) / 20));
    speed.value = clamped.toFixed(2);
    updateSpeedVisual();
    cb.onSpeed(clamped);
  };
  speed.addEventListener('input', () => {
    // bpm 显示由 PracticeApp 算好(base×speed)后通过 setBpm 回显——单一数据源。
    updateSpeedVisual();
    cb.onSpeed(parseFloat(speed.value));
  });
  minus.addEventListener('click', () => applySpeed(parseFloat(speed.value) - 0.05));
  plus.addEventListener('click', () => applySpeed(parseFloat(speed.value) + 0.05));
  tempoMain.append(tempoReadout, speed);
  tempo.append(minus, tempoMain, plus);
  actions.appendChild(tempo);

  // ── 设置(⚙) + 面板 ──
  const gearWrap = document.createElement('span');
  gearWrap.className = 'pr-gear';
  gearWrap.title = '设置';
  gearWrap.innerHTML = ICON.gear;
  const settings = document.createElement('div');
  settings.className = 'pr-settings';
  gearWrap.appendChild(settings);

  // 设置项:谱面模式
  let curMode = initial.mode;
  settings.appendChild(mkSegRow('谱面模式', [
    { val: 'staff', label: '五线谱' }, { val: 'jianpu', label: '简谱' }, { val: 'both', label: '双谱' },
  ] as { val: ScoreMode; label: string }[], curMode, (v) => {
    curMode = v as ScoreMode;
    cb.onMode(curMode);
  }));
  // 设置项:键面标注
  let curLabels = initial.labels;
  settings.appendChild(mkSegRow('键面标注', [
    { val: 'name', label: '音名' }, { val: 'solfege', label: '唱名' },
    { val: 'octave', label: '八度' }, { val: 'none', label: '关' },
  ] as { val: KeyLabels; label: string }[], curLabels, (v) => {
    curLabels = v as KeyLabels;
    cb.onLabels(curLabels);
  }));
  // 设置项:指法模式
  let curFingering = initial.fingering;
  settings.appendChild(mkSegRow('指法', [
    { val: 'cfixed', label: '移调指法' }, { val: 'follow', label: '原调指法' },
  ] as { val: Fingering; label: string }[], curFingering, (v) => {
    curFingering = v as Fingering;
    cb.onFingering(curFingering);
  }));
  // 设置项:键盘音域(只读提示)
  const rangeRow = document.createElement('div');
  rangeRow.className = 'pr-set-row';
  rangeRow.innerHTML = `<span>键盘音域</span><span class="pr-set-val">${esc(initial.rangeLabel)}</span>`;
  settings.appendChild(rangeRow);
  // 设置项:谱面宽度滑块(640~1200,影响每行小节数/行高)
  // 谱面宽度:640~1056(1056 = computeLayout 硬下限,超过会横向拉伸变形)。
  settings.appendChild(mkSliderRow('谱面宽度', initial.scoreWidth, 640, 1056, 16, (v) => cb.onScoreWidth(v)));

  // ⚙ 切换面板
  gearWrap.addEventListener('click', (e) => {
    e.stopPropagation();
    settings.classList.toggle('open');
  });
  // 点外部关闭
  document.addEventListener('click', (e) => {
    if (!settings.classList.contains('open')) return;
    if (!gearWrap.contains(e.target as Node)) settings.classList.remove('open');
  });

  actions.appendChild(gearWrap);

  return {
    el,
    dotEl: dot,
    setState(state) {
      play.innerHTML = state === 'stopped' ? ICON.play : ICON.pause;
      play.title = state === 'playing' ? '暂停' : (state === 'paused' ? '继续' : '播放');
      play.setAttribute('aria-label', play.title);
      play.classList.toggle('is-playing', state === 'playing');
      play.classList.toggle('is-paused', state === 'paused');
    },
    setBpm(bpm) {
      bpmValue.textContent = String(Math.round(bpm));
    },
    setAbState(state) {
      ab.classList.toggle('on', state.on);
      abPanel.setOn(state.on);
      abPanel.setSelection(state.selection);
    },
  };
}

// ── helpers ──

/** 分段控件行:label + 一组互斥分段按钮。 */
function mkSegRow<T extends string>(
  label: string,
  options: { val: T; label: string }[],
  initial: T,
  onPick: (val: T) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pr-set-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const seg = document.createElement('div');
  seg.className = 'pr-seg';
  let cur = initial;   // 可变:切换后更新,否则点回原选项被当成"当前"跳过
  options.forEach(opt => {
    const s = document.createElement('span');
    s.textContent = opt.label;
    s.dataset.val = opt.val;
    if (opt.val === cur) s.classList.add('on');
    s.addEventListener('click', () => {
      if (opt.val === cur) return;
      cur = opt.val;
      seg.querySelectorAll('span').forEach(x => x.classList.toggle('on', x.dataset.val === opt.val));
      onPick(opt.val);
    });
    seg.appendChild(s);
  });
  row.append(lbl, seg);
  return row;
}

/** 滑块行:label + range 输入 + 数值显示。拖动实时回调。 */
function mkSliderRow(
  label: string,
  cur: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pr-set-row';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const wrap = document.createElement('div');
  wrap.className = 'pr-set-slider';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(cur);
  const val = document.createElement('span');
  val.className = 'pr-set-val';
  val.textContent = String(cur);
  input.addEventListener('input', () => {
    const v = parseInt(input.value, 10);
    val.textContent = String(v);
    onChange(v);
  });
  wrap.append(input, val);
  row.append(lbl, wrap);
  return row;
}

/** 转义防 XSS(标题/音域文本来自乐谱)。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
