// 应用装配：工具栏 ↔ 画布 ↔ 简谱 ↔ 播放 ↔ 导出 ↔ 快捷键
// 录入模型：追加式（短信验证码）—— 只能往末尾加，只能从末尾删。

import { Note, Piece, durationBeats } from '../core/types';
import { KEYS } from '../core/theory';
import { createPiece, appendNote, popNote, remainingBeats, remainingBeatsInCurrentBar, capacityBeats, totalBeats, noteStartBeats } from '../core/model';
import { computeLayout } from '../render/layout';
import { buildSVG, exportPNG } from '../render/export';
import { ensureFontLoaded } from '../render/glyphs';
import { clickYToMidi } from '../render/staff';
import { buildToolbar, defaultTool, ToolState, TUPLET_CONFIG, TupletMode } from './toolbar';
import { Player, PlayState } from '../audio/player';
import { buildPlaybackCard, loadFingering, loadShow, saveFingering, saveShow, Fingering, ShowFlags, PlaybackView } from './playback-card';
import { twinkleExample } from './examples';

interface HoverState { midi: number; x: number; }

export class App {
  private piece: Piece;
  private tool: ToolState;
  /** 连音组(tuplet)输入进度：开启 tuplet 模式后，追踪当前组已输入第几个、共用 groupId。
   *  输入第 actual 个后关闭模式并清空。null 表示不在组输入中。 */
  private tupletProgress: { groupId: string; count: number; actual: number; normal: number } | null = null;
  private tupletIdCounter = 0;
  private root: HTMLElement;
  private svgHost!: HTMLElement;
  private statusEl!: HTMLElement;
  private bpm = 100;
  private playingIndex = -1;
  private currentBeat = 0;
  private playState: PlayState = 'stopped';
  private fingering: Fingering;
  private show: ShowFlags;
  private player: Player;
  private toolbar!: HTMLElement;
  private playbackCard!: HTMLElement;
  private hover: HoverState | null = null;
  private layout!: ReturnType<typeof computeLayout>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.piece = createPiece();
    this.tool = defaultTool();
    this.fingering = loadFingering();
    this.show = loadShow();
    this.player = new Player({
      onNote: (i) => { this.playingIndex = i; this.render(); },
      onTick: (beat) => { this.currentBeat = beat; (this.playbackCard as any)._setProgress?.(beat); },
      onStateChange: (s) => {
        this.playState = s;
        if (s === 'stopped') { this.playingIndex = -1; this.currentBeat = 0; }
        (this.playbackCard as any)._refresh?.();
        this.render();
      },
      onEnd: () => { this.playingIndex = -1; this.currentBeat = 0; this.render(); },
    });
    this.buildDOM();
    void ensureFontLoaded().then(() => this.render());
  }

  private buildDOM(): void {
    this.root.innerHTML = '';
    this.root.className = 'app';

    const header = document.createElement('header');
    header.className = 'app-header';
    header.innerHTML = `<h1>简谱翻译 <span class="dot">·</span> <em>MusicSheet</em></h1>
      <p class="hint">点击五线谱放音 → 下方实时显示简谱 · 类似短信验证码：只能往右追加，退格删除最后一个</p>`;
    this.root.appendChild(header);

    this.toolbar = buildToolbar(this.tool, { onChange: () => this.onToolChange(), onRest: () => this.appendRest() });
    this.root.appendChild(this.toolbar);

    const stageWrap = document.createElement('div');
    stageWrap.className = 'stage';
    this.svgHost = document.createElement('div');
    this.svgHost.className = 'svg-host';
    stageWrap.appendChild(this.svgHost);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    stageWrap.appendChild(this.statusEl);

    this.root.appendChild(stageWrap);

    // 放音功能区卡片（替换原播放底栏）
    this.playbackCard = buildPlaybackCard(() => this.playbackView(), {
      onTogglePlay: () => this.togglePlay(),
      onStop: () => { this.player.stop(); this.playingIndex = -1; this.currentBeat = 0; this.render(); },
      onRestart: () => this.restart(),
      onSeek: (beat) => this.seek(beat),
      onBpm: (b) => this.changeBpm(b),
      onFingering: (f) => { this.fingering = f; saveFingering(f); this.refreshCard(); },
      onShow: (key, on) => { this.show = { ...this.show, [key]: on }; saveShow(this.show); this.refreshCard(); },
    });
    this.root.appendChild(this.playbackCard);

    // 编辑操作栏（示例/清空/导出）—— 次要操作，放卡片下一行
    const editBar = document.createElement('div');
    editBar.className = 'edit-bar';
    const exampleBtn = mkBtn('示例：小星星', 'ghost', () => this.loadExample());
    const clearBtn = mkBtn('清空', 'ghost', () => this.clear());
    const exportBtn = mkBtn('⬇ 导出 PNG', 'accent', () => this.doExport());
    editBar.append(spacer(), exampleBtn, clearBtn, exportBtn);
    this.root.appendChild(editBar);

    this.bindCanvas();
    this.bindKeys();
    this.render();
  }

  private isMouseDown = false;

  private bindCanvas(): void {
    // 阻止双击/拖拽选中文本和音符（CSS user-select:none 的补充）
    this.svgHost.addEventListener('selectstart', (e) => e.preventDefault());
    this.svgHost.addEventListener('dblclick', (e) => e.preventDefault());

    // 记录鼠标按下状态：按下期间绝不重渲染，避免点击中途中断
    this.svgHost.addEventListener('mousedown', () => { this.isMouseDown = true; });
    window.addEventListener('mouseup', () => { this.isMouseDown = false; });

    // mousemove → 悬停预览。仅当音高真正变化（吸附后的 midi 不同）才重渲染，
    // 既省性能，又避免每次微小移动都重建 SVG 把点击打断。
    this.svgHost.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isMouseDown) return; // 按下期间不重渲染
      const { y, ok } = this.toSvgCoords(e);
      if (!ok) { this.clearHover(); return; }
      const midi = clickYToMidi(y, this.piece, this.layout);
      if (this.hover && this.hover.midi === midi) return; // 音高没变，不重渲染
      this.hover = { midi, x: this.layout.nextSlotX };
      this.render();
      this.maybePreview(midi);
    });
    this.svgHost.addEventListener('mouseleave', () => this.clearHover());

    // click → 追加音符。命中范围：整个 SVG 区域（追加式录入里 x 不影响落点，只用 y 决定音高）。
    this.svgHost.addEventListener('click', (e: MouseEvent) => {
      const { y, ok } = this.toSvgCoords(e);
      if (!ok) return;
      const midi = clickYToMidi(y, this.piece, this.layout);
      this.appendNoteWithPitch(midi);
    });
  }

  private lastPreviewMidi: number | null = null;
  private maybePreview(midi: number): void {
    if (this.lastPreviewMidi !== midi) {
      this.lastPreviewMidi = midi;
      this.player.preview(midi);
    }
  }

  private clearHover(): void {
    if (this.hover) { this.hover = null; this.render(); }
  }

  private toSvgCoords(e: MouseEvent): { x: number; y: number; ok: boolean } {
    const svg = this.svgHost.querySelector('svg');
    if (!svg) return { x: 0, y: 0, ok: false };
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.layout.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.layout.height;
    return { x, y, ok: true };
  }

  private appendNoteWithPitch(midi: number): void {
    const tuplet = this.computeTupletForNextNote();
    const note: Note = { midi, duration: this.tool.duration, dotted: this.tool.dotted, accidental: this.tool.accidental, tuplet };
    const ok = appendNote(this.piece, note);
    if (!ok) { this.flashOverfillRejected(); return; }
    this.applyTieIfPending(midi);
    this.advanceTupletProgress();
    this.afterEdit();
  }

  private appendRest(): void {
    const note: Note = { midi: null, duration: this.tool.duration, dotted: this.tool.dotted, accidental: null };
    const ok = appendNote(this.piece, note);
    if (!ok) { this.flashOverfillRejected(); return; }
    // 休止符不能建立 tie（无声），tieNext 自动作废
    this.afterEdit();
  }

  /** 若 tool.tieNext 为真且前一个音与新音同音高，在两者间建立连音线(tie)：
   *  前音标 tieStart、新音标 tieEnd。音高不同或前音为休止则忽略（tie 无意义）。 */
  private applyTieIfPending(newMidi: number): void {
    if (!this.tool.tieNext) return;
    const notes = this.piece.notes;
    if (notes.length < 2) return;
    const prev = notes[notes.length - 2];
    if (prev.midi !== null && prev.midi === newMidi) {
      prev.tieStart = true;
      notes[notes.length - 1].tieEnd = true;
    }
  }

  /** 计算下一个音的 tuplet 字段（若处于 tuplet 输入模式）。
   *  首个音时开新组（生成 groupId），返回 TupletInfo；非首音复用同 groupId。
   *  模式关闭或休止则返回 undefined。 */
  private computeTupletForNextNote(): Note['tuplet'] {
    const mode = this.tool.tupletMode;
    if (mode === 'off') return undefined;
    const cfg = TUPLET_CONFIG[mode];
    if (!this.tupletProgress) {
      // 开新组
      this.tupletProgress = {
        groupId: `tup-${++this.tupletIdCounter}`,
        count: 0,
        actual: cfg.actual,
        normal: cfg.normal,
      };
    }
    return { actual: this.tupletProgress.actual, normal: this.tupletProgress.normal, groupId: this.tupletProgress.groupId };
  }

  /** 输入一个音后推进 tuplet 进度：count++；达到 actual 则关闭模式、清进度。 */
  private advanceTupletProgress(): void {
    if (!this.tupletProgress) return;
    this.tupletProgress.count++;
    if (this.tupletProgress.count >= this.tupletProgress.actual) {
      // 组凑齐，关闭模式
      this.tupletProgress = null;
      this.tool.tupletMode = 'off';
      (this.toolbar as any)._setTupletMode?.('off');
    }
  }

  /** 切换「连音线」修饰符：开 → 下一个同音高音会与前音建立 tie。 */
  private toggleTieNext(): void {
    this.tool.tieNext = !this.tool.tieNext;
    (this.toolbar as any)._setTieNext?.(this.tool.tieNext);
    this.render();
  }

  /** 切换连音组(tuplet)模式：点当前模式=关闭(off)；点其他模式=切换到该模式。
   *  切换/关闭时若当前组未凑齐，回滚这些已输入音的 tuplet 标记（避免不完整组），
   *  并清进度，下次开新组。 */
  private toggleTupletMode(mode: Exclude<TupletMode, 'off'>): void {
    const newMode = this.tool.tupletMode === mode ? 'off' : mode;
    if (newMode === 'off' && this.tupletProgress) {
      // 关闭且当前组未凑齐：回滚已输入音的 tuplet 标记
      const gid = this.tupletProgress.groupId;
      for (const n of this.piece.notes) {
        if (n.tuplet?.groupId === gid) n.tuplet = undefined;
      }
      this.tupletProgress = null;
    } else if (newMode !== 'off') {
      // 切到新模式：若当前有未凑齐组先回滚，再重置进度（下次首个音开新组）
      if (this.tupletProgress) {
        const gid = this.tupletProgress.groupId;
        for (const n of this.piece.notes) {
          if (n.tuplet?.groupId === gid) n.tuplet = undefined;
        }
        this.tupletProgress = null;
      }
    }
    this.tool.tupletMode = newMode;
    (this.toolbar as any)._setTupletMode?.(newMode);
    this.render();
  }

  /** appendNote 拒绝时给出精确提示：区分「整个谱写满」和「本小节放不下」 */
  private flashOverfillRejected(): void {
    if (remainingBeats(this.piece) < 1e-6) {
      this.flash(`已写满 ${this.piece.measureCount} 个小节`);
    } else {
      const rem = remainingBeatsInCurrentBar(this.piece);
      this.flash(rem < 1e-6 ? '本小节已满，请先删一个音符或换小节' : `本小节剩 ${rem.toFixed(2)} 拍，放不下此音符`);
    }
  }

  private afterEdit(): void {
    // 追加后重置一次性修饰（附点/升降/休止），符合行业惯例
    (this.toolbar as any)._resetModifiers?.();
    this.hover = null;
    this.render();
  }

  private onToolChange(): void {
    const oldClef = this.piece.clef;
    const oldTime = `${this.piece.time.num}/${this.piece.time.den}`;
    const oldMeasureCount = this.piece.measureCount;
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    this.piece.measureCount = this.tool.measureCount;
    // 切换谱号 / 拍号 / 小节数：清空已输入的音符（避免错位与节奏错乱）
    const newTime = `${this.piece.time.num}/${this.piece.time.den}`;
    if (oldClef !== this.piece.clef || oldTime !== newTime || oldMeasureCount !== this.piece.measureCount) {
      this.piece.notes = [];
      this.playingIndex = -1;
    }
    this.render();
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'SELECT' || tag === 'INPUT') return;
      switch (e.key) {
        case '1': this.tool.duration = 'whole'; this.syncToolbarDurations(); break;
        case '2': this.tool.duration = 'half'; this.syncToolbarDurations(); break;
        case '3': this.tool.duration = 'quarter'; this.syncToolbarDurations(); break;
        case '4': this.tool.duration = 'eighth'; this.syncToolbarDurations(); break;
        case '5': this.tool.duration = 'sixteenth'; this.syncToolbarDurations(); break;
        case '6': this.tool.duration = 'thirtysecond'; this.syncToolbarDurations(); break;
        case '.': this.tool.dotted = !this.tool.dotted; (this.toolbar as any)._resetModifiers?.(); this.render(); break;
        case 't': this.toggleTieNext(); break;
        case 'r': this.toggleTupletMode('triplet'); break;
        case 'f': this.toggleTupletMode('quintuplet'); break;
        case 'x': this.toggleTupletMode('sextuplet'); break;
        case '0': this.appendRest(); break;
        case 'Backspace': popNote(this.piece); this.render(); e.preventDefault(); break;
        case ' ': this.togglePlay(); e.preventDefault(); break;
      }
    });
  }

  /** 键盘改了 duration 后，把工具栏高亮同步过来 */
  private syncToolbarDurations(): void {
    const btns = this.toolbar.querySelectorAll<HTMLButtonElement>('.chip[data-dur]');
    btns.forEach(b => b.classList.toggle('active', b.dataset.dur === this.tool.duration));
    this.render();
  }

  private togglePlay(): void {
    if (this.piece.notes.length === 0) return;       // 空乐谱不播
    const s = this.playState;
    if (s === 'playing') {
      this.player.pause();
    } else if (s === 'paused') {
      this.player.resume();
    } else {
      this.player.setBpm(this.bpm);
      this.player.play(this.piece);
    }
  }

  /** ⏮ 回到起点：播放中→从头播；暂停/停止→归零并停在停止态 */
  private restart(): void {
    this.player.stop();
    this.playingIndex = -1;
    this.currentBeat = 0;
    this.playState = 'stopped';
    this.refreshCard();
    this.render();
  }

  /** seek：播放中→从该 beat 继续；暂停/停止→定位但保持原态（按播放才从该处响） */
  private seek(beat: number): void {
    this.currentBeat = beat;
    if (this.playState === 'playing') {
      this.player.setBpm(this.bpm);
      this.player.seek(beat, true);
    } else if (this.playState === 'paused') {
      this.player.seek(beat, false);
      // 暂停态：只更新进度显示，不发声
      (this.playbackCard as any)._setProgress?.(beat);
    } else {
      // 停止态：定位到 beat，按播放时从这里开始（记录到 currentBeat，play() 会从头）
      // 停止态不支持中途起播 —— 直接从头播更直观
      (this.playbackCard as any)._setProgress?.(beat);
    }
  }

  /** BPM 变化：更新值，播放中无缝变速（重调度） */
  private changeBpm(bpm: number): void {
    this.bpm = bpm;
    this.player.setBpm(bpm);
    if (this.playState === 'playing') {
      const beat = this.player.getCurrentBeat();
      this.player.seek(beat, true);
    }
    this.refreshCard();
  }

  /** 构造给卡片的视图快照 */
  private playbackView(): PlaybackView {
    const totalBeats = this.piece.notes.reduce((s, n) => s + durationBeats(n), 0);
    return {
      piece: this.piece,
      playState: this.playState,
      bpm: this.bpm,
      currentBeat: this.playState === 'stopped' ? 0 : this.currentBeat,
      totalBeats,
      playingIndex: this.playingIndex,
      fingering: this.fingering,
      show: this.show,
    };
  }

  private refreshCard(): void {
    (this.playbackCard as any)._refresh?.();
  }

  private clear(): void {
    this.piece = createPiece();
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    this.piece.measureCount = this.tool.measureCount;
    this.playingIndex = -1;
    this.render();
  }

  private loadExample(): void {
    this.piece = twinkleExample(this.tool.measureCount);
    // 保留用户当前选择的调号与拍号（示例用绝对 MIDI 音高，调号只影响显示与简谱）
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    this.piece.measureCount = this.tool.measureCount;
    this.rebuildToolbar();
    this.render();
  }

  private rebuildToolbar(): void {
    const old = this.toolbar;
    this.toolbar = buildToolbar(this.tool, { onChange: () => this.onToolChange(), onRest: () => this.appendRest() });
    old.replaceWith(this.toolbar);
  }

  private async doExport(): Promise<void> {
    try { await exportPNG(this.piece, this.layout); this.flash('已导出 PNG'); }
    catch (err) { this.flash('导出失败：' + (err as Error).message); }
  }

  private flashTimer: number | undefined;
  private flash(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.classList.add('show', 'flash');
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => { this.statusEl.classList.remove('show', 'flash'); this.render(); }, 1600);
  }

  private render(): void {
    const width = Math.min(1200, Math.max(640, this.svgHost.clientWidth || 940));
    this.layout = computeLayout(this.piece, width, this.tool.duration);
    const svg = buildSVG(this.piece, this.layout, this.playingIndex, { hover: this.hover });
    // 播放/暂停态：注入播放头竖线（贯穿五线谱+简谱），停止态不显示
    const withHead = this.playState !== 'stopped'
      ? this.injectPlayhead(svg)
      : svg;
    this.svgHost.innerHTML = withHead;
    const svgEl = this.svgHost.querySelector('svg');
    if (svgEl) svgEl.setAttribute('width', '100%');
    // 状态
    const rem = remainingBeats(this.piece);
    const pct = Math.round((totalBeats(this.piece) / capacityBeats(this.piece)) * 100);
    this.statusEl.textContent = `${this.piece.notes.length} 个音符 · 已用 ${pct}% · 还能再写约 ${rem.toFixed(1)} 拍`;
    // 工具栏容量联动：disable 放不下的时值/附点按钮
    (this.toolbar as any)._refreshCapacity?.(remainingBeatsInCurrentBar(this.piece), rem);
    // 卡片随 render 刷新（音域/高亮/状态可能变）
    this.refreshCard();
  }

  /** 在五线谱 SVG 上叠加播放头：半透明紫色矩形条（20% 紫），宽度覆盖当前音符的 slot 宽度。 */
  private injectPlayhead(svg: string): string {
    const lay = this.layout;
    const notes = this.piece.notes;
    if (notes.length === 0 || lay.noteX.length === 0) return svg;
    const starts = noteStartBeats(this.piece);
    // 找 currentBeat 落在哪个音区间，取该音的中心 x + slot 宽度
    let idx = 0;
    for (let i = 0; i < notes.length; i++) {
      const startBeat = starts[i];
      const endBeat = startBeat + durationBeats(notes[i]);
      if (this.currentBeat >= startBeat && this.currentBeat <= endBeat + 1e-6) { idx = i; break; }
      if (this.currentBeat > endBeat) idx = Math.min(i, notes.length - 1);
    }
    const x0 = lay.noteX[idx];
    const w = lay.noteSlotW[idx] || 24;
    const y1 = lay.staffTop - 8;
    const y2 = lay.jianpuBottom + 8;
    const rect = `<rect class="pb-playhead" x="${x0 - w / 2}" y="${y1}" width="${w}" height="${y2 - y1}" rx="3"/>`;
    return svg.replace('</svg>', `${rect}</svg>`);
  }
}

function mkBtn(text: string, variant: 'primary' | 'ghost' | 'accent', onClick: () => void, extra?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn btn-${variant}` + (extra ? ` btn-${extra}` : '');
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function spacer(): HTMLElement {
  const s = document.createElement('div');
  s.className = 'spacer';
  return s;
}
