// PracticeApp —— 练琴页 controller。
//
// 职责(文档 §2.1):新建 Player + 装配 5 组件 + onTick 分发 + 算当前响的音 +
//   AB 循环检测 + 设置持久化 + 组件间协调(bounds 坐标换算)。
//
// 关键约束:
//   - 新建 Player(不复用编辑器);AB 循环放本 controller 的 onTick(不改 Player)。
//   - "当前响的音"由本 controller 算(active-midis.ts),喂原始 midi 给键盘。
//   - Score 引用传递,**只读使用**,绝不能改编辑器的 Score。
//   - destroy 要停播放 + 移除 DOM + dispose Player(释放 AudioContext),不能泄漏。
//   - 设置(键宽/高度/标注/指法/谱面模式)存 localStorage,全局不分曲子。
//   - 谱面模式切换时行高变,onLineLayout 会重新触发 → 转发给 waterfall.setBounds。
//
// 设计文档:docs/PracticeApp与顶栏节拍器设计.md §2。

import './practice-app.css';
import { Score, rangeToPiece } from '../core/score';
import { beatsPerBar } from '../core/types';
import { noteStartBeats, BEAT_EPS } from '../core/model';
import { Player, PlayState } from '../audio/player';
import { buildScoreSheet, ScoreMode } from './score-sheet';
import { buildKeyboard, whiteKeyRange, rangeFromWhites, KeyLabels } from './keyboard';
import { Fingering } from './fingering';
import { KeyRange } from './key-coords';
import { buildWaterfall, parseFallNotes, FallNote } from './waterfall';
import { buildMetronome } from './metronome';
import { buildPracticeControls, HandFilter } from './practice-controls';
import { AbSelection } from './ab-panel';
import { computeActiveMidis, ActiveStaff } from './active-midis';

// ── 设置(全局,不分曲子) ──────────────────────────────────

export interface PracticeSettings {
  /** 白键宽 px。 */
  keyWidth?: number;
  /** 键盘高度 px。 */
  keyboardHeight?: number;
  /** 键面标注。 */
  labels?: KeyLabels;
  /** 指法模式。 */
  fingering?: Fingering;
  /** 谱面档。 */
  mode?: ScoreMode;
  /** 谱面区宽度 px(640~1200,影响每行小节数/行高)。 */
  scoreWidth?: number;
}

export interface PracticeAppInitial {
  /** 完整乐谱(从编辑器传入,只读使用)。 */
  score: Score;
  /** 练琴页挂载点(host 元素)。 */
  root: HTMLElement;
  /** 持久化设置(localStorage 读)。 */
  savedSettings?: PracticeSettings;
  /** 用户点「返回」时触发(由 app.ts 做 destroy + 切回编辑器)。 */
  onRequestBack?: () => void;
}

const LS_SETTINGS = 'practiceSettings';
const LS_BPM_PREFIX = 'musicsheet:practice:bpm:';

