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
  // 播放(三角)
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  // 暂停(双竖条)
  pause: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
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

  // ── 左:返回 ──
  const back = document.createElement('span');
  back.className = 'pr-back';
  back.innerHTML = ICON.back;
  back.title = '返回编辑器';
  back.addEventListener('click', () => cb.onBack());
  el.appendChild(back);

  // ── 曲名 ──
  const title = document.createElement('span');
  title.className = 'pr-title';
  title.textContent = initial.title;
  el.appendChild(title);

  // ── 播放(克制小圆按钮) ──
  const play = document.createElement('button');
  play.className = 'pr-play';
  play.type = 'button';
  play.innerHTML = ICON.play;
  play.title = '播放 / 暂停';
  play.addEventListener('click', () => cb.onTogglePlay());
  el.appendChild(play);

  // ── 调号拍号 ──
  const meta = document.createElement('div');
  meta.className = 'pr-meta';
  const [keyName, ...keyRest] = initial.keyLabel.split(' ');
  meta.innerHTML = `<span><b>${esc(keyName)}</b>${keyRest.length ? ' ' + esc(keyRest.join(' ')) : ''}</span>`
    + `<span class="sep">|</span>`
    + `<span><b>${esc(initial.timeSig)}</b></span>`;
  el.appendChild(meta);

  // ── spacer ──
  const spacer = document.createElement('span');
  spacer.className = 'pr-spacer';
  el.appendChild(spacer);

  // ── AB 循环(容器:触发按钮 + 嵌入面板) ──
  // .pr-ab 作为 relative 容器,内嵌触发按钮 + ab-panel(absolute)。点按钮=开关面板,switch 在面板内。
  const ab = document.createElement('div');
  ab.className = 'pr-ab' + (initial.abOn ? ' on' : '');
  const abBtn = document.createElement('div');
  abBtn.className = 'pr-ab-btn';
  abBtn.title = 'AB 循环';
  abBtn.innerHTML = `<span>AB 循环</span><span class="ab-marks"><span>A</span><span>B</span></span>`;
  ab.appendChild(abBtn);

  const abPanel: AbPanelHandle = buildAbPanel(
    { totalMeasures: initial.totalMeasures, on: initial.abOn, selection: initial.abSelection },
    {
      onToggleLoop: (on) => {
        ab.classList.toggle('on', on);
        cb.onAbToggle(on);
      },
      onSelectionChange: (sel) => cb.onAbSelectionChange(sel),
      onOpenChange: () => {},
    },
  );
  ab.appendChild(abPanel.el);

  let abPanelOpen = false;
  abBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    abPanelOpen = !abPanelOpen;
    abPanel.el.classList.toggle('open', abPanelOpen);
  });
  // 点外部关闭面板(同 .pr-settings 的外部关闭逻辑)。
  document.addEventListener('click', (e) => {
    if (!abPanelOpen) return;
    if (!ab.contains(e.target as Node)) {
      abPanelOpen = false;
      abPanel.el.classList.remove('open');
    }
  });
  el.appendChild(ab);

  // ── 单手分段 ──
  const hand = document.createElement('div');
  hand.className = 'pr-hand';
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
      hand.querySelectorAll('span').forEach(x => x.classList.toggle('on', x.dataset.val === hf));
      cb.onHand(hf);
    });
    hand.appendChild(s);
  });
  el.appendChild(hand);

  // ── 节拍器开关(含 dot) ──
  const metro = document.createElement('div');
  metro.className = 'pr-metro' + (initial.metroOn ? ' on' : '');
  metro.title = '节拍器';
  const dot = document.createElement('span');
  dot.className = 'dot';
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
  el.appendChild(metro);

  // ── 变速滑块 + ♩=N ──
  const tempo = document.createElement('div');
  tempo.className = 'pr-tempo';
  const speed = document.createElement('input');
  speed.type = 'range';
  speed.min = '0.4'; speed.max = '1.6'; speed.step = '0.05';
  speed.value = String(initial.speed);
  speed.title = '变速';
  const bpmLabel = document.createElement('span');
  bpmLabel.className = 'pr-bpm';
  bpmLabel.innerHTML = `♩=<b>${Math.round(initial.bpm)}</b>`;
  speed.addEventListener('input', () => {
    // bpm 显示由 PracticeApp 算好(base×speed)后通过 setBpm 回显——单一数据源。
    cb.onSpeed(parseFloat(speed.value));
  });
  tempo.append(speed, bpmLabel);
  el.appendChild(tempo);

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

  el.appendChild(gearWrap);

  return {
    el,
    dotEl: dot,
    setState(state) {
      play.innerHTML = state === 'stopped' ? ICON.play : ICON.pause;
      play.title = state === 'playing' ? '暂停' : (state === 'paused' ? '继续' : '播放');
    },
    setBpm(bpm) {
      bpmLabel.innerHTML = `♩=<b>${Math.round(bpm)}</b>`;
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