/** 读全局练琴设置(localStorage)。 */
export function loadPracticeSettings(): PracticeSettings {
  try {
    const v = localStorage.getItem(LS_SETTINGS);
    return v ? JSON.parse(v) as PracticeSettings : {};
  } catch { return {}; }
}
/** 写全局练琴设置。 */
export function savePracticeSettings(s: PracticeSettings): void {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch { /* ignore */ }
}
/** 读某曲子的 baseBpm(按曲子 id 关联)。fallback 默认 100。 */
export function loadBpm(scoreId: string, fallback = 100): number {
  try {
    const v = localStorage.getItem(LS_BPM_PREFIX + scoreId);
    const n = v ? JSON.parse(v) as number : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch { return fallback; }
}
/** 写某曲子的 baseBpm。 */
export function saveBpm(scoreId: string, bpm: number): void {
  try { localStorage.setItem(LS_BPM_PREFIX + scoreId, JSON.stringify(bpm)); } catch { /* ignore */ }
}

// ── AB 循环状态持久化(按曲子 id,同 BPM 风格) ──
/** AB 持久化结构:selection(选区,与开关无关)+ on(开关状态)+ intervalBeats(间隔,拍数)。
 *  三者独立持久化,保证"退出啥状态进来就啥状态"(关着 switch 离开 → 进来还是关)。 */
export interface AbState { selection: AbSelection | null; on: boolean; intervalBeats: number; }
const LS_AB_PREFIX = 'musicsheet:practice:ab:';
/** 读某曲子的 AB 状态。读不到返回默认(首次进入)。 */
export function loadAbState(scoreId: string): AbState {
  try {
    const v = localStorage.getItem(LS_AB_PREFIX + scoreId);
    if (!v) return { selection: null, on: false, intervalBeats: 0 };
    const s = JSON.parse(v) as Partial<AbState>;
    return { selection: s.selection ?? null, on: !!s.on, intervalBeats: s.intervalBeats ?? 0 };
  } catch { return { selection: null, on: false, intervalBeats: 0 }; }
}
/** 写某曲子的 AB 状态。 */
export function saveAbState(scoreId: string, state: AbState): void {
  try { localStorage.setItem(LS_AB_PREFIX + scoreId, JSON.stringify(state)); } catch { /* ignore */ }
}

// ── 默认值 ──
const DEFAULT_KEY_WIDTH = 44;
const DEFAULT_KB_HEIGHT = 140;
const DEFAULT_LABELS: KeyLabels = 'name';
const DEFAULT_FINGERING: Fingering = 'follow';
const DEFAULT_MODE: ScoreMode = 'both';
/** 谱面区默认宽度 px。1000 是阅读舒适值(每行 2-3 小节,行高适中)。 */
const DEFAULT_SCORE_WIDTH = 1000;
/** 谱面宽度上下限。
 *  上限 1056 = computeLayout 的硬下限(layout.ts):超过它 SVG 会被横向拉伸变形(scaleX≠scaleY),
 *  故 1056 是不变形的最大宽度。下限 640 = score-sheet render 的 clamp 下限。 */
const SCORE_WIDTH_MIN = 640;
const SCORE_WIDTH_MAX = 1056;
const DEFAULT_FALLBACK_BPM = 100;

// ── PracticeApp ──────────────────────────────────────────

export class PracticeApp {
  private readonly score: Score;
  private readonly root: HTMLElement;
  private readonly settings: PracticeSettings;
  private readonly requestBack: () => void;

  private player: Player;
  private baseBpm: number;
  private speed = 1;
  private bpb: number;   // beatsPerBar

  // 组件 handle
  private scoreSheet: ReturnType<typeof buildScoreSheet>;
  private keyboard: ReturnType<typeof buildKeyboard>;
  private waterfall: ReturnType<typeof buildWaterfall>;
  private metronome: ReturnType<typeof buildMetronome>;
  private controls: ReturnType<typeof buildPracticeControls>;

  // 调度数据(给 computeActiveMidis)
  private staffs: ActiveStaff[];
  private piece: ReturnType<typeof rangeToPiece>;

  // 练琴状态
  private currentBeat = 0;
  private playState: PlayState = 'stopped';
  private handFilter: HandFilter = 'both';
  private metroOn: boolean;
  private abOn = false;
  private abSelection: AbSelection | null = null;   // AB 选区(小节级);null=未启用/无定义
  private abRange: { a: number; b: number } | null = null;   // beat 单位(由 abSelection 派生,onTick 用)
  /** AB 循环间隔(拍数,0~8)。到 B 点后停顿 intervalBeats 拍再跳回 A;0=立即。
   *  换算 ms:intervalBeats × 60/baseBpm × 1000(按基础 bpm,不受变速影响)。 */
  private abIntervalBeats = 0;
  /** 间隔停顿期间是否暂停中(onStateChange 跳过用,避免按钮态闪烁)。 */
  private abPausing = false;
  /** 间隔停顿的 pending timer(手动 seek/toggle/destroy 时需清除避免竞态)。 */
  private abPauseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 谱面区 DOM(设宽度用)。 */
  private scoreArea!: HTMLElement;
  /** 谱面区宽度 px。 */
  private scoreWidth: number;

  // 资源句柄(destroy 用)
  private boundResize: () => void;
  private boundScroll: () => void;
  /** Space 播放/暂停的全局 keydown(练琴页专属;mount 注册 destroy 卸载)。 */
  private boundKeyDown!: (e: KeyboardEvent) => void;
  private hitEl: HTMLElement;
  private fallWrap!: HTMLElement;
  /** 上一帧的方块区行底(overlay 内 y),用于检测换行突跳(实时值突增)时沿用,实现平滑跟随。 */
  private lastFrameLineBottom: number | null = null;
  private destroyed = false;
  /** (已废弃,保留 mount 注释引用) */
  /** 调试日志收集器(见 docs/调试日志收集器.md)。 */
  private __log: { t: number; tag: string; data: unknown }[] = [];
  private log = (tag: string, data: unknown = {}): void => {
    this.__log.push({ t: Math.round(performance.now() * 100) / 100, tag, data });
  };

  constructor(initial: PracticeAppInitial) {
    this.score = initial.score;
    this.root = initial.root;
    this.settings = initial.savedSettings ?? {};
    this.requestBack = initial.onRequestBack ?? (() => {});
    this.bpb = beatsPerBar(this.score.meta.time);
    this.scoreWidth = clamp(this.settings.scoreWidth ?? DEFAULT_SCORE_WIDTH, SCORE_WIDTH_MIN, SCORE_WIDTH_MAX);

    // 调试日志收集器(挂 window,用法见 docs/调试日志收集器.md)。
    // console: __msLogClear() 清空; __msLogSave() 上传到 server/log-sink.mjs 落盘 ms-log.json。
    (window as unknown as { __msLog?: unknown[] }).__msLog = this.__log;
    (window as unknown as { __msLogFn?: (tag: string, data?: unknown) => void }).__msLogFn = (tag: string, data?: unknown) => this.log(tag, data);
    (window as unknown as { __msLogClear?: () => void }).__msLogClear = () => { this.__log.length = 0; };
    (window as unknown as { __msLogSave?: () => void }).__msLogSave = () => {
      const sink = `http://${location.hostname}:4174/ms-log`;
      fetch(sink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.__log) })
        .then(r => r.json()).then(d => console.log('[ms-log] 已上传', d)).catch(e => console.error('[ms-log] 上传失败', e));
    };

    // ── 调度数据(整曲 treble/bass) ──
    const total = this.score.meta.totalMeasures;
    this.piece = rangeToPiece(this.score, 0, total, 'treble');   // treble/bass 都在
    const bassPiece = rangeToPiece(this.score, 0, total, 'bass');
    this.staffs = [
      { notes: this.piece.treble, starts: noteStartBeats(this.piece), hand: 'R' },
      { notes: bassPiece.bass, starts: noteStartBeats(bassPiece), hand: 'L' },
    ];

    // ── Player(新建) ──
    this.baseBpm = loadBpm(this.score.meta.id, DEFAULT_FALLBACK_BPM);
    // ── AB 状态恢复(严格按 LS:关着离开进来就是关,selection 仍在) ──
    const abState = loadAbState(this.score.meta.id);
    this.abOn = abState.on;
    this.abSelection = abState.selection;
    this.abRange = this.abSelection ? this.selectionToRange(this.abSelection) : null;
    this.abIntervalBeats = abState.intervalBeats;
    this.player = new Player({
      onTick: (beat) => this.onTick(beat),
      onStateChange: (s) => this.onStateChange(s),
      onEnd: () => this.onEnd(),
    });
    this.player.setBpm(this.baseBpm * this.speed);

    // ── 组件:谱面 ──
    this.scoreSheet = buildScoreSheet(
      { score: this.score, mode: this.settings.mode ?? DEFAULT_MODE, density: 'compact' },
      {
        onLineLayout: (info) => this.onLineLayout(info),
        onSeek: (beat) => this.onSeekBeat(beat),
      },
    );

    // ── 组件:键盘(布局源) ──
    const range = computeAutoRange(this.score);
    this.keyboard = buildKeyboard(
      {
        range,
        height: this.settings.keyboardHeight ?? DEFAULT_KB_HEIGHT,
        keyWidth: this.settings.keyWidth ?? DEFAULT_KEY_WIDTH,
        labels: this.settings.labels ?? DEFAULT_LABELS,
        fingering: this.settings.fingering ?? DEFAULT_FINGERING,
        key: this.score.meta.key,
      },
      {
        onKeyLayoutChange: (info) => {
          this.settings.keyWidth = info.whiteW;
          this.waterfall.setKeyLayout(info);
          this.updateBounds();
        },
        onHeightChange: (h) => {
          this.settings.keyboardHeight = h;
          this.updateBounds();
        },
        onLabelChange: () => {},
        onFingeringChange: () => {},
      },
    );

    // ── 组件:方块 ──
    const fallNotes: FallNote[] = parseFallNotes(this.score);
    this.waterfall = buildWaterfall(
      { notes: fallNotes, range, whiteW: this.keyboard.getKeyWidth(),
        fingering: this.settings.fingering ?? DEFAULT_FINGERING, key: this.score.meta.key },
      {},
    );

    // ── 判定线脉冲元素(Metronome 用;叠在方块区底,纯视觉) ──
    this.hitEl = document.createElement('div');
    this.hitEl.className = 'pr-hit';

    // ── 组件:顶栏 ──
    this.metroOn = true;
    this.controls = buildPracticeControls(
      {
        title: this.score.meta.title,
        keyLabel: this.keyLabel(),
        timeSig: `${this.score.meta.time.num}/${this.score.meta.time.den}`,
        bpm: Math.round(this.baseBpm * this.speed),
        speed: this.speed,
        handFilter: this.handFilter,
        metroOn: this.metroOn,
        abOn: this.abOn,
        totalMeasures: this.score.meta.totalMeasures,
        abSelection: this.abSelection,
        abIntervalBeats: this.abIntervalBeats,
        mode: this.settings.mode ?? DEFAULT_MODE,
        labels: this.settings.labels ?? DEFAULT_LABELS,
        fingering: this.settings.fingering ?? DEFAULT_FINGERING,
        rangeLabel: rangeText(range),
        scoreWidth: this.scoreWidth,
      },
      {
        onBack: () => this.onBack(),
        onTogglePlay: () => this.onTogglePlay(),
        onHand: (h) => this.onHand(h),
        onMetro: (on) => this.onMetro(on),
        onAbToggle: (on) => this.onAbToggle(on),
        onAbSelectionChange: (sel) => this.onAbSelectionChange(sel),
        onAbIntervalChange: (ms) => this.onAbIntervalChange(ms),
        onSpeed: (s) => this.onSpeed(s),
        onMode: (m) => this.onMode(m),
        onLabels: (l) => this.onLabels(l),
        onFingering: (f) => this.onFingering(f),
        onScoreWidth: (w) => this.onScoreWidth(w),
      },
    );

    // ── 组件:节拍器 ──
    this.metronome = buildMetronome({ hitEl: this.hitEl, dotEl: this.controls.dotEl, enabled: this.metroOn });

    // ── resize ──
    this.boundResize = () => this.updateBounds();
    window.addEventListener('resize', this.boundResize);

    // ── 谱面滚动监听(换行时方块区上边界跟随谱面平滑滚动) ──
    // score-sheet 换行走 scrollEl.scrollTo({behavior:'smooth'}),滚动期间当前行底连续变化。
    // 监听 scroll 事件实时算当前可见行底 → 设方块区 top,使方块区上边界与谱面滚动天然同步,
    // 不依赖猜 smooth 曲线(旧实现用 300ms 线性插值,跟浏览器滚动曲线不同步 → 跳变)。
    this.boundScroll = () => this.updateTopYFromScroll();
    const scrollEl = this.scoreSheet.el.querySelector('.score-sheet-scroll');
    if (scrollEl) scrollEl.addEventListener('scroll', this.boundScroll);
  }

  // ── 挂载 ──

  mount(): void {
    // DOM 结构:顶栏 + stage(score | overlay(hit + waterfall + keyboard))。
    const stage = document.createElement('div');
    stage.className = 'pa-stage';
    this.scoreArea = document.createElement('div');
    this.scoreArea.className = 'pa-score-area';
    this.scoreArea.style.width = this.scoreWidth + 'px';
    this.scoreArea.appendChild(this.scoreSheet.el);
    stage.appendChild(this.scoreArea);

    const overlay = document.createElement('div');
    overlay.className = 'pa-overlay';
    this.fallWrap = document.createElement('div');
    this.fallWrap.className = 'pa-fall';
    // waterfall 保留在带顶部淡出遮罩的容器内；判定线直接挂到键盘，始终使用同一坐标系。
    this.fallWrap.appendChild(this.waterfall.el);
    overlay.appendChild(this.fallWrap);
    overlay.appendChild(this.keyboard.el);
    this.keyboard.el.appendChild(this.hitEl);
    stage.appendChild(overlay);

    this.root.innerHTML = '';
    // root 作为 flex column 容器撑满父(practiceHost fixed inset:0 / harness #root 100vh):
    // 顶栏 flex:none + stage flex:1(min-height:0 让 score-area 可收缩,不被谱面 SVG 撑高)。
    this.root.classList.add('pa-root');
    this.root.appendChild(this.controls.el);
    this.root.appendChild(stage);

    // 布局完成后:先 onTick(0) 触发 score-sheet 首行 onLineLayout(更新 currentLineBottomY),
    // 再 updateBounds(按真实行底设方块区位置),避免方块区先在 top=0 闪一帧。
    requestAnimationFrame(() => {
      this.scoreSheet.onTick(0);
      this.updateBounds();
      // AB 视觉初始刷新(记忆恢复的选区 → 谱面遮罩 + A/B 标记)。
      this.updateAbVisual();
    });

    // ── Space 播放/暂停(练琴页专属 keydown)──
    // 可见性守卫用 root.hidden:返回编辑器时 App 给 practiceHost 设 hidden 属性
    // (CSS .practice-host[hidden]{display:none})。注意不能用 offsetParent===null ——
    // practiceHost 是 position:fixed,其 offsetParent 规范上恒为 null(无论可见与否),
    // 用它会把练琴页可见时也误判为隐藏 → Space 永远不触发。(库页面 host 是文档流元素才用 offsetParent。)
    // 反复进退练琴页,故 mount 注册 / destroy 卸载配对,避免多实例堆积。
    this.boundKeyDown = (e: KeyboardEvent) => {
      if (this.destroyed) return;
      if (this.root.hidden) return;   // 练琴页不可见时(已返回编辑器)不响应
      // 输入框聚焦时不劫持 Space(防御:练琴页未来可能加输入框)。
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === ' ') {
        e.preventDefault();
        this.onTogglePlay();
      }
    };
    window.addEventListener('keydown', this.boundKeyDown);
  }

  // ── onTick 分发(文档 §2.3) ──

  private onTick(beat: number): void {
    if (this.destroyed) return;
    this.currentBeat = beat;

    // AB 循环检测:到 B 点触发循环(含间隔逻辑)。触发后 return(由 triggerAbLoop 内分发 A 帧)。
    if (this.abOn && this.abRange && beat >= this.abRange.b - BEAT_EPS) {
      this.triggerAbLoop();
      return;
    }

    this.dispatchFrame(beat);
  }

  /** 分发一帧到所有视觉组件(scoreSheet/waterfall/keyboard/metronome)。
   *  各组件纯函数式重算,传 beat 即恢复到该 beat 状态。循环跳转时用 A 点 beat 主动调一次,
   *  避免当帧冻结在 B、下一帧才恢复的跳变。 */
  private dispatchFrame(beat: number): void {
    this.currentBeat = beat;
    this.scoreSheet.onTick(beat);
    this.waterfall.onTick(beat);
    const active = computeActiveMidis(beat, this.staffs, this.handFilter);
    this.keyboard.setActiveMidis(active);
    this.metronome.onTick(beat);
  }

  /** AB 循环触发:到 B 点后(可能停顿 interval)跳回 A 并从 A 重新播放 + 分发 A 帧。
   *  interval=0:立即 seek(A)+ dispatchFrame(A)。
   *  interval>0:pause(冻结所有组件,tickLoop 停 → onTick 不再调 → 完全静止)→ setTimeout(interval)
   *    → seek(A, true) + dispatchFrame(A)。pause 期间 abPausing=true 让 onStateChange 跳过(按钮无感)。 */
  private triggerAbLoop(): void {
    if (!this.abRange) return;
    const a = this.abRange.a;
    this.clearAbPauseTimer();
    if (this.abIntervalBeats <= 0) {
      this.seekAndDispatch(a);
      return;
    }
    // 间隔停顿:pause 冻结 → 延迟 intervalBeats 拍 → 从 A 继续。
    // 拍→ms 按 baseBpm(基础节奏,不受变速影响):间隔是"音乐停几拍"的语义。
    const ms = this.abIntervalBeats * 60 / this.baseBpm * 1000;
    this.abPausing = true;
    this.player.pause();   // tickLoop 停,onTick 不再被调,组件自动冻结
    this.abPauseTimer = setTimeout(() => {
      this.abPauseTimer = null;
      this.abPausing = false;
      this.seekAndDispatch(a);
    }, ms);
  }

  /** seek 到 beat(保持播放)+ 主动分发该 beat 一帧(确保当帧立即恢复,不等下一帧 rAF)。 */
  private seekAndDispatch(beat: number): void {
    this.player.seek(beat, true);
    this.dispatchFrame(beat);
  }

  /** 清除 AB 间隔的 pending timer(手动 seek/toggle/切选区/destroy 时调,避免竞态)。 */
  private clearAbPauseTimer(): void {
    if (this.abPauseTimer != null) {
      clearTimeout(this.abPauseTimer);
      this.abPauseTimer = null;
    }
    this.abPausing = false;
  }

  private onStateChange(state: PlayState): void {
    if (this.destroyed) return;
    // 间隔停顿期间 player 进 paused 态会触发此回调;跳过避免按钮/title 闪烁(间隔结束后自然恢复)。
    if (this.abPausing) return;
    this.playState = state;
    if (state === 'stopped') {
      this.currentBeat = 0;
      this.keyboard.clearHighlight();
      this.scoreSheet.onTick(0);
    }
    this.controls.setState(state);
  }

  private onEnd(): void {
    if (this.destroyed) return;
    // 整曲循环(或选区延伸到曲终):播放自然结束触发的 onEnd,应循环回 A 而非停止。
    // 触发条件:AB 开 + B 点 == 曲终(player 的结束判定 beat>=totalBeats 抢在 onTick 的 AB 检测前)。
    const totalBeats = this.score.meta.totalMeasures * this.bpb;
    if (this.abOn && this.abRange && this.abRange.b >= totalBeats - BEAT_EPS) {
      this.triggerAbLoop();
      return;
    }
    this.playState = 'stopped';
    this.currentBeat = 0;
    this.keyboard.clearHighlight();
    this.scoreSheet.onTick(0);
    this.controls.setState('stopped');
  }

  // ── 控件回调 ──

  /** 返回:通知外层(app.ts)做 destroy + 切回编辑器。 */
  private onBack(): void {
    this.requestBack();
  }

  private onTogglePlay(): void {
    this.clearAbPauseTimer();
    if (this.playState === 'playing') {
      this.player.pause();
    } else if (this.playState === 'paused') {
      this.player.resume();
    } else {
      // stopped → 从头或从当前位置播。练琴页停止后重头播直觉更好。
      this.player.play(this.piece, this.currentBeat > 0 ? this.currentBeat : 0);
    }
  }

  private onHand(h: HandFilter): void {
    this.handFilter = h;
    this.waterfall.setHandFilter(h);
    // 暂停/停止态下 onTick 不再跑,键盘高亮和方块不会自动刷新 —— 另一只手的键会残留高亮、
    // 旧手方块仍显示。用当前 beat 主动 dispatchFrame 刷一帧(与 onTick 同款完整分发:
    // scoreSheet + waterfall + keyboard + metronome)。播放态下会被下一帧覆盖,无副作用。
    this.dispatchFrame(this.currentBeat);
  }

  private onMetro(on: boolean): void {
    this.metroOn = on;
    this.metronome.setEnabled(on);
  }

  /** AB switch 切换。开时若 selection=null 自动全选(整曲循环);关时保留 selection(仅隐藏遮罩)。 */
  private onAbToggle(on: boolean): void {
    this.clearAbPauseTimer();
    this.abOn = on;
    if (on) {
      // 首次开(无选区):自动全选。
      if (!this.abSelection) {
        const total = this.score.meta.totalMeasures;
        this.applyAbSelection({ startMeasure: 0, endMeasure: Math.max(0, total - 1) });
      }
      // 定位到 A 点。
      if (this.abSelection) {
        const a = this.abSelection.startMeasure * this.bpb;
        this.player.seek(a, this.player.isPlaying());
      }
    }
    // 存(在自动全选之后,保证存的是最新 selection)。
    saveAbState(this.score.meta.id, { selection: this.abSelection, on: this.abOn, intervalBeats: this.abIntervalBeats });
    // 同步面板(自动全选的面板 selection 显示)+ 谱面视觉。
    this.controls.setAbState({ on: this.abOn, selection: this.abSelection });
    this.updateAbVisual();
  }

  /** AB 选区变化(面板拖选/单击/整曲循环触发)。派生 beat range + 存 + 刷新视觉 + 定位。 */
  private onAbSelectionChange(sel: AbSelection): void {
    this.clearAbPauseTimer();
    this.applyAbSelection(sel);
    saveAbState(this.score.meta.id, { selection: this.abSelection, on: this.abOn, intervalBeats: this.abIntervalBeats });
    // 同步面板显示(面板发起时是幂等的;外部/记忆恢复设置时确保面板跟上)。
    this.controls.setAbState({ on: this.abOn, selection: this.abSelection });
    if (this.abOn && this.abSelection) {
      const a = this.abSelection.startMeasure * this.bpb;
      this.player.seek(a, this.player.isPlaying());
    }
    this.updateAbVisual();
  }

  /** AB 间隔变化(面板滑块触发,单位拍)。存 + 供 triggerAbLoop 读取。 */
  private onAbIntervalChange(beats: number): void {
    this.abIntervalBeats = Math.max(0, Math.min(8, beats));
    saveAbState(this.score.meta.id, { selection: this.abSelection, on: this.abOn, intervalBeats: this.abIntervalBeats });
  }

  /** 应用选区到 abSelection + 派生 abRange(beat)。不持久化、不 seek(由调用方决定)。 */
  private applyAbSelection(sel: AbSelection): void {
    this.abSelection = sel;
    this.abRange = this.selectionToRange(sel);
  }

  /** 选区(小节)→ beat range。B 含末小节末拍:[startMeasure*bpb, (endMeasure+1)*bpb)。 */
  private selectionToRange(sel: AbSelection): { a: number; b: number } {
    return { a: sel.startMeasure * this.bpb, b: (sel.endMeasure + 1) * this.bpb };
  }

  /** beat 是否落在当前选区内(onSeek 限制用)。无选区时返回 false(由调用方保证 abOn 判断)。 */
  private isBeatInSelection(beat: number): boolean {
    if (!this.abSelection) return false;
    return beat >= this.abSelection.startMeasure * this.bpb
      && beat < (this.abSelection.endMeasure + 1) * this.bpb;
  }

  /** 刷新谱面遮罩 + A/B 标记。开关关或无选区 → 传 null(隐藏)。 */
  private updateAbVisual(): void {
    this.scoreSheet.setAbRange(this.abOn ? this.abSelection : null);
  }

  private onSpeed(s: number): void {
    this.clearAbPauseTimer();
    this.speed = s;
    this.player.setBpm(this.baseBpm * s);
    this.controls.setBpm(Math.round(this.baseBpm * s));
    if (this.player.isPlaying()) {
      // 变速重排:从当前 beat 重新调度(保持位置不变)。
      this.player.seek(this.player.getCurrentBeat(), true);
    }
  }

  private onMode(m: ScoreMode): void {
    this.settings.mode = m;
    this.scoreSheet.setMode(m);
    // setMode 重渲染(innerHTML 替换)清空 .current class + lastSysIdx=-1,
    // 用当前 beat 重跑一帧恢复高亮/当前行 + 触发 onLineLayout → updateBounds。
    this.scoreSheet.onTick(this.currentBeat);
    this.updateBounds();
  }

  private onLabels(l: KeyLabels): void {
    this.settings.labels = l;
    this.keyboard.setLabels(l);
  }

  private onFingering(f: Fingering): void {
    this.settings.fingering = f;
    this.keyboard.setFingering(f);
    this.waterfall.setFingering(f);
  }

  /** 谱面宽度变化:设容器宽 + 重渲染谱面(读新 clientWidth)+ 存设置。
   *  重渲染会重建 SVG(setScore innerHTML 替换),.current class 丢失 → 必须重播一帧
   *  onTick(currentBeat) 让 score-sheet 重新标记当前行(updateGradient)+ 报 onLineLayout。 */
  private onScoreWidth(w: number): void {
    this.scoreWidth = clamp(w, SCORE_WIDTH_MIN, SCORE_WIDTH_MAX);
    this.settings.scoreWidth = this.scoreWidth;
    this.scoreArea.style.width = this.scoreWidth + 'px';
    this.scoreSheet.setScore(this.score);
    // 重渲染清空了 .current;用当前 beat 重跑一帧恢复高亮/当前行 + 触发 onLineLayout → updateBounds。
    this.scoreSheet.onTick(this.currentBeat);
    this.updateBounds();
  }

  /** 谱面点击 → seek 到该 beat(拍粒度)。
   *  clamp 到 [0, 整曲总beat),防止点击末尾 padding 区越界。
   *  AB 开时:点击选区外完全无效(封闭练习模式),保持当前播放位置不变。 */
  private onSeekBeat(beat: number): void {
    this.clearAbPauseTimer();
    if (this.abOn && this.abSelection && !this.isBeatInSelection(beat)) return;
    const totalBeats = this.score.meta.totalMeasures * this.bpb;
    const b = Math.max(0, Math.min(beat, totalBeats));
    const playing = this.player.isPlaying();
    this.player.seek(b, playing);
    if (!playing) {
      // 暂停/停止态也更新一帧高亮位置。
      this.currentBeat = b;
      this.scoreSheet.onTick(b);
    }
  }

  // ── AB 循环:公开方法(底层支持,交互后续需求接) ──

  /** 设置 AB 区间(beat 单位)。a<b。传 null 清除。 */
  setAbRange(a: number | null, b?: number): void {
    if (a == null || b == undefined) { this.abRange = null; return; }
    this.abRange = { a: Math.min(a, b), b: Math.max(a, b) };
  }

  /** 跳到指定 beat(测试/外部调用用;播放中则保持播放从该 beat 继续,否则只更新位置)。 */
  seek(beat: number): void {
    this.onSeekBeat(beat);
  }

  // ── bounds 坐标换算(关键协调) ──

  /** score-sheet 当前行底部变化通知(行切换/切档/seek 时触发)。 */
  private onLineLayout(info: { lineBottomY: number; lineBottomOverlayY: number; linePx: number }): void {
    if (this.destroyed) return;
    void info;   // 方块区用实时屏幕行底(updateBounds 内随 smooth scroll 连续变化),无需存目标值
    this.updateBounds();
  }

  /** 谱面滚动时重算方块区(当前行屏幕底随滚动连续变化,实时跟随)。 */
  private updateTopYFromScroll(): void {
    if (this.destroyed) return;
    this.updateBounds();
  }

  /** 实时算「当前行底」在 overlay 内的 y(屏幕坐标,含滚动偏移)。
   *  用 score-sheet.currentLineBottomScreenY()(纯几何 sys.yTop+sys.height,不含 text 虚高),
   *  替代遍历子元素 getBBox(<text> 字体度量框虚高 → 行底算到键盘顶下,方块区无空间)。 */
  private currentLineBottomInOverlay(): number {
    const overlay = this.fallWrap?.parentElement;
    if (!overlay) return 0;
    const screenY = this.scoreSheet.currentLineBottomScreenY();
    if (screenY === null) return 0;
    const overlayTop = overlay.getBoundingClientRect().top;
    return Math.max(0, screenY - overlayTop);
  }

  /** 重算方块区位置/尺寸 + waterfall bounds。 */
  private updateBounds(): void {
    if (this.destroyed) return;
    const kbEl = this.keyboard.el;
    if (!kbEl || !this.fallWrap) return;
    const kbRect = kbEl.getBoundingClientRect();
    const overlayRect = this.fallWrap.parentElement!.getBoundingClientRect();
    const kbTopInOverlay = Math.max(0, kbRect.top - overlayRect.top);
    // 用实时屏幕行底(随 smooth scroll 连续变化),让方块区跟着谱面平滑滚动,而非瞬切。
    // 但换行起点那一帧 currentLineBottomScreenY 会突跳(新行还在视口下方,y 突增一个行高),
    // 导致方块区塌陷。检测突跳(本帧实时值比上一帧【实时值】大很多 ≈ 一个行高)时,把本帧
    // 也钳到上一帧实时值,抵消突跳;之后让实时值自然跑(随 scroll 连续减小,平滑过渡到新行底)。
    // 注意:lastFrameLineBottom 记的是【实时值】(用于检测突跳),钳制只影响本帧用的 lineBottom,
    // 不污染记录 —— 否则会被钳制值污染导致永远钳制(方块区钉死不动)。
    const rawLineBottom = this.currentLineBottomInOverlay();
    const jumpThreshold = (kbRect.height || 140) * 1.5;   // 突跳阈值 ≈ 1.5 倍键盘高(约一个行高)
    let lineBottom = rawLineBottom;
    if (this.lastFrameLineBottom != null && rawLineBottom > this.lastFrameLineBottom + jumpThreshold) {
      lineBottom = this.lastFrameLineBottom;   // 突跳帧:钳到上一帧实时值,抵消突跳
    }
    this.lastFrameLineBottom = rawLineBottom;   // 始终记录实时值(不污染)
    const top = Math.max(0, Math.min(lineBottom, kbTopInOverlay - 20));
    const height = Math.max(0, kbTopInOverlay - top);
    this.fallWrap.style.top = top + 'px';
    this.fallWrap.style.height = height + 'px';
    this.waterfall.setBounds({ topY: 0, bottomY: height });
  }

  // ── 工具 ──

  /** 调号文字:如 "C 大调"。大/小调按有无升降号简化为「大调」。 */
  private keyLabel(): string {
    const k = this.score.meta.key;
    const major = (k.sharps.length + k.flats.length) === 0 ? '大调' : '大调';
    return `${k.name} ${major}`;
  }

  /** 收集当前设置(离开时存 localStorage)。labels/fingering/mode 在对应 on* 回调里同步进 settings。 */
  getSettings(): PracticeSettings {
    return {
      keyWidth: this.keyboard.getKeyWidth(),
      keyboardHeight: this.keyboard.getHeight(),
      labels: this.settings.labels,
      fingering: this.settings.fingering,
      mode: this.settings.mode,
      scoreWidth: this.scoreWidth,
    };
  }

  // ── 卸载 ──

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearAbPauseTimer();
    this.player.dispose();
    window.removeEventListener('resize', this.boundResize);
    window.removeEventListener('keydown', this.boundKeyDown);
    const scrollEl = this.scoreSheet.el.querySelector('.score-sheet-scroll');
    if (scrollEl) scrollEl.removeEventListener('scroll', this.boundScroll);
    this.root.innerHTML = '';
  }
}

// ── 纯工具函数 ──

/** 按谱面音域自动算键盘 range:同时算 treble+bass(whiteKeyRange 各算一次取并集)。
 *  复刻 practice-demo.ts computeAutoRange。 */
function computeAutoRange(score: Score): KeyRange {
  const total = score.meta.totalMeasures;
  const tp = rangeToPiece(score, 0, total, 'treble');
  const bp = rangeToPiece(score, 0, total, 'bass');
  const tWhites = whiteKeyRange(tp);
  const bWhites = whiteKeyRange(bp);
  const all = [...new Set([...tWhites, ...bWhites])].sort((a, b) => a - b);
  return rangeFromWhites(all);
}

/** range → 文字提示,如 "C3–C5"。 */
function rangeText(range: KeyRange): string {
  return `${midiName(range.low)}–${midiName(range.high)}`;
}
function midiName(midi: number): string {
  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
/** 把 v 限制到 [lo, hi]。 */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
